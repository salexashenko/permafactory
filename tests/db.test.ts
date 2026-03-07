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

test("upsertAgent updates the role when an existing agent id is reused", async () => {
  await withDb((db, config) => {
    db.upsertAgent({
      id: "agent-task",
      projectId: config.projectId,
      role: "code",
      status: "running",
      taskId: "task-1",
      branch: "task/task-1",
      worktreePath: "/tmp/task-1"
    });

    db.upsertAgent({
      id: "agent-task",
      projectId: config.projectId,
      role: "review",
      status: "running",
      taskId: "task-1",
      branch: "task/task-1",
      worktreePath: "/tmp/task-1"
    });

    const agent = db.listAgents(config.projectId).find((candidate) => candidate.id === "agent-task");
    assert.equal(agent?.role, "review");
    assert.equal(agent?.status, "running");
  });
});

test("getManagerInput exposes structured latest task facts and deployment reasons", async () => {
  await withDb((db, config) => {
    const contract = makeTask("task_structured", []);
    contract.context.relatedTaskIds = ["parent-task"];

    db.upsertTask({
      projectId: config.projectId,
      id: contract.id,
      kind: "code",
      status: "done",
      title: contract.title,
      priority: "medium",
      goal: contract.goal,
      branchName: contract.branchName,
      baseBranch: contract.baseBranch,
      worktreePath: contract.worktreePath,
      contract,
      blockedByDecisionIds: []
    });
    db.insertTaskEvent(contract.id, "completed", "Structured completion", {
      status: "completed",
      recommendedAction: "merge",
      checks: [{ name: "build", status: "passed" }]
    });
    db.recordDeployment({
      projectId: config.projectId,
      target: "preview",
      status: "down",
      url: "http://127.0.0.1:3100",
      commit: "abc123",
      reason: "Healthcheck failed"
    });

    const input = db.getManagerInput(config);
    const task = input.tasks.find((candidate) => candidate.id === contract.id);

    assert.deepEqual(task?.relatedTaskIds, ["parent-task"]);
    assert.equal(task?.latestEventType, "completed");
    assert.equal(task?.latestEventPayload?.recommendedAction, "merge");
    assert.equal(input.deployments.preview.reason, "Healthcheck failed");
    assert.equal(input.deployments.preview.commit, "abc123");
  });
});

test("getManagerInput exposes recent manager turns", async () => {
  await withDb((db, config) => {
    db.insertManagerTurn({
      projectId: config.projectId,
      summary: "Queued a branch review",
      wakeReasons: ["no_active_work", "deployment_failure"],
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
        reviewsToStart: ["task/bootstrap->candidate"],
        integrations: [],
        deployments: [],
        decisions: [],
        userMessages: []
      },
      mismatchHints: ["summary_mentions_review_without_review_action"],
      toolCalls: [],
      rawOutput: {
        summary: "Queued a branch review",
        reviewsToStart: [{ branch: "task/bootstrap", baseBranch: "candidate", reason: "Review it" }]
      }
    });

    const input = db.getManagerInput(config);
    assert.equal(input.recentManagerTurns[0]?.summary, "Queued a branch review");
    assert.deepEqual(input.recentManagerTurns[0]?.wakeReasons, ["no_active_work", "deployment_failure"]);
    assert.equal(input.recentManagerTurns[0]?.actionCounts.reviewsToStart, 1);
    assert.deepEqual(input.recentManagerTurns[0]?.actionPreview.reviewsToStart, ["task/bootstrap->candidate"]);
    assert.deepEqual(input.recentManagerTurns[0]?.mismatchHints, ["summary_mentions_review_without_review_action"]);
    assert.deepEqual(input.recentManagerTurns[0]?.toolCalls, []);
    assert.equal(input.recentManagerTurns[0]?.rawOutput?.summary, "Queued a branch review");
  });
});

test("manager tool calls persist and recent manager turns expose tool traces", async () => {
  await withDb((db, config) => {
    db.recordManagerToolCallStart({
      projectId: config.projectId,
      threadId: "thread_1",
      turnId: "turn_1",
      requestId: "req_1",
      toolName: "start_task",
      args: {
        id: "task_bootstrap",
        branchName: "task/bootstrap"
      }
    });
    db.finishManagerToolCall({
      projectId: config.projectId,
      requestId: "req_1",
      toolName: "start_task",
      status: "completed",
      result: {
        taskId: "task_bootstrap",
        status: "queued"
      }
    });

    db.insertManagerTurn({
      projectId: config.projectId,
      turnId: "turn_1",
      summary: "Started bootstrap work",
      wakeReasons: ["startup"],
      actionCounts: {
        tasksToStart: 1,
        tasksToCancel: 0,
        reviewsToStart: 0,
        integrations: 0,
        deployments: 0,
        decisions: 0,
        userMessages: 0
      },
      actionPreview: {
        tasksToStart: ["task_bootstrap:task/bootstrap"],
        tasksToCancel: [],
        reviewsToStart: [],
        integrations: [],
        deployments: [],
        decisions: [],
        userMessages: []
      },
      mismatchHints: [],
      toolCalls: ["completed:start_task:task_bootstrap:task/bootstrap"],
      rawOutput: {
        summary: "Started bootstrap work"
      }
    });

    const toolCalls = db.listManagerToolCallsByTurn(config.projectId, "turn_1");
    assert.equal(toolCalls.length, 1);
    assert.equal(toolCalls[0]?.toolName, "start_task");
    assert.equal(toolCalls[0]?.status, "completed");

    const recentTurns = db.listRecentManagerTurns(config.projectId, 1);
    assert.deepEqual(recentTurns[0]?.toolCalls, [
      "completed:start_task:task_bootstrap:task/bootstrap"
    ]);
  });
});

test("getManagerInput surfaces reply threading metadata for Telegram messages", async () => {
  await withDb((db, config) => {
    db.insertInboxItem({
      id: "inbox_1",
      projectId: config.projectId,
      source: "telegram",
      externalId: "101",
      receivedAt: "2026-03-07T00:00:00.000Z",
      text: "What shipped?",
      status: "new"
    });

    const input = db.getManagerInput(config);
    assert.equal(input.userMessages[0]?.replyToMessageId, "101");
    assert.equal(input.inboxItems[0]?.externalId, "101");
  });
});
