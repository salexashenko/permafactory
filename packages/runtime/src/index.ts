import AjvModule, { type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { randomUUID, createHash } from "node:crypto";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import type {
  DecisionRequest,
  DecisionBudgetSnapshot,
  DeploymentIntent,
  FactoryProjectConfig,
  ManagerTurnInput,
  ManagerTurnOutput,
  PortLeaseRequirement,
  ReasoningEffort,
  TaskContract,
  TelegramOutboundKind,
  WorkerSandboxCapabilities
} from "@permafactory/models";

const execFileAsync = promisify(execFile);
const AjvCtor = AjvModule as unknown as new (options: Record<string, unknown>) => {
  compile<T>(schema: object): ValidateFunction<T>;
};
const addFormats = addFormatsModule as unknown as (ajvInstance: object) => void;

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface SpawnedProcess {
  pid: number | undefined;
  child: ReturnType<typeof spawn>;
}

export interface FactoryPaths {
  repoRoot: string;
  configPath: string;
  factoryRoot: string;
  dbPath: string;
  tasksDir: string;
  logsDir: string;
  worktreesDir: string;
  runtimeDir: string;
  runsDir: string;
  scriptsDir: string;
  bootstrapScriptPath: string;
  lockPath: string;
  supervisorPidPath: string;
  heartbeatPath: string;
  lifecycleLogPath: string;
  managerToolTokenPath: string;
}

export interface NormalizeManagerTurnOutputOptions {
  candidateBranch: string;
  worktreesDir: string;
  now?: string;
  createId?: (prefix: string) => string;
}

export interface ReachableHostCandidates {
  tailscaleDnsName?: string;
  tailscaleIp?: string;
  lanIp?: string;
}

export interface ReachableHostResolution {
  host: string;
  source: "tailscale-dns" | "tailscale-ip" | "lan-ip" | "localhost";
}

export function getFactoryPaths(repoRoot: string): FactoryPaths {
  const factoryRoot = path.join(repoRoot, ".factory");
  return {
    repoRoot,
    configPath: path.join(repoRoot, "factory.config.ts"),
    factoryRoot,
    dbPath: path.join(factoryRoot, "factory.sqlite"),
    tasksDir: path.join(factoryRoot, "tasks"),
    logsDir: path.join(factoryRoot, "logs"),
    worktreesDir: path.join(factoryRoot, "worktrees"),
    runtimeDir: path.join(factoryRoot, "runtime"),
    runsDir: path.join(factoryRoot, "runs"),
    scriptsDir: path.join(factoryRoot, "scripts"),
    bootstrapScriptPath: path.join(factoryRoot, "scripts", "bootstrap-worktree.sh"),
    lockPath: path.join(factoryRoot, ".lock"),
    supervisorPidPath: path.join(factoryRoot, "factoryd.pid"),
    heartbeatPath: path.join(factoryRoot, "factoryd.heartbeat.json"),
    lifecycleLogPath: path.join(factoryRoot, "logs", "factoryd.lifecycle.log"),
    managerToolTokenPath: path.join(factoryRoot, "manager-tool.token")
  };
}

export function getFactorydUnitName(projectId: string, repoRoot: string): string {
  const normalizedProjectId = projectId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "project";
  const repoHash = createHash("sha1").update(path.resolve(repoRoot)).digest("hex").slice(0, 8);
  return `permafactory-${normalizedProjectId}-${repoHash}.service`;
}

export async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function ensureExecutable(filePath: string): Promise<void> {
  await chmod(filePath, 0o755);
}

export async function writeText(filePath: string, content: string): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await writeFile(filePath, content, "utf8");
}

export async function writeTextIfAbsent(filePath: string, content: string): Promise<boolean> {
  if (await fileExists(filePath)) {
    return false;
  }

  await writeText(filePath, content);
  return true;
}

export async function readText(filePath: string): Promise<string> {
  return await readFile(filePath, "utf8");
}

function parseQuotedEnvValue(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }

  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }

  return value;
}

function parseEnvContent(content: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) {
      continue;
    }

    const [, key, rawValue] = match;
    if (!key) {
      continue;
    }

    values[key] = parseQuotedEnvValue(rawValue ?? "");
  }

  return values;
}

function formatEnvValue(value: string): string {
  if (value.length === 0) {
    return '""';
  }

  if (/^[A-Za-z0-9._~:@%/+,\-=]+$/.test(value)) {
    return value;
  }

  return JSON.stringify(value);
}

