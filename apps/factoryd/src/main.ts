import http from "node:http";
import net from "node:net";
import path from "node:path";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";
import { open, readlink, readdir, rm } from "node:fs/promises";
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
  buildProjectSpecExcerpt,
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
  pollTelegramUpdates,
  randomId,
  readEnvFileValues,
  readText,
  resolveRuntimeScriptCommand,
  resolveReachableHttpUrl,
  runCommand,
  sampleResources,
  selectTaskCommitMessage,
  sendTelegramApiRequest,
  shouldDeliverTelegramNotification,
  slugify,
  spawnLoggedShellCommand,
  spawnLoggedProcess,
  matchesTelegramSlashCommand,
  updateGitBranchRef,
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
  "inspect_branch_diff",
  "read_task_artifacts",
  "inspect_deploy_state",
  "inspect_factory_processes",
  "kill_factory_process",
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
  healthcheckScript: string;
}

interface ResolvedRuntimeScripts {
  worktreePath: string;
  buildScript: string;
  serveScript: string;
  healthcheckScript: string;
}

interface RuntimeDeployIdentity {
  target: "stable" | "preview";
  slot: RuntimeSlotName;
  commit: string;
  branch?: string;
  port: number;
  url: string;
  generatedAt: string;
}

interface RuntimeEnsureResult {
  ok: boolean;
  reason: "healthy" | "serve_script_not_configured" | "healthcheck_failed";
  scripts: ResolvedRuntimeScripts;
}

interface ProcessSnapshot {
  pid: number;
  ppid: number;
  elapsedSeconds: number;
  cpuPercent: number;
  memoryPercent: number;
  processKey: string;
  startTicks?: number;
  cwd?: string;
  exe?: string;
  args: string;
  command: string;
}

interface FactoryProcessRecord extends ProcessSnapshot {
  kind:
    | "supervisor"
    | "app_server"
    | "worker"
    | "runtime"
    | "manager_mcp"
    | "browser_mcp"
    | "chrome"
    | "other";
  ownerKind: "supervisor" | "manager" | "task" | "runtime" | "unknown";
  ownerId?: string;
  rootPid?: number;
  rootProcessKey?: string;
  rootCwd?: string;
  active: boolean;
  stale: boolean;
  protected: boolean;
  killable: boolean;
}

function serializeLifecycleValue(value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack
    };
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (Array.isArray(value)) {
    return value.map((entry) => serializeLifecycleValue(entry));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, serializeLifecycleValue(entry)])
    );
  }

  return value;
}

function appendLifecycleEntry(
  logPath: string,
  event: string,
  details: Record<string, unknown> = {}
): void {
  try {
    const serializedDetails = serializeLifecycleValue(details);
    appendFileSync(
      logPath,
      `${JSON.stringify({
        at: nowIso(),
        pid: process.pid,
        event,
        ...(serializedDetails && typeof serializedDetails === "object"
          ? (serializedDetails as Record<string, unknown>)
          : { details: serializedDetails })
      })}\n`,
      "utf8"
    );
  } catch {
    // Ignore best-effort lifecycle logging failures.
  }
}

function writeHeartbeatSnapshot(filePath: string, payload: Record<string, unknown>): void {
  try {
    const serializedPayload = serializeLifecycleValue(payload);
    writeFileSync(
      filePath,
      `${JSON.stringify({
        at: nowIso(),
        pid: process.pid,
        ...(serializedPayload && typeof serializedPayload === "object"
          ? (serializedPayload as Record<string, unknown>)
          : { payload: serializedPayload })
      }, null, 2)}\n`,
      "utf8"
    );
  } catch {
    // Ignore best-effort heartbeat write failures.
  }
}

