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
  DecisionBudgetSnapshot,
  FactoryProjectConfig,
  PortLeaseRequirement,
  TaskContract
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
    lockPath: path.join(factoryRoot, ".lock")
  };
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

export async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readText(filePath)) as T;
}

export async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeText(filePath, `${JSON.stringify(value, null, 2)}\n`);
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

export function randomId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
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

export function derivePortLeaseRequirement(task: Pick<TaskContract, "kind" | "needsPreview" | "constraints">): PortLeaseRequirement {
  const mustRunChecks = task.constraints.mustRunChecks.map((check) => check.toLowerCase());
  const needsE2e = mustRunChecks.some((check) =>
    ["e2e", "playwright", "cypress", "browser"].some((needle) => check.includes(needle))
  );
  const needsApp =
    task.needsPreview ||
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
