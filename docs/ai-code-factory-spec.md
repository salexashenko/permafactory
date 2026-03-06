# AI Code Factory Spec

## Summary

Build a Linux-first autonomous coding factory around the latest Codex CLI. The system has a deterministic supervisor process that never stops, a persistent manager agent that communicates over Telegram and manages the backlog/release train, and isolated coding/review/testing workers that run in parallel in git worktrees with assigned ports.

The implementation target is:

- `codex-cli >= 0.111.0`
- Linux host with `systemd`
- Node.js + TypeScript control plane
- SQLite for local state
- Telegram for human interaction
- `main` as last-stable branch, `candidate` as integration branch

The v1 design intentionally does **not** depend on the experimental Codex `multi_agent` feature. It uses stable documented CLI surfaces:

- `codex app-server`
- `codex exec --json`
- `codex exec resume`
- `codex review`
- `codex fork` only if/when a worker benefits from inheriting thread context

## Goals

- Keep the factory active without requiring the user to babysit it.
- Cap user decisions at 15 per day.
- Ensure at least one non-manager worker is active at all times.
- Maintain a continuously testable last-stable version.
- Allow parallel coding agents without port collisions.
- Make all meaningful frontend actions callable from the browser console.
- Prefer deterministic orchestration over giving reliability responsibilities to an LLM.

## Non-Goals

- Multi-machine distributed scheduling in v1.
- Autonomous self-modification of the factory runtime.
- Production exposure of unsafe browser console actions to anonymous users.
- Dependence on Codex experimental features for core invariants.


## High-Level Architecture

### 1. `factoryd` supervisor

`factoryd` is a deterministic Node/TypeScript daemon run under `systemd`. It owns:

- process supervision
- resource budgeting
- worktree and port allocation
- Codex process launch/resume/kill
- Telegram I/O
- decision-budget enforcement
- release promotion orchestration
- persistent state

`factoryd` is the system of record. The manager agent advises and decides product/workflow matters, but `factoryd` enforces invariants.

### 2. Codex control plane

Run one long-lived local Codex app server:

```bash
codex app-server --listen ws://127.0.0.1:7781
```

Use it only for the manager agent thread and any future rich thread operations that need:

- resumable conversations
- turn interruption on Telegram messages
- structured turn output via `outputSchema`
- thread metadata and history

### 3. Manager agent

The manager is a persistent Codex thread hosted by `app-server`. It is event-driven, not continuously burning tokens.

Responsibilities:

- inspect repo state, backlog, worker results, and user messages
- create/stop/reprioritize worker tasks
- request reviews and tests
- decide when `candidate` is releasable
- communicate with the user via Telegram
- choose assumptions or alternate work when the user does not respond

The manager never directly shells out. It emits structured intents that `factoryd` validates and executes.

The manager's behavior is versioned in [prompts/manager.md](/Users/sergey/code/permafactory/prompts/manager.md). `factoryd` must load that file as the manager thread's developer instructions when the thread is first created and on any cold resume after app-server restart.

### 4. Worker agents

Workers are isolated OS processes started by `factoryd` using the Codex CLI:

- coding worker: `codex exec --json`
- test worker: `codex exec --json`
- review worker: `codex review`, or reviewer-role `codex exec --json` when structured output is required for gating

Each worker gets:

- its own git worktree
- its own branch
- its own port lease
- its own Codex thread/session id
- a typed task contract file

Workers are disposable. If one stalls, `factoryd` resumes or replaces it.

### 5. Stable and preview runtime slots

Keep three runtime slots:

- `stable-a`: one of two blue/green stable slots
- `stable-b`: the other blue/green stable slot
- `preview`: serves the latest healthy `candidate`

The user-facing stable URL must point to whichever stable slot is currently active. Promotions build and smoke-test on the inactive stable slot, then switch traffic atomically. `stable` must stay available while `preview` is rebuilt, restarted, or broken.

## Deliberate Design Choices

### Manager via `app-server`, workers via `exec`

Use `app-server` for the manager because it provides thread lifecycle and interruption semantics. Use `exec` and `review` for workers because separate OS processes are simpler to observe, throttle, and kill.

### Dedicated Codex home

Do not run the factory against a personal `~/.codex` directory. The service account must use a dedicated Codex home, for example:

- `FACTORY_CODEX_HOME=/var/lib/factory/codex`

Every Codex child process must run with:

- explicit `CODEX_HOME`
- explicit model/sandbox/approval flags
- explicit working directory

This avoids user-local config drift breaking automation.

### Model and reasoning policy

Use `gpt-5.4` for:

- manager turns
- coding workers
- review workers
- test workers