function readPsFields(pid: number, fields: string[]): string | undefined {
  try {
    const output = execFileSync("ps", ["-o", `${fields.join(",")}=`, "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    return output.length > 0 ? output : undefined;
  } catch {
    return undefined;
  }
}

function getProcessIdentitySnapshot(): Record<string, unknown> {
  const identity: Record<string, unknown> = {
    ppid: process.ppid
  };

  const processFields = readPsFields(process.pid, ["pgid", "sid", "command"]);
  if (processFields) {
    const match = processFields.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/s);
    if (match) {
      identity.pgid = Number.parseInt(match[1] ?? "", 10);
      identity.sid = Number.parseInt(match[2] ?? "", 10);
      identity.command = match[3]?.trim();
    }
  }

  const parentCommand = readPsFields(process.ppid, ["command"]);
  if (parentCommand) {
    identity.parentCommand = parentCommand.trim();
  }

  return identity;
}

function installProcessDiagnostics(paths: ReturnType<typeof getFactoryPaths>): () => void {
  const logEvent = (event: string, details: Record<string, unknown> = {}) => {
    appendLifecycleEntry(paths.lifecycleLogPath, event, details);
  };
  const writeHeartbeat = (phase: string, details: Record<string, unknown> = {}) => {
    writeHeartbeatSnapshot(paths.heartbeatPath, { phase, ...details });
  };

  const onUnhandledRejection = (reason: unknown) => {
    logEvent("unhandled_rejection", { reason });
    writeHeartbeat("unhandled_rejection", { reason });
  };
  const onUncaughtExceptionMonitor = (error: Error, origin: string) => {
    logEvent("uncaught_exception_monitor", { origin, error });
    writeHeartbeat("uncaught_exception_monitor", { origin, error });
  };
  const onBeforeExit = (code: number) => {
    logEvent("before_exit", { code });
    writeHeartbeat("before_exit", { code });
  };
  const onExit = (code: number) => {
    logEvent("exit", { code });
  };
  const onSigterm = () => {
    logEvent("signal", { signal: "SIGTERM" });
    writeHeartbeat("signal", { signal: "SIGTERM" });
  };
  const onSigint = () => {
    logEvent("signal", { signal: "SIGINT" });
    writeHeartbeat("signal", { signal: "SIGINT" });
  };

  logEvent("process_bootstrap", {
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    ...getProcessIdentitySnapshot()
  });
  writeHeartbeat("process_bootstrap", {
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    ...getProcessIdentitySnapshot()
  });

  process.on("unhandledRejection", onUnhandledRejection);
  process.on("uncaughtExceptionMonitor", onUncaughtExceptionMonitor);
  process.on("beforeExit", onBeforeExit);
  process.on("exit", onExit);
  process.on("SIGTERM", onSigterm);
  process.on("SIGINT", onSigint);

  return () => {
    process.off("unhandledRejection", onUnhandledRejection);
    process.off("uncaughtExceptionMonitor", onUncaughtExceptionMonitor);
    process.off("beforeExit", onBeforeExit);
    process.off("exit", onExit);
    process.off("SIGTERM", onSigterm);
    process.off("SIGINT", onSigint);
  };
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
  const paths = getFactoryPaths(repoRoot);
  await ensureDir(paths.factoryRoot);
  await ensureDir(paths.logsDir);
  const removeDiagnostics = installProcessDiagnostics(paths);
  await loadEnvFile(path.join(repoRoot, ".env.factory"));
  const config = await loadProjectConfig(repoRoot);
  const db = await FactoryDatabase.open(repoRoot);
  db.init();
  db.upsertProject(config);
  const supervisor = new FactorySupervisor(config, db);
  const handleStopSignal = () => {
    void supervisor.requestShutdown("signal");
  };
  process.once("SIGTERM", handleStopSignal);
  process.once("SIGINT", handleStopSignal);
  try {
    await supervisor.run(Boolean(parsed.values.once));
  } finally {
    removeDiagnostics();
    process.off("SIGTERM", handleStopSignal);
    process.off("SIGINT", handleStopSignal);
  }
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

  async request<T>(method: string, params: unknown, timeoutMs = 30_000): Promise<T> {
    await this.initialize();
    return await this.sendRequest<T>(method, params, timeoutMs);
  }

  private async sendRequest<T>(method: string, params: unknown, timeoutMs = 30_000): Promise<T> {
    await this.connect();
    const id = this.requestId++;
    const payload = { jsonrpc: "2.0", id, method, params };

    const promise = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method} response`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as T);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        }
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
    await this.request("turn/interrupt", { threadId, turnId }, 10_000);
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
  private managerToolToken = "";
  private managerThreadNeedsRotation = false;
  private stopRequested = false;
  private shuttingDown = false;
  private shutdownPromise?: Promise<void>;
  private telegramPollingTask?: Promise<void>;
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

  private getLifecycleSnapshot(): Record<string, unknown> {
    const summary = this.db.getTaskActivitySummary(this.config.projectId);
    return {
      projectId: this.config.projectId,
      repoRoot: this.config.repoRoot,
      managerRunning: this.managerRunning,
      stopRequested: this.stopRequested,
      shuttingDown: this.shuttingDown,
      activeManagerThreadId: this.activeManagerThreadId,
      activeManagerTurnId: this.activeManagerTurnId,
      pendingWakeReasons: [...this.pendingManagerWakeReasons],
      tasks: summary.tasks,
      activeRuns: summary.activeRuns
    };
  }

  private logLifecycle(event: string, details: Record<string, unknown> = {}): void {
    appendLifecycleEntry(this.paths.lifecycleLogPath, event, {
      ...this.getLifecycleSnapshot(),
      ...details
    });
  }

  private writeHeartbeat(phase: string, details: Record<string, unknown> = {}): void {
    writeHeartbeatSnapshot(this.paths.heartbeatPath, {
      ...this.getLifecycleSnapshot(),
      phase,
      ...details
    });
  }

  async run(once: boolean): Promise<void> {
    this.stopRequested = false;
    this.shuttingDown = false;
    await ensureDir(this.paths.logsDir);
    await ensureDir(this.paths.tasksDir);
    await ensureDir(this.paths.worktreesDir);
    await ensureDir(this.paths.runtimeDir);
    await ensureDir(this.paths.runsDir);
    await this.ensureManagerToolToken();
    await this.claimSupervisorPid();
    this.logLifecycle("run_started", { once });
    this.writeHeartbeat("run_started", { once });

    try {
      await this.refreshProjectState();
      await this.startDashboardServer();
      if (!once) {
        await this.startTelegramPollingFallback();
      }

      do {
        await this.tick();
        if (!once && !this.stopRequested) {
          this.writeHeartbeat("tick_wait");
          await this.waitForNextTickOrStop();
        }
      } while (!once && !this.stopRequested);
    } finally {
      this.logLifecycle("run_finally");
      await this.requestShutdown("run_finally").catch(() => undefined);
      await this.telegramPollingTask?.catch(() => undefined);
      await this.releaseSupervisorPid();
    }
  }

  async requestShutdown(reason: string): Promise<void> {
    if (!this.shutdownPromise) {
      this.shutdownPromise = this.performShutdown(reason);
    }
    await this.shutdownPromise;
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

  private async performShutdown(reason: string): Promise<void> {
    if (this.shuttingDown) {
      return;
    }

    this.shuttingDown = true;
    this.stopRequested = true;
    this.pendingManagerWakeReasons.clear();
    this.logLifecycle("shutdown_started", { reason });
    this.writeHeartbeat("shutdown_started", { reason });

    await this.interruptManagerIfRunning().catch(() => undefined);

    const agents = this.db.listAgents(this.config.projectId);
    for (const agent of agents) {
      if (agent.role === "manager") {
        if (agent.status === "running") {
          this.db.upsertAgent({
            id: agent.id,
            projectId: agent.projectId,
            role: agent.role,
            status: "idle",
            threadId: agent.threadId,
            metadata: {
              ...agent.metadata,
              stoppedAt: nowIso(),
              stopReason: reason
            }
          });
        }
        continue;
      }

      if (agent.status !== "running" || !agent.taskId) {
        continue;
      }

      const task = this.db.getTask(agent.taskId);
      if (!task) {
        continue;
      }

      const nextTaskStatus = agent.role === "review" ? "review" : "queued";
      this.db.updateTaskStatus(task.id, nextTaskStatus);
      this.db.insertTaskEvent(
        task.id,
        nextTaskStatus,
        agent.role === "review"
          ? `Review interrupted by factory shutdown (${reason}); decide the next step after restart`
          : `Task stopped by factory shutdown (${reason}) and re-queued for the next start`
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
        metadata: {
          ...agent.metadata,
          stoppedAt: nowIso(),
          stopReason: reason
        }
      });
    }

    for (const child of this.workerChildren.values()) {
      if (child.pid) {
        await this.terminateProcessTree(child.pid);
      }
    }
    this.workerChildren.clear();

    for (const slot of ["stable-a", "stable-b", "preview"] as RuntimeSlotName[]) {
      await this.stopRuntimeProcess(slot);
    }
    for (const port of [
      this.config.ports.stableA,
      this.config.ports.stableB,
      this.config.ports.preview
    ]) {
      await this.stopOrphanRuntimeListeners(port);
    }

    if (this.stableProxyServer) {
      await new Promise<void>((resolve) => this.stableProxyServer?.close(() => resolve()));
      this.stableProxyServer = undefined;
    }

    if (this.dashboardServer) {
      await new Promise<void>((resolve) => this.dashboardServer?.close(() => resolve()));
      this.dashboardServer = undefined;
    }

    await this.resetManagerTransport().catch(() => undefined);
    this.activeManagerTurnId = undefined;
    this.activeManagerThreadId = undefined;
    this.managerRunning = false;
    this.logLifecycle("shutdown_completed", { reason });
    this.writeHeartbeat("shutdown_completed", { reason });
  }

  private async ensureManagerToolToken(): Promise<void> {
    const existing = await readText(this.paths.managerToolTokenPath).catch(() => "");
    const trimmed = existing.trim();
    if (trimmed.length > 0) {
      this.managerToolToken = trimmed;
      return;
    }

    this.managerToolToken = randomBytes(24).toString("hex");
    await writeText(this.paths.managerToolTokenPath, `${this.managerToolToken}\n`);
    this.managerThreadNeedsRotation = true;
  }

  private async tick(): Promise<void> {
    if (this.stopRequested) {
      return;
    }
    this.writeHeartbeat("tick_started");
    this.config = await loadProjectConfig(this.config.repoRoot);
    this.db.upsertProject(this.config);
    await this.refreshProjectState();
    const trackedFiles = await this.listTrackedFilesForBootstrapDetection();
    const appearsGreenfield = isLikelyGreenfieldRepoFiles(trackedFiles, this.config.projectSpecPath);
    await this.reconcileRuntimeTargets(appearsGreenfield);
    await this.reconcileStaleWorkers();
    this.reconcileStaleManagerState();
    await this.reconcileFactoryProcessLeaks();
    await this.reconcileCompletedTaskBranches();

    const expiredDecisions = this.db.expireTimedOutDecisions();
    if (expiredDecisions.length > 0) {
      const requeuedTasks = this.db.requeueSatisfiedBlockedTasks(this.config.projectId);
      for (const taskId of requeuedTasks) {
        this.db.insertTaskEvent(taskId, "queued", "Task re-queued after decision timeout");
      }
      this.pendingManagerWakeReasons.add("decision_timeout");
    }

    if (this.stopRequested) {
      return;
    }

    await this.startQueuedTasksIfPossible();

    const resources = await this.sampleManagerResources();
    this.db.recordHealthSample(this.config.projectId, resources);
    await this.maybeSendDailyDigest(resources);
    this.maybeWakeManagerForContinuity();

    if (this.shouldRunManager(resources)) {
      await this.runManagerTurn(resources);
    }

    if (this.stopRequested) {
      return;
    }
    await this.startQueuedTasksIfPossible();
    this.writeHeartbeat("tick_completed");
  }

  private async waitForNextTickOrStop(): Promise<void> {
    const deadline = Date.now() + this.config.scheduler.tickSeconds * 1000;
    while (!this.stopRequested && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
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
    const runningWorkers = agents.filter((agent) => agent.role !== "manager" && agent.status === "running");
    const hasRunningWorker = runningWorkers.length > 0;
    const runningTaskIds = new Set(
      runningWorkers
        .filter((agent) => agent.taskId)
        .map((agent) => agent.taskId as string)
    );
    const runningBranchNames = new Set(
      runningWorkers
        .map((agent) => agent.branch?.trim())
        .filter((branch): branch is string => Boolean(branch))
    );
    const runningWorktreePaths = new Set(
      runningWorkers
        .map((agent) => agent.worktreePath?.trim())
        .filter((worktreePath): worktreePath is string => Boolean(worktreePath))
    );
    const hasEquivalentRunningWorker = (task: (typeof tasks)[number]): boolean => {
      if (runningTaskIds.has(task.id)) {
        return true;
      }
      if (task.branchName && runningBranchNames.has(task.branchName.trim())) {
        return true;
      }
      if (task.worktreePath && runningWorktreePaths.has(task.worktreePath.trim())) {
        return true;
      }
      return false;
    };
    const hasQueuedTask = tasks.some((task) => task.status === "queued");
    const hasTrackedActiveTask = tasks.some(
      (task) => (task.status === "running" || task.status === "review") && hasEquivalentRunningWorker(task)
    );
    const orphanGraceMs = Math.max(this.config.scheduler.tickSeconds * 1000, 30_000);
    const hasOrphanedActiveTask = tasks.some((task) => {
      if (task.status !== "running" && task.status !== "review") {
        return false;
      }
      if (hasEquivalentRunningWorker(task)) {
        return false;
      }
      const updatedAtMs = Date.parse(task.updatedAt);
      return Number.isFinite(updatedAtMs) && Date.now() - updatedAtMs >= orphanGraceMs;
    });

    if ((hasQueuedTask || hasTrackedActiveTask || hasRunningWorker) && !hasOrphanedActiveTask) {
      return;
    }

    const cooldownMs = Math.max(this.config.scheduler.tickSeconds * 1000, 60_000);
    if (Date.now() - this.lastNoActiveWorkWakeAt < cooldownMs) {
      return;
    }

    this.pendingManagerWakeReasons.add(hasOrphanedActiveTask ? "orphaned_active_task" : "no_active_work");
    this.lastNoActiveWorkWakeAt = Date.now();
  }

  private async runManagerTurn(resources: ManagerTurnInput["resources"]): Promise<void> {
    this.managerRunning = true;
    const wakeReasons = [...this.pendingManagerWakeReasons];
    this.pendingManagerWakeReasons.clear();
    if (this.shouldRotateManagerThreadFromRecentTurns()) {
      this.managerThreadNeedsRotation = true;
      wakeReasons.push("manager_thread_rotation");
    }
    this.logLifecycle("manager_turn_requested", { wakeReasons });
    this.writeHeartbeat("manager_turn_requested", { wakeReasons });

    try {
      await this.ensureAppServer();
      const client = this.getAppServerClient();
      const developerInstructions = await this.buildManagerInstructions();
      const threadId = await client.ensureManagerThread(
        this.managerThreadNeedsRotation
          ? undefined
          : this.activeManagerThreadId ?? this.db.getAgentSession("manager", "thread")?.sessionId,
        this.config,
        developerInstructions,
        this.buildManagerThreadConfig()
      );
      this.managerThreadNeedsRotation = false;
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
      this.logLifecycle("manager_turn_started", {
        threadId,
        turnId: startedTurn.turnId,
        wakeReasons,
        userMessages: input.userMessages.length
      });
      this.writeHeartbeat("manager_turn_started", {
        threadId,
        turnId: startedTurn.turnId,
        wakeReasons,
        userMessages: input.userMessages.length
      });
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

      if (this.stopRequested) {
        return;
      }

      await this.applyManagerOutput(validated.value, wakeReasons, input.userMessages.length > 0);
      for (const inboxItem of this.db.listInboxItems(this.config.projectId, ["new"])) {
        this.db.markInboxItemStatus(inboxItem.id, "triaged");
      }
      this.logLifecycle("manager_turn_completed", {
        threadId,
        turnId: startedTurn.turnId,
        summary: validated.value.summary
      });
      this.writeHeartbeat("manager_turn_completed", {
        threadId,
        turnId: startedTurn.turnId,
        summary: validated.value.summary
      });

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
        this.logLifecycle("manager_turn_interrupted", {
          threadId: error.threadId,
          turnId: error.turnId
        });
        this.writeHeartbeat("manager_turn_interrupted", {
          threadId: error.threadId,
          turnId: error.turnId
        });
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
      this.logLifecycle("manager_turn_failed", {
        error,
        restartPlanned
      });
      this.writeHeartbeat("manager_turn_failed", {
        error,
        restartPlanned
      });

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
      this.writeHeartbeat("manager_turn_idle");
    }
  }

  private async recoverManagerFailure(error: unknown): Promise<boolean> {
    const message = error instanceof Error ? error.message : String(error);
    const shouldInterruptTurn = /Timed out waiting for turn/i.test(message);
    const shouldResetTransport =
      /Timed out waiting for turn|Timed out waiting for .* response|Not initialized|socket closed|Failed connecting/i.test(
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
      this.managerThreadNeedsRotation = true;
      return true;
    }

    return false;
  }

  private shouldRotateManagerThreadFromRecentTurns(): boolean {
    const recentTurns = this.db.listRecentManagerTurns(this.config.projectId, 4);
    if (recentTurns.length < 3) {
      return false;
    }

    const normalizedSummaries = new Set(
      recentTurns.slice(0, 3).map((turn) => this.normalizeManagerLoopSummary(turn.summary))
    );
    const repeatedNoOpLoop =
      recentTurns.slice(0, 3).every((turn) => this.isNoOpManagerTurn(turn)) &&
      normalizedSummaries.size === 1;
    const repeatedMismatchLoop = recentTurns
      .slice(0, 3)
      .every((turn) => turn.toolCalls.length === 0 && turn.mismatchHints.length > 0);

    return repeatedNoOpLoop || repeatedMismatchLoop;
  }

  private isNoOpManagerTurn(turn: ManagerTurnInput["recentManagerTurns"][number]): boolean {
    const totalActions =
      turn.actionCounts.tasksToStart +
      turn.actionCounts.tasksToCancel +
      turn.actionCounts.reviewsToStart +
      turn.actionCounts.integrations +
      turn.actionCounts.deployments +
      turn.actionCounts.decisions +
      turn.actionCounts.userMessages;
    return totalActions === 0 && turn.toolCalls.length === 0;
  }

  private normalizeManagerLoopSummary(summary: string): string {
    return summary
      .replace(/`[^`]+`/g, "`ref`")
      .replace(/\b[0-9a-f]{8,40}\b/gi, "sha")
      .replace(/\d+/g, "n")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
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
    input.project.projectSpecExcerpt = await this.loadProjectSpecExcerpt();
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

  private async loadProjectSpecExcerpt(): Promise<string | undefined> {
    if (!this.config.projectSpecPath) {
      return undefined;
    }

    const resolvedPath = path.resolve(this.config.repoRoot, this.config.projectSpecPath);
    const text = await readText(resolvedPath).catch(() => undefined);
    if (!text) {
      return undefined;
    }

    return buildProjectSpecExcerpt(text);
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

  private reconcileStaleManagerState(): void {
    if (this.managerRunning) {
      return;
    }

    const manager = this.db.listAgents(this.config.projectId).find((agent) => agent.role === "manager");
    if (!manager || manager.status !== "running") {
      return;
    }

    this.db.upsertAgent({
      id: manager.id,
      projectId: manager.projectId,
      role: "manager",
      status: "stalled",
      threadId: manager.threadId,
      metadata: {
        ...manager.metadata,
        recoveredAt: nowIso(),
        recoveredReason: "stale_manager_state"
      }
    });
    this.activeManagerThreadId = manager.threadId;
    this.activeManagerTurnId = undefined;
    this.managerThreadNeedsRotation = true;
    this.pendingManagerWakeReasons.add("manager_recovered");
    console.warn(
      `Recovered stale manager state${manager.threadId ? ` for thread ${manager.threadId}` : ""}; scheduling a fresh manager turn`
    );
  }

  private async reconcileFactoryProcessLeaks(): Promise<void> {
    if (this.managerRunning || this.activeManagerTurnId) {
      return;
    }

    const appServerPid = await this.findListenerPidForUrl(this.config.codex.appServerUrl);
    const keepRootPids = this.collectProtectedRootPids();

    if (appServerPid && !keepRootPids.has(appServerPid)) {
      await this.terminateProcessTree(appServerPid);
      this.appServerClient?.dispose();
      this.appServerClient = undefined;
      console.warn(`Killed stale app-server listener pid ${appServerPid}`);
      return;
    }

    const processes = await this.listFactoryProcesses({ includeArgs: true, limit: 400 });
    const staleRoots = new Set<number>();
    for (const processInfo of processes) {
      if (!processInfo.stale) {
        continue;
      }
      if (processInfo.kind !== "browser_mcp" && processInfo.kind !== "chrome" && processInfo.kind !== "manager_mcp") {
        continue;
      }
      if (processInfo.elapsedSeconds < 60) {
        continue;
      }
      staleRoots.add(processInfo.rootPid ?? processInfo.pid);
    }

    for (const pid of staleRoots) {
      if (keepRootPids.has(pid)) {
        continue;
      }
      await this.terminateProcessTree(pid);
      console.warn(`Reaped stale factory process tree rooted at pid ${pid}`);
    }
  }

  private async ensureOwnedAppServerListener(): Promise<void> {
    const listenerPid = await this.findListenerPidForUrl(this.config.codex.appServerUrl);
    if (!listenerPid) {
      return;
    }

    if (this.appServerProcess?.pid === listenerPid && this.isProcessAlive(listenerPid)) {
      return;
    }

    await this.terminateProcessTree(listenerPid);
    this.appServerClient?.dispose();
    this.appServerClient = undefined;
    console.warn(`Reclaimed app-server port by killing stale listener pid ${listenerPid}`);
  }

  private async findListenerPidForUrl(urlText: string): Promise<number | undefined> {
    let port: number | undefined;
    try {
      const url = new URL(urlText);
      port = Number.parseInt(url.port, 10);
    } catch {
      return undefined;
    }

    if (!port || !Number.isFinite(port)) {
      return undefined;
    }

    const result = await runCommand("ss", ["-ltnp", `( sport = :${port} )`], {
      cwd: this.config.repoRoot,
      allowNonZeroExit: true
    }).catch(() => ({ stdout: "", stderr: "", exitCode: 1 }));
    const pidMatch = result.stdout.match(/pid=(\d+)/);
    return pidMatch ? Number.parseInt(pidMatch[1] ?? "", 10) : undefined;
  }

  private async readProcLink(pid: number, linkName: "cwd" | "exe"): Promise<string | undefined> {
    try {
      return await readlink(`/proc/${pid}/${linkName}`);
    } catch {
      return undefined;
    }
  }

  private async readProcessStartTicks(pid: number): Promise<number | undefined> {
    const statText = await readText(`/proc/${pid}/stat`).catch(() => "");
    if (!statText) {
      return undefined;
    }

    const closeParenIndex = statText.lastIndexOf(")");
    if (closeParenIndex === -1 || closeParenIndex + 2 >= statText.length) {
      return undefined;
    }

    const fields = statText.slice(closeParenIndex + 2).trim().split(/\s+/);
    const startTicksText = fields[19];
    if (!startTicksText) {
      return undefined;
    }

    const startTicks = Number.parseInt(startTicksText, 10);
    return Number.isFinite(startTicks) ? startTicks : undefined;
  }

  private inferRuntimeSlotFromPath(pathText?: string): RuntimeSlotName | undefined {
    if (!pathText) {
      return undefined;
    }
    const relative = path.relative(this.paths.runtimeDir, pathText);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      return undefined;
    }
    const slot = relative.split(path.sep, 1)[0];
    return slot === "stable-a" || slot === "stable-b" || slot === "preview" ? slot : undefined;
  }

  private async listSystemProcesses(): Promise<ProcessSnapshot[]> {
    const result = await runCommand(
      "ps",
      ["-eo", "pid=,ppid=,etimes=,%cpu=,%mem=,args="],
      {
        cwd: this.config.repoRoot,
        allowNonZeroExit: true
      }
    );
    const parsed = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const match = line.match(/^(\d+)\s+(\d+)\s+(\d+)\s+([0-9.]+)\s+([0-9.]+)\s+(.+)$/);
        if (!match) {
          return undefined;
        }
        const [, pidText, ppidText, elapsedText, cpuText, memText, args] = match;
        const argsText = args ?? "";
        return {
          pid: Number.parseInt(pidText ?? "", 10),
          ppid: Number.parseInt(ppidText ?? "", 10),
          elapsedSeconds: Number.parseInt(elapsedText ?? "", 10),
          cpuPercent: Number.parseFloat(cpuText ?? "0") || 0,
          memoryPercent: Number.parseFloat(memText ?? "0") || 0,
          processKey: `${pidText ?? ""}:unknown`,
          args: argsText,
          command: argsText.split(/\s+/, 1)[0] ?? argsText
        } satisfies ProcessSnapshot;
      })
      .filter((entry): entry is ProcessSnapshot => Boolean(entry));

    return await Promise.all(
      parsed.map(async (entry) => {
        const [startTicks, cwd, exe] = await Promise.all([
          this.readProcessStartTicks(entry.pid),
          this.readProcLink(entry.pid, "cwd"),
          this.readProcLink(entry.pid, "exe")
        ]);
        return {
          ...entry,
          processKey: `${entry.pid}:${startTicks ?? "unknown"}`,
          startTicks,
          cwd,
          exe
        } satisfies ProcessSnapshot;
      })
    );
  }

  private collectDescendantPids(rootPid: number, childrenByParent: Map<number, number[]>): Set<number> {
    const seen = new Set<number>([rootPid]);
    const queue = [rootPid];
    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined) {
        continue;
      }
      for (const childPid of childrenByParent.get(current) ?? []) {
        if (seen.has(childPid)) {
          continue;
        }
        seen.add(childPid);
        queue.push(childPid);
      }
    }
    return seen;
  }

  private async listFactoryProcesses(options: {
    includeArgs?: boolean;
    includeStaleOnly?: boolean;
    limit?: number;
  } = {}): Promise<FactoryProcessRecord[]> {
    const processes = await this.listSystemProcesses();
    const byPid = new Map(processes.map((entry) => [entry.pid, entry]));
    const childrenByParent = new Map<number, number[]>();
    for (const processInfo of processes) {
      const siblings = childrenByParent.get(processInfo.ppid) ?? [];
      siblings.push(processInfo.pid);
      childrenByParent.set(processInfo.ppid, siblings);
    }

    const activeWorkerRoots = this.collectActiveWorkerRoots();
    const runtimeRoots = this.collectRuntimeRoots();

    const appServerPid = await this.findListenerPidForUrl(this.config.codex.appServerUrl);
    const currentAppServerPid =
      this.appServerProcess?.pid && this.isProcessAlive(this.appServerProcess.pid)
        ? this.appServerProcess.pid
        : undefined;
    // Prefer specific tracked roots before the supervisor so descendants are
    // attributed to the component that actually owns them.
    const protectedRootPids = this.collectProtectedRootPids(activeWorkerRoots, runtimeRoots);
    const knownRoots = new Set<number>([
      ...(appServerPid ? [appServerPid] : []),
      ...activeWorkerRoots.keys(),
      ...runtimeRoots.keys(),
      process.pid
    ]);

    const descendantToRoot = new Map<number, number>();
    for (const rootPid of knownRoots) {
      for (const pid of this.collectDescendantPids(rootPid, childrenByParent)) {
        if (!descendantToRoot.has(pid)) {
          descendantToRoot.set(pid, rootPid);
        }
      }
    }

    const candidateProcesses = processes.filter((processInfo) => {
      if (descendantToRoot.has(processInfo.pid)) {
        return true;
      }
      if (
        this.inferRuntimeSlotFromPath(processInfo.cwd) ||
        processInfo.args.includes("chrome-devtools-mcp") ||
        processInfo.args.includes("apps/factory-manager-mcp/src/main.ts") ||
        (processInfo.args.includes("/opt/google/chrome/chrome") &&
          processInfo.args.includes("puppeteer_dev_chrome_profile")) ||
        (processInfo.args.includes("codex app-server") &&
          processInfo.args.includes(this.config.codex.appServerUrl))
      ) {
        return true;
      }
      return false;
    });

    const records = candidateProcesses.map((processInfo) => {
      const rootPid = descendantToRoot.get(processInfo.pid) ?? processInfo.pid;
      const rootProcess = byPid.get(rootPid);
      let kind: FactoryProcessRecord["kind"] = "other";
      let ownerKind: FactoryProcessRecord["ownerKind"] = "unknown";
      let ownerId: string | undefined;
      let active = false;
      const inferredRuntimeSlot =
        this.inferRuntimeSlotFromPath(processInfo.cwd) ?? this.inferRuntimeSlotFromPath(rootProcess?.cwd);

      if (processInfo.pid === process.pid) {
        kind = "supervisor";
        ownerKind = "supervisor";
        ownerId = this.config.projectId;
        active = true;
      } else if ((processInfo.pid === appServerPid || rootPid === appServerPid) && appServerPid) {
        kind = processInfo.args.includes("chrome-devtools-mcp")
          ? "browser_mcp"
          : processInfo.args.includes("apps/factory-manager-mcp/src/main.ts")
            ? "manager_mcp"
            : processInfo.args.includes("/opt/google/chrome/chrome")
              ? "chrome"
              : "app_server";
        ownerKind = "manager";
        ownerId = "manager";
        active = this.managerRunning || this.activeManagerTurnId !== undefined;
      } else if (activeWorkerRoots.has(rootPid)) {
        kind = processInfo.args.includes("chrome-devtools-mcp")
          ? "browser_mcp"
          : processInfo.args.includes("/opt/google/chrome/chrome")
            ? "chrome"
            : "worker";
        ownerKind = "task";
        ownerId = activeWorkerRoots.get(rootPid);
        active = true;
      } else if (runtimeRoots.has(rootPid)) {
        kind = "runtime";
        ownerKind = "runtime";
        ownerId = runtimeRoots.get(rootPid);
        active = true;
      } else if (inferredRuntimeSlot) {
        kind = "runtime";
        ownerKind = "runtime";
        ownerId = inferredRuntimeSlot;
      } else if (processInfo.args.includes("chrome-devtools-mcp")) {
        kind = "browser_mcp";
      } else if (processInfo.args.includes("apps/factory-manager-mcp/src/main.ts")) {
        kind = "manager_mcp";
      } else if (processInfo.args.includes("/opt/google/chrome/chrome")) {
        kind = "chrome";
      } else if (processInfo.args.includes("codex app-server") && processInfo.args.includes(this.config.codex.appServerUrl)) {
        kind = "app_server";
      }

      const stale =
        !active &&
        (kind === "app_server" || kind === "manager_mcp" || kind === "browser_mcp" || kind === "chrome");
      const effectiveStale =
        stale ||
        (kind === "app_server" &&
          processInfo.pid === appServerPid &&
          currentAppServerPid !== undefined &&
          processInfo.pid !== currentAppServerPid);
      const protectedProcess = protectedRootPids.has(rootPid) || protectedRootPids.has(processInfo.pid);
      const killable = effectiveStale && !protectedProcess && kind !== "supervisor";

      return {
        ...processInfo,
        args: options.includeArgs === false ? processInfo.command : processInfo.args,
        kind,
        ownerKind,
        ownerId,
        rootPid,
        rootProcessKey: rootProcess?.processKey,
        rootCwd: rootProcess?.cwd,
        active,
        stale: effectiveStale,
        protected: protectedProcess,
        killable
      } satisfies FactoryProcessRecord;
    });

    const filtered = options.includeStaleOnly ? records.filter((record) => record.stale) : records;
    return filtered
      .sort((left, right) => right.cpuPercent - left.cpuPercent || right.elapsedSeconds - left.elapsedSeconds)
      .slice(0, options.limit ?? 100);
  }

  private async terminateProcessTree(pid: number): Promise<void> {
    const processes = await this.listSystemProcesses();
    const childrenByParent = new Map<number, number[]>();
    for (const processInfo of processes) {
      const children = childrenByParent.get(processInfo.ppid) ?? [];
      children.push(processInfo.pid);
      childrenByParent.set(processInfo.ppid, children);
    }
    const descendants = [...this.collectDescendantPids(pid, childrenByParent)].sort((left, right) => right - left);
    for (const targetPid of descendants) {
      try {
        process.kill(targetPid, "SIGTERM");
      } catch {
        // Ignore dead processes while reaping.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    for (const targetPid of descendants) {
      if (!this.isProcessAlive(targetPid)) {
        continue;
      }
      try {
        process.kill(targetPid, "SIGKILL");
      } catch {
        // Ignore dead processes while reaping.
      }
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

  private collectActiveWorkerRoots(): Map<number, string> {
    const activeWorkerRoots = new Map<number, string>();
    for (const [taskId, child] of this.workerChildren.entries()) {
      if (child.pid && this.isProcessAlive(child.pid)) {
        activeWorkerRoots.set(child.pid, taskId);
      }
    }
    return activeWorkerRoots;
  }

  private collectRuntimeRoots(): Map<number, RuntimeSlotName> {
    const runtimeRoots = new Map<number, RuntimeSlotName>();
    for (const [slot, runtime] of this.runtimeProcesses.entries()) {
      if (runtime.child.pid && this.isProcessAlive(runtime.child.pid)) {
        runtimeRoots.set(runtime.child.pid, slot);
      }
    }
    return runtimeRoots;
  }

  private collectProtectedRootPids(
    activeWorkerRoots = this.collectActiveWorkerRoots(),
    runtimeRoots = this.collectRuntimeRoots()
  ): Set<number> {
    const protectedRoots = new Set<number>([process.pid]);
    if (this.appServerProcess?.pid && this.isProcessAlive(this.appServerProcess.pid)) {
      protectedRoots.add(this.appServerProcess.pid);
    }
    for (const pid of activeWorkerRoots.keys()) {
      protectedRoots.add(pid);
    }
    for (const pid of runtimeRoots.keys()) {
      protectedRoots.add(pid);
    }
    return protectedRoots;
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
        case "inspect_branch_diff":
        case "read_task_artifacts":
        case "inspect_deploy_state":
        case "inspect_factory_processes":
        case "kill_factory_process":
        case "get_factory_status":
          break;
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
      case "inspect_branch_diff":
        if (typeof args.branch === "string") {
          subject = `:${args.branch}->${typeof args.baseBranch === "string" ? args.baseBranch : "default"}`;
        }
        break;
      case "read_task_artifacts":
        if (typeof args.taskId === "string") {
          subject = `:${args.taskId}`;
        } else if (typeof args.branch === "string") {
          subject = `:${args.branch}`;
        }
        break;
      case "inspect_deploy_state":
        if (typeof args.target === "string") {
          subject = `:${args.target}`;
        }
        break;
      case "inspect_factory_processes":
        if (args.includeStaleOnly === true) {
          subject = ":stale";
        }
        break;
      case "kill_factory_process":
        if (typeof args.pid === "number") {
          subject = `:${args.pid}`;
        }
        break;
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
      case "inspect_branch_diff": {
        return await this.inspectBranchDiff(args);
      }
      case "read_task_artifacts": {
        return await this.readTaskArtifacts(args);
      }
      case "inspect_deploy_state": {
        return await this.inspectDeployState(args);
      }
      case "inspect_factory_processes": {
        const includeStaleOnly = Boolean(args.includeStaleOnly);
        const includeArgs = args.includeArgs !== false;
        const limit =
          typeof args.limit === "number" ? Math.max(1, Math.min(200, Math.trunc(args.limit))) : 100;
        return {
          processes: await this.listFactoryProcesses({ includeStaleOnly, includeArgs, limit })
        };
      }
      case "kill_factory_process": {
        const pid = Number(args.pid);
        const expectedProcessKey =
          typeof args.processKey === "string" && args.processKey.length > 0 ? args.processKey : undefined;
        if (!Number.isInteger(pid) || pid <= 0) {
          throw new Error("Missing required integer argument: pid");
        }
        const inventory = await this.listFactoryProcesses({ includeArgs: true, limit: 500 });
        const target = inventory.find((processInfo) => processInfo.pid === pid);
        if (!target) {
          throw new Error(`Refused to kill pid ${pid}; it is not currently recognized as a factory-owned process`);
        }
        if (expectedProcessKey && target.processKey !== expectedProcessKey) {
          throw new Error(
            `Refused to kill pid ${pid}; process identity changed from ${expectedProcessKey} to ${target.processKey}`
          );
        }
        if (!target.killable) {
          throw new Error(
            `Refused to kill pid ${pid}; kind=${target.kind} active=${target.active} stale=${target.stale} protected=${target.protected}`
          );
        }
        await this.terminateProcessTree(pid);
        return {
          pid,
          kind: target.kind,
          ownerKind: target.ownerKind,
          ownerId: target.ownerId,
          stale: target.stale,
          protected: target.protected,
          killable: target.killable,
          alive: this.isProcessAlive(pid)
        };
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

  private async inspectBranchDiff(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const branch = this.requireStringArg(args, "branch");
    const baseBranch =
      (typeof args.baseBranch === "string" && args.baseBranch.length > 0
        ? args.baseBranch
        : this.findTaskByBranch(branch)?.baseBranch) ?? this.config.candidateBranch;
    const expectedCommit = typeof args.commit === "string" ? args.commit : undefined;
    const pathspecs = Array.isArray(args.pathspecs)
      ? args.pathspecs.filter((value): value is string => typeof value === "string" && value.length > 0)
      : [];
    const branchHead = await currentCommit(this.config.repoRoot, branch);
    if (expectedCommit && branchHead !== expectedCommit) {
      throw new Error(
        `Branch ${branch} is at ${branchHead.slice(0, 12)}, not ${expectedCommit.slice(0, 12)}`
      );
    }
    const baseHead = await currentCommit(this.config.repoRoot, baseBranch);
    const aheadByResult = await runCommand(
      "git",
      ["rev-list", "--count", `${baseBranch}..${branch}`],
      { cwd: this.config.repoRoot, allowNonZeroExit: true }
    );
    const behindByResult = await runCommand(
      "git",
      ["rev-list", "--count", `${branch}..${baseBranch}`],
      { cwd: this.config.repoRoot, allowNonZeroExit: true }
    );
    const diffArgs = ["diff", "--stat=120", `${baseBranch}..${branch}`];
    const nameStatusArgs = ["diff", "--name-status", `${baseBranch}..${branch}`];
    const logArgs = ["log", "--oneline", "--no-merges", `${baseBranch}..${branch}`, "-n", "10"];
    if (pathspecs.length > 0) {
      diffArgs.push("--", ...pathspecs);
      nameStatusArgs.push("--", ...pathspecs);
    }
    const [diffStat, changedFiles, commitLog] = await Promise.all([
      runCommand("git", diffArgs, { cwd: this.config.repoRoot, allowNonZeroExit: true }),
      runCommand("git", nameStatusArgs, { cwd: this.config.repoRoot, allowNonZeroExit: true }),
      runCommand("git", logArgs, { cwd: this.config.repoRoot, allowNonZeroExit: true })
    ]);

    return {
      branch,
      baseBranch,
      branchHead,
      baseHead,
      aheadBy: Number.parseInt(aheadByResult.stdout.trim() || "0", 10) || 0,
      behindBy: Number.parseInt(behindByResult.stdout.trim() || "0", 10) || 0,
      changedFiles: changedFiles.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .slice(0, 100),
      diffStat: diffStat.stdout.trim(),
      commitLog: commitLog.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
    };
  }

  private async readTaskArtifacts(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const task =
      (typeof args.taskId === "string" ? this.db.getTask(args.taskId) : undefined) ??
      (typeof args.branch === "string" ? this.findTaskByBranch(args.branch) : undefined);
    if (!task) {
      throw new Error(`Unknown task target ${String(args.taskId ?? args.branch ?? "unknown")}`);
    }

    const includeLogTailLines =
      typeof args.includeLogTailLines === "number" ? Math.max(0, Math.min(200, args.includeLogTailLines)) : 40;
    const runs = this.db
      .listRuns(this.config.projectId)
      .filter((run) => run.taskId === task.id)
      .slice(0, 3);
    const latestEvent = this.getLatestTaskEvent(task.id);

    const runArtifacts = await Promise.all(
      runs.map(async (run) => {
        const rawFinal =
          (await readText(run.finalMessagePath).catch(() => undefined)) ??
          (await this.readLastAgentMessageFromJsonl(run.jsonlLogPath).catch(() => undefined));
        let parsedFinal: Record<string, unknown> | string | undefined;
        if (rawFinal) {
          try {
            parsedFinal = JSON.parse(rawFinal) as Record<string, unknown>;
          } catch {
            parsedFinal = rawFinal;
          }
        }

        return {
          id: run.id,
          role: run.role,
          status: run.status,
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
          final: parsedFinal,
          logTail: await this.readFileTail(run.jsonlLogPath, includeLogTailLines),
          stderrTail: await this.readFileTail(path.join(run.runDirectory, "stderr.log"), includeLogTailLines)
        };
      })
    );

    return {
      task: {
        id: task.id,
        title: task.title,
        status: task.status,
        branchName: task.branchName,
        baseBranch: task.baseBranch,
        worktreePath: task.worktreePath,
        latestEvent
      },
      runs: runArtifacts
    };
  }

  private async inspectDeployState(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const target =
      typeof args.target === "string" && ["stable", "preview", "all"].includes(args.target)
        ? (args.target as "stable" | "preview" | "all")
        : "all";
    const includeLogTailLines =
      typeof args.includeLogTailLines === "number" ? Math.max(0, Math.min(200, args.includeLogTailLines)) : 40;
    const snapshot = this.db.getDeploymentSnapshot(this.config.projectId);

    return {
      requestedTarget: target,
      deployments:
        target === "stable"
          ? { stable: snapshot.stable }
          : target === "preview"
            ? { preview: snapshot.preview }
            : snapshot,
      runtimeProcesses:
        target === "stable"
          ? {
              stable: await this.inspectRuntimeSlotState(snapshot.stable.activeSlot, includeLogTailLines)
            }
          : target === "preview"
            ? {
                preview: await this.inspectRuntimeSlotState("preview", includeLogTailLines)
              }
            : {
                stable: await this.inspectRuntimeSlotState(snapshot.stable.activeSlot, includeLogTailLines),
                preview: await this.inspectRuntimeSlotState("preview", includeLogTailLines)
              }
    };
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

    if (this.stopRequested) {
      return;
    }

    const runningWorkers = this.db
      .listAgents(this.config.projectId)
      .filter((agent) => agent.role !== "manager" && agent.status === "running").length;
    if (runningWorkers >= this.config.scheduler.maxWorkers) {
      return;
    }

    await this.startWorker(normalized, normalized.kind === "test" ? "test" : "code");
  }

  private async ensureInjectedWorktreeFiles(worktreePath: string): Promise<void> {
    for (const relativePath of ["AGENTS.md"]) {
      const sourcePath = path.join(this.config.repoRoot, relativePath);
      const targetPath = path.join(worktreePath, relativePath);
      if (!(await fileExists(sourcePath)) || (await fileExists(targetPath))) {
        continue;
      }
      await writeText(targetPath, await readText(sourcePath));
    }
  }

  private async removeInjectedOnlyWorktreePathIfSafe(worktreePath: string): Promise<void> {
    if (!(await fileExists(worktreePath))) {
      return;
    }
    if (await fileExists(path.join(worktreePath, ".git"))) {
      return;
    }
    const entries = await readdir(worktreePath).catch(() => []);
    if (entries.length === 0 || entries.every((entry) => entry === "AGENTS.md")) {
      await rm(worktreePath, { recursive: true, force: true });
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
      runtime: { maxRuntimeMinutes: 60, reasoningEffort: "medium" },
      constraints: {
        ...task.contract.constraints,
        mustRunChecks: []
      }
    };
    await this.startWorker(reviewTask, "review");
  }

  private async commitTaskWorktree(
    contract: Pick<TaskContract, "id" | "title" | "commitMessageHint" | "branchName" | "worktreePath">,
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
    await runCommand("git", ["reset", "--", ".factory.env", "AGENTS.md"], {
      cwd: contract.worktreePath,
      allowNonZeroExit: true
    });

    const stagedChanges = await this.listRelevantWorktreeChanges(contract.worktreePath);
    if (stagedChanges.length === 0) {
      return undefined;
    }

    const commitMessage = selectTaskCommitMessage({
      taskId: contract.id,
      title: contract.title,
      commitMessageHint: contract.commitMessageHint,
      recommendedCommitMessage,
      summary
    });
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
      .filter((file) => file.length > 0 && file !== ".factory.env" && file !== "AGENTS.md");
  }

  private getLatestTaskEvent(taskId: string): { at: string; type: string; summary: string; payload?: Record<string, unknown> } | undefined {
    const latestTaskEvent = this.db.getLatestTaskEvent(taskId);
    return latestTaskEvent
      ? {
          at: latestTaskEvent.at,
          type: latestTaskEvent.type,
          summary: latestTaskEvent.summary,
          payload: latestTaskEvent.payload
        }
      : undefined;
  }

  private async readFileTail(filePath: string, maxLines: number): Promise<string[]> {
    if (maxLines <= 0) {
      return [];
    }
    const raw = await readText(filePath).catch(() => undefined);
    if (!raw) {
      return [];
    }
    return raw
      .split(/\r?\n/)
      .filter((line) => line.length > 0)
      .slice(-maxLines);
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
    if (this.stopRequested) {
      return;
    }
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
        this.logLifecycle("task_start_failed", {
          taskId: task.id,
          role: task.kind === "test" ? "test" : "code",
          error
        });
        this.writeHeartbeat("task_start_failed", {
          taskId: task.id,
          role: task.kind === "test" ? "test" : "code",
          error
        });
        console.error(`task ${task.id} failed to start: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private async startWorker(
    contract: TaskContract,
    role: "code" | "review" | "test"
  ): Promise<void> {
    const workerSandboxCapabilities = await this.ensureWorkerSandboxCapabilities();
    const projectSpecExcerpt = await this.loadProjectSpecExcerpt();
    const existingTaskRecord = this.db.getTask(contract.id);
    const worktreeId = contract.id;
    const worktreePath = contract.worktreePath;
    const branchName = contract.branchName;
    const baseBranch = contract.baseBranch || this.config.candidateBranch;
    const reusesExistingWorktree =
      existingTaskRecord?.worktreePath === worktreePath &&
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
      context: {
        ...portAwareContract.context,
        projectSpecPath: portAwareContract.context.projectSpecPath ?? this.config.projectSpecPath,
        projectSpecExcerpt: portAwareContract.context.projectSpecExcerpt ?? projectSpecExcerpt
      },
      ports: {
        ...(portAwareContract.ports.app !== undefined ? { app: portAwareContract.ports.app } : {}),
        ...(portAwareContract.ports.e2e !== undefined ? { e2e: portAwareContract.ports.e2e } : {}),
        ...(allocatedPorts.app !== undefined ? { app: allocatedPorts.app } : {}),
        ...(allocatedPorts.e2e !== undefined ? { e2e: allocatedPorts.e2e } : {})
      }
    };
    if (!reusesExistingWorktree) {
      await this.removeInjectedOnlyWorktreePathIfSafe(worktreePath);
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
    await this.ensureInjectedWorktreeFiles(worktreePath);

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
    this.logLifecycle("worker_spawned", {
      taskId: normalized.id,
      role,
      branchName,
      worktreePath,
      runId,
      pid: child.pid
    });
    this.writeHeartbeat("worker_spawned", {
      taskId: normalized.id,
      role,
      branchName,
      worktreePath,
      runId,
      pid: child.pid
    });

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

    child.on("exit", async (code, signal) => {
      this.logLifecycle("worker_process_exit", {
        taskId: normalized.id,
        role,
        runId,
        pid: child.pid,
        code,
        signal
      });
      this.writeHeartbeat("worker_process_exit", {
        taskId: normalized.id,
        role,
        runId,
        pid: child.pid,
        code,
        signal
      });
      try {
        if (this.shuttingDown) {
          this.db.finishRun(runId, "failed");
          return;
        }
        await this.handleWorkerExit(normalized, role, runId, {
          finalMessagePath,
          jsonlLogPath
        });
      } catch (error) {
        this.logLifecycle("worker_exit_handling_failed", {
          taskId: normalized.id,
          role,
          runId,
          error
        });
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
      const ensured = await this.ensureRuntimeProcess(activeSlot, snapshot.stable.commit, activePort);
      if (ensured.ok) {
        if (snapshot.stable.status !== "healthy" || snapshot.stable.activeSlot !== activeSlot) {
          this.db.recordDeployment({
            projectId: this.config.projectId,
            target: "stable",
            status: "healthy",
            url: stableUrl,
            commit: snapshot.stable.commit,
            activeSlot,
            reason: "stable runtime healthy"
          });
        }
      } else {
        this.db.recordDeployment({
          projectId: this.config.projectId,
          target: "stable",
          status: "down",
          url: stableUrl,
          commit: snapshot.stable.commit,
          activeSlot,
          reason:
            ensured.reason === "serve_script_not_configured"
              ? "stable serve script not configured"
              : "stable slot failed healthcheck"
        });
      }
    } else {
      await this.bootstrapStableRuntime();
    }

    if (snapshot.preview.commit) {
      const ensured = await this.ensureRuntimeProcess(
        "preview",
        snapshot.preview.commit,
        this.config.ports.preview
      );
      if (ensured.ok) {
        if (snapshot.preview.status !== "healthy") {
          this.db.recordDeployment({
            projectId: this.config.projectId,
            target: "preview",
            status: "healthy",
            url: previewUrl,
            commit: snapshot.preview.commit,
            reason: "preview runtime healthy"
          });
        }
      } else {
        this.db.recordDeployment({
          projectId: this.config.projectId,
          target: "preview",
          status: "down",
          url: previewUrl,
          commit: snapshot.preview.commit,
          reason:
            ensured.reason === "serve_script_not_configured"
              ? "preview serve script not configured"
              : "preview slot failed healthcheck"
        });
      }
    }
  }

  private async bootstrapStableRuntime(): Promise<void> {
    const commit = await currentCommit(this.config.repoRoot, this.config.defaultBranch);
    const ensured = await this.ensureRuntimeProcess("stable-a", commit, this.config.ports.stableA);
    if (!ensured.ok && ensured.reason === "serve_script_not_configured") {
      return;
    }
    await this.ensureStableProxyServer();
    const stableUrl = await this.resolveStableUrl();
    this.db.recordDeployment({
      projectId: this.config.projectId,
      target: "stable",
      status: ensured.ok ? "healthy" : "down",
      url: stableUrl,
      commit,
      activeSlot: "stable-a",
      reason:
        ensured.ok
          ? "bootstrap stable runtime"
          : ensured.reason === "serve_script_not_configured"
            ? "stable serve script not configured"
            : "bootstrap stable runtime failed"
    });
  }

  private async deployPreview(commit: string, reason: string): Promise<void> {
    const ensured = await this.ensureRuntimeProcess("preview", commit, this.config.ports.preview);
    if (!ensured.ok && ensured.reason === "serve_script_not_configured") {
      throw new Error("Preview serve script is not configured");
    }
    const previewUrl = await this.resolvePreviewUrl();
    this.db.recordDeployment({
      projectId: this.config.projectId,
      target: "preview",
      status: ensured.ok ? "healthy" : "down",
      url: previewUrl,
      commit,
      reason
    });
    await this.sendTelegramMessage(
      ensured.ok ? "info_update" : "incident_alert",
      ensured.ok
        ? `Preview updated: ${previewUrl}\nCommit: ${commit.slice(0, 12)}\n${reason}`
        : `Preview deployment failed for ${commit.slice(0, 12)}.\nExpected URL: ${previewUrl}\n${reason}`
    );
  }

  private async promoteCandidate(commit: string, reason: string): Promise<void> {
    const currentStable = this.db.getDeploymentSnapshot(this.config.projectId).stable;
    const nextSlot: RuntimeSlotName = currentStable.activeSlot === "stable-a" ? "stable-b" : "stable-a";
    const ensured = await this.ensureRuntimeProcess(nextSlot, commit, this.runtimeSlotPort(nextSlot));
    if (!ensured.ok && ensured.reason === "serve_script_not_configured") {
      throw new Error("Stable serve script is not configured");
    }
    const stableUrl = await this.resolveStableUrl();
    if (!ensured.ok) {
      this.db.recordDeployment({
        projectId: this.config.projectId,
        target: "stable",
        status: "down",
        url: stableUrl,
        commit,
        activeSlot: nextSlot,
        reason
      });
      await this.sendTelegramMessage(
        "incident_alert",
        `Stable promotion failed for ${commit.slice(0, 12)}.\nExpected URL: ${stableUrl}\n${reason}`
      );
      return;
    }

    const currentDefaultHead = await currentCommit(this.config.repoRoot, this.config.defaultBranch);
    const mergeBase = await runCommand("git", ["merge-base", this.config.defaultBranch, commit], {
      cwd: this.config.repoRoot
    });
    if (mergeBase.stdout.trim() !== currentDefaultHead) {
      throw new Error(`Cannot fast-forward ${this.config.defaultBranch} to ${commit.slice(0, 12)}`);
    }
    await updateGitBranchRef(this.config.repoRoot, this.config.defaultBranch, commit);
    await this.refreshProjectState();
    this.db.recordDeployment({
      projectId: this.config.projectId,
      target: "stable",
      status: "healthy",
      url: stableUrl,
      commit,
      activeSlot: nextSlot,
      reason
    });
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
    const currentStable = this.db.getDeploymentSnapshot(this.config.projectId).stable;
    const nextSlot: RuntimeSlotName = currentStable.activeSlot === "stable-a" ? "stable-b" : "stable-a";
    const ensured = await this.ensureRuntimeProcess(nextSlot, commit, this.runtimeSlotPort(nextSlot));
    if (!ensured.ok && ensured.reason === "serve_script_not_configured") {
      throw new Error("Stable serve script is not configured");
    }
    const stableUrl = await this.resolveStableUrl();
    if (ensured.ok) {
      await updateGitBranchRef(this.config.repoRoot, this.config.defaultBranch, commit);
      await this.refreshProjectState();
    }
    this.db.recordDeployment({
      projectId: this.config.projectId,
      target: "stable",
      status: ensured.ok ? "healthy" : "down",
      url: stableUrl,
      commit,
      activeSlot: nextSlot,
      reason: rollbackTag ? `${reason} (${rollbackTag})` : reason
    });
    await this.sendTelegramMessage(
      ensured.ok ? "ship_result" : "incident_alert",
      ensured.ok
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
    port: number
  ): Promise<RuntimeEnsureResult> {
    const worktreePath = this.runtimeSlotWorktreePath(slot);
    const existing = this.runtimeProcesses.get(slot);
    if (existing && existing.child.exitCode === null && existing.commit === commit) {
      const scripts = await this.resolveRuntimeScriptsForWorktree(slot, existing.worktreePath);
      if (
        existing.script === scripts.serveScript &&
        existing.healthcheckScript === scripts.healthcheckScript
      ) {
        try {
          await this.runRuntimeHealthcheck(worktreePath, port, scripts.healthcheckScript);
          return {
            ok: true,
            reason: "healthy",
            scripts
          };
        } catch {
          await this.stopRuntimeProcess(slot);
        }
      } else {
        await this.stopRuntimeProcess(slot);
      }
    }

    await this.stopRuntimeProcess(slot);
    await this.stopOrphanRuntimeListeners(port);
    const scripts = await this.prepareRuntimeWorktree(slot, commit, port);
    const deployIdentity = await this.buildRuntimeDeployIdentity(slot, commit, port);
    if (isPlaceholderScript(scripts.serveScript)) {
      return {
        ok: false,
        reason: "serve_script_not_configured",
        scripts
      };
    }

    const stdoutPath = path.join(this.paths.logsDir, `${slot}.out.log`);
    const stderrPath = path.join(this.paths.logsDir, `${slot}.err.log`);
    const started = await spawnLoggedShellCommand({
      script: scripts.serveScript,
      cwd: worktreePath,
      env: this.buildRuntimeEnvironment(port, deployIdentity),
      stdoutPath,
      stderrPath
    });
    this.runtimeProcesses.set(slot, {
      child: started.child,
      commit,
      worktreePath,
      port,
      script: scripts.serveScript,
      healthcheckScript: scripts.healthcheckScript
    });
    started.child.on("exit", () => {
      const current = this.runtimeProcesses.get(slot);
      if (current?.child.pid === started.child.pid) {
        this.runtimeProcesses.delete(slot);
      }
    });

    try {
      await this.runRuntimeHealthcheck(worktreePath, port, scripts.healthcheckScript);
      return {
        ok: true,
        reason: "healthy",
        scripts
      };
    } catch (error) {
      await this.stopRuntimeProcess(slot);
      console.error(`${slot} healthcheck failed: ${error instanceof Error ? error.message : String(error)}`);
      return {
        ok: false,
        reason: "healthcheck_failed",
        scripts
      };
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

  private configuredServeScriptForSlot(slot: RuntimeSlotName): string {
    return slot === "preview" ? this.config.scripts.servePreview : this.config.scripts.serveStable;
  }

  private async safeConfiguredScriptForWorktree(
    worktreePath: string,
    script: string,
    placeholderLabel: "build" | "serve" | "healthcheck"
  ): Promise<string> {
    if (!/^(npm|pnpm|yarn|bun)\s+run\b/i.test(script.trim())) {
      return script;
    }

    return (await fileExists(path.join(worktreePath, "package.json")))
      ? script
      : `echo '${placeholderLabel} script not configured'`;
  }

  private async resolveRuntimeScriptsForWorktree(
    slot: RuntimeSlotName,
    worktreePath: string
  ): Promise<ResolvedRuntimeScripts> {
    const detected = await detectPackageManagerAndScripts(worktreePath);
    const detectedServeScript =
      slot === "preview" ? detected.scripts.servePreview : detected.scripts.serveStable;
    const configuredBuildScript = await this.safeConfiguredScriptForWorktree(
      worktreePath,
      this.config.scripts.build,
      "build"
    );
    const configuredServeScript = await this.safeConfiguredScriptForWorktree(
      worktreePath,
      this.configuredServeScriptForSlot(slot),
      "serve"
    );
    const configuredHealthcheckScript = await this.safeConfiguredScriptForWorktree(
      worktreePath,
      this.config.scripts.healthcheck,
      "healthcheck"
    );
    return {
      worktreePath,
      buildScript: resolveRuntimeScriptCommand(detected.scripts.build, configuredBuildScript),
      serveScript: resolveRuntimeScriptCommand(
        detectedServeScript,
        configuredServeScript
      ),
      healthcheckScript: resolveRuntimeScriptCommand(
        detected.scripts.healthcheck,
        configuredHealthcheckScript
      )
    };
  }

  private async prepareRuntimeWorktree(
    slot: RuntimeSlotName,
    commit: string,
    port: number
  ): Promise<ResolvedRuntimeScripts> {
    const worktreePath = this.runtimeSlotWorktreePath(slot);
    await ensureDir(path.dirname(worktreePath));
    await ensureDetachedWorktreeAtRef(this.config.repoRoot, worktreePath, commit);
    const bootstrapScript = await this.resolveBootstrapWorktreeScriptPath(worktreePath);
    if (bootstrapScript) {
      await runCommand("bash", [bootstrapScript, worktreePath], {
        cwd: worktreePath,
        env: this.buildRuntimeEnvironment(port)
      });
    }
    const scripts = await this.resolveRuntimeScriptsForWorktree(slot, worktreePath);
    if (!isPlaceholderScript(scripts.buildScript)) {
      await runCommand("bash", ["-lc", scripts.buildScript], {
        cwd: worktreePath,
        env: this.buildRuntimeEnvironment(port)
      });
    }
    await this.writeRuntimeDeployIdentity(slot, commit, port, worktreePath);
    return scripts;
  }

  private buildRuntimeEnvironment(
    port: number,
    deployIdentity?: RuntimeDeployIdentity
  ): NodeJS.ProcessEnv {
    return {
      ...process.env,
      PORT: String(port),
      FACTORY_APP_PORT: String(port),
      ...(deployIdentity
        ? {
            PERMAFACTORY_DEPLOY_TARGET: deployIdentity.target,
            PERMAFACTORY_DEPLOY_SLOT: deployIdentity.slot,
            PERMAFACTORY_DEPLOY_COMMIT: deployIdentity.commit,
            ...(deployIdentity.branch ? { PERMAFACTORY_DEPLOY_BRANCH: deployIdentity.branch } : {}),
            PERMAFACTORY_DEPLOY_URL: deployIdentity.url
          }
        : {})
    };
  }

  private async buildRuntimeDeployIdentity(
    slot: RuntimeSlotName,
    commit: string,
    port: number
  ): Promise<RuntimeDeployIdentity> {
    const target = slot === "preview" ? "preview" : "stable";
    const branch = await this.resolveDeployedBranch(target, commit);
    return {
      target,
      slot,
      commit,
      branch,
      port,
      url: await resolveReachableHttpUrl(target === "preview" ? this.config.ports.preview : this.config.ports.stableProxy),
      generatedAt: nowIso()
    };
  }

  private async resolveDeployedBranch(
    target: "stable" | "preview",
    commit: string
  ): Promise<string | undefined> {
    const preferredBranch = target === "preview" ? this.config.candidateBranch : this.config.defaultBranch;
    const preferredHead = await currentCommit(this.config.repoRoot, preferredBranch).catch(() => undefined);
    if (preferredHead === commit) {
      return preferredBranch;
    }

    const containingBranches = await runCommand(
      "git",
      ["for-each-ref", "--format=%(refname:short)", `--contains=${commit}`, "refs/heads"],
      {
        cwd: this.config.repoRoot,
        allowNonZeroExit: true
      }
    );
    const branches = containingBranches.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    return branches.includes(preferredBranch) ? preferredBranch : branches[0];
  }

  private async writeRuntimeDeployIdentity(
    slot: RuntimeSlotName,
    commit: string,
    port: number,
    worktreePath: string
  ): Promise<RuntimeDeployIdentity> {
    const identity = await this.buildRuntimeDeployIdentity(slot, commit, port);
    const payload = `${JSON.stringify(identity, null, 2)}\n`;
    const relativePath = path.join("__permafactory", "deploy-state.json");
    const candidatePaths = [path.join(worktreePath, relativePath)];
    if (await fileExists(path.join(worktreePath, "dist"))) {
      candidatePaths.push(path.join(worktreePath, "dist", relativePath));
    }
    for (const candidatePath of candidatePaths) {
      await writeText(candidatePath, payload).catch(() => undefined);
    }
    return identity;
  }

  private async inspectRuntimeSlotState(
    slot: RuntimeSlotName,
    includeLogTailLines: number
  ): Promise<Record<string, unknown>> {
    const current = this.runtimeProcesses.get(slot);
    const stdoutPath = path.join(this.paths.logsDir, `${slot}.out.log`);
    const stderrPath = path.join(this.paths.logsDir, `${slot}.err.log`);
    return {
      slot,
      port: this.runtimeSlotPort(slot),
      pid: current?.child.pid,
      commit: current?.commit,
      worktreePath: current?.worktreePath,
      serveScript: current?.script,
      healthcheckScript: current?.healthcheckScript,
      stdoutTail: await this.readFileTail(stdoutPath, includeLogTailLines),
      stderrTail: await this.readFileTail(stderrPath, includeLogTailLines)
    };
  }

  private async resolveBootstrapWorktreeScriptPath(worktreePath: string): Promise<string | undefined> {
    const worktreeConfig = await loadProjectConfig(worktreePath).catch(() => undefined);
    const candidates = [
      worktreeConfig?.scripts.bootstrapWorktree,
      this.config.scripts.bootstrapWorktree,
      "scripts/bootstrap-worktree.sh",
      ".factory/scripts/bootstrap-worktree.sh"
    ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);

    for (const candidate of candidates) {
      const resolved = path.isAbsolute(candidate) ? candidate : path.resolve(worktreePath, candidate);
      if (await fileExists(resolved)) {
        return resolved;
      }
    }

    return undefined;
  }

  private async stopOrphanRuntimeListeners(port: number): Promise<void> {
    const result = await runCommand(
      "bash",
      ["-lc", `ss -ltnp '( sport = :${port} )'`],
      {
        cwd: this.config.repoRoot,
        allowNonZeroExit: true
      }
    );
    const pids = [...result.stdout.matchAll(/pid=(\d+)/g)]
      .map((match) => Number.parseInt(match[1] ?? "", 10))
      .filter((pid) => Number.isFinite(pid) && pid !== process.pid);

    if (pids.length === 0) {
      return;
    }

    const inventory = await this.listFactoryProcesses({ includeArgs: true, limit: 500 });
    for (const pid of new Set(pids)) {
      const record = inventory.find((processInfo) => processInfo.pid === pid);
      if (!record) {
        console.warn(`Refused to kill unknown listener pid ${pid} on managed port ${port}`);
        continue;
      }

      const targetPid = record.rootPid ?? record.pid;
      const targetRecord = inventory.find((processInfo) => processInfo.pid === targetPid) ?? record;
      const runtimeOwned = targetRecord.kind === "runtime" || targetRecord.ownerKind === "runtime";
      if (!runtimeOwned && !targetRecord.killable) {
        console.warn(
          `Refused to kill listener pid ${pid} on managed port ${port}; kind=${targetRecord.kind} active=${targetRecord.active} stale=${targetRecord.stale} protected=${targetRecord.protected}`
        );
        continue;
      }

      await this.terminateProcessTree(targetPid);
    }
  }

  private async runRuntimeHealthcheck(
    worktreePath: string,
    port: number,
    healthcheckScript: string
  ): Promise<void> {
    await waitForSuccessfulCommand(healthcheckScript, {
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
      this.stableProxyServer?.listen(this.config.ports.stableProxy, "0.0.0.0", () => {
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

    const deployIdentity = await this.buildRuntimeDeployIdentity(
      target.slot,
      this.db.getDeploymentSnapshot(this.config.projectId).stable.commit,
      this.config.ports.stableProxy
    );
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (requestUrl.pathname === "/__permafactory/deploy-state.json") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(`${JSON.stringify(deployIdentity, null, 2)}\n`);
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
        response.writeHead(proxyResponse.statusCode ?? 502, {
          ...proxyResponse.headers,
          "x-permafactory-deploy-target": deployIdentity.target,
          "x-permafactory-deploy-slot": deployIdentity.slot,
          "x-permafactory-deploy-commit": deployIdentity.commit,
          ...(deployIdentity.branch ? { "x-permafactory-deploy-branch": deployIdentity.branch } : {})
        });
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
    const specPath = contract.context.projectSpecPath ?? this.config.projectSpecPath;
    const specExcerpt = contract.context.projectSpecExcerpt;
    const projectGrounding = [
      "Project grounding:",
      `- canonical project spec path: ${specPath}`,
      "- before you code, review, or test, read the repo's AGENTS.md and the project spec",
      "- if current code drift conflicts with the spec and there is no newer user instruction overriding it, bias toward the spec"
    ];
    if (specExcerpt) {
      projectGrounding.push("", "Project spec excerpt:", specExcerpt);
    }

    return `${prompt}\n\n${projectGrounding.join("\n")}\n\nReturn JSON only matching this schema:\n${schema}\n\nTask contract:\n${JSON.stringify(contract, null, 2)}\n`;
  }

  private async ensureAppServer(): Promise<void> {
    await this.ensureOwnedAppServerListener();
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
      const listenerPid = await this.findListenerPidForUrl(this.config.codex.appServerUrl);
      if (listenerPid) {
        await this.terminateProcessTree(listenerPid);
      }
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
    const mergedScripts = { ...detected.scripts };
    for (const key of Object.keys(mergedScripts) as Array<keyof typeof mergedScripts>) {
      const detectedScript = mergedScripts[key];
      const existingScript = this.config.scripts[key];
      mergedScripts[key] =
        isPlaceholderScript(detectedScript) && !isPlaceholderScript(existingScript)
          ? existingScript
          : detectedScript;
    }

    if (JSON.stringify(mergedScripts) === JSON.stringify(this.config.scripts)) {
      return;
    }

    this.config = {
      ...this.config,
      scripts: mergedScripts
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

        if (request.method === "GET" && url.pathname === "/deploy-state") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify(await this.inspectDeployState({ target: "all", includeLogTailLines: 20 }), null, 2)
          );
          return;
        }

        if (request.method === "POST" && url.pathname === "/telegram/webhook") {
          await this.handleTelegramWebhook(request, response);
          return;
        }

        if (request.method === "POST" && url.pathname === "/internal/manager-tool") {
          const authorization = request.headers.authorization;
          const remoteAddress = request.socket.remoteAddress;
          const isLoopback =
            remoteAddress === "127.0.0.1" ||
            remoteAddress === "::1" ||
            remoteAddress === "::ffff:127.0.0.1";
          if (!isLoopback && authorization !== `Bearer ${this.managerToolToken}`) {
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

        if (request.method === "POST" && url.pathname === "/internal/stop") {
          const authorization = request.headers.authorization;
          const remoteAddress = request.socket.remoteAddress;
          const isLoopback =
            remoteAddress === "127.0.0.1" ||
            remoteAddress === "::1" ||
            remoteAddress === "::ffff:127.0.0.1";
          if (!isLoopback && authorization !== `Bearer ${this.managerToolToken}`) {
            response.writeHead(403, { "content-type": "application/json" });
            response.end(JSON.stringify({ ok: false, error: "forbidden" }));
            return;
          }

          const body = (await this.readJsonRequestBody(request).catch(() => ({}))) as Record<string, unknown>;
          const reason =
            typeof body.reason === "string" && body.reason.trim().length > 0
              ? body.reason.trim()
              : "internal_stop";
          response.writeHead(202, { "content-type": "application/json" });
          response.end(JSON.stringify({ ok: true, stopping: true, reason }));
          setImmediate(() => {
            void this.requestShutdown(reason);
          });
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
    await this.processTelegramUpdate(update);

    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  }

  private async startTelegramPollingFallback(): Promise<void> {
    if (this.telegramPollingTask) {
      return;
    }

    const botToken = process.env[this.config.telegram.botTokenEnvVar];
    if (!botToken || !this.config.telegram.controlChatId) {
      return;
    }

    const webhookConfigured = await this.isTelegramWebhookConfigured(botToken);
    if (webhookConfigured) {
      return;
    }

    this.telegramPollingTask = this.runTelegramPollingLoop(botToken);
  }

  private async isTelegramWebhookConfigured(botToken: string): Promise<boolean> {
    try {
      const info = await sendTelegramApiRequest<{ url?: string }>(botToken, "getWebhookInfo", {});
      return Boolean(info.url && info.url.trim().length > 0);
    } catch (error) {
      console.error(`telegram webhook probe failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  private async runTelegramPollingLoop(botToken: string): Promise<void> {
    let offset: number | undefined;

    while (!this.stopRequested) {
      try {
        const updates = await pollTelegramUpdates(botToken, offset);
        for (const update of updates) {
          const updateId = typeof update.update_id === "number" ? update.update_id : undefined;
          if (updateId !== undefined) {
            offset = updateId + 1;
          }
          await this.processTelegramUpdate(update);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/webhook/i.test(message) && /getUpdates/i.test(message)) {
          console.log("[telegram] polling fallback disabled because a webhook is configured");
          return;
        }
        console.error(`telegram polling failed: ${message}`);
        if (!this.stopRequested) {
          await new Promise((resolve) => setTimeout(resolve, 5000));
        }
      }
    }
  }

  private async processTelegramUpdate(update: Record<string, unknown>): Promise<void> {
    const botToken = process.env[this.config.telegram.botTokenEnvVar];
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
      if (matchesTelegramSlashCommand(message.text, "stop")) {
        await this.handleStopCommand(
          message.text,
          message.message_id ? String(message.message_id) : undefined,
          message.chat?.id ? String(message.chat.id) : undefined
        );
        return;
      }

      const secretCommand = this.parseSecretCommand(message.text);
      if (secretCommand) {
        await this.handleSecretCommand(secretCommand, message.message_id ? String(message.message_id) : undefined);
        return;
      }

      const externalId = message.message_id ? String(message.message_id) : undefined;
      const alreadyQueued = externalId
        ? this.db
            .listInboxItems(this.config.projectId)
            .some((item) => item.source === "telegram" && item.externalId === externalId)
        : false;
      if (!alreadyQueued) {
        this.db.insertInboxItem({
          id: randomId("inbox"),
          projectId: this.config.projectId,
          source: "telegram",
          externalId,
          receivedAt: nowIso(),
          text: message.text,
          status: "new"
        });
        this.db.insertTelegramMessage({
          id: randomId("telegram"),
          projectId: this.config.projectId,
          telegramMessageId: externalId,
          chatId: message.chat?.id ? String(message.chat.id) : undefined,
          direction: "inbound",
          kind: "message",
          text: message.text
        });
        await this.interruptManagerIfRunning();
        this.pendingManagerWakeReasons.add("telegram_message");
      }
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

  private async handleStopCommand(
    originalText: string,
    replyToMessageId?: string,
    chatId?: string
  ): Promise<void> {
    this.db.insertTelegramMessage({
      id: randomId("telegram"),
      projectId: this.config.projectId,
      telegramMessageId: replyToMessageId,
      chatId,
      direction: "inbound",
      kind: "command",
      text: originalText
    });
    await this.sendTelegramMessage(
      "info_update",
      "Stopping the factory now. Active workers, preview, and stable runtimes are being shut down cleanly.",
      replyToMessageId,
      undefined,
      undefined,
      { isDirectUserResponse: true }
    );
    await this.requestShutdown("telegram_stop");
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
