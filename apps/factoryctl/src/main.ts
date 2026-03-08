import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import process from "node:process";
import { FactoryDatabase } from "@permafactory/db";
import type { FactoryProjectConfig, InboxItem, SandboxMode, TaskPriority } from "@permafactory/models";
import { ensureProjectSpecAndConfig, getConfigPath, loadProjectConfig, renderFactoryConfig } from "@permafactory/config";
import {
  branchExists,
  currentCommit,
  ensureBranchFrom,
  fileExists,
  getFactoryPaths,
  isGitRepo,
  loadEnvFile,
  nowIso,
  parseTopLevelBacklogItems,
  pollTelegramUpdates,
  randomId,
  readText,
  removePath,
  runCommand,
  sendTelegramApiRequest,
  spawnLoggedProcess,
  withProjectLock,
  writeText
} from "@permafactory/runtime";

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const [command, maybeSubcommand, ...rest] = argv;

  switch (command) {
    case "init":
      await handleInit(
        [maybeSubcommand, ...rest].filter((value): value is string => typeof value === "string")
      );
      return;
    case "status":
      await handleStatus(
        [maybeSubcommand, ...rest].filter((value): value is string => typeof value === "string")
      );
      return;
    case "ingest":
      if (maybeSubcommand !== "backlog") {
        usage();
        return;
      }
      await handleIngestBacklog(rest);
      return;
    case "cleanup":
      await handleCleanup(
        [maybeSubcommand, ...rest].filter((value): value is string => typeof value === "string")
      );
      return;
    case "start":
      await handleStart(
        [maybeSubcommand, ...rest].filter((value): value is string => typeof value === "string")
      );
      return;
    case "stop":
      await handleStop(
        [maybeSubcommand, ...rest].filter((value): value is string => typeof value === "string")
      );
      return;
    case "telegram":
      if (maybeSubcommand !== "connect") {
        usage();
        return;
      }
      await handleTelegramConnect(rest);
      return;
    default:
      usage();
  }
}

function usage(): void {
  console.log(`factoryctl commands:
  init --repo <path> --project-id <id> --default-branch <branch> [--project-spec-path <path>] [--sandbox-mode <danger-full-access|workspace-write>]
  status --repo <path> [--json] [--assert-healthy]
  ingest backlog --repo <path> [--file <path>] [--text <text>]
  telegram connect --repo <path> --bot-token-env <ENV_NAME> [--webhook-url <url>] [--timeout-seconds <n>]
  cleanup --repo <path> [--dry-run] [--force]
  start --repo <path> [--foreground] [--once]
  stop --repo <path> [--force]
`);
}

function parseSandboxMode(value: string | undefined): SandboxMode | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "danger-full-access" || value === "workspace-write") {
    return value;
  }
  throw new Error(`Invalid --sandbox-mode: ${value}`);
}

function describeWorkerNetworkAccess(config: FactoryProjectConfig): string {
  return config.codex.sandboxMode === "workspace-write" ? "restricted" : "available";
}

function requireString(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`Missing required flag: ${name}`);
  }
  return value;
}

async function loadRepoEnv(repoRoot: string): Promise<void> {
  await loadEnvFile(path.join(repoRoot, ".env.factory"));
}

async function openProject(repoRoot: string): Promise<{ config: FactoryProjectConfig; db: FactoryDatabase }> {
  await loadRepoEnv(repoRoot);
  const config = await loadProjectConfig(repoRoot);
  const db = await FactoryDatabase.open(repoRoot);
  db.init();
  db.upsertProject(config);
  return { config, db };
}

