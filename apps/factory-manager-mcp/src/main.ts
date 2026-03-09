import { randomUUID } from "node:crypto";
import process from "node:process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ManagerToolHttpResponse, ManagerToolName } from "@permafactory/models";
import { z } from "zod";

const dashboardUrl = process.env.PERMAFACTORY_MANAGER_DASHBOARD_URL;
const toolToken = process.env.PERMAFACTORY_MANAGER_TOOL_TOKEN;

if (!dashboardUrl) {
  throw new Error("PERMAFACTORY_MANAGER_DASHBOARD_URL is required");
}

if (!toolToken) {
  throw new Error("PERMAFACTORY_MANAGER_TOOL_TOKEN is required");
}

const taskContractSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["code", "review-fix", "test", "maintenance"]),
  title: z.string().min(1),
  commitMessageHint: z.string().min(1).optional(),
  goal: z.string().min(1),
  acceptanceCriteria: z.array(z.string().min(1)),
  baseBranch: z.string().min(1),
  branchName: z.string().min(1),
  worktreePath: z.string().min(1),
  lockScope: z.array(z.string()),
  needsPreview: z.boolean(),
  ports: z
    .object({
      app: z.number().int().optional(),
      e2e: z.number().int().optional()
    })
    .strict(),
  runtime: z
    .object({
      maxRuntimeMinutes: z.number().int().positive(),
      reasoningEffort: z.enum(["medium", "extra-high"])
    })
    .strict(),
  constraints: z
    .object({
      files: z.array(z.string()).optional(),
      doNotTouch: z.array(z.string()).optional(),
      mustRunChecks: z.array(z.string())
    })
    .strict(),
  context: z
    .object({
      userIntent: z.string().min(1),
      relatedTaskIds: z.array(z.string()),
      blockingDecisions: z.array(z.string()),
      runtimeCapabilities: z
        .object({
          canBindListenSockets: z.boolean()
        })
        .strict()
        .optional()
    })
    .strict()
});

const reviewRequestSchema = z
  .object({
    taskId: z.string().optional(),
    branch: z.string().min(1),
    baseBranch: z.string().min(1),
    reason: z.string().min(1),
    worktreePath: z.string().optional(),
    commit: z.string().optional()
  })
  .strict();

const integrationRequestSchema = z
  .object({
    taskId: z.string().optional(),
    branch: z.string().optional(),
    targetBranch: z.string().optional(),
    reason: z.string().min(1),
    worktreePath: z.string().optional(),
    commit: z.string().optional()
  })
  .strict()
  .refine((value) => Boolean(value.taskId || value.branch), {
    message: "Either taskId or branch is required"
  });

const deploymentIntentSchema = z
  .object({
    kind: z.enum(["deploy_preview", "promote_candidate", "rollback_stable"]),
    reason: z.string().min(1),
    commit: z.string().optional(),
    rollbackTag: z.string().optional()
  })
  .strict();

const decisionOptionSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    consequence: z.string().min(1)
  })
  .strict();

const decisionRequestSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    reason: z.string().min(1),
    priority: z.enum(["critical", "high", "medium", "low"]),
    dedupeKey: z.string().min(1),
    options: z.array(decisionOptionSchema).min(2).max(4),
    defaultOptionId: z.string().min(1),
    expiresAt: z.string().min(1),
    impactSummary: z.string().min(1),
    budgetCost: z.literal(1)
  })
  .strict();

const replyUserSchema = z
  .object({
    kind: z.enum(["info_update", "daily_digest"]),
    text: z.string().min(1),
    replyToMessageId: z.string().optional(),
    decisionId: z.string().optional()
  })
  .strict();

const inspectBranchDiffSchema = z
  .object({
    branch: z.string().min(1),
    baseBranch: z.string().min(1).optional(),
    pathspecs: z.array(z.string().min(1)).max(50).optional(),
    commit: z.string().min(1).optional()
  })
  .strict();

const readTaskArtifactsSchema = z
  .object({
    taskId: z.string().min(1).optional(),
    branch: z.string().min(1).optional(),
    includeLogTailLines: z.number().int().min(0).max(200).optional()
  })
  .strict()
  .refine((value) => Boolean(value.taskId || value.branch), {
    message: "Either taskId or branch is required"
  });

const inspectDeployStateSchema = z
  .object({
    target: z.enum(["stable", "preview", "all"]).optional(),
    includeLogTailLines: z.number().int().min(0).max(200).optional()
  })
  .strict();

const inspectFactoryProcessesSchema = z
  .object({
    includeStaleOnly: z.boolean().optional(),
    includeArgs: z.boolean().optional(),
    limit: z.number().int().min(1).max(200).optional()
  })
  .strict();

const killFactoryProcessSchema = z
  .object({
    pid: z.number().int().positive(),
    processKey: z.string().min(1).optional(),
    force: z.boolean().optional()
  })
  .strict();