export async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readText(filePath)) as T;
}

export async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function readEnvFileValues(filePath: string): Promise<Record<string, string>> {
  if (!(await fileExists(filePath))) {
    return {};
  }

  return parseEnvContent(await readText(filePath));
}

export async function loadEnvFile(
  filePath: string,
  options: {
    override?: boolean;
  } = {}
): Promise<string[]> {
  const values = await readEnvFileValues(filePath);
  const loadedKeys: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (options.override || process.env[key] === undefined) {
      process.env[key] = value;
      loadedKeys.push(key);
    }
  }

  return loadedKeys;
}

export async function upsertEnvFileValue(
  filePath: string,
  key: string,
  value: string
): Promise<void> {
  const existing = (await fileExists(filePath)) ? await readText(filePath) : "";
  const lines = existing.length > 0 ? existing.split(/\r?\n/) : [];
  const rendered = `${key}=${formatEnvValue(value)}`;
  let updated = false;
  const nextLines: string[] = [];

  for (const rawLine of lines) {
    const match = rawLine.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match?.[1] === key) {
      if (!updated) {
        nextLines.push(rendered);
        updated = true;
      }
      continue;
    }

    nextLines.push(rawLine);
  }

  if (!updated) {
    if (nextLines.length > 0 && nextLines[nextLines.length - 1]?.trim() !== "") {
      nextLines.push("");
    }
    nextLines.push(rendered);
  }

  while (nextLines.length > 0 && nextLines[nextLines.length - 1] === "") {
    nextLines.pop();
  }

  await writeText(filePath, `${nextLines.join("\n")}\n`);
}

export function matchesTelegramSlashCommand(text: string, command: string): boolean {
  const trimmed = text.trim();
  return new RegExp(`^/${command}(?:@\\w+)?(?:\\s+.*)?$`, "i").test(trimmed);
}

export async function runCommand(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    allowNonZeroExit?: boolean;
  } = {}
): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      maxBuffer: 32 * 1024 * 1024
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    const execError = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: number;
    };

    if (!options.allowNonZeroExit) {
      throw new Error(
        `Command failed: ${command} ${args.join(" ")}\n${execError.stderr ?? execError.message}`
      );
    }

    return {
      stdout: execError.stdout ?? "",
      stderr: execError.stderr ?? execError.message,
      exitCode: execError.code ?? 1
    };
  }
}

export async function runShellCommand(
  script: string,
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    allowNonZeroExit?: boolean;
  } = {}
): Promise<CommandResult> {
  return await runCommand("bash", ["-lc", script], options);
}

export async function spawnLoggedProcess(options: {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdoutPath?: string;
  stderrPath?: string;
  detached?: boolean;
}): Promise<SpawnedProcess> {
  await ensureDir(options.stdoutPath ? path.dirname(options.stdoutPath) : process.cwd());
  if (options.stderrPath) {
    await ensureDir(path.dirname(options.stderrPath));
  }

  const stdoutFd = options.stdoutPath
    ? await open(options.stdoutPath, "a")
    : await open("/dev/null", "a");
  const stderrFd = options.stderrPath
    ? await open(options.stderrPath, "a")
    : await open("/dev/null", "a");

  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    detached: options.detached ?? false,
    stdio: ["ignore", stdoutFd.fd, stderrFd.fd]
  });

  stdoutFd.close().catch(() => undefined);
  stderrFd.close().catch(() => undefined);

  if (options.detached) {
    child.unref();
  }

  return { pid: child.pid, child };
}

export async function spawnLoggedShellCommand(options: {
  script: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdoutPath?: string;
  stderrPath?: string;
  detached?: boolean;
}): Promise<SpawnedProcess> {
  return await spawnLoggedProcess({
    command: "bash",
    args: ["-lc", options.script],
    cwd: options.cwd,
    env: options.env,
    stdoutPath: options.stdoutPath,
    stderrPath: options.stderrPath,
    detached: options.detached
  });
}

export async function isGitRepo(repoRoot: string): Promise<boolean> {
  const result = await runCommand("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: repoRoot,
    allowNonZeroExit: true
  });
  return result.exitCode === 0 && result.stdout.trim() === "true";
}

export async function branchExists(repoRoot: string, branch: string): Promise<boolean> {
  const result = await runCommand("git", ["show-ref", "--verify", `refs/heads/${branch}`], {
    cwd: repoRoot,
    allowNonZeroExit: true
  });
  return result.exitCode === 0;
}

