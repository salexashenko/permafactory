import http from "node:http";
import net from "node:net";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { open } from "node:fs/promises";
import process from "node:process";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { FactoryDatabase } from "@permafactory/db";
import {
  detectPackageManagerAndScripts,
  getConfigPath,
  loadProjectConfig,
  renderFactoryConfig
} from "@permafactory/config";
import { DEFAULT_MANAGER_THREAD_NAME } from "@permafactory/models";
import type {
  CodingWorkerResult,
  DecisionRequest,
  DeploymentIntent,
  FactoryProjectConfig,
  IntegrationRequest,
  ManagerToolCallRecord,
  ManagerToolHttpRequest,
  ManagerToolHttpResponse,
  ManagerToolName,
  ManagerTurnInput,
  ManagerTurnOutput,
  ReviewRequest,
  ReviewerResult,
  TaskContract,
  TesterResult,
  WorkerSandboxCapabilities
} from "@permafactory/models";
import {
  addWorktree,
  allocatePorts,
  applyWorkerSandboxCapabilities,
  currentCommit,
  deriveEffectivePortLeaseRequirement,
  ensureDetachedWorktreeAtRef,
  ensureDir,
  fileExists,
  getFactoryPaths,
  isPlaceholderScript,
  isLikelyGreenfieldRepoFiles,
  listDirtyFiles,
  loadEnvFile,
  localDateString,
  normalizeManagerTurnOutput,
  nowIso,
  randomId,
  readEnvFileValues,
  readText,
  resolveReachableHttpUrl,
  runCommand,
  sampleResources,
  sendTelegramApiRequest,
  shouldDeliverTelegramNotification,
  slugify,
  spawnLoggedShellCommand,
  spawnLoggedProcess,
  upsertEnvFileValue,
  validateWithSchema,
  waitForSuccessfulCommand,
  writeText
} from "@permafactory/runtime";

type JsonRpcResponse = {
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
  method?: string;
  params?: unknown;
};

type RuntimeSlotName = "stable-a" | "stable-b" | "preview";

const MANAGER_TOOL_NAMES: ReadonlySet<ManagerToolName> = new Set([
  "get_factory_status",
  "start_task",
  "cancel_task",
  "start_review",
  "integrate_branch",
  "apply_deployment",
  "request_decision",
  "reply_user"
]);

const RESERVED_SECRET_KEYS = new Set([
  "FACTORY_TASK_ID",
  "FACTORY_BRANCH",
  "FACTORY_APP_PORT",
  "FACTORY_E2E_PORT",
  "PORT",
  "HOST",
  "PATH",
  "HOME",
  "PWD",
  "SHELL",
  "NODE_OPTIONS",
  "CODEX_HOME"
]);

interface ManagedRuntimeProcess {
  child: ChildProcess;
  commit: string;
  worktreePath: string;
  port: number;
  script: string;
}

class InterruptedTurnError extends Error {
  constructor(public readonly threadId: string, public readonly turnId: string) {
    super(`Turn ${turnId} on thread ${threadId} was interrupted`);
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const parsed = parseArgs({
    args: process.argv.slice(2),
    options: {
      repo: { type: "string" },
      once: { type: "boolean" }
    },
    strict: true
  });

  const repoRoot = path.resolve(parsed.values.repo ?? process.cwd());
  await loadEnvFile(path.join(repoRoot, ".env.factory"));
  const config = await loadProjectConfig(repoRoot);
  const db = await FactoryDatabase.open(repoRoot);
  db.init();
  db.upsertProject(config);
  const supervisor = new FactorySupervisor(config, db);
  await supervisor.run(Boolean(parsed.values.once));
}

class AppServerClient {
  private socket?: WebSocket;
  private requestId = 1;
  private initialized = false;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private notificationListeners = new Set<(message: JsonRpcResponse) => void>();

  constructor(private readonly url: string) {}

  async connect(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) {
      return;
    }

    const SocketImpl = (globalThis as typeof globalThis & { WebSocket: typeof WebSocket }).WebSocket;
    this.socket = new SocketImpl(this.url);

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out connecting to ${this.url}`)), 5000);
      this.socket?.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      });
      this.socket?.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error(`Failed connecting to ${this.url}`));
      });
    });

    this.socket.addEventListener("message", (event) => {
      const text = typeof event.data === "string" ? event.data : String(event.data);
      const message = JSON.parse(text) as JsonRpcResponse;
      if (typeof message.id === "number") {
        const pending = this.pending.get(message.id);
        if (!pending) {
          return;
        }
        this.pending.delete(message.id);
        if (message.error) {
          pending.reject(new Error(message.error.message));
        } else {
          pending.resolve(message.result);
        }
        return;
      }

      for (const listener of this.notificationListeners) {
        listener(message);
      }
    });

    this.socket.addEventListener("close", () => {
      this.initialized = false;
      this.socket = undefined;
      for (const [id, pending] of this.pending.entries()) {
        this.pending.delete(id);
        pending.reject(new Error("App server socket closed"));
      }
    });
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    await this.connect();
    await this.sendRequest("initialize", {
      clientInfo: { name: "permafactory", version: "0.1.0" },
      capabilities: null
    });
    this.initialized = true;
  }

  dispose(): void {
    this.initialized = false;
    try {
      this.socket?.close();
    } catch {
      // Ignore close errors during transport reset.
    }
    this.socket = undefined;
  }

  onNotification(listener: (message: JsonRpcResponse) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  async request<T>(method: string, params: unknown): Promise<T> {
    await this.initialize();
    return await this.sendRequest<T>(method, params);
  }

  private async sendRequest<T>(method: string, params: unknown): Promise<T> {
    await this.connect();
    const id = this.requestId++;
    const payload = { jsonrpc: "2.0", id, method, params };

    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject
      });
    });

    this.socket?.send(JSON.stringify(payload));
    return await promise;
  }

  async ensureManagerThread(
    threadId: string | undefined,
    config: FactoryProjectConfig,
    developerInstructions: string,
    threadConfig?: Record<string, unknown>
  ): Promise<string> {
    const params = {
      model: config.codex.managerModel,
      cwd: config.repoRoot,
      approvalPolicy: "never",
      sandbox: config.codex.sandboxMode,
      config: threadConfig ?? null,
      serviceName: "permafactory",
      developerInstructions,
      personality: null,
      experimentalRawEvents: false
    };

    try {
      if (threadId) {
        const resumed = await this.request<{ thread: { id: string } }>("thread/resume", {
          threadId,
          ...params
        });
        return resumed.thread.id;
      }
    } catch {
      // Start fresh below.
    }

    const started = await this.request<{ thread: { id: string } }>("thread/start", params);
    return started.thread.id;
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.request("turn/interrupt", { threadId, turnId });
  }

  async startTurn(
    threadId: string,
    inputText: string,
    outputSchema: unknown | undefined,
    timeoutMs = 10 * 60 * 1000
  ): Promise<{ turnId: string; completion: Promise<{ status: string; outputText?: string }> }> {
    const result = await this.request<{ turn: { id: string } }>("turn/start", {
      threadId,
      input: [{ type: "text", text: inputText, text_elements: [] }],
      ...(outputSchema ? { outputSchema } : {})
    });
    const turnId = result.turn.id;
    return {
      turnId,
      completion: this.collectTurnResult(threadId, turnId, timeoutMs)
    };
  }

  private async collectTurnResult(
    threadId: string,
    turnId: string,
    timeoutMs: number
  ): Promise<{ status: string; outputText?: string }> {
    const status = await this.waitForTurn(threadId, turnId, timeoutMs);
    if (status !== "completed") {
      if (/(interrupt|cancel)/i.test(status)) {
        throw new InterruptedTurnError(threadId, turnId);
      }
      throw new Error(`Turn ${turnId} finished with status ${status}`);
    }

    const thread = await this.request<{ thread: { turns: Array<{ id: string; items: Array<{ type: string; text?: string }> }> } }>(
      "thread/read",
      { threadId, includeTurns: true }
    );

    const turn = thread.thread.turns.find((candidate) => candidate.id === turnId);
    const lastAgentMessage = [...(turn?.items ?? [])]
      .reverse()
      .find((item) => item.type === "agentMessage" && typeof item.text === "string");
    if (!lastAgentMessage?.text) {
      throw new Error(`No final agent message found for turn ${turnId}`);
    }

    return { status, outputText: lastAgentMessage.text };
  }

  private async waitForTurn(threadId: string, turnId: string, timeoutMs: number): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error(`Timed out waiting for turn ${turnId}`));
      }, timeoutMs);

      const unsubscribe = this.onNotification((message) => {
        if (
          message.method === "turn/completed" &&
          message.params &&
          typeof message.params === "object" &&
          "threadId" in message.params &&
          "turn" in message.params
        ) {
          const params = message.params as { threadId: string; turn: { id: string; status: string } };
          if (params.threadId === threadId && params.turn.id === turnId) {
            clearTimeout(timer);
            unsubscribe();
            resolve(params.turn.status);
          }
        }
      });
    });
  }
}

class FactorySupervisor {
  private readonly paths: ReturnType<typeof getFactoryPaths>;
  private readonly factoryRepoRoot: string;
  private readonly managerSchemaPath: string;
  private readonly workerSchemaPath: string;
  private readonly reviewerSchemaPath: string;
  private readonly testerSchemaPath: string;
  private readonly managerPromptPath: string;
  private readonly workerPromptPath: string;
  private readonly reviewerPromptPath: string;
  private readonly testerPromptPath: string;
  private managerRunning = false;
  private appServerProcess?: ChildProcess;
  private appServerClient?: AppServerClient;
  private dashboardServer?: http.Server;
  private stableProxyServer?: http.Server;
  private workerChildren = new Map<string, ChildProcess>();
  private runtimeProcesses = new Map<RuntimeSlotName, ManagedRuntimeProcess>();
  private pendingManagerWakeReasons = new Set<string>(["startup"]);
  private lastNoActiveWorkWakeAt = 0;
  private activeManagerTurnId?: string;
  private activeManagerThreadId?: string;
  private activeManagerHasDirectUserMessage = false;
  private activeManagerReplyToMessageId?: string;
  private readonly managerToolToken = randomBytes(24).toString("hex");
  private workerSandboxCapabilities?: WorkerSandboxCapabilities & { sandboxMode: string };

  constructor(private config: FactoryProjectConfig, private readonly db: FactoryDatabase) {
    this.paths = getFactoryPaths(this.config.repoRoot);
    this.factoryRepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
    this.managerSchemaPath = path.resolve(this.factoryRepoRoot, "schemas/manager-output.schema.json");
    this.workerSchemaPath = path.resolve(this.factoryRepoRoot, "schemas/worker-result.schema.json");
    this.reviewerSchemaPath = path.resolve(this.factoryRepoRoot, "schemas/reviewer-result.schema.json");
    this.testerSchemaPath = path.resolve(this.factoryRepoRoot, "schemas/tester-result.schema.json");
    this.managerPromptPath = path.resolve(this.factoryRepoRoot, "prompts/manager.md");
    this.workerPromptPath = path.resolve(this.factoryRepoRoot, "prompts/worker.md");
    this.reviewerPromptPath = path.resolve(this.factoryRepoRoot, "prompts/reviewer.md");
    this.testerPromptPath = path.resolve(this.factoryRepoRoot, "prompts/tester.md");
  }

  async run(once: boolean): Promise<void> {
    await ensureDir(this.paths.logsDir);
    await ensureDir(this.paths.tasksDir);
    await ensureDir(this.paths.worktreesDir);
    await ensureDir(this.paths.runtimeDir);
    await ensureDir(this.paths.runsDir);
    await this.claimSupervisorPid();

    try {
      await this.refreshProjectState();
      await this.startDashboardServer();

      do {
        await this.tick();
        if (!once) {
          await new Promise((resolve) => setTimeout(resolve, this.config.scheduler.tickSeconds * 1000));
        }
      } while (!once);
    } finally {
      await this.releaseSupervisorPid();
    }
  }

  private async claimSupervisorPid(): Promise<void> {
    const existingPidText = await readText(this.paths.supervisorPidPath).catch(() => undefined);
    const existingPid = existingPidText ? Number.parseInt(existingPidText.trim(), 10) : undefined;
    if (existingPid && Number.isFinite(existingPid) && existingPid !== process.pid && this.isProcessAlive(existingPid)) {
      throw new Error(`factoryd is already running for ${this.config.repoRoot} as pid ${existingPid}`);
    }

    await writeText(this.paths.supervisorPidPath, `${process.pid}\n`);
  }

  private async releaseSupervisorPid(): Promise<void> {
    const existingPidText = await readText(this.paths.supervisorPidPath).catch(() => undefined);
    const existingPid = existingPidText ? Number.parseInt(existingPidText.trim(), 10) : undefined;
    if (existingPid === process.pid) {
      await writeText(this.paths.supervisorPidPath, "").catch(() => undefined);
    }
  }

  private async tick(): Promise<void> {
    this.config = await loadProjectConfig(this.config.repoRoot);
    this.db.upsertProject(this.config);
    await this.refreshProjectState();
    const trackedFiles = await this.listTrackedFilesForBootstrapDetection();
    const appearsGreenfield = isLikelyGreenfieldRepoFiles(trackedFiles, this.config.projectSpecPath);
    await this.reconcileRuntimeTargets(appearsGreenfield);
    await this.reconcileStaleWorkers();
    await this.reconcileCompletedTaskBranches();

    const expiredDecisions = this.db.expireTimedOutDecisions();
    if (expiredDecisions.length > 0) {
      const requeuedTasks = this.db.requeueSatisfiedBlockedTasks(this.config.projectId);
      for (const taskId of requeuedTasks) {
        this.db.insertTaskEvent(taskId, "queued", "Task re-queued after decision timeout");
      }
      this.pendingManagerWakeReasons.add("decision_timeout");
    }

    const resources = await this.sampleManagerResources();
    this.db.recordHealthSample(this.config.projectId, resources);
    await this.maybeSendDailyDigest(resources);
    this.maybeWakeManagerForContinuity();

    if (this.shouldRunManager(resources)) {
      await this.runManagerTurn(resources);
    }

    await this.startQueuedTasksIfPossible();
  }

  private shouldRunManager(_resources: ManagerTurnInput["resources"]): boolean {
    if (this.managerRunning) {
      return false;
    }

    if (this.pendingManagerWakeReasons.size > 0) {
      return true;
    }

    const inboxItems = this.db.listInboxItems(this.config.projectId);
    if (inboxItems.some((item) => item.status === "new")) {
      return true;
    }

    const agents = this.db.listAgents(this.config.projectId);
    const managerNeedsRecovery = agents.some(
      (agent) => agent.role === "manager" && ["failed", "stalled"].includes(agent.status)
    );
    if (managerNeedsRecovery) {
      return true;
    }
    return false;
  }

  private maybeWakeManagerForContinuity(): void {
    const tasks = this.db.listTasks(this.config.projectId);
    const agents = this.db.listAgents(this.config.projectId);
    const hasActiveTask = tasks.some((task) => ["queued", "running", "review"].includes(task.status));
    const hasRunningWorker = agents.some((agent) => agent.role !== "manager" && agent.status === "running");
    if (hasActiveTask || hasRunningWorker) {
      return;
    }

    const cooldownMs = Math.max(this.config.scheduler.tickSeconds * 1000, 60_000);
    if (Date.now() - this.lastNoActiveWorkWakeAt < cooldownMs) {
      return;
    }

    this.pendingManagerWakeReasons.add("no_active_work");
    this.lastNoActiveWorkWakeAt = Date.now();
  }

  private async runManagerTurn(resources: ManagerTurnInput["resources"]): Promise<void> {
    this.managerRunning = true;
    const wakeReasons = [...this.pendingManagerWakeReasons];
    this.pendingManagerWakeReasons.clear();

    try {
      await this.ensureAppServer();
      const client = this.getAppServerClient();
      const developerInstructions = await this.buildManagerInstructions();
      const threadId = await client.ensureManagerThread(
        this.activeManagerThreadId ?? this.db.getAgentSession("manager", "thread")?.sessionId,
        this.config,
        developerInstructions,
        this.buildManagerThreadConfig()
      );
      this.activeManagerThreadId = threadId;
      this.db.upsertAgent({
        id: "manager",
        projectId: this.config.projectId,
        role: "manager",
        status: "running",
        threadId
      });
      this.db.setAgentSession({
        id: "manager-thread",
        projectId: this.config.projectId,
        agentId: "manager",
        sessionType: "thread",
        sessionId: threadId,
        transport: "app-server"
      });

      const input = await this.buildManagerInput(resources);
      this.activeManagerHasDirectUserMessage = input.userMessages.length > 0;
      this.activeManagerReplyToMessageId = input.userMessages.at(-1)?.replyToMessageId;
      const startedTurn = await client.startTurn(
        threadId,
        JSON.stringify(input, null, 2),
        undefined,
        this.config.scheduler.managerStallSeconds * 1000
      );
      this.activeManagerTurnId = startedTurn.turnId;
      this.db.upsertAgent({
        id: "manager",
        projectId: this.config.projectId,
        role: "manager",
        status: "running",
        threadId,
        turnId: startedTurn.turnId
      });

      const result = await startedTurn.completion;
      if (!result.outputText) {
        throw new Error(`Manager turn ${startedTurn.turnId} produced no output text`);
      }

      const parsed = JSON.parse(result.outputText) as unknown;
      const normalized = normalizeManagerTurnOutput(parsed, {
        candidateBranch: this.config.candidateBranch,
        worktreesDir: this.paths.worktreesDir
      });
      const validated = await validateWithSchema<ManagerTurnOutput>(this.managerSchemaPath, normalized);
      if (!validated.valid) {
        throw new Error(`Manager output validation failed: ${validated.errors.join("; ")}`);
      }

      await this.applyManagerOutput(validated.value, wakeReasons, input.userMessages.length > 0);
      for (const inboxItem of this.db.listInboxItems(this.config.projectId, ["new"])) {
        this.db.markInboxItemStatus(inboxItem.id, "triaged");
      }

      this.db.upsertAgent({
        id: "manager",
        projectId: this.config.projectId,
        role: "manager",
        status: "idle",
        threadId,
        turnId: undefined
      });
    } catch (error) {
      if (error instanceof InterruptedTurnError) {
        this.db.upsertAgent({
          id: "manager",
          projectId: this.config.projectId,
          role: "manager",
          status: "idle",
          threadId: this.activeManagerThreadId
        });
        this.pendingManagerWakeReasons.add("manager_interrupted");
        return;
      }

      const restartPlanned = await this.recoverManagerFailure(error);

      this.db.upsertAgent({
        id: "manager",
        projectId: this.config.projectId,
        role: "manager",
        status: restartPlanned ? "idle" : "failed",
        threadId: this.activeManagerThreadId
      });
      console.error(`manager turn failed: ${error instanceof Error ? error.message : String(error)}`);
      this.pendingManagerWakeReasons.add("manager_failure");
    } finally {
      this.activeManagerTurnId = undefined;
      this.activeManagerHasDirectUserMessage = false;
      this.activeManagerReplyToMessageId = undefined;
      this.managerRunning = false;
    }
  }

  private async recoverManagerFailure(error: unknown): Promise<boolean> {
    const message = error instanceof Error ? error.message : String(error);
    const shouldInterruptTurn = /Timed out waiting for turn/i.test(message);
    const shouldResetTransport = /Timed out waiting for turn|Not initialized|socket closed|Failed connecting/i.test(
      message
    );

    if (shouldInterruptTurn && this.activeManagerThreadId && this.activeManagerTurnId) {
      try {
        await this.getAppServerClient().interruptTurn(this.activeManagerThreadId, this.activeManagerTurnId);
      } catch {
        // Ignore best-effort interrupt failures during recovery.
      }
    }

    if (shouldResetTransport) {
      await this.resetManagerTransport();
      return true;
    }

    return false;
  }

  private async buildManagerInstructions(): Promise<string> {
    const prompt = await readText(this.managerPromptPath);
    return `${prompt}\n\n## Project Context\n\n- repoRoot: ${this.config.repoRoot}\n- defaultBranch: ${this.config.defaultBranch}\n- candidateBranch: ${this.config.candidateBranch}\n- projectSpecPath: ${this.config.projectSpecPath}\n- managerThreadName: ${DEFAULT_MANAGER_THREAD_NAME}\n`;
  }

