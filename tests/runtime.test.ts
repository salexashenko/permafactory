import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import {
  allocateFreshTaskId,
  allocatePorts,
  applyWorkerSandboxCapabilities,
  buildProjectSpecExcerpt,
  compressRecentManagerTurns,
  computeNoActiveWorkWakeCooldownMs,
  computeDecisionBudgetSnapshot,
  currentCommit,
  deriveEffectivePortLeaseRequirement,
  formatHttpUrl,
  getFactoryPaths,
  isManagerTurnNoOp,
  isLikelyGreenfieldRepoFiles,
  loadEnvFile,
  matchesTelegramSlashCommand,
  normalizeManagerLoopSummary,
  normalizeManagerTurnOutput,
  parseTopLevelBacklogItems,
  readEnvFileValues,
  resolveRuntimeScriptCommand,
  runCommand,
  selectReachableHost,
  selectTaskCommitMessage,
  selectTaskWorktreePath,
  shouldDeliverTelegramNotification,
  updateGitBranchRef,
  upsertEnvFileValue,
  validateWithSchema
} from "@permafactory/runtime";
import { ensureProjectSpecAndConfig } from "@permafactory/config";
import type { FactoryProjectConfig, ManagerTurnOutput, TaskContract } from "@permafactory/models";

const config: FactoryProjectConfig = {
  projectId: "demo",
  repoRoot: "/tmp/demo",
  defaultBranch: "main",
  candidateBranch: "candidate",
  projectSpecPath: "docs/project-spec.md",
  timezone: "UTC",
  codex: {
    versionFloor: "0.111.0",
    model: "gpt-5.4",
    managerModel: "gpt-5.4",
    approvalPolicy: "never",
    sandboxMode: "workspace-write",
    appServerUrl: "ws://127.0.0.1:7781",
    searchEnabled: true,
    codingReasoningPolicy: {
      simple: "medium",
      complex: "extra-high",
      fallbackHighestSupported: "high"
    }
  },
  telegram: {
    botTokenEnvVar: "TELEGRAM_BOT_TOKEN",
    webhookSecretEnvVar: "TELEGRAM_WEBHOOK_SECRET",
    controlChatId: "",
    allowedAdminUserIds: [],
    allowAdminDm: false
  },
  intake: {
    sources: ["telegram", "backlog_file"],
    backlogFile: ".factory/backlog.md"
  },
  bootstrap: {
    status: "waiting_for_telegram",
    onboardingSummaryPath: "docs/factory-onboarding.md"
  },
  scheduler: {
    tickSeconds: 15,
    minWorkers: 1,
    maxWorkers: 3,
    workerStallSeconds: 600,
    managerStallSeconds: 600,
    messageResponseSlaSeconds: 60
  },
  ports: {
    stableProxy: 3000,
    stableA: 3001,
    stableB: 3002,
    dashboard: 8787,
    appServer: 7781,
    workerStart: 3200,
    workerEnd: 3299,
    e2eStart: 4200,
    e2eEnd: 4299
  },
  scripts: {
    bootstrapWorktree: ".factory/scripts/bootstrap-worktree.sh",
    install: "npm ci",
    lint: "npm run lint",
    test: "npm run test",
    build: "npm run build",
    smoke: "npm run smoke",
    serveStable: "npm run start",
    serveWorker: "npm run dev",
    e2e: "npm run e2e",
    healthcheck: "npm run healthcheck"
  },
  browserActions: {
    enabled: true,
    namespace: "__factory"
  },
  decisionBudget: {
    dailyLimit: 15,
    reserveCritical: 3
  }
};

test("parseTopLevelBacklogItems extracts bullets and headings", () => {
  const items = parseTopLevelBacklogItems(`# Backlog

- first task
  more detail

## second task
extra detail
`);
  assert.deepEqual(items, ["first task\nmore detail", "second task\nextra detail"]);
});

test("computeDecisionBudgetSnapshot preserves critical reserve", () => {
  const snapshot = computeDecisionBudgetSnapshot("2026-03-06", 12, 15, 3);
  assert.equal(snapshot.remaining, 3);
  assert.equal(snapshot.remainingNormal, 0);
  assert.equal(snapshot.remainingCriticalReserve, 3);
});

test("allocatePorts can allocate app-only leases", () => {
  const ports = allocatePorts(config, new Set([3200, 3201, 4200]), { app: true, e2e: false });
  assert.deepEqual(ports, { app: 3202 });
});