export async function ensureBranchFrom(
  repoRoot: string,
  branch: string,
  baseBranch: string
): Promise<void> {
  if (await branchExists(repoRoot, branch)) {
    return;
  }

  await runCommand("git", ["branch", branch, baseBranch], { cwd: repoRoot });
}

export async function currentCommit(repoRoot: string, ref = "HEAD"): Promise<string> {
  const result = await runCommand("git", ["rev-parse", ref], { cwd: repoRoot });
  return result.stdout.trim();
}

export function buildProjectSpecExcerpt(
  text: string,
  options: {
    maxChars?: number;
  } = {}
): string {
  const maxChars = options.maxChars ?? 18_000;
  const normalized = text.trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, maxChars)}\n\n[project spec excerpt truncated]`;
}

function firstMeaningfulLine(value?: string): string | undefined {
  const line = value?.trim().split(/\r?\n/, 1)[0]?.trim();
  return line && line.length > 0 ? line : undefined;
}

export function selectTaskCommitMessage(options: {
  taskId: string;
  title: string;
  commitMessageHint?: string;
  recommendedCommitMessage?: string;
  summary?: string;
}): string {
  const candidate =
    firstMeaningfulLine(options.commitMessageHint) ??
    firstMeaningfulLine(options.title) ??
    firstMeaningfulLine(options.recommendedCommitMessage) ??
    firstMeaningfulLine(options.summary) ??
    `Complete ${options.taskId}`;
  return candidate.slice(0, 120);
}

export async function updateGitBranchRef(
  repoRoot: string,
  branch: string,
  commit: string
): Promise<void> {
  await runCommand("git", ["update-ref", `refs/heads/${branch}`, commit], { cwd: repoRoot });
}

export async function listDirtyFiles(repoRoot: string): Promise<string[]> {
  const result = await runCommand("git", ["status", "--short"], { cwd: repoRoot });
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^[A-Z?]+\s+/, ""));
}

export async function addWorktree(
  repoRoot: string,
  worktreePath: string,
  branchName: string,
  baseRef: string
): Promise<void> {
  await ensureDir(path.dirname(worktreePath));
  await runCommand("git", ["worktree", "prune", "--expire", "now"], {
    cwd: repoRoot,
    allowNonZeroExit: true
  });
  await runCommand("git", ["worktree", "add", "-B", branchName, worktreePath, baseRef], {
    cwd: repoRoot
  });
}

export async function removeWorktree(repoRoot: string, worktreePath: string): Promise<void> {
  await runCommand("git", ["worktree", "remove", "--force", worktreePath], { cwd: repoRoot });
}

export async function ensureDetachedWorktreeAtRef(
  repoRoot: string,
  worktreePath: string,
  ref: string
): Promise<void> {
  if (!(await fileExists(path.join(worktreePath, ".git")))) {
    await ensureDir(path.dirname(worktreePath));
    await runCommand("git", ["worktree", "prune", "--expire", "now"], {
      cwd: repoRoot,
      allowNonZeroExit: true
    });
    await runCommand("git", ["worktree", "add", "--detach", worktreePath, ref], {
      cwd: repoRoot
    });
    return;
  }

  await runCommand("git", ["-C", worktreePath, "reset", "--hard"], { cwd: repoRoot });
  await runCommand("git", ["-C", worktreePath, "clean", "-fd"], { cwd: repoRoot });
  await runCommand("git", ["-C", worktreePath, "checkout", "--detach", ref], { cwd: repoRoot });
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export function allocateFreshTaskId(requestedId: string, existingTaskIds: Iterable<string>): string {
  const existing = new Set(existingTaskIds);
  if (!existing.has(requestedId)) {
    return requestedId;
  }

  let attempt = 2;
  let candidate = `${requestedId}-r${attempt}`;
  while (existing.has(candidate)) {
    attempt += 1;
    candidate = `${requestedId}-r${attempt}`;
  }
  return candidate;
}

export function selectTaskWorktreePath(
  worktreesDir: string,
  branchName: string,
  options: {
    existingWorktreePath?: string;
    requestedWorktreePath?: string;
  } = {}
): string {
  return (
    options.existingWorktreePath ||
    options.requestedWorktreePath ||
    path.join(worktreesDir, slugify(branchName))
  );
}

export function randomId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function isManagerTurnNoOp(turn: ManagerTurnInput["recentManagerTurns"][number]): boolean {
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

export function normalizeManagerLoopSummary(summary: string): string {
  return summary
    .replace(/`[^`]+`/g, "`ref`")
    .replace(/\b[0-9a-f]{8,40}\b/gi, "sha")
    .replace(/\d+/g, "n")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function compressRecentManagerTurns(
  turns: ManagerTurnInput["recentManagerTurns"],
  options: { maxTurns?: number } = {}
): ManagerTurnInput["recentManagerTurns"] {
  const maxTurns = Math.max(1, options.maxTurns ?? 8);
  const compressed: ManagerTurnInput["recentManagerTurns"] = [];

  for (const turn of turns) {
    const last = compressed[compressed.length - 1];
    const duplicateNoOpLoop =
      last &&
      isManagerTurnNoOp(turn) &&
      isManagerTurnNoOp(last) &&
      normalizeManagerLoopSummary(turn.summary) === normalizeManagerLoopSummary(last.summary);
    if (duplicateNoOpLoop) {
      continue;
    }
    compressed.push(turn);
    if (compressed.length >= maxTurns) {
      break;
    }
  }

  return compressed;
}