function renderTelegramSetupGuide(config: FactoryProjectConfig): string {
  return [
    "",
    "Telegram setup",
    `Worker network access: ${describeWorkerNetworkAccess(config)}`,
    `1. Open Telegram and start a chat with @BotFather.`,
    "2. Send /newbot and follow the prompts for the bot name and username.",
    `3. Put the token into ${path.join(config.repoRoot, ".env.factory")} as ${config.telegram.botTokenEnvVar}=...`,
    "4. Easiest path: send a direct message to the bot from your own Telegram account.",
    "5. If you prefer a shared control room, add the bot to a supergroup instead.",
    "6. If the bot needs to read normal supergroup messages, run /setprivacy in BotFather and disable privacy mode for this bot.",
    `7. Generate ${config.telegram.webhookSecretEnvVar}, for example: openssl rand -hex 32`,
    `8. Run: factoryctl telegram connect --repo ${config.repoRoot} --bot-token-env ${config.telegram.botTokenEnvVar}`,
    "9. Send /hello to the bot in your DM or in the control supergroup to bind it.",
    "10. You do not need to discover the chat id manually; the CLI captures it from /hello.",
    "11. After the chat is bound, add normal API keys from your phone with /secret KEY value.",
    "12. Use /secrets to list configured key names. Multiline secrets should still go in .env.factory from the host shell.",
    "13. Use /stop in Telegram to shut the factory down cleanly when you want it paused.",
    `More detail: ${path.join(config.repoRoot, config.bootstrap.onboardingSummaryPath)}`
  ].join("\n");
}

async function handleInit(args: string[]): Promise<void> {
  const parsed = parseArgs({
    args,
    options: {
      repo: { type: "string" },
      "project-id": { type: "string" },
      "default-branch": { type: "string" },
      "project-spec-path": { type: "string" },
      "sandbox-mode": { type: "string" }
    },
    strict: true
  });

  const repoRoot = path.resolve(requireString(parsed.values.repo, "--repo"));
  const projectId = requireString(parsed.values["project-id"], "--project-id");
  let defaultBranch = requireString(parsed.values["default-branch"], "--default-branch");
  const projectSpecPath = parsed.values["project-spec-path"];
  const sandboxMode = parseSandboxMode(parsed.values["sandbox-mode"]);

  await withProjectLock(repoRoot, async () => {
    await loadRepoEnv(repoRoot);
    if (!(await isGitRepo(repoRoot))) {
      throw new Error(`${repoRoot} is not a git repository`);
    }

    if (!(await branchExists(repoRoot, defaultBranch))) {
      const headBranch = (
        await runCommand("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
          cwd: repoRoot
        })
      ).stdout.trim();
      if (headBranch && headBranch !== "HEAD" && (await branchExists(repoRoot, headBranch))) {
        console.warn(
          `Default branch ${defaultBranch} does not exist; using current branch ${headBranch} instead`
        );
        defaultBranch = headBranch;
      } else {
        throw new Error(`Default branch ${defaultBranch} does not exist`);
      }
    }

    const config = await ensureProjectSpecAndConfig({
      repoRoot,
      projectId,
      defaultBranch,
      projectSpecPath,
      sandboxMode
    });

    await ensureBranchFrom(repoRoot, config.candidateBranch, config.defaultBranch);

    const db = await FactoryDatabase.open(repoRoot);
    db.init();
    db.upsertProject(config);
    db.updateProjectCommits(
      projectId,
      await currentCommit(repoRoot, config.defaultBranch),
      await currentCommit(repoRoot, config.candidateBranch)
    );
    db.close();

    console.log(`Initialized ${projectId}`);
    console.log(`repo: ${repoRoot}`);
    console.log(`config: ${getConfigPath(repoRoot)}`);
    console.log(`candidate branch: ${config.candidateBranch}`);
    console.log(`project spec: ${config.projectSpecPath}`);
    console.log(`worker network access: ${describeWorkerNetworkAccess(config)}`);
    console.log(`env template: ${path.join(repoRoot, ".env.factory.example")}`);
    console.log(renderTelegramSetupGuide(config));
  });
}