The manager selects reasoning effort for coding agents at task-creation time:

- `medium` for simple or well-bounded coding tasks
- `extra-high` for complex, ambiguous, risky, or architecture-shaping coding tasks

If the underlying Codex runtime exposes a lower maximum reasoning enum than `extra-high`, `factoryd` must map `extra-high` to the highest supported value for that runtime while preserving the intent of the policy.

### Git model

Use these long-lived branches:

- `main`: last known stable, user-facing
- `candidate`: integration branch for accepted worker output

Use these short-lived branches:

- `agent/<taskId>`: one per worker
- `release/<timestamp>`: optional frozen candidate for promotion/debugging

Worker branches are created from `candidate`. After review and checks pass, the manager requests a squash merge into `candidate`. Shipping fast-forwards `main` to the chosen `candidate` commit and tags it `stable-<timestamp>`.

Git authority is deterministic:

- workers may modify files only inside their assigned worktree
- only `factoryd` may create commits
- only `factoryd` may create or remove branches
- only `factoryd` may merge into `candidate` or move `main`
- only `factoryd` may tag releases or prune worktrees

## Process Model

### `systemd` units

Create:

- `factoryd.service`
- `factoryd-health.timer`
- `factoryd-health.service`

`factoryd.service`:

- `Restart=always`
- `RestartSec=5`
- runs the Node daemon

`factoryd-health.timer`:

- runs every minute
- verifies `factoryd` is healthy and the app-server WebSocket responds
- if unhealthy, restarts `factoryd`

`factoryd` itself is responsible for ensuring active Codex worker/manager sessions exist.

### Child processes

`factoryd` manages:

- one `codex app-server` child
- zero or more `codex exec` children
- zero or more `codex review` children
- zero or more per-slot app runtime processes

## State Model

Use SQLite with WAL mode. Tables:

- `settings`
- `projects`
- `project_bootstrap_steps`
- `runs`
- `agents`
- `agent_sessions`
- `inbox_items`
- `tasks`
- `task_events`
- `scope_locks`
- `decision_budget_days`
- `decision_requests`
- `telegram_messages`
- `worktrees`
- `port_leases`
- `artifacts`
- `deployments`
- `health_samples`
- `cleanup_runs`
- `release_tags`

SQLite is sufficient because only `factoryd` mutates state in v1.

## New Project Bootstrap

The factory must support adopting an existing real repository, not just running inside a pre-arranged demo app.

### Control-room model

Use a **private Telegram supergroup**, not a Telegram channel, as the default human interface.

Reasoning:

- channels are broadcast-oriented and poor for two-way task intake
- supergroups support direct human conversation, replies, inline buttons, and bot commands
- the group becomes the shared operational log for the project

The bot may also accept direct messages from explicitly whitelisted admins, but the project's canonical conversation lives in the private supergroup.

### Day-0 prerequisites

Before a repo can be factory-managed, these facts must be known:

- repo root path
- default branch
- Linux host path where the repo will live
- service account that will run `factoryd`
- Telegram bot token
- Telegram webhook secret token
- Telegram control-room chat id
- commands for install, test, build, preview serve, and healthcheck

The bot token and chat must be created by a human. Telegram bot creation cannot be fully automated by the Bot API, so the product must treat this as a manual prerequisite validated by tooling.

### Bootstrap CLI

Introduce an admin CLI named `factoryctl`.

Required v1 commands:

- `factoryctl init`
- `factoryctl telegram connect`
- `factoryctl ingest backlog`
- `factoryctl cleanup`
- `factoryctl start`
- `factoryctl status`

#### `factoryctl init`

Purpose:

- adopt a repo
- scaffold factory config
- create local factory directories
- create `candidate` branch if missing
- validate the local runtime

Example:

```bash
factoryctl init \
  --repo /srv/projects/acme-web \
  --project-id acme-web \
  --default-branch main
```

`factoryctl init` must:

- verify the target is a git repo
- detect package manager and likely scripts from project manifests
- create `.factory/`
- create `.factory/tasks/`, `.factory/logs/`, `.factory/worktrees/`
- create `.factory/runs/` and `.factory/scripts/`
- create `candidate` from the default branch if it does not exist
- generate `factory.config.ts` with discovered defaults and placeholders
- generate a `.env.factory.example`
- generate or update a root `AGENTS.md` factory-policy stub if one does not already exist
- scaffold `.factory/scripts/bootstrap-worktree.sh`
- mark bootstrap status as `waiting_for_telegram`

#### `factoryctl telegram connect`

Purpose:

- validate Telegram connectivity
- bind one project to one control-room chat

Example:

