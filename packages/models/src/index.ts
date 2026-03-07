export type BootstrapStatus =
  | "waiting_for_config"
  | "waiting_for_telegram"
  | "waiting_for_first_task"
  | "baselining_repo"
  | "active"
  | "paused"
  | "error";

export type AgentRole = "manager" | "code" | "test" | "review";
export type AgentStatus =
  | "idle"
  | "running"
  | "stalled"
  | "failed"
  | "completed"
  | "blocked";

export type TaskKind = "code" | "review-fix" | "test" | "maintenance";
export type TaskStatus =
  | "queued"
  | "running"
  | "blocked"
  | "review"
  | "done"
  | "failed"
  | "cancelled";
export type TaskPriority = "low" | "medium" | "high" | "urgent";
export type DecisionPriority = "critical" | "high" | "medium" | "low";
export type DecisionStatus =
  | "open"
  | "resolved"
  | "timed_out"
  | "deferred"
  | "cancelled";
export type ReasoningEffort = "medium" | "extra-high";
export type SandboxMode = "workspace-write" | "danger-full-access";
export type DeploymentStatus = "healthy" | "degraded" | "down";
export type TelegramOutboundKind =
  | "info_update"
  | "decision_required"
  | "incident_alert"
  | "ship_result"
  | "daily_digest";
export type WorkerResultStatus = "completed" | "blocked" | "failed";
export type CheckStatus = "passed" | "failed" | "not_run";

export interface WorkerSandboxCapabilities {
  canBindListenSockets: boolean;
}