async function handleStatus(args: string[]): Promise<void> {
  const parsed = parseArgs({
    args,
    options: {
      repo: { type: "string" },
      json: { type: "boolean" },
      "assert-healthy": { type: "boolean" }
    },
    strict: true
  });

  const repoRoot = path.resolve(requireString(parsed.values.repo, "--repo"));
  const { config, db } = await openProject(repoRoot);
  const project = db.getProjectById(config.projectId);
  const agents = db.listAgents(config.projectId);
  const openDecisions = db.listOpenDecisions(config.projectId);
  const taskActivity = db.getTaskActivitySummary(config.projectId);
  const summary = {
    projectId: config.projectId,
    bootstrapStatus: project.bootstrapStatus,
    repoRoot,
    defaultBranch: config.defaultBranch,
    candidateBranch: config.candidateBranch,
    inboxItems: db.listInboxItems(config.projectId).length,
    tasks: taskActivity.tasks,
    activeRuns: taskActivity.activeRuns,
    agents: agents.map((agent) => ({
      id: agent.id,
      role: agent.role,
      status: agent.status,
      taskId: agent.taskId
    })),
    recentManagerTurns: db.listRecentManagerTurns(config.projectId, 5),
    openDecisions: openDecisions.length,
    activePortLeases: db.listActivePortLeases(config.projectId).length
  };

  if (parsed.values.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`Project: ${summary.projectId}`);
    console.log(`Bootstrap: ${summary.bootstrapStatus}`);
    console.log(`Tasks queued/running/blocked/review: ${summary.tasks.queued}/${summary.tasks.running}/${summary.tasks.blocked}/${summary.tasks.review}`);
    console.log(
      `Active runs code/review/test: ${summary.activeRuns.code}/${summary.activeRuns.review}/${summary.activeRuns.test}`
    );
    console.log(`Open decisions: ${summary.openDecisions}`);
    console.log(`Agents: ${summary.agents.map((agent) => `${agent.role}:${agent.status}`).join(", ") || "none"}`);
    console.log(`Active port leases: ${summary.activePortLeases}`);
  }

  if (
    parsed.values["assert-healthy"] &&
    (summary.bootstrapStatus === "error" || summary.agents.some((agent) => agent.status === "failed"))
  ) {
    throw new Error("Project health assertion failed");
  }

  db.close();
}

async function handleIngestBacklog(args: string[]): Promise<void> {
  const parsed = parseArgs({
    args,
    options: {
      repo: { type: "string" },
      file: { type: "string" },
      text: { type: "string" },
      priority: { type: "string" }
    },
    strict: true
  });

  const repoRoot = path.resolve(requireString(parsed.values.repo, "--repo"));
  const { config, db } = await openProject(repoRoot);

  let text = parsed.values.text;
  if (!text) {
    const filePath = parsed.values.file
      ? path.resolve(repoRoot, parsed.values.file)
      : path.join(repoRoot, config.intake.backlogFile);
    if (!(await fileExists(filePath))) {
      throw new Error(`Backlog file not found: ${filePath}`);
    }
    text = await readText(filePath);
  }

  const items = parseTopLevelBacklogItems(text);
  if (items.length === 0) {
    console.log("No backlog items found");
    db.close();
    return;
  }

  const priority = (parsed.values.priority as TaskPriority | undefined) ?? "medium";
  for (const itemText of items) {
    const inboxItem: InboxItem & { projectId: string } = {
      id: randomId("inbox"),
      projectId: config.projectId,
      source: "backlog_file",
      receivedAt: nowIso(),
      text: itemText,
      status: "new"
    };
    db.insertInboxItem(inboxItem);
    db.upsertTask({
      projectId: config.projectId,
      id: randomId("task"),
      status: "queued",
      title: itemText.split("\n")[0]?.slice(0, 120) ?? "Backlog task",
      priority,
      goal: itemText
    });
  }

  if (config.bootstrap.status === "waiting_for_first_task") {
    config.bootstrap.status = "baselining_repo";
    await writeText(getConfigPath(repoRoot), renderFactoryConfig(config));
    db.upsertProject(config);
  }

  console.log(`Ingested ${items.length} backlog item(s)`);
  db.close();
}

