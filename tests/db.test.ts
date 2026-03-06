import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { FactoryDatabase } from "@permafactory/db";
import type { DecisionRequest, FactoryProjectConfig, TaskContract } from "@permafactory/models";

function makeConfig(repoRoot: string): FactoryProjectConfig {
  return {
    projectId: "demo",
    repoRoot,
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
      status: "active",
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
}

function makeDecision(id: string, expiresAt: string): DecisionRequest {
  return {
    id,
    title: `Decision ${id}`,
    reason: "Need a choice",
    priority: "medium",
    dedupeKey: `dedupe-${id}`,
    options: [
      { id: "opt_a", label: "A", consequence: "Do A" },
      { id: "opt_b", label: "B", consequence: "Do B" }
    ],
    defaultOptionId: "opt_a",
    expiresAt,
    impactSummary: "Impacts the task",
    budgetCost: 1
  };
}

function makeTask(id: string, blockingDecisions: string[]): TaskContract {
  return {
    id,
    kind: "code",
    title: "Blocked task",
    goal: "Wait for the decision",
    acceptanceCriteria: ["Decision is resolved"],
    baseBranch: "candidate",
    branchName: `agent/${id}`,
    worktreePath: `/tmp/${id}`,
    lockScope: [],
    needsPreview: false,
    ports: {},
    runtime: {
      maxRuntimeMinutes: 15,
      reasoningEffort: "medium"
    },
    constraints: {
      mustRunChecks: []
    },
    context: {
      userIntent: "Test blocking",
      relatedTaskIds: [],
      blockingDecisions
    }
  };
}

async function withDb(
  run: (db: FactoryDatabase, config: FactoryProjectConfig) => Promise<void> | void
): Promise<void> {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "permafactory-db-"));
  const db = await FactoryDatabase.open(repoRoot);
  const config = makeConfig(repoRoot);
  db.init();
  db.upsertProject(config);

  try {
    await run(db, config);
  } finally {
    db.close();
    await rm(repoRoot, { recursive: true, force: true });
  }
}

test("requeueSatisfiedBlockedTasks waits for all blocking decisions", async () => {
  await withDb((db, config) => {
    db.insertDecision(config.projectId, makeDecision("dec_a", "2026-03-07T00:00:00.000Z"));
    db.insertDecision(config.projectId, makeDecision("dec_b", "2026-03-07T00:00:00.000Z"));

    db.upsertTask({
      projectId: config.projectId,
      id: "task_blocked",
      kind: "code",
      status: "blocked",
      title: "Blocked task",
      priority: "medium",
      goal: "Wait for reply",
      contract: makeTask("task_blocked", ["dec_a", "dec_b"]),
      blockedByDecisionIds: ["dec_a", "dec_b"]
    });

    assert.deepEqual(db.requeueSatisfiedBlockedTasks(config.projectId), []);
    db.resolveDecision("dec_a", "resolved", "opt_b");
    assert.deepEqual(db.requeueSatisfiedBlockedTasks(config.projectId), []);
    db.resolveDecision("dec_b", "resolved", "opt_a");
    assert.deepEqual(db.requeueSatisfiedBlockedTasks(config.projectId), ["task_blocked"]);
    assert.equal(db.getTask("task_blocked")?.status, "queued");
    assert.deepEqual(db.getTask("task_blocked")?.blockedByDecisionIds, []);
  });
});

test("expireTimedOutDecisions applies the default option", async () => {
  await withDb((db, config) => {
    db.insertDecision(config.projectId, makeDecision("dec_timeout", "2026-03-06T00:00:00.000Z"));
    const expired = db.expireTimedOutDecisions("2026-03-06T12:00:00.000Z");
    assert.equal(expired.length, 1);
    assert.equal(expired[0]?.id, "dec_timeout");

    const decision = db.getDecision("dec_timeout");
    assert.equal(decision?.status, "timed_out");
    assert.equal(decision?.resolvedOptionId, "opt_a");
  });
});