```bash
factoryctl telegram connect \
  --repo /srv/projects/acme-web \
  --bot-token-env TELEGRAM_BOT_TOKEN
```

Workflow:

1. human creates a bot with `@BotFather`
2. human creates a private supergroup for the project
3. human adds the bot to the supergroup
4. human sends `/hello` in the supergroup
5. `factoryctl telegram connect` polls updates, captures the chat id, confirms the admin user, stores the binding, and configures the production webhook plus secret token

The tool must reject public groups and unknown chats by default.

#### `factoryctl ingest backlog`

Purpose:

- seed the first wave of work before or alongside Telegram messages

Supported v1 sources:

- `.factory/backlog.md`
- `BACKLOG.md`
- a one-off `--text` argument

`factoryctl ingest backlog` converts each top-level task into normalized `inbox_items` and `tasks`.

#### `factoryctl start`

Purpose:

- start `factoryd`
- start the Codex app-server
- ensure bootstrap tasks are queued if the repo has never been baselined

If no explicit product task has been ingested yet, the factory must still start and queue discovery/bootstrap work.

### Bootstrap state machine

Each project moves through these states:

- `waiting_for_config`
- `waiting_for_telegram`
- `waiting_for_first_task`
- `baselining_repo`
- `active`
- `paused`
- `error`

The project becomes `active` only after:

- Telegram is bound
- at least one task or inbox item exists
- repo baseline tasks have completed successfully
- preview can be started and health-checked

### First-run baseline tasks

On the first run against a real project, the manager must not jump straight into feature work. It must first make the project operable.

Mandatory bootstrap work:

- detect and validate install/build/test/start scripts
- run the project locally in the preview slot
- establish a healthcheck path or command
- map the current repo structure
- identify missing browser-console action coverage
- create an onboarding summary for the user

If the repo cannot start successfully, the first active work should be stabilization and operability, not feature delivery.

### Initial task ingress

Every work request enters through the same normalized inbox.

Sources in v1:

- Telegram free-form messages in the control room
- Telegram commands such as `/ship` and `/status`
- seeded backlog markdown files

Normalization rule:

- raw input becomes an `inbox_item`
- the manager triages `inbox_items` into `tasks`, `decisions`, or direct Telegram replies

This keeps the manager's task intake consistent regardless of source.

## Core Scheduling Rules

### Main loop

Run a supervisor tick every 15 seconds.

Each tick:

1. sample CPU, memory, disk, swap, and live processes
2. refresh worker/app-server health
3. reconcile desired vs actual agent counts
4. drain urgent events, especially Telegram messages and worker completions
5. schedule a manager turn if the state changed materially
6. start or stop workers to satisfy resource policy

Any worker entering a terminal state (`completed`, `blocked`, or `failed`) must:

1. persist its final result and terminal event
2. release or mark its runtime resources for cleanup
3. enqueue a manager wakeup immediately

This manager notification is mandatory for coder, reviewer, and tester workers.

### Worker floor

Maintain:

- exactly 1 manager thread
- at least 1 non-manager worker when backlog exists and the host is healthy

If no product work is ready, the manager must assign maintenance work, for example:

- increase tests
- improve browser-action coverage
- review open diffs
- reduce flaky checks
- document current state

### Resource policy

Default worker limits:

- min workers: `1`
- max workers: `3`

Worker classes:

- heavy: coders and testers that run builds, browsers, or preview servers
- light: manager, reviewers, and research-style read-only tasks

Do not launch a new worker if any condition holds:

- CPU > 75% over the last minute
- RAM > 80%
- swap activity detected in the last minute
- stable slot is unhealthy
- fewer than 2 free worker ports remain

If CPU > 85% or RAM > 90%:

- stop launching new workers
- let current workers finish their active command
- keep only the manager and one highest-priority worker alive
- prefer keeping a light worker alive over a heavy preview workload

## Stall Detection and Recovery

### Health signals

Track for each agent:

- child PID alive/dead
- last JSON event timestamp
- last stdout byte timestamp
- current CPU%
- RSS memory
- active command item id and status
- thread/session id

### Stall definition

A worker is considered stalled when all are true:

- active for at least 3 minutes
- no JSON event for 10 minutes
- CPU < 1% for 3 consecutive health samples
- no file writes in its worktree for 10 minutes

The manager thread is stalled when:

- app-server is reachable
- the manager has an active turn
- no relevant thread notification arrives for 10 minutes
- and no CPU activity is attributed to the app-server turn

### Recovery sequence

For workers:

1. send `SIGINT`
2. wait 30 seconds
3. if still alive, send `SIGKILL`
4. run `codex exec resume <threadId>` with a recovery prompt
5. if resume fails twice, mark task `blocked`, archive logs, and re-queue it

