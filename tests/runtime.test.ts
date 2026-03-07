import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import {
  allocatePorts,
  applyWorkerSandboxCapabilities,
  computeDecisionBudgetSnapshot,
  deriveEffectivePortLeaseRequirement,
  formatHttpUrl,
  isLikelyGreenfieldRepoFiles,
  loadEnvFile,
  normalizeManagerTurnOutput,
  parseTopLevelBacklogItems,
  readEnvFileValues,
  resolveRuntimeScriptCommand,
  selectReachableHost,
  shouldDeliverTelegramNotification,
  upsertEnvFileValue,
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

test("deriveEffectivePortLeaseRequirement suppresses worker ports when sandbox cannot bind", () => {
  const requirement = deriveEffectivePortLeaseRequirement(
    {
      kind: "code",
      needsPreview: true,
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
    title: "Bootstrap preview",
    goal: "Bootstrap preview",
    acceptanceCriteria: ["Preview command exists"],
    baseBranch: "candidate",
    branchName: "task/bootstrap-preview",
    worktreePath: "/tmp/demo/.factory/worktrees/task_demo",
    lockScope: ["repo"],
    needsPreview: true,
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
      userIntent: "Bootstrap preview",
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