test("allocateFreshTaskId preserves unused ids and increments reused ids", () => {
  assert.equal(allocateFreshTaskId("task-alpha", []), "task-alpha");
  assert.equal(allocateFreshTaskId("task-alpha", ["task-alpha"]), "task-alpha-r2");
  assert.equal(
    allocateFreshTaskId("task-alpha", ["task-alpha", "task-alpha-r2", "task-alpha-r3"]),
    "task-alpha-r4"
  );
});

test("selectTaskWorktreePath prefers the branch lane path over a new requested path", () => {
  assert.equal(
    selectTaskWorktreePath("/tmp/worktrees", "task/clean-phone-shell", {
      existingWorktreePath: "/tmp/worktrees/task-clean-phone-shell",
      requestedWorktreePath: "/tmp/worktrees/task-clean-phone-shell-retry"
    }),
    "/tmp/worktrees/task-clean-phone-shell"
  );
  assert.equal(
    selectTaskWorktreePath("/tmp/worktrees", "task/clean-phone-shell", {
      requestedWorktreePath: "/tmp/worktrees/task-clean-phone-shell-retry"
    }),
    "/tmp/worktrees/task-clean-phone-shell-retry"
  );
  assert.equal(
    selectTaskWorktreePath("/tmp/worktrees", "task/clean-phone-shell"),
    "/tmp/worktrees/task-clean-phone-shell"
  );
});

test("compressRecentManagerTurns collapses repeated no-op loop turns", () => {
  const turns = [
    {
      at: "2026-03-09T18:28:46.695Z",
      summary: "No safe manager action changed this turn because routing is still unreliable.",
      wakeReasons: ["no_active_work"],
      actionCounts: {
        tasksToStart: 0,
        tasksToCancel: 0,
        reviewsToStart: 0,
        integrations: 0,
        deployments: 0,
        decisions: 0,
        userMessages: 0
      },
      actionPreview: {
        tasksToStart: [],
        tasksToCancel: [],
        reviewsToStart: [],
        integrations: [],
        deployments: [],
        decisions: [],
        userMessages: []
      },
      mismatchHints: [],
      toolCalls: []
    },
    {
      at: "2026-03-09T18:27:28.270Z",
      summary: "No safe manager action changed this turn because routing is still unreliable.",
      wakeReasons: ["no_active_work"],
      actionCounts: {
        tasksToStart: 0,
        tasksToCancel: 0,
        reviewsToStart: 0,
        integrations: 0,
        deployments: 0,
        decisions: 0,
        userMessages: 0
      },
      actionPreview: {
        tasksToStart: [],
        tasksToCancel: [],
        reviewsToStart: [],
        integrations: [],
        deployments: [],
        decisions: [],
        userMessages: []
      },
      mismatchHints: [],
      toolCalls: []
    },
    {
      at: "2026-03-09T18:23:58.695Z",
      summary: "Started review on task/foo against candidate.",
      wakeReasons: ["worker_terminal"],
      actionCounts: {
        tasksToStart: 0,
        tasksToCancel: 0,
        reviewsToStart: 1,
        integrations: 0,
        deployments: 0,
        decisions: 0,
        userMessages: 0
      },
      actionPreview: {
        tasksToStart: [],
        tasksToCancel: [],
        reviewsToStart: ["task/foo->candidate"],
        integrations: [],
        deployments: [],
        decisions: [],
        userMessages: []
      },
      mismatchHints: [],
      toolCalls: ["completed:start_review:task/foo->candidate"]
    }
  ];

  const compressed = compressRecentManagerTurns(turns);
  assert.equal(compressed.length, 2);
  assert.equal(compressed[0]?.at, "2026-03-09T18:28:46.695Z");
  assert.equal(compressed[1]?.at, "2026-03-09T18:23:58.695Z");
});

test("computeNoActiveWorkWakeCooldownMs backs off repeated no-op continuity wakes", () => {
  const repeatedNoOps = Array.from({ length: 4 }, (_, index) => ({
    at: `2026-03-09T18:2${index}:00.000Z`,
    summary: "No safe manager action changed this turn because routing is still unreliable.",
    wakeReasons: ["no_active_work"],
    actionCounts: {
      tasksToStart: 0,
      tasksToCancel: 0,
      reviewsToStart: 0,
      integrations: 0,
      deployments: 0,
      decisions: 0,
      userMessages: 0
    },
    actionPreview: {
      tasksToStart: [],
      tasksToCancel: [],
      reviewsToStart: [],
      integrations: [],
      deployments: [],
      decisions: [],
      userMessages: []
    },
    mismatchHints: [],
    toolCalls: []
  }));

  assert.equal(isManagerTurnNoOp(repeatedNoOps[0]!), true);
  assert.equal(
    normalizeManagerLoopSummary("No safe manager action changed this turn because routing is still unreliable."),
    normalizeManagerLoopSummary("No safe manager action changed this turn because routing is still unreliable.")
  );
  assert.equal(computeNoActiveWorkWakeCooldownMs(repeatedNoOps, 60_000), 15 * 60_000);
});