For manager:

1. call app-server `turn/interrupt`
2. if no recovery, restart `codex app-server`
3. `thread/resume` the manager thread
4. inject a state summary and continue

## Telegram Contract

Use Telegram as the sole remote human interface in v1.

The default topology is one bot plus one private supergroup per project.

### Transport

Use Telegram webhooks for steady-state operation.

Requirements:

- configure a Telegram webhook secret token
- verify the `X-Telegram-Bot-Api-Secret-Token` header on every webhook request
- accept only `message` and `callback_query` update types in v1

`factoryctl telegram connect` may use temporary polling during bootstrap chat binding before the webhook is configured, but production operation must use webhooks.

### Supported inbound actions

- free-form text message
- `/hello`
- `/status`
- `/budget`
- `/ship`
- `/pause`
- `/resume`
- `/stable`
- `/preview`
- inline decision button tap

### Supported outbound message kinds

- `info_update`
- `decision_required`
- `incident_alert`
- `ship_result`
- `daily_digest`

Every inbound Telegram message must create a high-priority event in SQLite and immediately wake the manager flow.

Whenever a new stable version becomes live, `factoryd` must send a `ship_result` message to the control room automatically. This notification is mandatory, must not depend on the manager remembering to send it, and does not count against the daily decision budget.

The `/hello` command is reserved for initial chat binding during bootstrap.

### User-message handling

When a Telegram message arrives:

1. persist the message
2. if the manager is idle, start a manager turn immediately
3. if the manager is active, interrupt the current turn and start a new one with the queued message
4. respond within 60 seconds with either:
   - a direct answer
   - a status update
   - or a decision card

The manager must never block the entire factory waiting for the reply.

## Decision-Budget Policy

The hard cap is 15 user decisions per local day.

### Definitions

A decision consumes budget only when the user must choose among viable options or approve a risky action.

These do **not** consume budget:

- status updates
- digests
- incident notifications that do not ask for a choice
- confirmations that work has completed

### Reserve policy

Use:

- `daily_hard_cap = 15`
- `normal_cap = 12`
- `critical_reserve = 3`

Meaning:

- normal decisions stop at 12 per day
- the last 3 decisions are reserved for critical release, security, or production-blocking questions
- after 15 per day, no new decisions may be sent until the budget resets

### Enforcement

`factoryd` enforces the limit, not the manager prompt.

When the limit is reached:

- reject additional `decision_required` messages for the day
- log them as `deferred`
- instruct the manager to continue by assumption or work on something else

Before sending a new decision card:

- compute a dedupe key from question, options, and scope
- reuse an equivalent open decision if one already exists
- batch related low-priority asks when that reduces budget pressure without making the choice ambiguous

### Required decision payload

Every decision card must include:

- why the choice matters
- priority
- dedupe key
- 2 to 4 options
- default option
- expiry time
- impact summary
- budget cost, always `1` in v1

## Worktree and Port Strategy

### Worktree layout

Use:

- `.factory/worktrees/<taskId>`

Per worktree metadata:

- branch name
- base branch/commit
- assigned ports
- owning agent id
- current task id

### Worktree bootstrap

After `git worktree add`, `factoryd` must run a deterministic bootstrap script owned by the supervisor, for example:

```bash
.factory/scripts/bootstrap-worktree.sh <worktreePath>
```

The bootstrap step exists because worktrees only inherit checked-in files. They do not inherit untracked local state, generated files, or machine-local env setup.

Bootstrap responsibilities:

- install dependencies from the lockfile
- create or link safe local env files
- write `.factory.env` with assigned ports and task metadata
- run any initial build/setup required for the repo to become runnable
- seed local test data if the project requires it

### Scope locking

Add path-based lock arbitration for coding tasks:

- every task has a `lockScope` list of directories, packages, or services it intends to modify
- only one coder may hold an overlapping lock scope at a time
- reviewers and testers may overlap with coder lock scopes
- if the repo has `CODEOWNERS`, use it as one input when deriving default lock scopes

### Port allocation

Reserve fixed ports:

- stable proxy/public slot: `3000`
- stable-a internal slot: `3001`
- stable-b internal slot: `3002`
- preview slot: `3100`
- app-server ws: `7781`
- dashboard/api: `8787`

Worker range:

- app ports: `3200-3299`
- auxiliary/e2e ports: `4200-4299`

Allocation policy:

- lease the lowest free port pair
- hold the lease until the worktree is archived
- never share ports across active worktrees

Pass these env vars to worker commands:

- `PORT`
- `FACTORY_APP_PORT`
- `FACTORY_E2E_PORT`
- `FACTORY_TASK_ID`
- `FACTORY_BRANCH`