export interface FactoryProjectConfig {
  projectId: string;
  repoRoot: string;
  defaultBranch: string;
  candidateBranch: "candidate";
  projectSpecPath: string;
  timezone: string;
  codex: {
    versionFloor: string;
    model: "gpt-5.4";
    managerModel: "gpt-5.4";
    approvalPolicy: "never";
    sandboxMode: SandboxMode;
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
    status: BootstrapStatus;
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

export interface ManagerTurnInput {
  now: string;
  timezone: string;
  project: {
    id: string;
    bootstrapStatus: BootstrapStatus;
    projectSpecPath?: string;
    onboardingSummaryPath: string;
  };
  repo: {
    root: string;
    defaultBranch: string;
    candidateBranch: string;
    currentStableCommit: string;
    currentCandidateCommit: string;
    dirtyFiles: string[];
    trackedFileCount: number;
    trackedFilesSample: string[];
    appearsGreenfield: boolean;
    branches: Array<{
      name: string;
      head?: string;
      baseBranch?: string;
      aheadBy?: number;
      behindBy?: number;
      canFastForwardBase?: boolean;
      isIntegrated?: boolean;
      linkedTaskIds: string[];
      latestTaskStatus?: TaskStatus;
      latestTaskUpdatedAt?: string;
      worktreePath?: string;
      dirtyFileCount?: number;
      dirtyFilesSample?: string[];
    }>;
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
  openDecisions: Array<{
    id: string;
    title: string;
    priority: DecisionPriority;
    dedupeKey: string;
    defaultOptionId: string;
    expiresAt: string;
    blockingTaskIds: string[];
  }>;
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
    role: AgentRole;
    status: "idle" | "running" | "stalled" | "failed";
    taskId?: string;
    branch?: string;
    worktreePath?: string;
  }>;
  tasks: Array<{
    id: string;
    status: "queued" | "running" | "blocked" | "review" | "done" | "failed";
    title: string;
    priority: TaskPriority;
    branchName?: string;
    baseBranch?: string;
    worktreePath?: string;
    relatedTaskIds: string[];
    blockedByDecisionIds: string[];
    latestEventAt?: string;
    latestEventType?: string;
    latestEventSummary?: string;
    latestEventPayload?: Record<string, unknown>;
    branchHead?: string;
    baseHead?: string;
    aheadBy?: number;
    behindBy?: number;
    canFastForwardBase?: boolean;
    isIntegrated?: boolean;
    worktreeDirtyFileCount?: number;
    worktreeDirtyFilesSample?: string[];
  }>;
  deployments: {
    stable: {
      status: DeploymentStatus;
      url: string;
      commit: string;
      activeSlot: "stable-a" | "stable-b";
      reason?: string;
      updatedAt?: string;
      canRollback?: boolean;
      rollbackTargetCommit?: string;
    };
    preview: {
      status: DeploymentStatus;
      url: string;
      commit: string;
      reason?: string;
      updatedAt?: string;
    };
  };
  resources: {
    cpuPercent: number;
    memoryPercent: number;
    swapActive: boolean;
    freeWorkerSlots: number;
    workerSandbox: WorkerSandboxCapabilities;
  };
  recentEvents: Array<{
    at: string;
    type: string;
    summary: string;
  }>;
  recentManagerTurns: Array<{
    at: string;
    summary: string;
    wakeReasons: string[];
    actionCounts: {
      tasksToStart: number;
      tasksToCancel: number;
      reviewsToStart: number;
      integrations: number;
      deployments: number;
      decisions: number;
      userMessages: number;
    };
    actionPreview: {
      tasksToStart: string[];
      tasksToCancel: string[];
      reviewsToStart: string[];
      integrations: string[];
      deployments: string[];
      decisions: string[];
      userMessages: string[];
    };
    mismatchHints: string[];
    rawOutput?: Record<string, unknown>;
  }>;
}

export interface TelegramOutboundMessage {
  kind: TelegramOutboundKind;
  text: string;
  replyToMessageId?: string;
  decisionId?: string;
}

export interface ReviewRequest {
  taskId?: string;
  branch: string;
  baseBranch: string;
  reason: string;
  worktreePath?: string;
  commit?: string;
}

export interface IntegrationRequest {
  taskId?: string;
  branch?: string;
  targetBranch?: string;
  reason: string;
  worktreePath?: string;
  commit?: string;
}

export interface DeploymentIntent {
  kind: "deploy_preview" | "promote_candidate" | "rollback_stable";
  reason: string;
  commit?: string;
  rollbackTag?: string;
}

export interface DecisionOption {
  id: string;
  label: string;
  consequence: string;
}

export interface DecisionRequest {
  id: string;
  title: string;
  reason: string;
  priority: DecisionPriority;
  dedupeKey: string;
  options: DecisionOption[];
  defaultOptionId: string;
  expiresAt: string;
  impactSummary: string;
  budgetCost: 1;
}

export interface TaskContract {
  id: string;
  kind: TaskKind;
  title: string;
  goal: string;
  acceptanceCriteria: string[];
  baseBranch: string;
  branchName: string;
  worktreePath: string;
  lockScope: string[];
  needsPreview: boolean;
  ports: {
    app?: number;
    e2e?: number;
  };
  runtime: {
    maxRuntimeMinutes: number;
    reasoningEffort: ReasoningEffort;
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
    runtimeCapabilities?: WorkerSandboxCapabilities;
  };
}

export interface ManagerTurnOutput {
  summary: string;
  userMessages: TelegramOutboundMessage[];
  tasksToStart: TaskContract[];
  tasksToCancel: string[];
  reviewsToStart: ReviewRequest[];
  integrations: IntegrationRequest[];
  deployments: DeploymentIntent[];
  decisions: DecisionRequest[];
  assumptions: string[];
}

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

export interface WorkerCheck {
  name: string;
  status: CheckStatus;
  details?: string;
}

export interface CodingWorkerResult {
  taskId: string;
  status: WorkerResultStatus;
  summary: string;
  changedFiles: string[];
  checks: WorkerCheck[];
  followups: string[];
  recommendedCommitMessage?: string;
  notesForReviewer?: string;
  needsReview: boolean;
  needsDecision: boolean;
}

export interface ReviewerFinding {
  severity: "low" | "medium" | "high";
  summary: string;
  file?: string;
  line?: number;
}

export interface ReviewerResult {
  taskId: string;
  status: WorkerResultStatus;
  summary: string;
  followups: string[];
  blockingFindings: ReviewerFinding[];
  recommendedAction: "merge" | "request_changes" | "rerun";
}

export interface TesterResult {
  taskId: string;
  status: WorkerResultStatus;
  summary: string;
  followups: string[];
  checks: WorkerCheck[];
  artifacts: string[];
}

export interface InboxItem {
  id: string;
  source: "telegram" | "backlog_file";
  externalId?: string;
  receivedAt: string;
  text: string;
  status: "new" | "triaged" | "done";
}

export interface ProjectRecord {
  id: string;
  repoRoot: string;
  configPath: string;
  defaultBranch: string;
  candidateBranch: string;
  bootstrapStatus: BootstrapStatus;
  projectSpecPath?: string;
  onboardingSummaryPath: string;
  stableCommit: string;
  candidateCommit: string;
  telegramControlChatId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentRecord {
  id: string;
  projectId: string;
  role: AgentRole;
  status: AgentStatus;
  taskId?: string;
  branch?: string;
  worktreePath?: string;
  threadId?: string;
  turnId?: string;
  pid?: number;
  metadata?: Record<string, unknown>;
  updatedAt: string;
}

export interface TaskRecord {
  id: string;
  projectId: string;
  kind: TaskKind | null;
  status: TaskStatus;
  title: string;
  priority: TaskPriority;
  goal: string;
  branchName?: string;
  baseBranch?: string;
  worktreePath?: string;
  contract?: TaskContract;
  blockedByDecisionIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface DecisionRecord extends DecisionRequest {
  projectId: string;
  status: DecisionStatus;
  resolvedOptionId?: string;
  blockingTaskIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface DecisionBudgetSnapshot {
  date: string;
  used: number;
  limit: number;
  normalCap: number;
  remaining: number;
  remainingNormal: number;
  remainingCriticalReserve: number;
}

export interface ResourceSnapshot {
  cpuPercent: number;
  memoryPercent: number;
  swapActive: boolean;
  freeWorkerSlots: number;
}

export interface PortLeaseRequirement {
  app: boolean;
  e2e: boolean;
}

export const DEFAULT_CANDIDATE_BRANCH = "candidate";
export const DEFAULT_PROJECT_SPEC_PATH = "docs/project-spec.md";
export const DEFAULT_ONBOARDING_SUMMARY_PATH = "docs/factory-onboarding.md";
export const DEFAULT_MANAGER_THREAD_NAME = "factory-manager";