async function handleTelegramConnect(args: string[]): Promise<void> {
  const parsed = parseArgs({
    args,
    options: {
      repo: { type: "string" },
      "bot-token-env": { type: "string" },
      "webhook-url": { type: "string" },
      "timeout-seconds": { type: "string" }
    },
    strict: true
  });

  const repoRoot = path.resolve(requireString(parsed.values.repo, "--repo"));
  const { config, db } = await openProject(repoRoot);
  const tokenEnvName = requireString(parsed.values["bot-token-env"], "--bot-token-env");
  const botToken = process.env[tokenEnvName];
  if (!botToken) {
    throw new Error(`Environment variable ${tokenEnvName} is not set`);
  }

  const timeoutSeconds = Number.parseInt(parsed.values["timeout-seconds"] ?? "60", 10);
  const deadline = Date.now() + timeoutSeconds * 1000;
  let offset: number | undefined;
  let bound = false;

  while (Date.now() < deadline && !bound) {
    const updates = await pollTelegramUpdates(botToken, offset);
    for (const update of updates) {
      const updateId = typeof update.update_id === "number" ? update.update_id : undefined;
      if (updateId !== undefined) {
        offset = updateId + 1;
      }

      const message = update.message as
        | {
            text?: string;
            message_id?: number;
            chat?: { id?: number | string; type?: string };
            from?: { id?: number | string };
          }
        | undefined;

      if (!message?.text || message.text.trim() !== "/hello") {
        continue;
      }

      const chatType = message.chat?.type;
      if (chatType !== "supergroup" && chatType !== "private") {
        throw new Error("Telegram connect only accepts a private chat or a supergroup");
      }
      if (message.chat?.id === undefined) {
        throw new Error("Telegram connect received /hello without a chat id");
      }

      const chatId = String(message.chat.id);
      config.telegram.controlChatId = chatId;
      config.telegram.allowAdminDm = chatType === "private";
      if (message.from?.id) {
        const userId = String(message.from.id);
        if (!config.telegram.allowedAdminUserIds.includes(userId)) {
          config.telegram.allowedAdminUserIds = [userId, ...config.telegram.allowedAdminUserIds];
        }
      }
      config.bootstrap.status = "baselining_repo";
      await writeText(getConfigPath(repoRoot), renderFactoryConfig(config));
      db.upsertProject(config);
      db.bindTelegramControlChat(config.projectId, chatId);

      const webhookUrl = parsed.values["webhook-url"];
      if (webhookUrl) {
        const webhookSecret = process.env[config.telegram.webhookSecretEnvVar];
        if (!webhookSecret) {
          throw new Error(
            `Cannot configure webhook without ${config.telegram.webhookSecretEnvVar} in the environment`
          );
        }

        await sendTelegramApiRequest(botToken, "setWebhook", {
          url: webhookUrl,
          secret_token: webhookSecret,
          allowed_updates: ["message", "callback_query"]
        });
      }

      console.log(`Bound Telegram ${chatType} chat ${chatId}`);
      bound = true;
      break;
    }
  }

  if (!bound) {
    throw new Error("Timed out waiting for /hello in a Telegram DM or control supergroup");
  }

  db.close();
}