export function computeNoActiveWorkWakeCooldownMs(
  turns: ManagerTurnInput["recentManagerTurns"],
  defaultCooldownMs: number
): number {
  const baseCooldownMs = Math.max(defaultCooldownMs, 60_000);
  let idleNoOpStreak = 0;

  for (const turn of turns) {
    if (!isManagerTurnNoOp(turn)) {
      break;
    }
    const idleWakeOnly =
      turn.wakeReasons.length > 0 &&
      turn.wakeReasons.every((reason) => reason === "no_active_work" || reason === "manager_thread_rotation");
    if (!idleWakeOnly) {
      break;
    }
    idleNoOpStreak += 1;
  }

  if (idleNoOpStreak >= 8) {
    return Math.max(baseCooldownMs, 60 * 60_000);
  }
  if (idleNoOpStreak >= 4) {
    return Math.max(baseCooldownMs, 15 * 60_000);
  }
  if (idleNoOpStreak >= 2) {
    return Math.max(baseCooldownMs, 5 * 60_000);
  }
  return baseCooldownMs;
}

function normalizeHost(value: string | undefined): string | undefined {
  const normalized = value?.trim().replace(/\.$/, "");
  return normalized && normalized.length > 0 ? normalized : undefined;
}

export function selectReachableHost(candidates: ReachableHostCandidates): ReachableHostResolution {
  const tailscaleDnsName = normalizeHost(candidates.tailscaleDnsName);
  if (tailscaleDnsName) {
    return { host: tailscaleDnsName, source: "tailscale-dns" };
  }

  const tailscaleIp = normalizeHost(candidates.tailscaleIp);
  if (tailscaleIp) {
    return { host: tailscaleIp, source: "tailscale-ip" };
  }

  const lanIp = normalizeHost(candidates.lanIp);
  if (lanIp) {
    return { host: lanIp, source: "lan-ip" };
  }

  return { host: "127.0.0.1", source: "localhost" };
}