async function callFactoryTool(
  toolName: ManagerToolName,
  requestId: string,
  args: Record<string, unknown>
): Promise<ManagerToolHttpResponse> {
  const response = await fetch(`${dashboardUrl}/internal/manager-tool`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${toolToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      requestId,
      toolName,
      args
    })
  });
  const payload = (await response.json()) as ManagerToolHttpResponse;
  if (!response.ok || !payload.ok) {
    return {
      ok: false,
      cached: payload.cached,
      error: payload.error ?? `HTTP ${response.status}`
    };
  }
  return payload;
}

async function runTool(
  toolName: ManagerToolName,
  extra: { requestId?: string | number },
  args: Record<string, unknown> = {}
) {
  const response = await callFactoryTool(
    toolName,
    extra.requestId !== undefined ? String(extra.requestId) : randomUUID(),
    args
  );
  const text = JSON.stringify(response.ok ? response.result ?? {} : response, null, 2);
  return {
    content: [{ type: "text" as const, text }],
    ...(response.ok ? {} : { isError: true })
  };
}

async function main(): Promise<void> {
  const server = new McpServer(
    { name: "permafactory-manager", version: "0.1.0" },
    { capabilities: { logging: {} } }
  );

  server.registerTool(
    "get_factory_status",
    {
      description:
        "Fetch a fresh factory snapshot after tool actions or when the initial turn input no longer reflects current repo state."
    },
    async (extra) => await runTool("get_factory_status", extra)
  );

  server.registerTool(
    "inspect_branch_diff",
    {
      description:
        "Inspect a branch against its base branch with commit, ahead/behind, file, and diff-stat facts.",
      inputSchema: inspectBranchDiffSchema
    },
    async (args, extra) => await runTool("inspect_branch_diff", extra, args)
  );

  server.registerTool(
    "read_task_artifacts",
    {
      description:
        "Read the latest structured task outcome, recent task events, and recent run log tail for a task or branch.",
      inputSchema: readTaskArtifactsSchema
    },
    async (args, extra) => await runTool("read_task_artifacts", extra, args)
  );

  server.registerTool(
    "inspect_deploy_state",
    {
      description:
        "Inspect stable/preview deployment identity, branches, runtime slot state, and recent runtime logs.",
      inputSchema: inspectDeployStateSchema
    },
    async (args, extra) => await runTool("inspect_deploy_state", extra, args)
  );

  server.registerTool(
    "inspect_factory_processes",
    {
      description:
        "Inspect factory-owned processes, including active workers, app-server helpers, browser MCP processes, and stale resource leaks.",
      inputSchema: inspectFactoryProcessesSchema
    },
    async (args, extra) => await runTool("inspect_factory_processes", extra, args)
  );

  server.registerTool(
    "kill_factory_process",
    {
      description:
        "Terminate a factory-owned process by pid when it is stale, leaking resources, or otherwise needs to be reaped.",
      inputSchema: killFactoryProcessSchema
    },
    async (args, extra) => await runTool("kill_factory_process", extra, args)
  );

  server.registerTool(
    "start_task",
    {
      description: "Queue a new worker task with a full TaskContract.",
      inputSchema: taskContractSchema
    },
    async (args, extra) => await runTool("start_task", extra, args)
  );

  server.registerTool(
    "cancel_task",
    {
      description: "Cancel a running or queued task by task id.",
      inputSchema: z.object({ taskId: z.string().min(1) }).strict()
    },
    async (args, extra) => await runTool("cancel_task", extra, args)
  );

  server.registerTool(
    "start_review",
    {
      description: "Start a review pass for a branch or task branch.",
      inputSchema: reviewRequestSchema
    },
    async (args, extra) => await runTool("start_review", extra, args)
  );

  server.registerTool(
    "integrate_branch",
    {
      description: "Integrate a reviewed branch into its target branch.",
      inputSchema: integrationRequestSchema
    },
    async (args, extra) => await runTool("integrate_branch", extra, args)
  );

  server.registerTool(
    "apply_deployment",
    {
      description: "Deploy preview, promote candidate to stable, or roll stable back.",
      inputSchema: deploymentIntentSchema
    },
    async (args, extra) => await runTool("apply_deployment", extra, args)
  );

  server.registerTool(
    "request_decision",
    {
      description: "Create a Telegram decision card, subject to budget and dedupe rules.",
      inputSchema: decisionRequestSchema
    },
    async (args, extra) => await runTool("request_decision", extra, args)
  );

  server.registerTool(
    "reply_user",
    {
      description:
        "Send a direct product-facing reply or a daily digest to the user.",
      inputSchema: replyUserSchema
    },
    async (args, extra) => await runTool("reply_user", extra, args)
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