async function handleCleanup(args: string[]): Promise<void> {
  const parsed = parseArgs({
    args,
    options: {
      repo: { type: "string" },
      "dry-run": { type: "boolean" },
      force: { type: "boolean" }
    },
    strict: true
  });

  const repoRoot = path.resolve(requireString(parsed.values.repo, "--repo"));
  const { config, db } = await openProject(repoRoot);

  const worktreeRows = db.db
    .prepare(
      `
        SELECT worktrees.id, worktrees.path, tasks.status, tasks.updated_at
        FROM worktrees
        JOIN tasks ON tasks.id = worktrees.task_id
        WHERE worktrees.project_id = ?
      `
    )
    .all(config.projectId) as Array<Record<string, unknown>>;

  const now = Date.now();
  const completedCutoffMs = 30 * 60 * 1000;
  const blockedCutoffMs = 24 * 60 * 60 * 1000;
  const cleanupTargets = worktreeRows.filter((row) => {
    const updatedAt = Date.parse(String(row.updated_at));
    const ageMs = now - updatedAt;
    const status = String(row.status);
    if (status === "done" || status === "cancelled") {
      return parsed.values.force || ageMs >= completedCutoffMs;
    }
    if (status === "failed" || status === "blocked") {
      return parsed.values.force || ageMs >= blockedCutoffMs;
    }
    return false;
  });

  if (parsed.values["dry-run"] || cleanupTargets.length === 0) {
    console.log(JSON.stringify({ cleanupTargets }, null, 2));
    db.close();
    return;
  }

  for (const row of cleanupTargets) {
    const worktreePath = String(row.path);
    await removePath(worktreePath);
    db.releasePortLeasesByWorktree(String(row.id));
  }

  console.log(`Removed ${cleanupTargets.length} worktree(s)`);
  db.close();
}

async function handleStart(args: string[]): Promise<void> {
  const parsed = parseArgs({
    args,
    options: {
      repo: { type: "string" },
      foreground: { type: "boolean" },
      once: { type: "boolean" }
    },
    strict: true
  });

  const repoRoot = path.resolve(requireString(parsed.values.repo, "--repo"));
  await loadRepoEnv(repoRoot);
  const factoryRepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const factorydEntrypoint = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../factoryd/src/main.ts"
  );
  const commandArgs = ["--import", "tsx", factorydEntrypoint, "--repo", repoRoot];
  if (parsed.values.once) {
    commandArgs.push("--once");
  }

  if (parsed.values.foreground) {
    const result = await runCommand(process.execPath, commandArgs, {
      cwd: factoryRepoRoot,
      allowNonZeroExit: true
    });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    if (result.exitCode !== 0) {
      throw new Error(`factoryd exited with code ${result.exitCode}`);
    }
    return;
  }

  const paths = getFactoryPaths(repoRoot);
  const existingPidText = await readText(paths.supervisorPidPath).catch(() => undefined);
  const existingPid = existingPidText ? Number.parseInt(existingPidText.trim(), 10) : undefined;
  if (existingPid && Number.isFinite(existingPid)) {
    try {
      process.kill(existingPid, 0);
      console.log(`factoryd is already running for ${repoRoot} (pid ${existingPid})`);
      return;
    } catch {
      // Ignore stale pid files and launch a fresh daemon below.
    }
  }

  const spawned = await spawnLoggedProcess({
    command: process.execPath,
    args: commandArgs,
    cwd: factoryRepoRoot,
    stdoutPath: path.join(paths.logsDir, "factoryd.out.log"),
    stderrPath: path.join(paths.logsDir, "factoryd.err.log"),
    detached: true
  });
  console.log(`Started factoryd (pid ${spawned.pid ?? "unknown"})`);
}