  private buildManagerThreadConfig(): Record<string, unknown> {
    const managerMcpPath = path.resolve(
      this.factoryRepoRoot,
      "apps/factory-manager-mcp/src/main.ts"
    );
    const tsxBinPath = path.resolve(this.factoryRepoRoot, "node_modules/.bin/tsx");
    return {
      mcp_servers: {
        permafactory_manager: {
          command: tsxBinPath,
          args: [managerMcpPath],
          env: {
            PERMAFACTORY_MANAGER_DASHBOARD_URL: this.dashboardBaseUrl(),
            PERMAFACTORY_MANAGER_TOOL_TOKEN: this.managerToolToken
          }
        },
        chrome_devtools: {
          ...this.buildBrowserMcpServerConfig(),
          startup_timeout_ms: 20_000
        }
      }
    };
  }

  private dashboardBaseUrl(): string {
    return `http://127.0.0.1:${this.config.ports.dashboard}`;
  }

  private repoEnvPath(): string {
    return path.join(this.config.repoRoot, ".env.factory");
  }

  private async listAvailableSecretKeys(): Promise<string[]> {
    const values = await readEnvFileValues(this.repoEnvPath());
    return Object.keys(values)
      .filter(
        (key) =>
          !RESERVED_SECRET_KEYS.has(key) &&
          !key.startsWith("FACTORY_") &&
          key !== this.config.telegram.botTokenEnvVar &&
          key !== this.config.telegram.webhookSecretEnvVar
      )
      .sort();
  }

  private buildBrowserMcpServerConfig(): {
    command: string;
    args: string[];
  } {
    return {
      command: path.resolve(this.factoryRepoRoot, "node_modules/.bin/chrome-devtools-mcp"),
      args: ["--headless", "--isolated", "--no-usage-statistics"]
    };
  }

  private buildWorkerMcpConfigArgs(): string[] {
    const browser = this.buildBrowserMcpServerConfig();
    const args = [
      "-c",
      `mcp_servers.chrome_devtools.command=${JSON.stringify(browser.command)}`,
      "-c",
      `mcp_servers.chrome_devtools.args=[${browser.args.map((value) => JSON.stringify(value)).join(",")}]`,
      "-c",
      "mcp_servers.chrome_devtools.startup_timeout_ms=20000"
    ];
    return args;
  }

  private async buildManagerInput(resources: ManagerTurnInput["resources"]): Promise<ManagerTurnInput> {
    const input = this.db.getManagerInput(this.config);
    input.project.availableSecretKeys = await this.listAvailableSecretKeys();
    input.repo.dirtyFiles = await listDirtyFiles(this.config.repoRoot);
    input.repo.currentStableCommit = await currentCommit(this.config.repoRoot, this.config.defaultBranch);
    input.repo.currentCandidateCommit = await currentCommit(
      this.config.repoRoot,
      this.config.candidateBranch
    );
    const trackedFiles = await this.listTrackedFilesForBootstrapDetection();
    input.repo.trackedFileCount = trackedFiles.length;
    input.repo.trackedFilesSample = trackedFiles.slice(0, 50);
    input.repo.appearsGreenfield = isLikelyGreenfieldRepoFiles(trackedFiles, this.config.projectSpecPath);
    await this.enrichManagerTaskFacts(input);
    await this.enrichManagerBranchFacts(input);
    input.resources = resources;
    input.deployments = this.db.getDeploymentSnapshot(this.config.projectId);
    return input;
  }

  private async sampleManagerResources(): Promise<ManagerTurnInput["resources"]> {
    const workerSandboxCapabilities = await this.ensureWorkerSandboxCapabilities();
    const agents = this.db.listAgents(this.config.projectId);
    const activeWorkers = agents.filter(
      (agent) => agent.role !== "manager" && agent.status === "running"
    ).length;
    const sampledResources = await sampleResources(this.config.scheduler.maxWorkers, activeWorkers);
    return {
      ...sampledResources,
      workerSandbox: {
        canBindListenSockets: workerSandboxCapabilities.canBindListenSockets
      }
    };
  }