## Browser Console Automation Contract

All user-triggerable frontend actions must route through a shared action registry. UI controls and browser-console automation must call the same underlying functions.

Expose a global object in preview, worker, and localhost test environments:

```ts
declare global {
  interface Window {
    __factory: BrowserActionBridge;
  }
}

export interface BrowserActionBridge {
  listActions(): string[];
  run<TPayload = unknown, TResult = unknown>(
    action: string,
    payload?: TPayload
  ): Promise<TResult>;
  getState(): Promise<Record<string, unknown>>;
}
```

Rules:

- action names are stable strings, for example `editor.createFile`
- payloads and results are JSON-serializable
- UI handlers must call the same registry entries that `window.__factory.run()` uses
- the bridge is disabled on public stable builds unless explicitly authenticated/admin-gated

## Persistent Policy Layering

Use Codex instruction layering intentionally.

Recommended policy layers:

- service-account `CODEX_HOME/AGENTS.md` for global factory rules
- repo-root `AGENTS.md` for project-wide engineering policy
- nested `AGENTS.md` or `AGENTS.override.md` files for service- or area-specific constraints

Use these layers for standing policies such as:

- release gates
- dependency policy
- test expectations
- browser console action requirements
- default UX/product principles
- stable-slot protection rules

Keep AGENTS files concise and specific. They should hold persistent policy, not turn-by-turn planning.

## Public Interfaces

### `factory.config.ts`

```ts
export interface FactoryProjectConfig {
  projectId: string;
  repoRoot: string;
  defaultBranch: "main";
  candidateBranch: "candidate";
  timezone: string;
  codex: {
    versionFloor: string;
    model: "gpt-5.4";
    managerModel: "gpt-5.4";
    approvalPolicy: "never";
    sandboxMode: "workspace-write" | "danger-full-access";
    appServerUrl: string;
    searchEnabled: boolean;
    codingReasoningPolicy: {
      simple: "medium";
      complex: "extra-high";
      fallbackHighestSupported: "high";
    };
  };
  telegram: {
    botTokenEnvVar: string;
    webhookSecretEnvVar: string;
    controlChatId: string;
    allowedAdminUserIds: string[];
    allowAdminDm: boolean;
  };
  intake: {
    sources: Array<"telegram" | "backlog_file">;
    backlogFile: string;
  };
  bootstrap: {
    status:
      | "waiting_for_config"
      | "waiting_for_telegram"
      | "waiting_for_first_task"
      | "baselining_repo"
      | "active"
      | "paused"
      | "error";
    onboardingSummaryPath: string;
  };
  scheduler: {
    tickSeconds: number;
    minWorkers: number;
    maxWorkers: number;
    workerStallSeconds: number;
    managerStallSeconds: number;
    messageResponseSlaSeconds: number;
  };
  ports: {
    stableProxy: number;
    stableA: number;
    stableB: number;
    preview: number;
    dashboard: number;
    appServer: number;
    workerStart: number;
    workerEnd: number;
    e2eStart: number;
    e2eEnd: number;
  };
  scripts: {
    bootstrapWorktree: string;
    install: string;
    lint: string;
    test: string;
    build: string;
    smoke: string;
    serveStable: string;
    servePreview: string;
    serveWorker: string;
    e2e: string;
    healthcheck: string;
  };
  browserActions: {
    enabled: boolean;
    namespace: string;
  };
  decisionBudget: {
    dailyLimit: number;
    reserveCritical: number;
  };
}
```

### Manager turn output

The manager must return JSON that matches this schema. Use app-server `turn/start.outputSchema` to enforce it.