async function handleStop(args: string[]): Promise<void> {
  const parsed = parseArgs({
    args,
    options: {
      repo: { type: "string" },
      force: { type: "boolean" }
    },
    strict: true
  });

  const repoRoot = path.resolve(requireString(parsed.values.repo, "--repo"));
  await loadRepoEnv(repoRoot);
  const config = await loadProjectConfig(repoRoot);
  const paths = getFactoryPaths(repoRoot);
  const supervisorPidText = await readText(paths.supervisorPidPath).catch(() => "");
  const supervisorPid = Number.parseInt(supervisorPidText.trim(), 10);
  const knownPorts = [
    config.ports.stableProxy,
    config.ports.stableA,
    config.ports.stableB,
    config.ports.preview,
    config.ports.dashboard,
    config.ports.appServer
  ];

  let attemptedGracefulStop = false;
  try {
    attemptedGracefulStop = await requestDashboardStop(config);
  } catch {
    attemptedGracefulStop = false;
  }

  if (Number.isFinite(supervisorPid)) {
    if (!attemptedGracefulStop) {
      await signalProcess(supervisorPid, "SIGTERM");
    }
    await waitForProcessExit(supervisorPid, 20_000);
  }

  const remainingListenerPids = await listListenerPids(repoRoot, knownPorts);
  const shouldForceCleanup =
    parsed.values.force ||
    (Number.isFinite(supervisorPid) && isProcessAlive(supervisorPid)) ||
    remainingListenerPids.size > 0;

  if (shouldForceCleanup) {
    if (Number.isFinite(supervisorPid) && isProcessAlive(supervisorPid)) {
      await killProcessTree(repoRoot, supervisorPid);
    }
    for (const pid of remainingListenerPids) {
      await killProcessTree(repoRoot, pid);
    }
  }

  await removePath(paths.supervisorPidPath).catch(() => undefined);

  const listenersAfterStop = await listListenerPids(repoRoot, knownPorts);
  const stopped =
    (!Number.isFinite(supervisorPid) || !isProcessAlive(supervisorPid)) &&
    listenersAfterStop.size === 0;

  if (!stopped) {
    throw new Error(`Failed to stop factory cleanly for ${repoRoot}`);
  }

  console.log(`Stopped factoryd for ${repoRoot}`);
}

async function requestDashboardStop(config: FactoryProjectConfig): Promise<boolean> {
  const response = await fetch(`http://127.0.0.1:${config.ports.dashboard}/internal/stop`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      reason: "factoryctl_stop"
    })
  }).catch(() => undefined);

  return Boolean(response?.ok);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function signalProcess(pid: number, signal: NodeJS.Signals): Promise<void> {
  try {
    process.kill(pid, signal);
  } catch {
    // Ignore already-dead processes during stop.
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function killProcessTree(repoRoot: string, pid: number): Promise<void> {
  const psResult = await runCommand(
    "ps",
    ["-eo", "pid=,ppid="],
    {
      cwd: repoRoot,
      allowNonZeroExit: true
    }
  );
  const childrenByParent = new Map<number, number[]>();
  for (const line of psResult.stdout.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!match) {
      continue;
    }
    const childPid = Number.parseInt(match[1] ?? "", 10);
    const parentPid = Number.parseInt(match[2] ?? "", 10);
    const children = childrenByParent.get(parentPid) ?? [];
    children.push(childPid);
    childrenByParent.set(parentPid, children);
  }

  const descendants = new Set<number>([pid]);
  const queue = [pid];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) {
      continue;
    }
    for (const childPid of childrenByParent.get(current) ?? []) {
      if (descendants.has(childPid)) {
        continue;
      }
      descendants.add(childPid);
      queue.push(childPid);
    }
  }

  const ordered = [...descendants].sort((left, right) => right - left);
  for (const targetPid of ordered) {
    await signalProcess(targetPid, "SIGTERM");
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
  for (const targetPid of ordered) {
    if (!isProcessAlive(targetPid)) {
      continue;
    }
    await signalProcess(targetPid, "SIGKILL");
  }
}

async function listListenerPids(repoRoot: string, ports: number[]): Promise<Set<number>> {
  const pids = new Set<number>();
  for (const port of ports) {
    const result = await runCommand("ss", ["-ltnp", `( sport = :${port} )`], {
      cwd: repoRoot,
      allowNonZeroExit: true
    }).catch(() => ({ stdout: "", stderr: "", exitCode: 1 }));
    for (const match of result.stdout.matchAll(/pid=(\d+)/g)) {
      const pid = Number.parseInt(match[1] ?? "", 10);
      if (Number.isFinite(pid)) {
        pids.add(pid);
      }
    }
  }
  return pids;
}
