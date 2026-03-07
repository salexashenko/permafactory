import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  allocatePorts,
  computeDecisionBudgetSnapshot,
  formatHttpUrl,
  normalizeManagerTurnOutput,
  parseTopLevelBacklogItems,
  selectReachableHost,
  shouldDeliverTelegramNotification,
  validateWithSchema
} from "@permafactory/runtime";
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
    preview: 3100,
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
    servePreview: "npm run preview",
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

test("shouldDeliverTelegramNotification only allows direct replies, decisions, ships, and digests", () => {
  assert.equal(shouldDeliverTelegramNotification("decision_required"), true);
  assert.equal(shouldDeliverTelegramNotification("ship_result"), true);
  assert.equal(shouldDeliverTelegramNotification("daily_digest"), true);
  assert.equal(shouldDeliverTelegramNotification("info_update"), false);
  assert.equal(
    shouldDeliverTelegramNotification("info_update", { isDirectUserResponse: true }),
    true
  );
  assert.equal(shouldDeliverTelegramNotification("incident_alert"), false);
});

test("manager output schema accepts a minimal valid payload", async () => {
  const schemaPath = path.resolve("schemas/manager-output.schema.json");
  const output: ManagerTurnOutput = {
    summary: "No-op turn",
    userMessages: [],
    tasksToStart: [],
    tasksToCancel: [],
    reviewsToStart: [],
    deployments: [],
    decisions: [],
    assumptions: []
  };

  const result = await validateWithSchema<ManagerTurnOutput>(schemaPath, output);
  assert.equal(result.valid, true);
});

test("manager output schema rejects malformed tasks", async () => {
  const schemaPath = path.resolve("schemas/manager-output.schema.json");
  const malformed = {
    summary: "Bad output",
    userMessages: [],
    tasksToStart: [{ id: "x" }] satisfies Partial<TaskContract>[],
    tasksToCancel: [],
    reviewsToStart: [],
    deployments: [],
    decisions: [],
    assumptions: []
  };

  const result = await validateWithSchema<ManagerTurnOutput>(schemaPath, malformed);
  assert.equal(result.valid, false);
});

test("normalizeManagerTurnOutput materializes planner-friendly manager output", async () => {
  const schemaPath = path.resolve("schemas/manager-output.schema.json");
  const normalized = normalizeManagerTurnOutput(
    {
      summary: "Bootstrap the repo",
      userMessages: [{ kind: "reply", message: "I am baselining the calculator app." }],
      tasksToStart: [
        {
          kind: "feature",
          title: "Baseline the calculator app",
          goal: "Verify build, test, and preview workflows for the calculator web app.",
          acceptance: ["Build passes", "Tests pass"],
          checks: ["npm run build", "npm test", "npm run smoke"]
        }
      ],
      deployments: [{ action: "preview", summary: "Refresh preview after baseline checks." }],
      assumptions: ["Use candidate as the default base branch."]
    },
    {
      candidateBranch: "candidate",
      worktreesDir: "/tmp/demo/.factory/worktrees",
      now: "2026-03-07T00:00:00.000Z",
      createId: (prefix) => `${prefix}_fixed`
    }
  );

  assert.equal(normalized.userMessages[0]?.kind, "info_update");
  assert.equal(normalized.tasksToStart[0]?.id, "task_fixed");
  assert.equal(normalized.tasksToStart[0]?.branchName, "agent/baseline-the-calculator-app");
  assert.equal(normalized.tasksToStart[0]?.worktreePath, "/tmp/demo/.factory/worktrees/task_fixed");
  assert.equal(normalized.deployments[0]?.kind, "deploy_preview");

  const result = await validateWithSchema<ManagerTurnOutput>(schemaPath, normalized);
  assert.equal(result.valid, true);
});