```ts
export interface ManagerTurnInput {
  now: string;
  timezone: string;
  project: {
    id: string;
    bootstrapStatus:
      | "waiting_for_config"
      | "waiting_for_telegram"
      | "waiting_for_first_task"
      | "baselining_repo"
      | "active"
      | "paused"
      | "error";
    onboardingSummaryPath: string;
  };
  repo: {
    root: string;
    defaultBranch: string;
    candidateBranch: string;
    currentStableCommit: string;
    currentCandidateCommit: string;
    dirtyFiles: string[];
  };
  decisionBudget: {
    date: string;
    used: number;
    limit: number;
    normalCap: number;
    remaining: number;
    remainingNormal: number;
    remainingCriticalReserve: number;
  };
  userMessages: Array<{
    id: string;
    source: "telegram";
    receivedAt: string;
    text: string;
    urgent: boolean;
  }>;
  inboxItems: Array<{
    id: string;
    source: "telegram" | "backlog_file";
    receivedAt: string;
    text: string;
    status: "new" | "triaged" | "done";
  }>;
  agents: Array<{
    id: string;
    role: "manager" | "code" | "test" | "review";
    status: "idle" | "running" | "stalled" | "failed";
    taskId?: string;
    branch?: string;
    worktreePath?: string;
  }>;
  tasks: Array<{
    id: string;
    status: "queued" | "running" | "blocked" | "review" | "done" | "failed";
    title: string;
    priority: "low" | "medium" | "high" | "urgent";
    blockedByDecisionIds: string[];
  }>;
  deployments: {
    stable: {
      status: "healthy" | "degraded" | "down";
      url: string;
      commit: string;
      activeSlot: "stable-a" | "stable-b";
    };
    preview: {
      status: "healthy" | "degraded" | "down";
      url: string;
      commit: string;
    };
  };
  resources: {
    cpuPercent: number;
    memoryPercent: number;
    swapActive: boolean;
    freeWorkerSlots: number;
  };
  recentEvents: Array<{
    at: string;
    type: string;
    summary: string;
  }>;
}

export interface TelegramOutboundMessage {
  kind:
    | "info_update"
    | "decision_required"
    | "incident_alert"
    | "ship_result"
    | "daily_digest";
  text: string;
  replyToMessageId?: string;
  decisionId?: string;
}

export interface ReviewRequest {
  taskId: string;
  branch: string;
  baseBranch: string;
  reason: string;
}

export interface DeploymentIntent {
  kind: "deploy_preview" | "promote_candidate" | "rollback_stable";
  reason: string;
  commit?: string;
  rollbackTag?: string;
}

export interface ManagerTurnOutput {
  summary: string;
  userMessages: TelegramOutboundMessage[];
  tasksToStart: TaskContract[];
  tasksToCancel: string[];
  reviewsToStart: ReviewRequest[];
  deployments: DeploymentIntent[];
  decisions: DecisionRequest[];
  assumptions: string[];
}
```

### Worker task contract

Persist one JSON file per worker at `.factory/tasks/<taskId>.json`.

```ts
export interface TaskContract {
  id: string;
  kind: "code" | "review-fix" | "test" | "maintenance";
  title: string;
  goal: string;
  acceptanceCriteria: string[];
  baseBranch: string;
  branchName: string;
  worktreePath: string;
  lockScope: string[];
  needsPreview: boolean;
  ports: {
    app: number;
    e2e: number;
  };
  runtime: {
    maxRuntimeMinutes: number;
    reasoningEffort: "medium" | "extra-high";
  };
  constraints: {
    files?: string[];
    doNotTouch?: string[];
    mustRunChecks: string[];
  };
  context: {
    userIntent: string;
    relatedTaskIds: string[];
    blockingDecisions: string[];
  };
}
```

### Worker run record

```ts
export interface WorkerRun {
  id: string;
  taskId: string;
  role: "code" | "review" | "test";
  attempt: number;
  runDirectory: string;
  jsonlLogPath: string;
  finalMessagePath: string;
  maxRuntimeMinutes: number;
}
```

### Worker result

The final worker message must be JSON matching:

```ts
export interface WorkerResult {
  taskId: string;
  status: "completed" | "blocked" | "failed";
  summary: string;
  changedFiles: string[];
  checks: Array<{
    name: string;
    status: "passed" | "failed" | "not_run";
    details?: string;
  }>;
  followups: string[];
  recommendedCommitMessage?: string;
  notesForReviewer?: string;
  needsReview: boolean;
  needsDecision: boolean;
}
```

### Decision request

```ts
export interface DecisionRequest {
  id: string;
  title: string;
  reason: string;
  priority: "critical" | "high" | "medium" | "low";
  dedupeKey: string;
  options: Array<{
    id: string;
    label: string;
    consequence: string;
  }>;
  defaultOptionId: string;
  expiresAt: string;
  impactSummary: string;
  budgetCost: 1;
}
```

### Inbox item

```ts
export interface InboxItem {
  id: string;
  source: "telegram" | "backlog_file";
  externalId?: string;
  receivedAt: string;
  text: string;
  status: "new" | "triaged" | "done";
}
```

## Agent Launch Commands

### Manager bootstrap

`factoryd` starts the app-server if missing:

```bash
CODEX_HOME=/var/lib/factory/codex \
codex app-server --listen ws://127.0.0.1:7781
```

Then `factoryd` creates or resumes the manager thread and runs turns over WebSocket using:

- developer instructions loaded from [prompts/manager.md](/Users/sergey/code/permafactory/prompts/manager.md)
- a single `ManagerTurnInput` JSON payload per turn
- a strict `ManagerTurnOutput` JSON schema
- model `gpt-5.4`