test("deriveEffectivePortLeaseRequirement suppresses worker ports when sandbox cannot bind", () => {
  const requirement = deriveEffectivePortLeaseRequirement(
    {
      kind: "code",
      needsAppRuntime: true,
      constraints: {
        mustRunChecks: ["npm run preview", "npm run smoke"]
      }
    },
    {
      canBindListenSockets: false
    }
  );

  assert.deepEqual(requirement, { app: false, e2e: false });
});

test("applyWorkerSandboxCapabilities clears unusable worker ports and records the capability", () => {
  const contract: TaskContract = {
    id: "task_demo",
    kind: "code",
    title: "Bootstrap runtime",
    goal: "Bootstrap runtime",
    acceptanceCriteria: ["Runtime command exists"],
    baseBranch: "candidate",
    branchName: "task/bootstrap-runtime",
    worktreePath: "/tmp/demo/.factory/worktrees/task_demo",
    lockScope: ["repo"],
    needsAppRuntime: true,
    ports: {
      app: 3200,
      e2e: 4200
    },
    runtime: {
      maxRuntimeMinutes: 45,
      reasoningEffort: "medium"
    },
    constraints: {
      mustRunChecks: ["npm run preview"]
    },
    context: {
      userIntent: "Bootstrap runtime",
      relatedTaskIds: [],
      blockingDecisions: []
    }
  };

  const adapted = applyWorkerSandboxCapabilities(contract, {
    canBindListenSockets: false
  });

  assert.deepEqual(adapted.ports, {});
  assert.equal(adapted.context.runtimeCapabilities?.canBindListenSockets, false);
});

test("isLikelyGreenfieldRepoFiles detects spec-only repos", () => {
  assert.equal(
    isLikelyGreenfieldRepoFiles(
      ["spec.md", "docs/factory-onboarding.md", "AGENTS.md", "factory.config.ts"],
      "spec.md"
    ),
    true
  );
});

test("isLikelyGreenfieldRepoFiles detects runnable project trees", () => {
  assert.equal(isLikelyGreenfieldRepoFiles(["spec.md", "package.json"], "spec.md"), false);
  assert.equal(isLikelyGreenfieldRepoFiles(["spec.md", "src/app.tsx"], "spec.md"), false);
});

test("selectReachableHost prefers Tailscale DNS and falls back to LAN IP", () => {
  assert.deepEqual(
    selectReachableHost({
      tailscaleDnsName: "bigboy.tail685bf8.ts.net.",
      tailscaleIp: "100.90.88.58",
      lanIp: "192.168.1.10"
    }),
    {
      host: "bigboy.tail685bf8.ts.net",
      source: "tailscale-dns"
    }
  );

  assert.deepEqual(
    selectReachableHost({
      lanIp: "192.168.1.10"
    }),
    {
      host: "192.168.1.10",
      source: "lan-ip"
    }
  );
});

test("formatHttpUrl brackets IPv6 hosts", () => {
  assert.equal(formatHttpUrl("100.90.88.58", 3100), "http://100.90.88.58:3100");
  assert.equal(formatHttpUrl("fd7a:115c:a1e0::ea01:583a", 3100), "http://[fd7a:115c:a1e0::ea01:583a]:3100");
});

test("getFactoryPaths exposes lifecycle log and heartbeat paths", () => {
  const paths = getFactoryPaths("/tmp/demo");
  assert.equal(paths.heartbeatPath, "/tmp/demo/.factory/factoryd.heartbeat.json");
  assert.equal(paths.lifecycleLogPath, "/tmp/demo/.factory/logs/factoryd.lifecycle.log");
});