  private async enrichManagerTaskFacts(input: ManagerTurnInput): Promise<void> {
    for (const task of input.tasks) {
      task.branchHead = task.branchName
        ? await currentCommit(this.config.repoRoot, task.branchName).catch(() => undefined)
        : undefined;
      task.baseHead = task.baseBranch
        ? await currentCommit(this.config.repoRoot, task.baseBranch).catch(() => undefined)
        : undefined;

      if (task.branchHead && task.baseHead && task.branchName && task.baseBranch) {
        task.isIntegrated = task.branchHead === task.baseHead;

        const aheadBehind = await runCommand(
          "git",
          ["rev-list", "--left-right", "--count", `${task.baseBranch}...${task.branchName}`],
          {
            cwd: this.config.repoRoot,
            allowNonZeroExit: true
          }
        );
        if (aheadBehind.exitCode === 0) {
          const [behindText, aheadText] = aheadBehind.stdout.trim().split(/\s+/);
          task.behindBy = Number.parseInt(behindText ?? "0", 10) || 0;
          task.aheadBy = Number.parseInt(aheadText ?? "0", 10) || 0;
        }

        const mergeBase = await runCommand("git", ["merge-base", task.baseBranch, task.branchName], {
          cwd: this.config.repoRoot,
          allowNonZeroExit: true
        });
        task.canFastForwardBase =
          !task.isIntegrated &&
          mergeBase.exitCode === 0 &&
          mergeBase.stdout.trim() === task.baseHead;
      } else if (task.branchHead && task.baseHead) {
        task.isIntegrated = task.branchHead === task.baseHead;
      }

      if (task.worktreePath && (await fileExists(path.join(task.worktreePath, ".git")))) {
        const dirtyFiles = await listDirtyFiles(task.worktreePath);
        task.worktreeDirtyFileCount = dirtyFiles.length;
        task.worktreeDirtyFilesSample = dirtyFiles.slice(0, 25);
      }
    }
  }

  private async enrichManagerBranchFacts(input: ManagerTurnInput): Promise<void> {
    const taskGroups = new Map<
      string,
      Array<{
        id: string;
        status: ManagerTurnInput["tasks"][number]["status"];
        updatedAt?: string;
        worktreePath?: string;
        baseBranch?: string;
      }>
    >();

    for (const task of input.tasks) {
      if (!task.branchName) {
        continue;
      }
      const group = taskGroups.get(task.branchName) ?? [];
      group.push({
        id: task.id,
        status: task.status,
        updatedAt: task.latestEventAt,
        worktreePath: task.worktreePath,
        baseBranch: task.baseBranch
      });
      taskGroups.set(task.branchName, group);
    }

    const branchNames = new Set<string>([this.config.defaultBranch, this.config.candidateBranch, ...taskGroups.keys()]);
    input.repo.branches = [];

    for (const branchName of branchNames) {
      const linkedTasks = taskGroups.get(branchName) ?? [];
      const preferredTask = [...linkedTasks].sort((left, right) =>
        (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "")
      )[0];
      const head = await currentCommit(this.config.repoRoot, branchName).catch(() => undefined);
      const baseBranch =
        preferredTask?.baseBranch ??
        (branchName !== this.config.candidateBranch && branchName !== this.config.defaultBranch
          ? this.config.candidateBranch
          : undefined);

      const branchRecord: ManagerTurnInput["repo"]["branches"][number] = {
        name: branchName,
        head,
        baseBranch,
        linkedTaskIds: linkedTasks.map((task) => task.id),
        latestTaskStatus: preferredTask?.status,
        latestTaskUpdatedAt: preferredTask?.updatedAt,
        worktreePath: preferredTask?.worktreePath
      };

      if (head && baseBranch) {
        const baseHead = await currentCommit(this.config.repoRoot, baseBranch).catch(() => undefined);
        if (baseHead) {
          branchRecord.isIntegrated = head === baseHead;
          const aheadBehind = await runCommand(
            "git",
            ["rev-list", "--left-right", "--count", `${baseBranch}...${branchName}`],
            {
              cwd: this.config.repoRoot,
              allowNonZeroExit: true
            }
          );
          if (aheadBehind.exitCode === 0) {
            const [behindText, aheadText] = aheadBehind.stdout.trim().split(/\s+/);
            branchRecord.behindBy = Number.parseInt(behindText ?? "0", 10) || 0;
            branchRecord.aheadBy = Number.parseInt(aheadText ?? "0", 10) || 0;
          }

          const mergeBase = await runCommand("git", ["merge-base", baseBranch, branchName], {
            cwd: this.config.repoRoot,
            allowNonZeroExit: true
          });
          branchRecord.canFastForwardBase =
            !branchRecord.isIntegrated &&
            mergeBase.exitCode === 0 &&
            mergeBase.stdout.trim() === baseHead;
        }
      }

      if (preferredTask?.worktreePath && (await fileExists(path.join(preferredTask.worktreePath, ".git")))) {
        const dirtyFiles = await listDirtyFiles(preferredTask.worktreePath);
        branchRecord.dirtyFileCount = dirtyFiles.length;
        branchRecord.dirtyFilesSample = dirtyFiles.slice(0, 25);
      }

      input.repo.branches.push(branchRecord);
    }
  }

  private async ensureWorkerSandboxCapabilities(): Promise<WorkerSandboxCapabilities> {
    if (this.workerSandboxCapabilities?.sandboxMode === this.config.codex.sandboxMode) {
      return this.workerSandboxCapabilities;
    }

    if (this.config.codex.sandboxMode === "danger-full-access") {
      this.workerSandboxCapabilities = {
        canBindListenSockets: true,
        sandboxMode: this.config.codex.sandboxMode
      };
      return this.workerSandboxCapabilities;
    }

    const sandboxCommand =
      process.platform === "linux"
        ? "linux"
        : process.platform === "darwin"
          ? "macos"
          : process.platform === "win32"
            ? "windows"
            : undefined;

    if (!sandboxCommand) {
      this.workerSandboxCapabilities = {
        canBindListenSockets: true,
        sandboxMode: this.config.codex.sandboxMode
      };
      return this.workerSandboxCapabilities;
    }

    const probe = await runCommand(
      "codex",
      [
        "sandbox",
        sandboxCommand,
        "--full-auto",
        "node",
        "-e",
        "require('node:http').createServer((_,res)=>res.end('ok')).listen(0,'127.0.0.1',()=>{console.log('LISTEN_OK'); process.exit(0);}).on('error',err=>{console.error(err.code || err.message); process.exit(1);})"
      ],
      {
        cwd: this.config.repoRoot,
        allowNonZeroExit: true
      }
    );
    const canBindListenSockets = probe.exitCode === 0 && /LISTEN_OK/.test(probe.stdout);
    if (!canBindListenSockets) {
      const detail = (probe.stderr || probe.stdout).trim() || `exit ${probe.exitCode}`;
      console.warn(`worker sandbox listen preflight failed: ${detail}`);
    }

    this.workerSandboxCapabilities = {
      canBindListenSockets,
      sandboxMode: this.config.codex.sandboxMode
    };
    return this.workerSandboxCapabilities;
  }