The manager thread must be long-lived. `factoryd` should resume it after restart rather than creating a fresh thread unless the thread history is corrupted or explicitly rotated.

### Coding worker

Each worker run must have a dedicated run directory:

- `.factory/runs/<runId>/`

At minimum the run directory stores:

- JSONL event log
- final assistant message JSON
- normalized parsed result
- any captured test or browser artifacts

`factoryd` must validate the final worker JSON against the role-specific schema before accepting the result as authoritative.

```bash
CODEX_HOME=/var/lib/factory/codex \
PORT=<appPort> \
FACTORY_E2E_PORT=<e2ePort> \
codex exec --json \
  -C <worktreePath> \
  -m gpt-5.4 \
  -s workspace-write \
  -a never \
  -c 'model_reasoning_effort="<mappedReasoningEffort>"' \
  --output-last-message <runDirectory>/final.json \
  --search \
  -
```

For coding workers, `mappedReasoningEffort` comes from `TaskContract.runtime.reasoningEffort` after applying the runtime fallback rule for `extra-high`.

### Review worker

```bash
CODEX_HOME=/var/lib/factory/codex \
codex review --base <baseBranch>
```

Store raw review output in the run directory. When the release gate requires machine-validated reviewer output, run a reviewer-role `codex exec --json` wrapper instead of relying solely on `codex review`.

Tester runs must follow the same run-directory and final-result validation pattern as coding workers.

## Release Pipeline

### Candidate update flow

1. worker finishes and `factoryd` immediately enqueues a manager wakeup with the worker result
2. run project checks in the worktree
3. run `codex review --base candidate`
4. if checks and review pass, squash-merge into `candidate`
5. redeploy `preview`
6. notify manager with integration results

### Stable ship flow

1. manager emits `deployments: [{ kind: "promote_candidate" }]`
2. `factoryd` verifies:
   - `preview` healthy
   - required checks green
   - reviewer has no blocking findings
   - smoke checks can pass on the inactive stable slot
   - no unresolved blocking decisions
3. build the candidate release into the inactive stable slot
4. run smoke checks against that inactive stable slot
5. atomically switch the stable proxy to the newly built slot
6. verify post-switch health on the new active stable slot
7. fast-forward `main` to the now-live stable commit
8. tag that commit `stable-<timestamp>`
9. keep the previously active stable slot and artifact as the immediate rollback target
10. send a mandatory `ship_result` Telegram message with stable URL, commit, and tag
11. record the deployment and ship notification in `deployments`, `artifacts`, and `telegram_messages`

### Rollback

Rollback is deterministic and does not require the manager:

1. point the stable proxy back to the previous stable slot
2. mark the newer release as rolled back
3. send incident notification
4. enqueue a manager wakeup

## Cleanup and Retention

Cleanup must be deterministic and primarily enforced by `factoryd`, not left to agent judgment.

### Cleanup responsibilities

`factoryd` owns:

- reaping orphan child processes
- releasing port leases
- archiving or deleting completed worktrees
- pruning merged agent branches
- rotating logs and artifacts
- expiring stale decisions, inbox items, and temporary files

The manager owns:

- cancelling superseded tasks
- preferring small tasks so cleanup stays cheap
- requesting maintenance cleanup when repo clutter or flaky state is slowing work

### Cleanup triggers

Run cleanup in three situations:

1. immediately when a task enters a terminal state
2. every hour as a background sweep
3. on service startup before accepting new work

### Worktree cleanup policy

For `completed` tasks:

- archive task metadata and worker result immediately
- kill any remaining child processes immediately
- release port leases immediately
- delete the worktree after a 30 minute cooldown
- delete the corresponding `agent/<taskId>` branch after the worktree is deleted and its diff is merged or intentionally discarded

For `failed` or `blocked` tasks:

- kill remaining child processes immediately
- release port leases immediately
- keep the worktree for inspection for 24 hours
- then archive or delete it unless explicitly pinned for debugging

### Artifact and log retention

Keep:

- current stable artifact plus the previous 5 stable artifacts
- current preview artifact plus the previous 2 preview artifacts
- raw worker logs for 14 days
- summarized task/review/deploy metadata for 90 days
- manager thread history indefinitely unless manually rotated

Compress logs older than 24 hours before deletion.

### Inbox and decision cleanup

- expire unanswered decisions at `expiresAt`
- mark expired decisions as `timed_out`
- resolved and expired decisions remain queryable for 90 days
- completed inbox items remain queryable for 90 days
- superseded inbox items may be auto-closed by the manager with a reason

### Safety rules