test("buildProjectSpecExcerpt preserves short specs and truncates long ones", () => {
  assert.equal(buildProjectSpecExcerpt("## Spec\nShip it\n", { maxChars: 100 }), "## Spec\nShip it");

  const longText = "A".repeat(120);
  const excerpt = buildProjectSpecExcerpt(longText, { maxChars: 40 });
  assert.match(excerpt, /^\S{40}/);
  assert.match(excerpt, /\[project spec excerpt truncated\]$/);
});

test("shouldDeliverTelegramNotification allows direct replies, decisions, ships, incidents, and digests", () => {
  assert.equal(shouldDeliverTelegramNotification("decision_required"), true);
  assert.equal(shouldDeliverTelegramNotification("ship_result"), true);
  assert.equal(shouldDeliverTelegramNotification("daily_digest"), true);
  assert.equal(shouldDeliverTelegramNotification("info_update"), false);
  assert.equal(
    shouldDeliverTelegramNotification("info_update", { isDirectUserResponse: true }),
    true
  );
  assert.equal(shouldDeliverTelegramNotification("incident_alert"), true);
});

test("matchesTelegramSlashCommand accepts bot-targeted commands with optional payload", () => {
  assert.equal(matchesTelegramSlashCommand("/stop", "stop"), true);
  assert.equal(matchesTelegramSlashCommand("/stop@test_bot", "stop"), true);
  assert.equal(matchesTelegramSlashCommand("/secret OPENAI_API_KEY sk-test", "secret"), true);
  assert.equal(matchesTelegramSlashCommand("/hello", "stop"), false);
});

test("resolveRuntimeScriptCommand prefers the deployed worktree command when available", () => {
  assert.equal(
    resolveRuntimeScriptCommand("npm run preview", "echo 'serve script not configured'"),
    "npm run preview"
  );
  assert.equal(
    resolveRuntimeScriptCommand("npm run preview", "npm run serve"),
    "npm run preview"
  );
});

test("resolveRuntimeScriptCommand falls back to configured overrides when detection has no command", () => {
  assert.equal(
    resolveRuntimeScriptCommand("echo 'serve script not configured'", "node scripts/custom-serve.mjs"),
    "node scripts/custom-serve.mjs"
  );
});

test("selectTaskCommitMessage prefers manager-owned commit summaries", () => {
  assert.equal(
    selectTaskCommitMessage({
      taskId: "task_feature",
      title: "Implement basic incident investigation flow",
      commitMessageHint: "Add first incident investigation flow to the Verdant field notebook",
      recommendedCommitMessage: "test: harden coverage",
      summary: "Added incident investigation UI and state flow"
    }),
    "Add first incident investigation flow to the Verdant field notebook"
  );
});

test("selectTaskCommitMessage falls back to the manager task title before worker prefixes", () => {
  assert.equal(
    selectTaskCommitMessage({
      taskId: "task_feature",
      title: "Add first creature bond interaction",
      recommendedCommitMessage: "fix: wire button"
    }),
    "Add first creature bond interaction"
  );
});

test("updateGitBranchRef advances a branch ref to the deployed commit", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "permafactory-git-"));

  await runCommand("git", ["init", "-b", "main"], { cwd: repoRoot });
  await runCommand("git", ["config", "user.name", "Permafactory Test"], { cwd: repoRoot });
  await runCommand("git", ["config", "user.email", "permafactory@example.com"], { cwd: repoRoot });

  await writeFile(path.join(repoRoot, "spec.md"), "# Demo\n");
  await runCommand("git", ["add", "spec.md"], { cwd: repoRoot });
  await runCommand("git", ["commit", "-m", "Initial spec"], { cwd: repoRoot });
  await runCommand("git", ["branch", "candidate"], { cwd: repoRoot });
  await runCommand("git", ["checkout", "candidate"], { cwd: repoRoot });
  await writeFile(path.join(repoRoot, "feature.txt"), "hello\n");
  await runCommand("git", ["add", "feature.txt"], { cwd: repoRoot });
  await runCommand("git", ["commit", "-m", "Feature commit"], { cwd: repoRoot });
  const featureCommit = await currentCommit(repoRoot, "HEAD");
  await runCommand("git", ["checkout", "main"], { cwd: repoRoot });

  await updateGitBranchRef(repoRoot, "main", featureCommit);

  assert.equal(await currentCommit(repoRoot, "main"), featureCommit);
});