  private async reconcileStaleWorkers(): Promise<void> {
    let recoveredAny = false;
    for (const agent of this.db.listAgents(this.config.projectId)) {
      if (agent.role === "manager" || agent.status !== "running" || !agent.taskId) {
        continue;
      }

      if (this.workerChildren.has(agent.taskId)) {
        continue;
      }

      if (agent.pid && this.isProcessAlive(agent.pid)) {
        continue;
      }

      const task = this.db.getTask(agent.taskId);
      if (!task?.contract) {
        continue;
      }

      const recoveredStatus = agent.role === "review" ? "review" : "queued";
      this.db.updateTaskStatus(task.id, recoveredStatus);
      this.db.insertTaskEvent(
        task.id,
        recoveredStatus,
        agent.role === "review"
          ? "Review worker disappeared during supervisor startup recovery; manager should decide the next step"
          : "Task re-queued after worker process was missing during supervisor startup"
      );
      this.db.upsertAgent({
        id: agent.id,
        projectId: agent.projectId,
        role: agent.role,
        status: "failed",
        taskId: agent.taskId,
        branch: agent.branch,
        worktreePath: agent.worktreePath,
        threadId: agent.threadId,
        turnId: agent.turnId,
        metadata: agent.metadata
      });
      recoveredAny = true;
    }

    if (recoveredAny) {
      this.pendingManagerWakeReasons.add("worker_recovered");
    }
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private async applyManagerOutput(
    output: ManagerTurnOutput,
    wakeReasons: string[],
    _hasDirectUserMessage: boolean
  ): Promise<void> {
    console.log(`[manager] ${output.summary}`);
    if (wakeReasons.length > 0) {
      console.log(`[manager] wake reasons: ${wakeReasons.join(", ")}`);
    }
    const toolCalls = this.activeManagerTurnId
      ? this.db.listManagerToolCallsByTurn(this.config.projectId, this.activeManagerTurnId)
      : [];
    const actionPreview = this.buildManagerActionPreviewFromToolCalls(toolCalls);
    const mismatchHints = this.computeManagerTurnMismatchHints(output.summary, actionPreview);
    this.db.insertManagerTurn({
      projectId: this.config.projectId,
      turnId: this.activeManagerTurnId,
      summary: output.summary,
      wakeReasons,
      actionCounts: this.buildManagerActionCounts(actionPreview),
      actionPreview,
      mismatchHints,
      toolCalls: this.buildManagerToolCallPreview(toolCalls),
      rawOutput: JSON.parse(JSON.stringify(output)) as Record<string, unknown>
    });
  }

  private buildManagerActionPreviewFromToolCalls(
    toolCalls: ManagerToolCallRecord[]
  ): ManagerTurnInput["recentManagerTurns"][number]["actionPreview"] {
    const preview: ManagerTurnInput["recentManagerTurns"][number]["actionPreview"] = {
      tasksToStart: [],
      tasksToCancel: [],
      reviewsToStart: [],
      integrations: [],
      deployments: [],
      decisions: [],
      userMessages: []
    };

    for (const call of toolCalls) {
      if (call.status !== "completed") {
        continue;
      }

      const args = call.args ?? {};
      switch (call.toolName) {
        case "start_task":
          if (typeof args.id === "string" && typeof args.branchName === "string") {
            preview.tasksToStart.push(`${args.id}:${args.branchName}`);
          }
          break;
        case "cancel_task":
          if (typeof args.taskId === "string") {
            preview.tasksToCancel.push(args.taskId);
          }
          break;
        case "start_review":
          if (typeof args.branch === "string" && typeof args.baseBranch === "string") {
            preview.reviewsToStart.push(`${args.branch}->${args.baseBranch}`);
          }
          break;
        case "integrate_branch":
          if (typeof args.branch === "string") {
            preview.integrations.push(`${args.branch}->${typeof args.targetBranch === "string" ? args.targetBranch : "default"}`);
          } else if (typeof args.taskId === "string") {
            preview.integrations.push(`${args.taskId}->${typeof args.targetBranch === "string" ? args.targetBranch : "default"}`);
          }
          break;
        case "apply_deployment":
          if (typeof args.kind === "string") {
            preview.deployments.push(args.kind);
          }
          break;
        case "request_decision":
          if (
            call.result?.outcome === "created" &&
            typeof args.id === "string" &&
            typeof args.title === "string"
          ) {
            preview.decisions.push(`${args.id}:${args.title}`);
          }
          break;
        case "reply_user":
          if (
            call.result?.delivered === true &&
            typeof args.kind === "string" &&
            typeof args.text === "string"
          ) {
            preview.userMessages.push(`${args.kind}:${args.text.slice(0, 80)}`);
          }
          break;
        case "get_factory_status":
          break;
      }
    }

    return preview;
  }

  private buildManagerActionCounts(
    actionPreview: ManagerTurnInput["recentManagerTurns"][number]["actionPreview"]
  ): ManagerTurnInput["recentManagerTurns"][number]["actionCounts"] {
    return {
      tasksToStart: actionPreview.tasksToStart.length,
      tasksToCancel: actionPreview.tasksToCancel.length,
      reviewsToStart: actionPreview.reviewsToStart.length,
      integrations: actionPreview.integrations.length,
      deployments: actionPreview.deployments.length,
      decisions: actionPreview.decisions.length,
      userMessages: actionPreview.userMessages.length
    };
  }

  private buildManagerToolCallPreview(toolCalls: ManagerToolCallRecord[]): string[] {
    return toolCalls.map((call) => this.summarizeManagerToolCall(call));
  }

  private summarizeManagerToolCall(call: ManagerToolCallRecord): string {
    const args = call.args ?? {};
    let subject = "";
    switch (call.toolName) {
      case "start_task":
        if (typeof args.id === "string" && typeof args.branchName === "string") {
          subject = `:${args.id}:${args.branchName}`;
        }
        break;
      case "cancel_task":
        if (typeof args.taskId === "string") {
          subject = `:${args.taskId}`;
        }
        break;
      case "start_review":
        if (typeof args.branch === "string" && typeof args.baseBranch === "string") {
          subject = `:${args.branch}->${args.baseBranch}`;
        }
        break;
      case "integrate_branch":
        if (typeof args.branch === "string") {
          subject = `:${args.branch}->${typeof args.targetBranch === "string" ? args.targetBranch : "default"}`;
        } else if (typeof args.taskId === "string") {
          subject = `:${args.taskId}->${typeof args.targetBranch === "string" ? args.targetBranch : "default"}`;
        }
        break;
      case "apply_deployment":
        if (typeof args.kind === "string") {
          subject = `:${args.kind}`;
        }
        break;
      case "request_decision":
        if (typeof args.id === "string" && typeof args.title === "string") {
          subject = `:${args.id}:${args.title}`;
        }
        break;
      case "reply_user":
        if (typeof args.kind === "string") {
          subject = `:${args.kind}`;
        }
        break;
      case "get_factory_status":
        break;
    }

    const suffix = call.errorText ? `:${call.errorText.slice(0, 80)}` : "";
    return `${call.status}:${call.toolName}${subject}${suffix}`;
  }

  private computeManagerTurnMismatchHints(
    summary: string,
    actionPreview: ManagerTurnInput["recentManagerTurns"][number]["actionPreview"]
  ): string[] {
    const hints: string[] = [];
    if (
      /(queued|started|requested).{0,24}review|review.{0,24}(queued|started|requested)/i.test(summary) &&
      actionPreview.reviewsToStart.length === 0
    ) {
      hints.push("summary_mentions_review_without_review_action");
    }
    if (
      /(integrat|merge|fast-forward)/i.test(summary) &&
      actionPreview.integrations.length === 0
    ) {
      hints.push("summary_mentions_integration_without_integration_action");
    }
    if (
      /(deploy|rollback|promot|ship|preview update)/i.test(summary) &&
      actionPreview.deployments.length === 0
    ) {
      hints.push("summary_mentions_deployment_without_deployment_action");
    }
    if (
      /(started|queued).{0,24}(task|worker|coding|cleanup|recovery)|\bstarted a fresh\b/i.test(summary) &&
      actionPreview.tasksToStart.length === 0 &&
      actionPreview.reviewsToStart.length === 0
    ) {
      hints.push("summary_mentions_started_work_without_start_action");
    }
    if (/\bcancel/i.test(summary) && actionPreview.tasksToCancel.length === 0) {
      hints.push("summary_mentions_cancel_without_cancel_action");
    }
    return hints;
  }

  private async executeManagerToolCall(
    request: ManagerToolHttpRequest
  ): Promise<ManagerToolHttpResponse> {
    if (!this.activeManagerTurnId || !this.activeManagerThreadId) {
      return { ok: false, error: "manager tools require an active manager turn" };
    }

    const existing = this.db.getManagerToolCall(
      this.config.projectId,
      request.requestId,
      request.toolName
    );
    if (existing?.status === "completed") {
      return { ok: true, cached: true, result: existing.result ?? {} };
    }
    if (existing?.status === "failed") {
      return { ok: false, cached: true, error: existing.errorText ?? "cached tool call failure" };
    }
    if (existing?.status === "running") {
      return { ok: false, cached: true, error: "manager tool call is already running" };
    }

    this.db.recordManagerToolCallStart({
      projectId: this.config.projectId,
      threadId: this.activeManagerThreadId,
      turnId: this.activeManagerTurnId,
      requestId: request.requestId,
      toolName: request.toolName,
      args: request.args
    });

    try {
      const result = await this.dispatchManagerToolCall(request.toolName, request.args);
      this.db.finishManagerToolCall({
        projectId: this.config.projectId,
        requestId: request.requestId,
        toolName: request.toolName,
        status: "completed",
        result
      });
      return { ok: true, cached: false, result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.db.finishManagerToolCall({
        projectId: this.config.projectId,
        requestId: request.requestId,
        toolName: request.toolName,
        status: "failed",
        errorText: message
      });
      return { ok: false, cached: false, error: message };
    }
  }

  private async dispatchManagerToolCall(
    toolName: ManagerToolName,
    args: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    switch (toolName) {
      case "get_factory_status": {
        const resources = await this.sampleManagerResources();
        const snapshot = await this.buildManagerInput(resources);
        return { snapshot: JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown> };
      }
      case "start_task": {
        const contract = args as unknown as TaskContract;
        await this.materializeAndStartTask(contract);
        const task = this.db.getTask(contract.id);
        return {
          taskId: contract.id,
          status: task?.status ?? "queued",
          branchName: contract.branchName,
          worktreePath: contract.worktreePath
        };
      }
      case "cancel_task": {
        const taskId = this.requireStringArg(args, "taskId");
        await this.cancelTask(taskId);
        return {
          taskId,
          status: this.db.getTask(taskId)?.status ?? "cancelled"
        };
      }
      case "start_review": {
        const review = args as unknown as ReviewRequest;
        await this.startReviewRequest(review);
        return {
          taskId: review.taskId,
          branch: review.branch,
          baseBranch: review.baseBranch
        };
      }
      case "integrate_branch": {
        const integration = args as unknown as IntegrationRequest;
        await this.integrateRequest(integration);
        const targetBranch = integration.targetBranch ?? this.config.candidateBranch;
        return {
          taskId: integration.taskId,
          branch: integration.branch,
          targetBranch,
          commit: await currentCommit(this.config.repoRoot, targetBranch).catch(() => "")
        };
      }
      case "apply_deployment": {
        const deployment = args as unknown as DeploymentIntent;
        await this.handleDeploymentIntent(deployment);
        const snapshot = this.db.getDeploymentSnapshot(this.config.projectId);
        if (deployment.kind === "deploy_preview") {
          return {
            kind: deployment.kind,
            target: "preview",
            status: snapshot.preview.status,
            url: snapshot.preview.url,
            commit: snapshot.preview.commit
          };
        }
        return {
          kind: deployment.kind,
          target: "stable",
          status: snapshot.stable.status,
          url: snapshot.stable.url,
          commit: snapshot.stable.commit
        };
      }
      case "request_decision": {
        const decision = args as unknown as DecisionRequest;
        return await this.maybeCreateDecision(decision);
      }
      case "reply_user": {
        const kind = this.requireStringArg(args, "kind");
        const text = this.requireStringArg(args, "text");
        const replyToMessageId =
          (typeof args.replyToMessageId === "string" ? args.replyToMessageId : undefined) ??
          this.activeManagerReplyToMessageId;
        const decisionId = typeof args.decisionId === "string" ? args.decisionId : undefined;
        const delivered = await this.sendTelegramMessage(
          kind,
          text,
          replyToMessageId,
          decisionId,
          undefined,
          {
            isDirectUserResponse: kind === "info_update" && this.activeManagerHasDirectUserMessage
          }
        );
        return {
          kind,
          delivered,
          replyToMessageId
        };
      }
    }

    throw new Error(`Unknown manager tool: ${String(toolName)}`);
  }

  private requireStringArg(args: Record<string, unknown>, key: string): string {
    const value = args[key];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`Missing required string argument: ${key}`);
    }
    return value;
  }