- never delete the current stable artifact
- never delete a worktree that still has a live process attached
- never delete a blocked worktree before its inspection TTL unless explicitly pinned or dismissed by an operator
- never delete a branch that has not been merged, archived as abandoned, or explicitly force-closed

### Admin cleanup command

Add:

- `factoryctl cleanup`

Required behaviors:

- `--dry-run` shows what would be removed
- `--project <id>` scopes the cleanup
- `--force` bypasses cooldown windows but still respects safety rules around live processes and current stable

### Cleanup acceptance criteria

Cleanup is considered correct when:

- no completed task holds ports after terminalization
- no orphan worker process survives a sweep
- merged task worktrees do not accumulate indefinitely
- rollback artifacts remain available after routine pruning
- cleanup never removes the active stable deployment

## Suggested Repository Layout

```text
AGENTS.md
docs/
  ai-code-factory-spec.md
apps/
  factoryd/
  factoryctl/
  dashboard/
packages/
  config/
  db/
  codex/
  telegram/
  scheduler/
  browser-actions/
  deployment/
prompts/
  manager.md
  worker.md
  reviewer.md
  tester.md
schemas/
  manager-output.schema.json
  worker-result.schema.json
  reviewer-result.schema.json
  tester-result.schema.json
systemd/
  factoryd.service
  factoryd-health.service
  factoryd-health.timer
.factory/
  backlog.md
  bootstrap.json
  runs/
  scripts/
    bootstrap-worktree.sh
  tasks/
  worktrees/
  logs/
```

## Testing and Acceptance Criteria

### Unit tests

- port allocator never reuses an active lease
- scope-lock allocator rejects overlapping coder tasks
- decision budget resets by timezone and hard-stops at 15
- decision budget preserves the critical reserve for high-priority questions
- decision dedupe reuses equivalent open questions
- resource policy computes the expected worker cap
- manager output schema rejects malformed deployment and decision payloads

### Integration tests

- `factoryd` restarts the manager when no Codex process is alive
- a stalled worker is interrupted, resumed once, then replaced on repeated failure
- Telegram inbound message interrupts an active manager turn and receives a response within SLA
- Telegram webhook rejects requests with a missing or invalid secret token
- two code workers can run simultaneously in separate worktrees with different ports
- two coders with overlapping lock scopes cannot run simultaneously
- every worker terminal state enqueues a manager wakeup with the worker result
- completed code changes trigger `codex review --base candidate`
- successful stable promotion always emits a `ship_result` Telegram message
- successful stable promotion switches traffic to the inactive blue/green slot only after smoke passes
- completed tasks release their ports immediately and are cleaned up on schedule
- blocked tasks retain inspectable worktrees until their TTL expires
- preview can fail without taking down stable

### End-to-end tests

- user can open stable and preview simultaneously
- browser console can run the same action path as the UI
- manager can exhaust the decision budget and then continue by assumption
- shipping promotes candidate to stable while leaving a rollback target
- routine cleanup preserves rollback-ready stable artifacts while pruning old worker state

## Implementation Order

1. bootstrap Node/TypeScript monorepo and SQLite state layer
2. implement `factoryctl init` and project bootstrap state machine
3. implement `factory.config.ts`, AGENTS layering, and service-account Codex bootstrap
4. build `factoryd` child-process supervisor, runs table, and health sampler
5. add deterministic worktree bootstrap and scope-lock arbitration
6. integrate `codex exec --json` worker launcher/resumer with run-directory capture
7. integrate `codex app-server` manager thread with strict output schema
8. add Telegram bot binding, secure webhooks, inbox ingestion, and decision-budget enforcement
9. add candidate integration pipeline and supervisor-owned Git operations
10. add blue/green stable slots, smoke checks, and rollback flow
11. add browser-action bridge and Playwright coverage
12. harden with cleanup sweeps, systemd units, and operational dashboards

## Assumptions and Defaults

- deployment target is a single Linux box
- Node.js is the control-plane runtime
- SQLite is enough for v1 state
- the recommended Telegram topology is a private supergroup, not a channel
- production Telegram ingress uses webhooks with secret-token verification
- `main` must remain stable
- `candidate` may be unstable and is the source of preview deployments
- the factory may continue working without immediate user response
- all user choice prompts count against the 15/day budget
- the last 3 daily decisions are reserved for critical blockers
- browser-console actions are only exposed in safe environments
- v1 will not rely on Codex experimental `multi_agent` behavior

## Sources

- [Codex guide](https://developers.openai.com/codex/getting-started/)
- [Codex multi-agents guide](https://developers.openai.com/codex/multi-agents/)
- [Introducing Codex](https://openai.com/index/introducing-codex/)