export function formatHttpUrl(host: string, port: number): string {
  const normalizedHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${normalizedHost}:${port}`;
}

export function shouldDeliverTelegramNotification(
  kind: string,
  options: { isDirectUserResponse?: boolean } = {}
): boolean {
  if (
    kind === "decision_required" ||
    kind === "ship_result" ||
    kind === "daily_digest" ||
    kind === "incident_alert"
  ) {
    return true;
  }

  if (kind === "info_update") {
    return options.isDirectUserResponse === true;
  }

  return false;
}

function pickTailscaleIp(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const ips = value
    .map((entry) => stringValue(entry))
    .filter((entry): entry is string => Boolean(entry));
  return ips.find((ip) => !ip.includes(":")) ?? ips[0];
}

function firstNonLoopbackIpv4(): string | undefined {
  const interfaces = os.networkInterfaces();
  for (const addresses of Object.values(interfaces)) {
    if (!addresses) {
      continue;
    }

    for (const address of addresses) {
      if (address.internal || address.family !== "IPv4") {
        continue;
      }
      if (address.address.startsWith("169.254.")) {
        continue;
      }
      return address.address;
    }
  }

  return undefined;
}

async function resolveTailscaleHostCandidates(): Promise<ReachableHostCandidates> {
  try {
    const { stdout } = await execFileAsync("tailscale", ["status", "--json"], {
      maxBuffer: 2 * 1024 * 1024
    });
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    const self = asRecord(parsed.Self);
    return {
      tailscaleDnsName: firstString(self?.DNSName),
      tailscaleIp: pickTailscaleIp(self?.TailscaleIPs ?? parsed.TailscaleIPs)
    };
  } catch {
    return {};
  }
}

export async function resolveReachableHttpUrl(port: number): Promise<string> {
  const tailscale = await resolveTailscaleHostCandidates();
  const selected = selectReachableHost({
    ...tailscale,
    lanIp: firstNonLoopbackIpv4()
  });
  return formatHttpUrl(selected.host, port);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const stringified = stringValue(value);
    if (stringified) {
      return stringified;
    }
  }

  return undefined;
}

function stringArray(value: unknown): string[] {
  if (typeof value === "string") {
    return value
      .split(/\r?\n|,/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }

  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => stringValue(entry))
    .filter((entry): entry is string => Boolean(entry));
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function normalizeTelegramKind(value: unknown): TelegramOutboundKind {
  switch (firstString(value)?.toLowerCase()) {
    case "decision_required":
    case "decision":
      return "decision_required";
    case "incident_alert":
    case "incident":
    case "alert":
    case "error":
      return "incident_alert";
    case "ship_result":
    case "ship":
    case "deploy":
    case "release":
      return "ship_result";
    case "daily_digest":
    case "digest":
      return "daily_digest";
    case "info_update":
    case "info":
    case "update":
    case "reply":
    case "response":
    case "status":
    default:
      return "info_update";
  }
}

function normalizeTaskKind(value: unknown): TaskContract["kind"] {
  switch (firstString(value)?.toLowerCase()) {
    case "review-fix":
    case "review_fix":
    case "reviewfix":
    case "followup":
      return "review-fix";
    case "test":
    case "testing":
    case "qa":
      return "test";
    case "maintenance":
    case "chore":
    case "docs":
    case "cleanup":
      return "maintenance";
    case "code":
    case "coding":
    case "feature":
    case "implementation":
    case "fix":
    case "bugfix":
    default:
      return "code";
  }
}

function normalizeReasoningEffort(value: unknown, title: string, goal: string): ReasoningEffort {
  const explicit = firstString(value)?.toLowerCase();
  if (explicit === "medium" || explicit === "extra-high") {
    return explicit;
  }

  const combined = `${title}\n${goal}`.toLowerCase();
  return /(architecture|refactor|migrate|design|complex|agent|scheduler|deployment|telegram)/.test(combined)
    ? "extra-high"
    : "medium";
}

function normalizeDeploymentKind(value: unknown): DeploymentIntent["kind"] | undefined {
  switch (firstString(value)?.toLowerCase()) {
    case "promote_candidate":
    case "promote":
    case "ship":
    case "release":
    case "promote-candidate":
      return "promote_candidate";
    case "rollback_stable":
    case "rollback":
    case "rollback-stable":
      return "rollback_stable";
    default:
      return undefined;
  }
}

function normalizeDecisionPriority(value: unknown): DecisionRequest["priority"] {
  switch (firstString(value)?.toLowerCase()) {
    case "critical":
      return "critical";
    case "high":
      return "high";
    case "low":
      return "low";
    case "medium":
    default:
      return "medium";
  }
}

function inferNeedsAppRuntime(
  kind: TaskContract["kind"],
  title: string,
  goal: string,
  checks: string[]
): boolean {
  if (checks.some((check) => /(serve|preview|smoke|browser|playwright|cypress|dev|start)/i.test(check))) {
    return true;
  }

  if (kind !== "code") {
    return false;
  }

  return /(ui|ux|frontend|web|page|browser|app|calculator)/i.test(`${title}\n${goal}`);
}

function defaultAcceptanceCriteria(kind: TaskContract["kind"], goal: string): string[] {
  if (kind === "test") {
    return ["The target behavior is covered by a reproducible automated or scripted test."];
  }

  if (kind === "maintenance") {
    return ["The maintenance goal is complete and the repo remains operable."];
  }

  return [goal.length > 0 ? goal : "The task goal is complete and relevant checks pass."];
}

export function normalizeManagerTurnOutput(
  raw: unknown,
  options: NormalizeManagerTurnOutputOptions
): ManagerTurnOutput {
  const object = asRecord(raw);
  if (!object) {
    throw new Error("Manager output must be a JSON object");
  }

  void options;

  const forbiddenKeys = [
    "userMessages",
    "tasksToStart",
    "tasksToCancel",
    "reviewsToStart",
    "integrations",
    "deployments",
    "decisions"
  ].filter((key) => key in object);
  if (forbiddenKeys.length > 0) {
    throw new Error(
      `Manager output must not include side-effect fields (${forbiddenKeys.join(", ")}); use MCP tools instead`
    );
  }

  const allowedKeys = new Set(["summary", "assumptions", "defaults", "message", "title", "status"]);
  const unexpectedKeys = Object.keys(object).filter((key) => !allowedKeys.has(key));
  if (unexpectedKeys.length > 0) {
    throw new Error(
      `Manager output must contain only summary and assumptions; unexpected fields: ${unexpectedKeys.join(", ")}`
    );
  }

  return {
    summary: firstString(object.summary, object.message, object.title, object.status) ?? "Manager turn update",
    assumptions: stringArray(object.assumptions ?? object.defaults)
  };
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function computeDecisionDedupeKey(
  title: string,
  options: string[],
  scope: string
): string {
  return sha256(`${scope}\n${title}\n${options.join("\n")}`).slice(0, 24);
}

export function computeDecisionBudgetSnapshot(
  date: string,
  used: number,
  limit: number,
  reserveCritical: number
): DecisionBudgetSnapshot {
  const normalCap = limit - reserveCritical;
  const remaining = Math.max(0, limit - used);
  const remainingNormal = used >= normalCap ? 0 : normalCap - used;
  const remainingCriticalReserve = Math.max(0, remaining - remainingNormal);
  return {
    date,
    used,
    limit,
    normalCap,
    remaining,
    remainingNormal,
    remainingCriticalReserve
  };
}

export function derivePortLeaseRequirement(
  task: Pick<TaskContract, "kind" | "needsAppRuntime" | "constraints">
): PortLeaseRequirement {
  const mustRunChecks = task.constraints.mustRunChecks.map((check) => check.toLowerCase());
  const needsE2e = mustRunChecks.some((check) =>
    ["e2e", "playwright", "cypress", "browser"].some((needle) => check.includes(needle))
  );
  const needsApp =
    task.needsAppRuntime ||
    needsE2e ||
    task.kind === "code" ||
    mustRunChecks.some((check) =>
      ["serve", "preview", "smoke", "dev", "start"].some((needle) => check.includes(needle))
    );

  return {
    app: needsApp,
    e2e: needsE2e
  };
}

export function deriveEffectivePortLeaseRequirement(
  task: Pick<TaskContract, "kind" | "needsAppRuntime" | "constraints">,
  capabilities: WorkerSandboxCapabilities
): PortLeaseRequirement {
  if (!capabilities.canBindListenSockets) {
    return { app: false, e2e: false };
  }

  return derivePortLeaseRequirement(task);
}

export function applyWorkerSandboxCapabilities(
  contract: TaskContract,
  capabilities: WorkerSandboxCapabilities
): TaskContract {
  return {
    ...contract,
    ports: capabilities.canBindListenSockets ? { ...contract.ports } : {},
    context: {
      ...contract.context,
      runtimeCapabilities: {
        ...(contract.context.runtimeCapabilities ?? {}),
        canBindListenSockets: capabilities.canBindListenSockets
      }
    }
  };
}

const RUNNABLE_PROJECT_SIGNAL_BASENAMES = new Set([
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "bun.lock",
  "pyproject.toml",
  "requirements.txt",
  "setup.py",
  "Cargo.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "composer.json",
  "gemfile",
  "mix.exs",
  "makefile",
  "cmakelists.txt"
]);

const RUNNABLE_PROJECT_SIGNAL_EXTENSIONS = new Set([
  ".html",
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".vue",
  ".svelte",
  ".astro",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".kt",
  ".swift",
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".rb",
  ".php",
  ".elm"
]);

function isIgnorableGreenfieldBootstrapFile(file: string, projectSpecPath?: string): boolean {
  const normalized = file.replace(/\\/g, "/");
  const lower = normalized.toLowerCase();
  const basename = path.basename(lower);
  const projectSpecLower = projectSpecPath?.replace(/\\/g, "/").toLowerCase();

  if (projectSpecLower && lower === projectSpecLower) {
    return true;
  }
  if (lower === "factory.config.ts" || lower === "agents.md" || lower === ".env.factory.example") {
    return true;
  }
  if (basename.startsWith("readme") || basename.startsWith("license")) {
    return true;
  }
  if (/^docs\/.+\.md$/i.test(normalized)) {
    return true;
  }

  return false;
}

function isRunnableProjectSignalFile(file: string): boolean {
  const normalized = file.replace(/\\/g, "/");
  const basename = path.basename(normalized).toLowerCase();
  if (RUNNABLE_PROJECT_SIGNAL_BASENAMES.has(basename)) {
    return true;
  }

  const extension = path.extname(basename);
  return RUNNABLE_PROJECT_SIGNAL_EXTENSIONS.has(extension);
}

export function isLikelyGreenfieldRepoFiles(files: string[], projectSpecPath?: string): boolean {
  const meaningfulFiles = files
    .map((file) => file.trim())
    .filter((file) => file.length > 0)
    .filter((file) => !isIgnorableGreenfieldBootstrapFile(file, projectSpecPath));

  if (meaningfulFiles.length === 0) {
    return true;
  }

  return !meaningfulFiles.some((file) => isRunnableProjectSignalFile(file));
}

export function findLowestFreePort(
  start: number,
  end: number,
  usedPorts: Set<number>
): number | undefined {
  for (let port = start; port <= end; port += 1) {
    if (!usedPorts.has(port)) {
      return port;
    }
  }

  return undefined;
}

export function allocatePorts(
  config: FactoryProjectConfig,
  usedPorts: Set<number>,
  requirement: PortLeaseRequirement
): { app?: number; e2e?: number } {
  const app = requirement.app
    ? findLowestFreePort(config.ports.workerStart, config.ports.workerEnd, usedPorts)
    : undefined;

  if (requirement.app && app === undefined) {
    throw new Error("No free worker app port available");
  }

  if (app !== undefined) {
    usedPorts.add(app);
  }

  const e2e = requirement.e2e
    ? findLowestFreePort(config.ports.e2eStart, config.ports.e2eEnd, usedPorts)
    : undefined;

  if (requirement.e2e && e2e === undefined) {
    throw new Error("No free worker e2e port available");
  }

  if (e2e !== undefined) {
    usedPorts.add(e2e);
  }

  return {
    ...(app !== undefined ? { app } : {}),
    ...(e2e !== undefined ? { e2e } : {})
  };
}

export function parseTopLevelBacklogItems(markdown: string): string[] {
  const lines = markdown.split(/\r?\n/);
  const items: string[] = [];
  let current: string[] = [];

  const flush = () => {
    const text = current.join("\n").trim();
    if (text) {
      items.push(text);
    }
    current = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (/^#\s+/.test(line) && current.length > 0) {
      flush();
    }

    if (/^[-*]\s+/.test(line) || /^##\s+/.test(line)) {
      if (current.length > 0) {
        flush();
      }
      current.push(line.replace(/^[-*#\s]+/, "").trim());
      continue;
    }

    if (current.length > 0) {
      current.push(line.trim());
    }
  }

  flush();
  return items;
}

export async function loadJsonSchema(schemaPath: string): Promise<object> {
  return await readJson<object>(schemaPath);
}

export async function createSchemaValidator<T>(schemaPath: string): Promise<ValidateFunction<T>> {
  const schema = await loadJsonSchema(schemaPath);
  const ajv = new AjvCtor({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile<T>(schema);
}

export async function validateWithSchema<T>(
  schemaPath: string,
  value: unknown
): Promise<{ valid: true; value: T } | { valid: false; errors: string[] }> {
  const validator = await createSchemaValidator<T>(schemaPath);
  if (validator(value)) {
    return { valid: true, value: value as T };
  }

  return {
    valid: false,
    errors:
      validator.errors?.map((error) => `${error.instancePath || "/"} ${error.message}`) ?? [
        "Unknown validation error"
      ]
  };
}

export async function copyFileIfMissing(source: string, destination: string): Promise<boolean> {
  if (await fileExists(destination)) {
    return false;
  }

  await ensureDir(path.dirname(destination));
  await copyFile(source, destination);
  return true;
}

export function localDateString(timezone: string, date = new Date()): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  return formatter.format(date);
}

export async function withProjectLock<T>(
  repoRoot: string,
  work: () => Promise<T>
): Promise<T> {
  const lockPath = getFactoryPaths(repoRoot).lockPath;
  await ensureDir(path.dirname(lockPath));
  const handle = await open(lockPath, "wx").catch(() => {
    throw new Error(`Project is already locked: ${lockPath}`);
  });

  try {
    await handle.writeFile(`${process.pid}\n`, "utf8");
    return await work();
  } finally {
    await handle.close().catch(() => undefined);
    await rm(lockPath, { force: true }).catch(() => undefined);
  }
}

export async function sampleResources(maxWorkers: number, activeWorkerCount: number): Promise<{
  cpuPercent: number;
  memoryPercent: number;
  swapActive: boolean;
  freeWorkerSlots: number;
}> {
  const cpuPercent = Math.min(100, ((os.loadavg().at(0) ?? 0) / Math.max(1, os.cpus().length)) * 100);
  const memoryPercent = Math.min(100, ((os.totalmem() - os.freemem()) / os.totalmem()) * 100);
  const swapActive = await detectSwapActivity();
  const freeWorkerSlots = Math.max(0, maxWorkers - activeWorkerCount);
  return { cpuPercent, memoryPercent, swapActive, freeWorkerSlots };
}

async function detectSwapActivity(): Promise<boolean> {
  try {
    const meminfo = await readText("/proc/meminfo");
    const swapFreeMatch = meminfo.match(/^SwapFree:\s+(\d+)/m);
    const swapTotalMatch = meminfo.match(/^SwapTotal:\s+(\d+)/m);
    if (!swapFreeMatch || !swapTotalMatch) {
      return false;
    }

    const swapFree = Number.parseInt(swapFreeMatch.at(1) ?? "0", 10);
    const swapTotal = Number.parseInt(swapTotalMatch.at(1) ?? "0", 10);
    return swapTotal > 0 && swapFree < swapTotal;
  } catch {
    return false;
  }
}

export async function pruneEmptyDirectories(rootDir: string): Promise<void> {
  if (!(await fileExists(rootDir))) {
    return;
  }

  const entries = await readdir(rootDir, { withFileTypes: true });
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => pruneEmptyDirectories(path.join(rootDir, entry.name)))
  );

  const remaining = await readdir(rootDir);
  if (remaining.length === 0) {
    await rm(rootDir, { recursive: true, force: true });
  }
}

export async function safeStat(targetPath: string): Promise<Awaited<ReturnType<typeof stat>> | undefined> {
  try {
    return await stat(targetPath);
  } catch {
    return undefined;
  }
}

export function isPlaceholderScript(script: string): boolean {
  return /not configured/i.test(script);
}

export function resolveRuntimeScriptCommand(
  detectedScript: string,
  configuredScript: string
): string {
  return !isPlaceholderScript(detectedScript) ? detectedScript : configuredScript;
}

export async function sendTelegramApiRequest<T>(
  botToken: string,
  method: string,
  payload: Record<string, unknown>
): Promise<T> {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(`Telegram API ${method} failed with HTTP ${response.status}`);
  }

  const data = (await response.json()) as { ok: boolean; result?: T; description?: string };
  if (!data.ok) {
    throw new Error(`Telegram API ${method} failed: ${data.description ?? "unknown error"}`);
  }

  if (data.result === undefined) {
    throw new Error(`Telegram API ${method} returned no result`);
  }

  return data.result;
}

export async function pollTelegramUpdates(
  botToken: string,
  offset?: number
): Promise<Array<Record<string, unknown>>> {
  return await sendTelegramApiRequest<Array<Record<string, unknown>>>(botToken, "getUpdates", {
    timeout: 10,
    allowed_updates: ["message", "callback_query"],
    ...(offset ? { offset } : {})
  });
}

export async function removePath(targetPath: string): Promise<void> {
  await rm(targetPath, { recursive: true, force: true });
}

export async function listFilesRecursively(rootDir: string): Promise<string[]> {
  if (!(await fileExists(rootDir))) {
    return [];
  }

  const entries = await readdir(rootDir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const target = path.join(rootDir, entry.name);
      if (entry.isDirectory()) {
        return await listFilesRecursively(target);
      }
      return [target];
    })
  );
  return nested.flat();
}

export async function waitForSuccessfulCommand(
  script: string,
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    intervalMs?: number;
  } = {}
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const intervalMs = options.intervalMs ?? 2_000;
  const deadline = Date.now() + timeoutMs;
  let lastFailure = "";

  while (Date.now() <= deadline) {
    const result = await runShellCommand(script, {
      cwd: options.cwd,
      env: options.env,
      allowNonZeroExit: true
    });
    if (result.exitCode === 0) {
      return;
    }

    lastFailure = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(
    lastFailure
      ? `Command did not succeed before timeout: ${lastFailure}`
      : "Command did not succeed before timeout"
  );
}