test("ensureProjectSpecAndConfig adds permafactory ignores to target repo gitignore", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "permafactory-init-"));

  await writeFile(path.join(repoRoot, ".gitignore"), "node_modules/\n");

  await ensureProjectSpecAndConfig({
    repoRoot,
    projectId: "demo",
    defaultBranch: "main",
    projectSpecPath: "spec.md"
  });
  await ensureProjectSpecAndConfig({
    repoRoot,
    projectId: "demo",
    defaultBranch: "main",
    projectSpecPath: "spec.md"
  });

  const gitignoreText = await readFile(path.join(repoRoot, ".gitignore"), "utf8");

  assert.match(gitignoreText, /^node_modules\/\n\n# Permafactory\n/m);
  assert.match(gitignoreText, /^\.factory\/$/m);
  assert.match(gitignoreText, /^\.env\.factory$/m);
  assert.match(gitignoreText, /^\.env\.factory\.example$/m);
  assert.match(gitignoreText, /^\.factory\.env$/m);
  assert.equal((gitignoreText.match(/# Permafactory/g) ?? []).length, 1);
});

test("manager output schema accepts a minimal valid payload", async () => {
  const schemaPath = path.resolve("schemas/manager-output.schema.json");
  const output: ManagerTurnOutput = {
    summary: "No-op turn",
    assumptions: []
  };

  const result = await validateWithSchema<ManagerTurnOutput>(schemaPath, output);
  assert.equal(result.valid, true);
});

test("manager output schema rejects legacy side-effect fields", async () => {
  const schemaPath = path.resolve("schemas/manager-output.schema.json");
  const malformed = {
    summary: "Bad output",
    tasksToStart: [
      {
        id: "x"
      }
    ],
    assumptions: []
  };

  const result = await validateWithSchema<ManagerTurnOutput>(schemaPath, malformed);
  assert.equal(result.valid, false);
});

test("normalizeManagerTurnOutput keeps only summary and assumptions", async () => {
  const schemaPath = path.resolve("schemas/manager-output.schema.json");
  const normalized = normalizeManagerTurnOutput(
    {
      summary: "Bootstrap the repo",
      assumptions: ["Use candidate as the default base branch."]
    },
    {
      candidateBranch: "candidate",
      worktreesDir: "/tmp/demo/.factory/worktrees",
      now: "2026-03-07T00:00:00.000Z",
      createId: (prefix) => `${prefix}_fixed`
    }
  );

  assert.equal(normalized.summary, "Bootstrap the repo");
  assert.deepEqual(normalized.assumptions, ["Use candidate as the default base branch."]);

  const result = await validateWithSchema<ManagerTurnOutput>(schemaPath, normalized);
  assert.equal(result.valid, true);
});

test("normalizeManagerTurnOutput rejects legacy side-effect arrays", () => {
  assert.throws(
    () =>
      normalizeManagerTurnOutput(
        {
          summary: "Do work",
          tasksToStart: [{ id: "task_1" }]
        },
        {
          candidateBranch: "candidate",
          worktreesDir: "/tmp/demo/.factory/worktrees"
        }
      ),
    /use MCP tools instead/
  );
});

test("upsertEnvFileValue stores secrets without corrupting the env file", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "permafactory-runtime-"));
  const envPath = path.join(dir, ".env.factory");

  await upsertEnvFileValue(envPath, "OPENAI_API_KEY", "sk-demo");
  await upsertEnvFileValue(envPath, "JSON_SECRET", '{"a":1}');
  await upsertEnvFileValue(envPath, "OPENAI_API_KEY", "sk-updated");

  const values = await readEnvFileValues(envPath);
  assert.deepEqual(values, {
    OPENAI_API_KEY: "sk-updated",
    JSON_SECRET: '{"a":1}'
  });
});

test("loadEnvFile can override existing values and parse quoted secrets", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "permafactory-runtime-"));
  const envPath = path.join(dir, ".env.factory");

  await upsertEnvFileValue(envPath, "TEST_FACTORY_SECRET", "from-file");
  await upsertEnvFileValue(envPath, "TEST_FACTORY_JSON", '{"enabled":true}');

  process.env.TEST_FACTORY_SECRET = "existing";
  const loadedKeys = await loadEnvFile(envPath, { override: true });

  assert.equal(process.env.TEST_FACTORY_SECRET, "from-file");
  assert.equal(process.env.TEST_FACTORY_JSON, '{"enabled":true}');
  assert.deepEqual(
    new Set(loadedKeys),
    new Set(["TEST_FACTORY_SECRET", "TEST_FACTORY_JSON"])
  );

  delete process.env.TEST_FACTORY_SECRET;
  delete process.env.TEST_FACTORY_JSON;
});