  private async readJsonRequestBody(request: http.IncomingMessage): Promise<Record<string, unknown>> {
    const body = await new Promise<string>((resolve, reject) => {
      let chunks = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        chunks += chunk;
      });
      request.on("end", () => resolve(chunks));
      request.on("error", reject);
    });
    return JSON.parse(body) as Record<string, unknown>;
  }

  private parseManagerToolHttpRequest(body: Record<string, unknown>): ManagerToolHttpRequest {
    const requestId = body.requestId;
    const toolName = body.toolName;
    const args = body.args;
    if (typeof requestId !== "string" || requestId.length === 0) {
      throw new Error("manager tool request missing requestId");
    }
    if (typeof toolName !== "string" || toolName.length === 0) {
      throw new Error("manager tool request missing toolName");
    }
    if (!MANAGER_TOOL_NAMES.has(toolName as ManagerToolName)) {
      throw new Error(`unknown manager tool: ${toolName}`);
    }
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      throw new Error("manager tool request missing args object");
    }
    return {
      requestId,
      toolName: toolName as ManagerToolName,
      args: args as Record<string, unknown>
    };
  }

  private async maybeCreateDecision(
    decision: DecisionRequest
  ): Promise<Record<string, unknown>> {
    const budget = this.db.getDecisionBudget(
      this.config.projectId,
      this.config.timezone,
      this.config.decisionBudget.dailyLimit,
      this.config.decisionBudget.reserveCritical
    );
    if (this.db.findOpenDecisionByDedupe(this.config.projectId, decision.dedupeKey)) {
      return { outcome: "duplicate_open_decision", decisionId: decision.id };
    }

    if (budget.remaining <= 0) {
      return { outcome: "budget_exhausted", decisionId: decision.id };
    }

    if (decision.priority !== "critical" && budget.remainingNormal <= 0) {
      return { outcome: "critical_reserve_only", decisionId: decision.id };
    }

    this.db.insertDecision(this.config.projectId, decision);
    this.db.incrementDecisionBudget(this.config.projectId, this.config.timezone);

    const keyboard = decision.options.map((option) => [
      {
        text: option.label,
        callback_data: `decision:${decision.id}:${option.id}`
      }
    ]);

    await this.sendTelegramMessage(
      "decision_required",
      `${decision.title}\n\n${decision.reason}\n\nDefault: ${decision.defaultOptionId}\nExpires: ${decision.expiresAt}`,
      undefined,
      decision.id,
      keyboard
    );
    return { outcome: "created", decisionId: decision.id };
  }

  private async sendTelegramMessage(
    kind: string,
    text: string,
    replyToMessageId?: string,
    decisionId?: string,
    inlineKeyboard?: Array<Array<{ text: string; callback_data: string }>>,
    options: { isDirectUserResponse?: boolean } = {}
  ): Promise<boolean> {
    if (!shouldDeliverTelegramNotification(kind, options)) {
      console.log(`[telegram:suppressed:${kind}] ${text}`);
      return false;
    }

    const messageId = randomId("telegram");
    const chatId = this.config.telegram.controlChatId;
    const botToken = process.env[this.config.telegram.botTokenEnvVar];

    this.db.insertTelegramMessage({
      id: messageId,
      projectId: this.config.projectId,
      chatId,
      direction: "outbound",
      kind,
      text,
      replyToMessageId,
      decisionId
    });

    if (!chatId || !botToken) {
      console.log(`[telegram:${kind}] ${text}`);
      return true;
    }

    try {
      await sendTelegramApiRequest(botToken, "sendMessage", {
        chat_id: chatId,
        text,
        reply_to_message_id: replyToMessageId ? Number.parseInt(replyToMessageId, 10) : undefined,
        reply_markup: inlineKeyboard ? { inline_keyboard: inlineKeyboard } : undefined
      });
      return true;
    } catch (error) {
      console.error(`telegram send failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  private async cancelTask(taskId: string): Promise<void> {
    const task = this.db.getTask(taskId);
    if (!task) {
      return;
    }

    const agent = this.db.listAgents(this.config.projectId).find((candidate) => candidate.taskId === taskId);
    if (agent?.pid) {
      try {
        process.kill(agent.pid, "SIGINT");
      } catch {
        // Ignore already-dead children.
      }
    }

    this.db.updateTaskStatus(taskId, "cancelled");
    this.db.insertTaskEvent(taskId, "cancelled", "Task cancelled by manager");
  }

  private async materializeAndStartTask(contract: TaskContract): Promise<void> {
    const branchName = contract.branchName || `agent/${slugify(contract.id)}`;
    const worktreePath = contract.worktreePath || path.join(this.paths.worktreesDir, contract.id);
    const normalized: TaskContract = {
      ...contract,
      branchName,
      worktreePath,
      baseBranch: contract.baseBranch || this.config.candidateBranch,
      ports: contract.ports ?? {}
    };
    const openDecisionIds = new Set(
      this.db.listOpenDecisions(this.config.projectId).map((decision) => decision.id)
    );
    const unresolvedBlockingDecisions = normalized.context.blockingDecisions.filter((decisionId) =>
      openDecisionIds.has(decisionId)
    );
    const initialStatus = unresolvedBlockingDecisions.length > 0 ? "blocked" : "queued";

    if (this.config.bootstrap.status === "waiting_for_first_task") {
      await this.persistBootstrapStatus("baselining_repo");
    }

    this.db.upsertTask({
      projectId: this.config.projectId,
      id: normalized.id,
      kind: normalized.kind,
      status: initialStatus,
      title: normalized.title,
      priority: "medium",
      goal: normalized.goal,
      branchName: normalized.branchName,
      baseBranch: normalized.baseBranch,
      worktreePath: normalized.worktreePath,
      contract: normalized,
      blockedByDecisionIds: unresolvedBlockingDecisions
    });

    if (unresolvedBlockingDecisions.length > 0) {
      this.db.insertTaskEvent(
        normalized.id,
        "blocked",
        `Task blocked pending decision(s): ${unresolvedBlockingDecisions.join(", ")}`
      );
      return;
    }
  }

  private async reconcileCompletedTaskBranches(): Promise<void> {
    for (const task of this.db.listTasks(this.config.projectId)) {
      if (!task.contract || !["done", "review"].includes(task.status) || !task.worktreePath) {
        continue;
      }

      if (!(await fileExists(path.join(task.worktreePath, ".git")))) {
        continue;
      }

      const committedBranchHead = await this.commitTaskWorktree(task.contract);
      if (!committedBranchHead) {
        continue;
      }

      this.db.insertTaskEvent(
        task.id,
        "committed",
        `Recovered task branch commit at ${committedBranchHead.slice(0, 12)}`,
        { commit: committedBranchHead }
      );
      this.pendingManagerWakeReasons.add("task_branch_committed");
    }
  }

  private findTaskByBranch(branchName: string): ReturnType<FactoryDatabase["getTask"]> {
    return this.db.listTasks(this.config.projectId).find((task) => task.branchName === branchName);
  }

  private async startReviewRequest(review: ReviewRequest): Promise<void> {
    const task =
      (review.taskId ? this.db.getTask(review.taskId) : undefined) ?? this.findTaskByBranch(review.branch);
    if (!task?.contract) {
      throw new Error(
        `Cannot start review for unknown branch target ${review.taskId ?? review.branch ?? "unknown"}`
      );
    }

    if (
      this.db
        .listAgents(this.config.projectId)
        .some((agent) => agent.taskId === task.id && agent.status === "running")
    ) {
      return;
    }

    if (review.commit) {
      const currentBranchHead = await currentCommit(this.config.repoRoot, review.branch).catch(() => undefined);
      if (!currentBranchHead || currentBranchHead !== review.commit) {
        throw new Error(
          `Review request for ${review.branch} expected ${review.commit.slice(0, 12)} but found ${currentBranchHead?.slice(0, 12) ?? "missing"}`
        );
      }
    }

    const reviewTask: TaskContract = {
      ...task.contract,
      id: task.id,
      title: `Review ${task.title}`,
      goal: review.reason,
      baseBranch: review.baseBranch || task.baseBranch || task.contract.baseBranch,
      branchName: review.branch || task.branchName || task.contract.branchName,
      worktreePath: review.worktreePath || task.worktreePath || task.contract.worktreePath,
      needsPreview: false,
      ports: {},
      runtime: { maxRuntimeMinutes: 30, reasoningEffort: "medium" },
      constraints: {
        ...task.contract.constraints,
        mustRunChecks: []
      }
    };
    await this.startWorker(reviewTask, "review");
  }

  private async commitTaskWorktree(
    contract: Pick<TaskContract, "id" | "title" | "branchName" | "worktreePath">,
    recommendedCommitMessage?: string,
    summary?: string
  ): Promise<string | undefined> {
    const relevantChanges = await this.listRelevantWorktreeChanges(contract.worktreePath);
    if (relevantChanges.length === 0) {
      return undefined;
    }

    await runCommand("git", ["add", "-A", "--", "."], {
      cwd: contract.worktreePath
    });
    await runCommand("git", ["reset", "--", ".factory.env"], {
      cwd: contract.worktreePath,
      allowNonZeroExit: true
    });

    const stagedChanges = await this.listRelevantWorktreeChanges(contract.worktreePath);
    if (stagedChanges.length === 0) {
      return undefined;
    }

    const firstLine =
      recommendedCommitMessage?.trim().split(/\r?\n/, 1)[0] ??
      summary?.trim().split(/\r?\n/, 1)[0] ??
      `Complete ${contract.title}`;
    const commitMessage = firstLine.slice(0, 120) || `Complete ${contract.id}`;
    const commit = await runCommand("git", ["commit", "-m", commitMessage, "--no-verify"], {
      cwd: contract.worktreePath,
      allowNonZeroExit: true
    });
    if (commit.exitCode !== 0 && !/nothing to commit/i.test(commit.stderr + commit.stdout)) {
      throw new Error(`Failed to commit ${contract.branchName}: ${(commit.stderr || commit.stdout).trim()}`);
    }

    await this.refreshDetectedScriptsFromWorktree(contract.worktreePath);
    return await currentCommit(contract.worktreePath, "HEAD");
  }

  private async listRelevantWorktreeChanges(worktreePath: string): Promise<string[]> {
    const result = await runCommand("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd: worktreePath
    });
    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0)
      .map((line) => line.slice(3).split(" -> ").at(-1)?.trim() ?? "")
      .filter((file) => file.length > 0 && file !== ".factory.env");
  }

  private async integrateRequest(integration: IntegrationRequest): Promise<void> {
    const task =
      (integration.taskId ? this.db.getTask(integration.taskId) : undefined) ??
      (integration.branch ? this.findTaskByBranch(integration.branch) : undefined);
    if (!task?.contract || !task.branchName || !task.worktreePath) {
      throw new Error(
        `Cannot integrate unknown branch target ${integration.taskId ?? integration.branch ?? "unknown"}`
      );
    }

    const mergeTarget = integration.targetBranch ?? task.baseBranch ?? task.contract.baseBranch;
    if (!mergeTarget) {
      throw new Error(`Task ${task.id} has no merge target`);
    }

    if (integration.commit) {
      const currentBranchHead = await currentCommit(this.config.repoRoot, task.branchName).catch(() => undefined);
      if (!currentBranchHead || currentBranchHead !== integration.commit) {
        throw new Error(
          `Integration request for ${task.branchName} expected ${integration.commit.slice(0, 12)} but found ${currentBranchHead?.slice(0, 12) ?? "missing"}`
        );
      }
    }

    const committedBranchHead =
      (await this.commitTaskWorktree(task.contract, undefined, integration.reason)) ??
      (await currentCommit(this.config.repoRoot, task.branchName));
    const targetHead = await currentCommit(this.config.repoRoot, mergeTarget);
    const mergeBase = await runCommand("git", ["merge-base", mergeTarget, task.branchName], {
      cwd: this.config.repoRoot
    });
    if (mergeBase.stdout.trim() !== targetHead) {
      throw new Error(`Cannot fast-forward ${mergeTarget} to ${task.branchName}`);
    }

    await runCommand(
      "git",
      ["update-ref", `refs/heads/${mergeTarget}`, committedBranchHead],
      { cwd: this.config.repoRoot }
    );
    await this.refreshDetectedScriptsFromWorktree(task.worktreePath);
    await this.refreshProjectState();
    this.db.insertTaskEvent(
      task.id,
      "integrated",
      `Integrated ${task.branchName} into ${mergeTarget} at ${committedBranchHead.slice(0, 12)}: ${integration.reason}`,
      { targetBranch: mergeTarget, commit: committedBranchHead }
    );
    this.pendingManagerWakeReasons.add("branch_integrated");
  }

  private async startQueuedTasksIfPossible(): Promise<void> {
    const runningWorkers = this.db
      .listAgents(this.config.projectId)
      .filter((agent) => agent.role !== "manager" && agent.status === "running").length;
    const availableSlots = Math.max(0, this.config.scheduler.maxWorkers - runningWorkers);
    if (availableSlots <= 0) {
      return;
    }

    const queuedTasks = this.db
      .listTasks(this.config.projectId)
      .filter((task) => task.status === "queued" && task.contract)
      .slice(0, availableSlots);
    for (const task of queuedTasks) {
      try {
        await this.startWorker(task.contract as TaskContract, task.kind === "test" ? "test" : "code");
      } catch (error) {
        this.db.updateTaskStatus(task.id, "failed");
        this.db.insertTaskEvent(
          task.id,
          "failed",
          `Task failed to start: ${error instanceof Error ? error.message : String(error)}`
        );
        console.error(`task ${task.id} failed to start: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private async startWorker(
    contract: TaskContract,
    role: "code" | "review" | "test"
  ): Promise<void> {
    const workerSandboxCapabilities = await this.ensureWorkerSandboxCapabilities();
    const worktreeId = contract.id;
    const worktreePath = contract.worktreePath;
    const branchName = contract.branchName;
    const baseBranch = contract.baseBranch || this.config.candidateBranch;
    const reusesExistingWorktree =
      role === "review" &&
      this.db.getTask(contract.id)?.worktreePath === worktreePath &&
      (await fileExists(path.join(worktreePath, ".git")));
    const requirement = reusesExistingWorktree
      ? { app: false, e2e: false }
      : deriveEffectivePortLeaseRequirement(contract, workerSandboxCapabilities);
    const usedPorts = new Set(this.db.listActivePortLeases(this.config.projectId).map((lease) => lease.port));
    const allocatedPorts = allocatePorts(this.config, usedPorts, {
      app: requirement.app && contract.ports.app === undefined,
      e2e: requirement.e2e && contract.ports.e2e === undefined
    });
    const portAwareContract = applyWorkerSandboxCapabilities(contract, workerSandboxCapabilities);
    const normalized: TaskContract = {
      ...portAwareContract,
      ports: {
        ...(portAwareContract.ports.app !== undefined ? { app: portAwareContract.ports.app } : {}),
        ...(portAwareContract.ports.e2e !== undefined ? { e2e: portAwareContract.ports.e2e } : {}),
        ...(allocatedPorts.app !== undefined ? { app: allocatedPorts.app } : {}),
        ...(allocatedPorts.e2e !== undefined ? { e2e: allocatedPorts.e2e } : {})
      }
    };
    if (!reusesExistingWorktree) {
      await ensureDir(path.dirname(worktreePath));
      await addWorktree(this.config.repoRoot, worktreePath, branchName, baseBranch);
      const baseCommit = await currentCommit(this.config.repoRoot, baseBranch);

      this.db.insertWorktree({
        id: worktreeId,
        projectId: this.config.projectId,
        taskId: normalized.id,
        worktreePath,
        branchName,
        baseBranch,
        baseCommit,
        appPort: normalized.ports.app,
        e2ePort: normalized.ports.e2e
      });
      if (normalized.ports.app !== undefined) {
        this.db.addPortLease(this.config.projectId, worktreeId, "app", normalized.ports.app);
      }
      if (normalized.ports.e2e !== undefined) {
        this.db.addPortLease(this.config.projectId, worktreeId, "e2e", normalized.ports.e2e);
      }

      const envFilePath = path.join(worktreePath, ".factory.env");
      const envText = [
        `FACTORY_TASK_ID=${normalized.id}`,
        `FACTORY_BRANCH=${branchName}`,
        normalized.ports.app !== undefined ? `PORT=${normalized.ports.app}` : undefined,
        normalized.ports.app !== undefined ? `FACTORY_APP_PORT=${normalized.ports.app}` : undefined,
        normalized.ports.e2e !== undefined ? `FACTORY_E2E_PORT=${normalized.ports.e2e}` : undefined
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n");
      await writeText(envFilePath, `${envText}\n`);

      await runCommand("bash", [path.resolve(this.config.repoRoot, this.config.scripts.bootstrapWorktree), worktreePath], {
        cwd: this.config.repoRoot,
        env: {
          FACTORY_TASK_ID: normalized.id,
          FACTORY_BRANCH: branchName,
          ...(normalized.ports.app !== undefined
            ? { PORT: String(normalized.ports.app), FACTORY_APP_PORT: String(normalized.ports.app) }
            : {}),
          ...(normalized.ports.e2e !== undefined
            ? { FACTORY_E2E_PORT: String(normalized.ports.e2e) }
            : {})
        },
        allowNonZeroExit: true
      });
    }

    const runId = randomId("run");
    const runDir = path.join(this.paths.runsDir, runId);
    await ensureDir(runDir);
    const codexHome = process.env.CODEX_HOME;
    const jsonlLogPath = path.join(runDir, "events.jsonl");
    const finalMessagePath = path.join(runDir, "final.json");
    const stdoutFd = await open(jsonlLogPath, "a");
    const stderrFd = await open(path.join(runDir, "stderr.log"), "a");
    const prompt = await this.buildWorkerPrompt(normalized, role);
    const schemaPath =
      role === "review"
        ? this.reviewerSchemaPath
        : role === "test"
          ? this.testerSchemaPath
          : this.workerSchemaPath;

    const child = spawn(
      "codex",
      [
        "exec",
        "--json",
        "--cd",
        worktreePath,
        "--model",
        this.config.codex.model,
        "--sandbox",
        this.config.codex.sandboxMode,
        ...this.buildWorkerMcpConfigArgs(),
        "-"
      ],
      {
        cwd: this.config.repoRoot,
        env: {
          ...process.env,
          ...(codexHome ? { CODEX_HOME: codexHome } : {}),
          FACTORY_TASK_ID: normalized.id,
          FACTORY_BRANCH: branchName,
          ...(normalized.ports.app !== undefined
            ? { PORT: String(normalized.ports.app), FACTORY_APP_PORT: String(normalized.ports.app) }
            : {}),
          ...(normalized.ports.e2e !== undefined
            ? { FACTORY_E2E_PORT: String(normalized.ports.e2e) }
            : {})
        },
        stdio: ["pipe", stdoutFd.fd, stderrFd.fd]
      }
    );
    stdoutFd.close().catch(() => undefined);
    stderrFd.close().catch(() => undefined);
    child.stdin?.write(prompt);
    child.stdin?.end();

    this.workerChildren.set(normalized.id, child);
    this.db.insertRun({
      id: runId,
      projectId: this.config.projectId,
      taskId: normalized.id,
      role,
      attempt: 1,
      status: "running",
      runDirectory: runDir,
      jsonlLogPath,
      finalMessagePath,
      maxRuntimeMinutes: contract.runtime.maxRuntimeMinutes,
      pid: child.pid
    });
    this.db.upsertAgent({
      id: `agent-${normalized.id}`,
      projectId: this.config.projectId,
      role,
      status: "running",
      taskId: normalized.id,
      branch: branchName,
      worktreePath,
      pid: child.pid
    });
    if (role !== "review") {
      this.db.updateTaskStatus(normalized.id, "running");
    }
    this.db.insertTaskEvent(normalized.id, "started", `Started ${role} worker`);

    child.on("exit", async () => {
      try {
        await this.handleWorkerExit(normalized, role, runId, {
          finalMessagePath,
          jsonlLogPath
        });
      } catch (error) {
        console.error(`worker exit handling failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        this.workerChildren.delete(normalized.id);
      }
    });
  }

  private async handleWorkerExit(
    contract: TaskContract,
    role: "code" | "review" | "test",
    runId: string,
    outputPaths: { finalMessagePath: string; jsonlLogPath: string }
  ): Promise<void> {
    const schemaPath =
      role === "review"
        ? this.reviewerSchemaPath
        : role === "test"
          ? this.testerSchemaPath
          : this.workerSchemaPath;
    const raw =
      (await readText(outputPaths.finalMessagePath).catch(() => undefined)) ??
      (await this.readLastAgentMessageFromJsonl(outputPaths.jsonlLogPath)) ??
      "{}";
    const parsed = JSON.parse(raw) as unknown;
    const validated =
      role === "review"
        ? await validateWithSchema<ReviewerResult>(schemaPath, parsed)
        : role === "test"
          ? await validateWithSchema<TesterResult>(schemaPath, parsed)
          : await validateWithSchema<CodingWorkerResult>(schemaPath, parsed);

    if (!validated.valid) {
      this.db.finishRun(runId, "failed");
      this.db.updateTaskStatus(contract.id, "failed");
      this.db.insertTaskEvent(contract.id, "failed", `Schema validation failed: ${validated.errors.join("; ")}`);
      this.db.upsertAgent({
        id: `agent-${contract.id}`,
        projectId: this.config.projectId,
        role,
        status: "failed",
        taskId: contract.id,
        branch: contract.branchName,
        worktreePath: contract.worktreePath
      });
      this.pendingManagerWakeReasons.add("worker_failed");
      return;
    }

    this.db.finishRun(runId, validated.value.status);
    this.db.upsertAgent({
      id: `agent-${contract.id}`,
      projectId: this.config.projectId,
      role,
      status:
        validated.value.status === "completed"
          ? "completed"
          : validated.value.status === "blocked"
            ? "blocked"
            : "failed",
      taskId: contract.id,
      branch: contract.branchName,
      worktreePath: contract.worktreePath
    });

    let committedBranchHead: string | undefined;
    if (role === "code" && validated.value.status === "completed") {
      const result = validated.value as CodingWorkerResult;
      committedBranchHead = await this.commitTaskWorktree(
        contract,
        result.recommendedCommitMessage,
        result.summary
      );
    }

    if (role === "code") {
      const result = validated.value as CodingWorkerResult;
      const nextStatus = result.status === "completed" ? (result.needsReview ? "review" : "done") : result.status;
      this.db.updateTaskStatus(contract.id, nextStatus as never);
      this.db.insertTaskEvent(contract.id, result.status, result.summary, result);
      if (result.status === "completed" && committedBranchHead) {
        this.db.insertTaskEvent(
          contract.id,
          "committed",
          `Committed ${contract.branchName} at ${committedBranchHead.slice(0, 12)}`,
          { commit: committedBranchHead }
        );
      }
    } else if (role === "review") {
      const result = validated.value as ReviewerResult;
      const nextStatus =
        result.status !== "completed"
          ? result.status
          : result.recommendedAction === "merge"
            ? "done"
            : "failed";
      this.db.updateTaskStatus(contract.id, nextStatus as never);
      const reviewSummary =
        result.status === "completed"
          ? `Review ${result.recommendedAction}: ${result.summary}`
          : result.summary;
      this.db.insertTaskEvent(contract.id, result.status, reviewSummary, result);
    } else {
      const result = validated.value as TesterResult;
      this.db.updateTaskStatus(contract.id, result.status === "completed" ? "done" : (result.status as never));
      this.db.insertTaskEvent(contract.id, result.status, result.summary, result);
    }

    this.pendingManagerWakeReasons.add("worker_terminal");
  }

  private async readLastAgentMessageFromJsonl(jsonlLogPath: string): Promise<string | undefined> {
    const raw = await readText(jsonlLogPath).catch(() => undefined);
    if (!raw) {
      return undefined;
    }

    const lines = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index];
      if (!line) {
        continue;
      }

      try {
        const event = JSON.parse(line) as {
          type?: string;
          item?: { type?: string; text?: string };
        };
        if (event.type === "item.completed" && event.item?.type === "agent_message" && event.item.text) {
          return event.item.text;
        }
      } catch {
        // Ignore non-JSON log lines emitted alongside JSONL events.
      }
    }

    return undefined;
  }

  private async handleDeploymentIntent(
    intent: DeploymentIntent
  ): Promise<void> {
    if (intent.kind === "deploy_preview") {
      const commit = intent.commit ?? (await currentCommit(this.config.repoRoot, this.config.candidateBranch));
      await this.deployPreview(commit, intent.reason);
      return;
    }

    if (intent.kind === "promote_candidate") {
      const commit = intent.commit ?? (await currentCommit(this.config.repoRoot, this.config.candidateBranch));
      await this.promoteCandidate(commit, intent.reason);
      return;
    }

    const rollbackState = this.db.getDeploymentSnapshot(this.config.projectId).stable;
    if (!intent.commit && !intent.rollbackTag && !rollbackState.canRollback) {
      console.log("[manager] skipped rollback_stable: no rollback target is currently available");
      return;
    }

    const commit = await this.resolveRollbackCommit(intent.rollbackTag, intent.commit);
    await this.rollbackStable(commit, intent.reason, intent.rollbackTag);
  }

  private async reconcileRuntimeTargets(appearsGreenfield: boolean): Promise<void> {
    const snapshot = this.db.getDeploymentSnapshot(this.config.projectId);
    const stableUrl = await this.resolveStableUrl();
    const previewUrl = await this.resolvePreviewUrl();
    if (appearsGreenfield) {
      if (snapshot.stable.status !== "down" || snapshot.stable.reason !== "stable runtime deferred until repo has runnable app files") {
        this.db.recordDeployment({
          projectId: this.config.projectId,
          target: "stable",
          status: "down",
          url: stableUrl,
          commit: snapshot.stable.commit,
          activeSlot: snapshot.stable.activeSlot,
          reason: "stable runtime deferred until repo has runnable app files"
        });
      }
      if (snapshot.preview.status !== "down" || snapshot.preview.reason !== "preview runtime deferred until repo has runnable app files") {
        this.db.recordDeployment({
          projectId: this.config.projectId,
          target: "preview",
          status: "down",
          url: previewUrl,
          commit: snapshot.preview.commit,
          reason: "preview runtime deferred until repo has runnable app files"
        });
      }
      return;
    }

    if (snapshot.stable.commit) {
      await this.ensureStableProxyServer();
      const activeSlot = snapshot.stable.activeSlot;
      const activePort = this.runtimeSlotPort(activeSlot);
      const stableScript = this.config.scripts.serveStable;
      if (isPlaceholderScript(stableScript)) {
        if (snapshot.stable.status !== "down") {
          this.db.recordDeployment({
            projectId: this.config.projectId,
            target: "stable",
            status: "down",
            url: stableUrl,
            commit: snapshot.stable.commit,
            activeSlot,
            reason: "stable serve script not configured"
          });
        }
      } else if (!(await this.ensureRuntimeProcess(activeSlot, snapshot.stable.commit, stableScript, activePort))) {
        this.db.recordDeployment({
          projectId: this.config.projectId,
          target: "stable",
          status: "down",
          url: stableUrl,
          commit: snapshot.stable.commit,
          activeSlot,
          reason: "stable slot failed healthcheck"
        });
      }
    } else {
      await this.bootstrapStableRuntime();
    }

    if (snapshot.preview.commit) {
      const previewScript = this.config.scripts.servePreview;
      if (isPlaceholderScript(previewScript)) {
        if (snapshot.preview.status !== "down") {
          this.db.recordDeployment({
            projectId: this.config.projectId,
            target: "preview",
            status: "down",
            url: previewUrl,
            commit: snapshot.preview.commit,
            reason: "preview serve script not configured"
          });
        }
      } else if (
        !(await this.ensureRuntimeProcess(
          "preview",
          snapshot.preview.commit,
          previewScript,
          this.config.ports.preview
        ))
      ) {
        this.db.recordDeployment({
          projectId: this.config.projectId,
          target: "preview",
          status: "down",
          url: previewUrl,
          commit: snapshot.preview.commit,
          reason: "preview slot failed healthcheck"
        });
      }
    }
  }

  private async bootstrapStableRuntime(): Promise<void> {
    const serveScript = this.config.scripts.serveStable;
    if (isPlaceholderScript(serveScript)) {
      return;
    }

    const commit = await currentCommit(this.config.repoRoot, this.config.defaultBranch);
    const success = await this.ensureRuntimeProcess(
      "stable-a",
      commit,
      serveScript,
      this.config.ports.stableA
    );
    await this.ensureStableProxyServer();
    const stableUrl = await this.resolveStableUrl();
    this.db.recordDeployment({
      projectId: this.config.projectId,
      target: "stable",
      status: success ? "healthy" : "down",
      url: stableUrl,
      commit,
      activeSlot: "stable-a",
      reason: success ? "bootstrap stable runtime" : "bootstrap stable runtime failed"
    });
  }

  private async deployPreview(commit: string, reason: string): Promise<void> {
    const script = this.config.scripts.servePreview;
    if (isPlaceholderScript(script)) {
      throw new Error("Preview serve script is not configured");
    }

    const success = await this.ensureRuntimeProcess(
      "preview",
      commit,
      script,
      this.config.ports.preview
    );
    const previewUrl = await this.resolvePreviewUrl();
    this.db.recordDeployment({
      projectId: this.config.projectId,
      target: "preview",
      status: success ? "healthy" : "down",
      url: previewUrl,
      commit,
      reason
    });
    await this.sendTelegramMessage(
      success ? "info_update" : "incident_alert",
      success
        ? `Preview updated: ${previewUrl}\nCommit: ${commit.slice(0, 12)}\n${reason}`
        : `Preview deployment failed for ${commit.slice(0, 12)}.\nExpected URL: ${previewUrl}\n${reason}`
    );
  }

  private async promoteCandidate(commit: string, reason: string): Promise<void> {
    const serveScript = this.config.scripts.serveStable;
    if (isPlaceholderScript(serveScript)) {
      throw new Error("Stable serve script is not configured");
    }

    const currentStable = this.db.getDeploymentSnapshot(this.config.projectId).stable;
    const nextSlot: RuntimeSlotName = currentStable.activeSlot === "stable-a" ? "stable-b" : "stable-a";
    const success = await this.ensureRuntimeProcess(
      nextSlot,
      commit,
      serveScript,
      this.runtimeSlotPort(nextSlot)
    );
    const stableUrl = await this.resolveStableUrl();
    this.db.recordDeployment({
      projectId: this.config.projectId,
      target: "stable",
      status: success ? "healthy" : "down",
      url: stableUrl,
      commit,
      activeSlot: nextSlot,
      reason
    });
    if (!success) {
      await this.sendTelegramMessage(
        "incident_alert",
        `Stable promotion failed for ${commit.slice(0, 12)}.\nExpected URL: ${stableUrl}\n${reason}`
      );
      return;
    }

    await this.ensureStableProxyServer();
    const tag = `stable-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    this.db.insertReleaseTag(this.config.projectId, tag, commit);
    await this.sendTelegramMessage(
      "ship_result",
      `Stable is live: ${stableUrl}\nCommit: ${commit.slice(0, 12)} (${nextSlot})\n${reason}`
    );
  }

  private async rollbackStable(
    commit: string,
    reason: string,
    rollbackTag?: string
  ): Promise<void> {
    const serveScript = this.config.scripts.serveStable;
    if (isPlaceholderScript(serveScript)) {
      throw new Error("Stable serve script is not configured");
    }

    const currentStable = this.db.getDeploymentSnapshot(this.config.projectId).stable;
    const nextSlot: RuntimeSlotName = currentStable.activeSlot === "stable-a" ? "stable-b" : "stable-a";
    const success = await this.ensureRuntimeProcess(
      nextSlot,
      commit,
      serveScript,
      this.runtimeSlotPort(nextSlot)
    );
    const stableUrl = await this.resolveStableUrl();
    this.db.recordDeployment({
      projectId: this.config.projectId,
      target: "stable",
      status: success ? "healthy" : "down",
      url: stableUrl,
      commit,
      activeSlot: nextSlot,
      reason: rollbackTag ? `${reason} (${rollbackTag})` : reason
    });
    await this.sendTelegramMessage(
      success ? "ship_result" : "incident_alert",
      success
        ? `Stable rolled back: ${stableUrl}\nCommit: ${commit.slice(0, 12)} (${nextSlot})\n${reason}`
        : `Stable rollback failed for ${commit.slice(0, 12)}.\nExpected URL: ${stableUrl}\n${reason}`
    );
  }

  private async resolveRollbackCommit(
    rollbackTag?: string,
    explicitCommit?: string
  ): Promise<string> {
    if (explicitCommit) {
      return explicitCommit;
    }

    if (rollbackTag) {
      const tag = this.db.getReleaseTag(this.config.projectId, rollbackTag);
      if (!tag) {
        throw new Error(`Unknown rollback tag: ${rollbackTag}`);
      }
      return tag.commit;
    }

    const deployments = this.db.listDeployments(this.config.projectId, "stable", 10);
    const currentCommit = deployments[0]?.commit;
    const previous = deployments.find(
      (deployment) => deployment.status === "healthy" && deployment.commit && deployment.commit !== currentCommit
    );
    if (!previous) {
      throw new Error("No previous healthy stable deployment is available for rollback");
    }

    return previous.commit;
  }

  private async ensureRuntimeProcess(
    slot: RuntimeSlotName,
    commit: string,
    script: string,
    port: number
  ): Promise<boolean> {
    const worktreePath = this.runtimeSlotWorktreePath(slot);
    const existing = this.runtimeProcesses.get(slot);
    if (
      existing &&
      existing.child.exitCode === null &&
      existing.commit === commit &&
      existing.script === script
    ) {
      try {
        await this.runRuntimeHealthcheck(worktreePath, port);
        return true;
      } catch {
        await this.stopRuntimeProcess(slot);
      }
    }

    await this.stopRuntimeProcess(slot);
    await ensureDir(path.dirname(worktreePath));
    await ensureDetachedWorktreeAtRef(this.config.repoRoot, worktreePath, commit);
    await runCommand(
      "bash",
      [path.resolve(this.config.repoRoot, this.config.scripts.bootstrapWorktree), worktreePath],
      {
        cwd: this.config.repoRoot,
        env: this.buildRuntimeEnvironment(port),
        allowNonZeroExit: true
      }
    );

    const stdoutPath = path.join(this.paths.logsDir, `${slot}.out.log`);
    const stderrPath = path.join(this.paths.logsDir, `${slot}.err.log`);
    const started = await spawnLoggedShellCommand({
      script,
      cwd: worktreePath,
      env: this.buildRuntimeEnvironment(port),
      stdoutPath,
      stderrPath
    });
    this.runtimeProcesses.set(slot, {
      child: started.child,
      commit,
      worktreePath,
      port,
      script
    });
    started.child.on("exit", () => {
      const current = this.runtimeProcesses.get(slot);
      if (current?.child.pid === started.child.pid) {
        this.runtimeProcesses.delete(slot);
      }
    });

    try {
      await this.runRuntimeHealthcheck(worktreePath, port);
      return true;
    } catch (error) {
      await this.stopRuntimeProcess(slot);
      console.error(`${slot} healthcheck failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  private async stopRuntimeProcess(slot: RuntimeSlotName): Promise<void> {
    const existing = this.runtimeProcesses.get(slot);
    if (!existing) {
      return;
    }

    this.runtimeProcesses.delete(slot);
    try {
      existing.child.kill("SIGTERM");
    } catch {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
    if (existing.child.exitCode === null) {
      try {
        existing.child.kill("SIGKILL");
      } catch {
        // Ignore already-dead children.
      }
    }
  }

  private runtimeSlotWorktreePath(slot: RuntimeSlotName): string {
    return path.join(this.paths.runtimeDir, slot);
  }

  private runtimeSlotPort(slot: RuntimeSlotName): number {
    if (slot === "stable-a") {
      return this.config.ports.stableA;
    }
    if (slot === "stable-b") {
      return this.config.ports.stableB;
    }
    return this.config.ports.preview;
  }

  private buildRuntimeEnvironment(port: number): NodeJS.ProcessEnv {
    return {
      ...process.env,
      PORT: String(port),
      FACTORY_APP_PORT: String(port)
    };
  }

  private async runRuntimeHealthcheck(worktreePath: string, port: number): Promise<void> {
    await waitForSuccessfulCommand(this.config.scripts.healthcheck, {
      cwd: worktreePath,
      env: this.buildRuntimeEnvironment(port),
      timeoutMs: 60_000,
      intervalMs: 2_000
    });
  }

  private async ensureStableProxyServer(): Promise<void> {
    if (this.stableProxyServer) {
      return;
    }

    this.stableProxyServer = http.createServer((request, response) => {
      void this.proxyStableHttp(request, response);
    });
    this.stableProxyServer.on("upgrade", (request, socket, head) => {
      void this.proxyStableUpgrade(request, socket, head);
    });

    await new Promise<void>((resolve, reject) => {
      this.stableProxyServer?.once("error", reject);
      this.stableProxyServer?.listen(this.config.ports.stableProxy, "127.0.0.1", () => {
        this.stableProxyServer?.off("error", reject);
        resolve();
      });
    });
  }

  private async resolveStableUrl(): Promise<string> {
    return await resolveReachableHttpUrl(this.config.ports.stableProxy);
  }

  private async resolvePreviewUrl(): Promise<string> {
    return await resolveReachableHttpUrl(this.config.ports.preview);
  }

  private async proxyStableHttp(
    request: http.IncomingMessage,
    response: http.ServerResponse
  ): Promise<void> {
    const target = this.getStableProxyTarget();
    if (!target) {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "stable_unavailable" }));
      return;
    }

    const proxyRequest = http.request(
      {
        host: "127.0.0.1",
        port: target.port,
        method: request.method,
        path: request.url,
        headers: {
          ...request.headers,
          host: `127.0.0.1:${target.port}`
        }
      },
      (proxyResponse) => {
        response.writeHead(proxyResponse.statusCode ?? 502, proxyResponse.headers);
        proxyResponse.pipe(response);
      }
    );

    proxyRequest.on("error", (error) => {
      if (!response.headersSent) {
        response.writeHead(502, { "content-type": "application/json" });
      }
      response.end(
        JSON.stringify({ error: "stable_proxy_error", detail: error instanceof Error ? error.message : String(error) })
      );
    });

    request.pipe(proxyRequest);
  }

  private async proxyStableUpgrade(
    request: http.IncomingMessage,
    socket: Duplex,
    head: Buffer
  ): Promise<void> {
    const target = this.getStableProxyTarget();
    if (!target) {
      socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    const upstream = net.connect(target.port, "127.0.0.1", () => {
      const headers = Object.entries(request.headers)
        .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : (value ?? "")}`)
        .join("\r\n");
      upstream.write(
        `${request.method ?? "GET"} ${request.url ?? "/"} HTTP/${request.httpVersion}\r\n${headers}\r\n\r\n`
      );
      if (head.length > 0) {
        upstream.write(head);
      }
      upstream.pipe(socket);
      socket.pipe(upstream);
    });

    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  }

  private getStableProxyTarget(): { slot: "stable-a" | "stable-b"; port: number } | undefined {
    const snapshot = this.db.getDeploymentSnapshot(this.config.projectId).stable;
    if (!snapshot.commit || snapshot.status === "down") {
      return undefined;
    }

    return {
      slot: snapshot.activeSlot,
      port: this.runtimeSlotPort(snapshot.activeSlot)
    };
  }

  private async maybeSendDailyDigest(resources: ManagerTurnInput["resources"]): Promise<void> {
    const chatId = this.config.telegram.controlChatId;
    if (!chatId) {
      return;
    }

    const today = localDateString(this.config.timezone);
    const latestDigest = this.db.getLatestTelegramMessageByKind(this.config.projectId, "daily_digest");
    if (latestDigest && localDateString(this.config.timezone, new Date(latestDigest.recordedAt)) === today) {
      return;
    }

    const taskActivity = this.db.getTaskActivitySummary(this.config.projectId);
    const agents = this.db.listAgents(this.config.projectId);
    const openDecisions = this.db.listOpenDecisions(this.config.projectId);
    const deployments = this.db.getDeploymentSnapshot(this.config.projectId);
    const text =
      `Daily digest ${today}\n` +
      `Tasks queued/running/blocked/review: ${taskActivity.tasks.queued}/` +
      `${taskActivity.tasks.running}/` +
      `${taskActivity.tasks.blocked}/` +
      `${taskActivity.tasks.review}\n` +
      `Active runs code/review/test: ${taskActivity.activeRuns.code}/` +
      `${taskActivity.activeRuns.review}/` +
      `${taskActivity.activeRuns.test}\n` +
      `Open decisions: ${openDecisions.length}\n` +
      `Agents running: ${agents.filter((agent) => agent.status === "running").length}\n` +
      `Stable: ${deployments.stable.status} ${deployments.stable.commit.slice(0, 12) || "none"}\n` +
      `Preview: ${deployments.preview.status} ${deployments.preview.commit.slice(0, 12) || "none"}\n` +
      `Free worker slots: ${resources.freeWorkerSlots}`;
    await this.sendTelegramMessage("daily_digest", text);
  }

  private async buildWorkerPrompt(
    contract: TaskContract,
    role: "code" | "review" | "test"
  ): Promise<string> {
    const promptPath =
      role === "review"
        ? this.reviewerPromptPath
        : role === "test"
          ? this.testerPromptPath
          : this.workerPromptPath;
    const schemaPath =
      role === "review"
        ? this.reviewerSchemaPath
        : role === "test"
          ? this.testerSchemaPath
          : this.workerSchemaPath;
    const prompt = await readText(promptPath);
    const schema = await readText(schemaPath);
    return `${prompt}\n\nReturn JSON only matching this schema:\n${schema}\n\nTask contract:\n${JSON.stringify(contract, null, 2)}\n`;
  }

  private async ensureAppServer(): Promise<void> {
    const url = this.config.codex.appServerUrl;
    try {
      const client = this.getAppServerClient();
      await client.connect();
      return;
    } catch {
      // Start locally below.
    }

    if (!this.appServerProcess || this.appServerProcess.exitCode !== null) {
      const started = await spawnLoggedProcess({
        command: "codex",
        args: ["app-server", "--listen", url],
        cwd: this.config.repoRoot,
        stdoutPath: path.join(this.paths.logsDir, "app-server.out.log"),
        stderrPath: path.join(this.paths.logsDir, "app-server.err.log")
      });
      this.appServerProcess = started.child;
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }

    await this.getAppServerClient().connect();
  }

  private async resetManagerTransport(): Promise<void> {
    this.appServerClient?.dispose();
    this.appServerClient = undefined;

    if (!this.appServerProcess || this.appServerProcess.exitCode !== null) {
      this.appServerProcess = undefined;
      return;
    }

    try {
      this.appServerProcess.kill("SIGTERM");
    } catch {
      this.appServerProcess = undefined;
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
    if (this.appServerProcess.exitCode === null) {
      try {
        this.appServerProcess.kill("SIGKILL");
      } catch {
        // Ignore already-dead process.
      }
    }
    this.appServerProcess = undefined;
  }

  private getAppServerClient(): AppServerClient {
    if (!this.appServerClient) {
      this.appServerClient = new AppServerClient(this.config.codex.appServerUrl);
    }
    return this.appServerClient;
  }

  private async refreshProjectState(): Promise<void> {
    this.db.updateProjectCommits(
      this.config.projectId,
      await currentCommit(this.config.repoRoot, this.config.defaultBranch),
      await currentCommit(this.config.repoRoot, this.config.candidateBranch)
    );
  }

  private async refreshDetectedScriptsFromWorktree(worktreePath: string): Promise<void> {
    const detected = await detectPackageManagerAndScripts(worktreePath);
    if (JSON.stringify(detected.scripts) === JSON.stringify(this.config.scripts)) {
      return;
    }

    this.config = {
      ...this.config,
      scripts: detected.scripts
    };
    await this.persistConfig();
  }

  private async persistConfig(): Promise<void> {
    await writeText(getConfigPath(this.config.repoRoot), renderFactoryConfig(this.config));
    this.db.upsertProject(this.config);
  }

  private async persistBootstrapStatus(
    status: FactoryProjectConfig["bootstrap"]["status"]
  ): Promise<void> {
    if (this.config.bootstrap.status === status) {
      return;
    }

    this.config = {
      ...this.config,
      bootstrap: {
        ...this.config.bootstrap,
        status
      }
    };
    await this.persistConfig();
  }

  private async listTrackedFilesForBootstrapDetection(): Promise<string[]> {
    for (const ref of [this.config.candidateBranch, this.config.defaultBranch]) {
      const result = await runCommand("git", ["ls-tree", "-r", "--name-only", ref], {
        cwd: this.config.repoRoot,
        allowNonZeroExit: true
      });
      if (result.exitCode === 0) {
        return result.stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.length > 0);
      }
    }

    const fallback = await runCommand("git", ["ls-files"], {
      cwd: this.config.repoRoot,
      allowNonZeroExit: true
    });
    return fallback.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  private async startDashboardServer(): Promise<void> {
    if (this.dashboardServer) {
      return;
    }

    this.dashboardServer = http.createServer(async (request, response) => {
      try {
        const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
        if (request.method === "GET" && url.pathname === "/health") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ ok: true, now: nowIso() }));
          return;
        }

        if (request.method === "GET" && url.pathname === "/status") {
          const tasks = this.db.listTasks(this.config.projectId);
          const agents = this.db.listAgents(this.config.projectId);
          const deployments = this.db.getDeploymentSnapshot(this.config.projectId);
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify(
              {
                projectId: this.config.projectId,
                bootstrapStatus: this.config.bootstrap.status,
                tasks,
                agents,
                deployments
              },
              null,
              2
            )
          );
          return;
        }

        if (request.method === "POST" && url.pathname === "/telegram/webhook") {
          await this.handleTelegramWebhook(request, response);
          return;
        }

        if (request.method === "POST" && url.pathname === "/internal/manager-tool") {
          const authorization = request.headers.authorization;
          if (authorization !== `Bearer ${this.managerToolToken}`) {
            response.writeHead(403, { "content-type": "application/json" });
            response.end(JSON.stringify({ ok: false, error: "forbidden" }));
            return;
          }

          const body = await this.readJsonRequestBody(request);
          const toolRequest = this.parseManagerToolHttpRequest(body);
          const result = await this.executeManagerToolCall(toolRequest);
          response.writeHead(result.ok ? 200 : 400, { "content-type": "application/json" });
          response.end(JSON.stringify(result));
          return;
        }

        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "not_found" }));
      } catch (error) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
    });

    await new Promise<void>((resolve) => {
      this.dashboardServer?.listen(this.config.ports.dashboard, "127.0.0.1", () => resolve());
    });
  }

  private async handleTelegramWebhook(
    request: http.IncomingMessage,
    response: http.ServerResponse
  ): Promise<void> {
    const botToken = process.env[this.config.telegram.botTokenEnvVar];
    const expectedSecret = process.env[this.config.telegram.webhookSecretEnvVar];
    if (!expectedSecret) {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "webhook secret not configured" }));
      return;
    }

    if (request.headers["x-telegram-bot-api-secret-token"] !== expectedSecret) {
      response.writeHead(403, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "invalid_secret" }));
      return;
    }

    const update = await this.readJsonRequestBody(request);
    const message = update.message as
      | { message_id?: number; text?: string; chat?: { id?: string | number; type?: string }; from?: { id?: string | number } }
      | undefined;
    const callbackQuery = update.callback_query as
      | {
          id?: string;
          data?: string;
          from?: { id?: string | number };
          message?: { message_id?: number; chat?: { id?: string | number; type?: string } };
        }
      | undefined;

    if (
      message?.text &&
      this.isTelegramActorAllowed(
        message.chat?.id ? String(message.chat.id) : undefined,
        message.from?.id ? String(message.from.id) : undefined,
        message.chat?.type
      )
    ) {
      const secretCommand = this.parseSecretCommand(message.text);
      if (secretCommand) {
        await this.handleSecretCommand(secretCommand, message.message_id ? String(message.message_id) : undefined);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
        return;
      }

      const inboxId = randomId("inbox");
      this.db.insertInboxItem({
        id: inboxId,
        projectId: this.config.projectId,
        source: "telegram",
        externalId: message.message_id ? String(message.message_id) : undefined,
        receivedAt: nowIso(),
        text: message.text,
        status: "new"
      });
      this.db.insertTelegramMessage({
        id: randomId("telegram"),
        projectId: this.config.projectId,
        telegramMessageId: message.message_id ? String(message.message_id) : undefined,
        chatId: message.chat?.id ? String(message.chat.id) : undefined,
        direction: "inbound",
        kind: "message",
        text: message.text
      });
      await this.interruptManagerIfRunning();
      this.pendingManagerWakeReasons.add("telegram_message");
    }

    if (
      callbackQuery?.data?.startsWith("decision:") &&
      this.isTelegramActorAllowed(
        callbackQuery.message?.chat?.id ? String(callbackQuery.message.chat.id) : undefined,
        callbackQuery.from?.id ? String(callbackQuery.from.id) : undefined,
        callbackQuery.message?.chat?.type
      )
    ) {
      const [, decisionId, optionId] = callbackQuery.data.split(":");
      if (decisionId && optionId) {
        const decision = this.db.getDecision(decisionId);
        if (!decision) {
          await this.answerTelegramCallback(botToken, callbackQuery.id, "Decision not found");
        } else if (decision.status !== "open") {
          await this.answerTelegramCallback(
            botToken,
            callbackQuery.id,
            `Decision already ${decision.status.replace("_", " ")}`
          );
        } else if (!decision.options.some((option) => option.id === optionId)) {
          await this.answerTelegramCallback(botToken, callbackQuery.id, "Invalid option");
        } else {
          this.db.resolveDecision(decisionId, "resolved", optionId);
          this.db.insertTelegramMessage({
            id: randomId("telegram"),
            projectId: this.config.projectId,
            telegramMessageId: callbackQuery.message?.message_id
              ? String(callbackQuery.message.message_id)
              : undefined,
            chatId: callbackQuery.message?.chat?.id
              ? String(callbackQuery.message.chat.id)
              : undefined,
            direction: "inbound",
            kind: "decision_callback",
            text: `${decisionId}:${optionId}`,
            decisionId
          });
          const requeuedTasks = this.db.requeueSatisfiedBlockedTasks(this.config.projectId);
          for (const taskId of requeuedTasks) {
            this.db.insertTaskEvent(taskId, "queued", "Task re-queued after decision reply");
          }
          await this.answerTelegramCallback(
            botToken,
            callbackQuery.id,
            `Recorded: ${decision.options.find((option) => option.id === optionId)?.label ?? optionId}`
          );
          await this.interruptManagerIfRunning();
          this.pendingManagerWakeReasons.add("decision_reply");
        }
      }
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  }

  private parseSecretCommand(
    text: string
  ):
    | { kind: "list" }
    | { kind: "help" }
    | { kind: "set"; key: string; value: string }
    | undefined {
    const trimmed = text.trim();
    if (trimmed === "/secrets") {
      return { kind: "list" };
    }

    const commandMatch = trimmed.match(/^\/(secret|setsecret)(?:@\w+)?(?:\s+(.+))?$/);
    if (!commandMatch) {
      return undefined;
    }

    const payload = commandMatch[2]?.trim();
    if (!payload) {
      return { kind: "help" };
    }

    const equalsIndex = payload.indexOf("=");
    const spaceIndex = payload.indexOf(" ");
    if (equalsIndex > 0 && (spaceIndex === -1 || equalsIndex < spaceIndex)) {
      const key = payload.slice(0, equalsIndex).trim();
      const value = payload.slice(equalsIndex + 1).trim();
      return key && value ? { kind: "set", key, value } : { kind: "help" };
    }

    const firstSpace = payload.indexOf(" ");
    if (firstSpace <= 0) {
      return { kind: "help" };
    }

    const key = payload.slice(0, firstSpace).trim();
    const value = payload.slice(firstSpace + 1).trim();
    return key && value ? { kind: "set", key, value } : { kind: "help" };
  }

  private async handleSecretCommand(
    command:
      | { kind: "list" }
      | { kind: "help" }
      | { kind: "set"; key: string; value: string },
    replyToMessageId?: string
  ): Promise<void> {
    if (command.kind === "list") {
      const keys = await this.listAvailableSecretKeys();
      const text =
        keys.length > 0
          ? `Configured secret keys:\n${keys.map((key) => `- ${key}`).join("\n")}`
          : "No secret keys are configured yet. Send /secret ENV_NAME value to add one.";
      await this.sendTelegramMessage(
        "info_update",
        text,
        replyToMessageId,
        undefined,
        undefined,
        { isDirectUserResponse: true }
      );
      return;
    }

    if (command.kind === "help") {
      await this.sendTelegramMessage(
        "info_update",
        "Send secrets as /secret ENV_NAME value. Example: /secret OPENAI_API_KEY sk-...\nUse /secrets to list configured key names. Multiline secrets should be added from the host shell instead of Telegram.",
        replyToMessageId,
        undefined,
        undefined,
        { isDirectUserResponse: true }
      );
      return;
    }

    const key = command.key.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      await this.sendTelegramMessage(
        "info_update",
        `Refused secret name ${key}. Use a valid environment variable name like OPENAI_API_KEY.`,
        replyToMessageId,
        undefined,
        undefined,
        { isDirectUserResponse: true }
      );
      return;
    }

    if (RESERVED_SECRET_KEYS.has(key) || key.startsWith("FACTORY_")) {
      await this.sendTelegramMessage(
        "info_update",
        `Refused ${key}. That name is reserved for factory/runtime internals.`,
        replyToMessageId,
        undefined,
        undefined,
        { isDirectUserResponse: true }
      );
      return;
    }

    await upsertEnvFileValue(this.repoEnvPath(), key, command.value);
    process.env[key] = command.value;
    this.db.insertTelegramMessage({
      id: randomId("telegram"),
      projectId: this.config.projectId,
      chatId: this.config.telegram.controlChatId,
      direction: "inbound",
      kind: "secret_update",
      text: `${key}=[redacted]`,
      replyToMessageId
    });
    await this.sendTelegramMessage(
      "info_update",
      `Stored ${key}. Future workers, reviews, and deployments can use it without restarting the factory.`,
      replyToMessageId,
      undefined,
      undefined,
      { isDirectUserResponse: true }
    );
    await this.interruptManagerIfRunning();
    this.pendingManagerWakeReasons.add("secret_updated");
  }

  private isTelegramActorAllowed(
    chatId?: string,
    userId?: string,
    chatType?: string
  ): boolean {
    if (!chatId) {
      return false;
    }

    const allowListed =
      this.config.telegram.allowedAdminUserIds.length === 0 ||
      (userId !== undefined && this.config.telegram.allowedAdminUserIds.includes(userId));
    if (!allowListed) {
      return false;
    }

    if (chatId === this.config.telegram.controlChatId) {
      return true;
    }

    return Boolean(this.config.telegram.allowAdminDm && chatType === "private");
  }

  private async answerTelegramCallback(
    botToken: string | undefined,
    callbackId: string | undefined,
    text: string
  ): Promise<void> {
    if (!botToken || !callbackId) {
      return;
    }

    await sendTelegramApiRequest(botToken, "answerCallbackQuery", {
      callback_query_id: callbackId,
      text
    }).catch(() => undefined);
  }

  private async interruptManagerIfRunning(): Promise<void> {
    if (!this.activeManagerThreadId || !this.activeManagerTurnId) {
      return;
    }

    try {
      await this.getAppServerClient().interruptTurn(this.activeManagerThreadId, this.activeManagerTurnId);
    } catch {
      // Ignore interruptions failing during normal shutdown races.
    }
  }
}

function mapReasoningEffort(effort: TaskContract["runtime"]["reasoningEffort"]): string {
  if (effort === "extra-high") {
    return "high";
  }
  return effort;
}
