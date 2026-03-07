import http from "node:http";
import net from "node:net";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { open } from "node:fs/promises";
import process from "node:process";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { FactoryDatabase } from "@permafactory/db";
import { getConfigPath, loadProjectConfig, renderFactoryConfig } from "@permafactory/config";
import { DEFAULT_MANAGER_THREAD_NAME } from "@permafactory/models";
import type {
  CodingWorkerResult,
  FactoryProjectConfig,
  ManagerTurnInput,
  ManagerTurnOutput,
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
  readText,
  resolveReachableHttpUrl,
  runCommand,
  sampleResources,
  sendTelegramApiRequest,
  shouldDeliverTelegramNotification,
  slugify,
  spawnLoggedShellCommand,
  spawnLoggedProcess,
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
    developerInstructions: string
  ): Promise<string> {
    const params = {
      model: config.codex.managerModel,
      cwd: config.repoRoot,
      approvalPolicy: "never",
      sandbox: config.codex.sandboxMode,
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
  private activeManagerTurnId?: string;
  private activeManagerThreadId?: string;
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
    await this.refreshProjectState();
    if (!once) {
      await this.startDashboardServer();
    }

    do {
      await this.tick();
      if (!once) {
        await new Promise((resolve) => setTimeout(resolve, this.config.scheduler.tickSeconds * 1000));
      }
    } while (!once);
  }

  private async tick(): Promise<void> {
    this.config = await loadProjectConfig(this.config.repoRoot);
    this.db.upsertProject(this.config);
    await this.refreshProjectState();
    await this.reconcileRuntimeTargets();
    await this.reconcileStaleWorkers();
    const workerSandboxCapabilities = await this.ensureWorkerSandboxCapabilities();
    await this.maybeSeedGreenfieldBootstrapTask(workerSandboxCapabilities);

    const expiredDecisions = this.db.expireTimedOutDecisions();
    if (expiredDecisions.length > 0) {
      const requeuedTasks = this.db.requeueSatisfiedBlockedTasks(this.config.projectId);
      for (const taskId of requeuedTasks) {
        this.db.insertTaskEvent(taskId, "queued", "Task re-queued after decision timeout");
      }
      this.pendingManagerWakeReasons.add("decision_timeout");
    }

    const agents = this.db.listAgents(this.config.projectId);
    const activeWorkers = agents.filter(
      (agent) => agent.role !== "manager" && agent.status === "running"
    ).length;
    const sampledResources = await sampleResources(this.config.scheduler.maxWorkers, activeWorkers);
    const resources: ManagerTurnInput["resources"] = {
      ...sampledResources,
      workerSandbox: {
        canBindListenSockets: workerSandboxCapabilities.canBindListenSockets
      }
    };
    this.db.recordHealthSample(this.config.projectId, resources);
    await this.maybeSendDailyDigest(resources);

    if (this.shouldRunManager(resources)) {
      await this.runManagerTurn(resources);
    }

    await this.startQueuedTasksIfPossible();
  }

  private shouldRunManager(resources: ManagerTurnInput["resources"]): boolean {
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

    return false;
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
        developerInstructions
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
      const startedTurn = await client.startTurn(
        threadId,
        JSON.stringify(input, null, 2),
        undefined
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

  private async buildManagerInput(resources: ManagerTurnInput["resources"]): Promise<ManagerTurnInput> {
    const input = this.db.getManagerInput(this.config);
    input.repo.dirtyFiles = await listDirtyFiles(this.config.repoRoot);
    input.repo.currentStableCommit = await currentCommit(this.config.repoRoot, this.config.defaultBranch);
    input.repo.currentCandidateCommit = await currentCommit(
      this.config.repoRoot,
      this.config.candidateBranch
    );
    input.resources = resources;
    input.deployments = this.db.getDeploymentSnapshot(this.config.projectId);
    return input;
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

      const shouldRequeue = agent.role !== "review";
      this.db.updateTaskStatus(task.id, shouldRequeue ? "queued" : "failed");
      this.db.insertTaskEvent(
        task.id,
        shouldRequeue ? "queued" : "failed",
        shouldRequeue
          ? "Task re-queued after worker process was missing during supervisor startup"
          : "Review worker was missing during supervisor startup"
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
    hasDirectUserMessage: boolean
  ): Promise<void> {
    console.log(`[manager] ${output.summary}`);
    if (wakeReasons.length > 0) {
      console.log(`[manager] wake reasons: ${wakeReasons.join(", ")}`);
    }

    for (const decision of output.decisions) {
      await this.maybeCreateDecision(decision);
    }

    let directResponseSent = false;
    for (const message of output.userMessages) {
      const isDirectUserResponse =
        hasDirectUserMessage && message.kind === "info_update" && !directResponseSent;
      const delivered = await this.sendTelegramMessage(
        message.kind,
        message.text,
        message.replyToMessageId,
        message.decisionId,
        undefined,
        { isDirectUserResponse }
      );
      if (delivered && message.kind === "info_update") {
        directResponseSent = true;
      }
    }

    for (const taskId of output.tasksToCancel) {
      await this.cancelTask(taskId);
    }

    for (const contract of output.tasksToStart) {
      await this.materializeAndStartTask(contract);
    }

    for (const review of output.reviewsToStart) {
      const task = this.db.getTask(review.taskId);
      if (!task?.contract || !["review", "blocked", "done"].includes(task.status)) {
        continue;
      }
      if (
        this.db
          .listAgents(this.config.projectId)
          .some((agent) => agent.role === "review" && agent.taskId === review.taskId && agent.status === "running")
      ) {
        continue;
      }
      const reviewTask: TaskContract = {
        ...task.contract,
        id: task.id,
        title: `Review ${task.title}`,
        goal: review.reason,
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

    for (const deployment of output.deployments) {
      try {
        await this.handleDeploymentIntent(deployment);
      } catch (error) {
        await this.sendTelegramMessage(
          "incident_alert",
          `Deployment ${deployment.kind} failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }

  private async maybeCreateDecision(decision: ManagerTurnOutput["decisions"][number]): Promise<void> {
    const budget = this.db.getDecisionBudget(
      this.config.projectId,
      this.config.timezone,
      this.config.decisionBudget.dailyLimit,
      this.config.decisionBudget.reserveCritical
    );
    if (this.db.findOpenDecisionByDedupe(this.config.projectId, decision.dedupeKey)) {
      return;
    }

    if (budget.remaining <= 0) {
      return;
    }

    if (decision.priority !== "critical" && budget.remainingNormal <= 0) {
      return;
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

  private async maybeSeedGreenfieldBootstrapTask(
    workerSandboxCapabilities: WorkerSandboxCapabilities
  ): Promise<void> {
    if (!["waiting_for_first_task", "baselining_repo"].includes(this.config.bootstrap.status)) {
      return;
    }

    if (this.db.listTasks(this.config.projectId).length > 0) {
      return;
    }

    if (this.db.listInboxItems(this.config.projectId, ["new"]).length > 0) {
      return;
    }

    const trackedFiles = await this.listTrackedFilesForBootstrapDetection();
    if (!isLikelyGreenfieldRepoFiles(trackedFiles, this.config.projectSpecPath)) {
      return;
    }

    const taskId = "bootstrap-greenfield";
    const contract: TaskContract = {
      id: taskId,
      kind: "code",
      title: "Build first runnable product slice from spec",
      goal: `Treat this repo as an intentional greenfield start and build the first coherent implementation slice described in ${this.config.projectSpecPath}. Establish the minimal runnable baseline needed for continued product work instead of blocking on missing existing code.`,
      acceptanceCriteria: [
        `Repository gains the first working implementation slice aligned with ${this.config.projectSpecPath}.`,
        "The repo includes the minimal project/tooling baseline needed for continued iteration in this codebase.",
        "At least one meaningful non-binding verification path passes and is reported in the worker result."
      ],
      baseBranch: this.config.candidateBranch,
      branchName: "task/bootstrap-greenfield",
      worktreePath: path.join(this.paths.worktreesDir, taskId),
      lockScope: ["repo"],
      needsPreview: false,
      ports: {},
      runtime: {
        maxRuntimeMinutes: 90,
        reasoningEffort: "extra-high"
      },
      constraints: {
        mustRunChecks: this.seededGreenfieldChecks()
      },
      context: {
        userIntent: `Start building the product from ${this.config.projectSpecPath}.`,
        relatedTaskIds: [],
        blockingDecisions: [],
        runtimeCapabilities: workerSandboxCapabilities
      }
    };

    await this.persistBootstrapStatus("baselining_repo");
    await this.materializeAndStartTask(contract);
    this.db.insertTaskEvent(
      taskId,
      "queued",
      `Seeded the initial greenfield implementation task from ${this.config.projectSpecPath}`
    );
    this.pendingManagerWakeReasons.add("greenfield_seeded");
  }

  private seededGreenfieldChecks(): string[] {
    return [this.config.scripts.build, this.config.scripts.test, this.config.scripts.smoke].filter(
      (script, index, allScripts) => !isPlaceholderScript(script) && allScripts.indexOf(script) === index
    );
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

    if (role === "code") {
      const result = validated.value as CodingWorkerResult;
      const nextStatus = result.status === "completed" ? (result.needsReview ? "review" : "done") : result.status;
      this.db.updateTaskStatus(contract.id, nextStatus as never);
      this.db.insertTaskEvent(contract.id, result.status, result.summary, result);
    } else if (role === "review") {
      const result = validated.value as ReviewerResult;
      const nextStatus =
        result.status !== "completed"
          ? result.status
          : result.recommendedAction === "merge"
            ? "done"
            : "failed";
      this.db.updateTaskStatus(contract.id, nextStatus as never);
      this.db.insertTaskEvent(contract.id, result.status, result.summary, result);
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
    intent: ManagerTurnOutput["deployments"][number]
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

    const commit = await this.resolveRollbackCommit(intent.rollbackTag, intent.commit);
    await this.rollbackStable(commit, intent.reason, intent.rollbackTag);
  }

  private async reconcileRuntimeTargets(): Promise<void> {
    const snapshot = this.db.getDeploymentSnapshot(this.config.projectId);
    const stableUrl = await this.resolveStableUrl();
    const previewUrl = await this.resolvePreviewUrl();
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

    const tasks = this.db.listTasks(this.config.projectId);
    const agents = this.db.listAgents(this.config.projectId);
    const openDecisions = this.db.listOpenDecisions(this.config.projectId);
    const deployments = this.db.getDeploymentSnapshot(this.config.projectId);
    const text =
      `Daily digest ${today}\n` +
      `Tasks queued/running/blocked/review: ${tasks.filter((task) => task.status === "queued").length}/` +
      `${tasks.filter((task) => task.status === "running").length}/` +
      `${tasks.filter((task) => task.status === "blocked").length}/` +
      `${tasks.filter((task) => task.status === "review").length}\n` +
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
    await writeText(getConfigPath(this.config.repoRoot), renderFactoryConfig(this.config));
    this.db.upsertProject(this.config);
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

    const body = await new Promise<string>((resolve, reject) => {
      let chunks = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        chunks += chunk;
      });
      request.on("end", () => resolve(chunks));
      request.on("error", reject);
    });
    const update = JSON.parse(body) as Record<string, unknown>;
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
