import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import type {
  AgentRecord,
  AgentStatus,
  DecisionBudgetSnapshot,
  DecisionRecord,
  DecisionRequest,
  FactoryProjectConfig,
  InboxItem,
  ManagerTurnInput,
  ProjectRecord,
  TaskContract,
  TaskPriority,
  TaskRecord,
  TaskStatus
} from "@permafactory/models";
import {
  computeDecisionBudgetSnapshot,
  getFactoryPaths,
  localDateString,
  nowIso,
  ensureDir
} from "@permafactory/runtime";

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || value.length === 0) {
    return fallback;
  }

  return JSON.parse(value) as T;
}

function serializeJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export class FactoryDatabase {
  readonly db: DatabaseSync;

  constructor(public readonly dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
  }

  static async open(repoRoot: string): Promise<FactoryDatabase> {
    const paths = getFactoryPaths(repoRoot);
    await ensureDir(path.dirname(paths.dbPath));
    return new FactoryDatabase(paths.dbPath);
  }

  init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        repo_root TEXT NOT NULL UNIQUE,
        config_path TEXT NOT NULL,
        default_branch TEXT NOT NULL,
        candidate_branch TEXT NOT NULL,
        bootstrap_status TEXT NOT NULL,
        project_spec_path TEXT,
        onboarding_summary_path TEXT NOT NULL,
        stable_commit TEXT NOT NULL,
        candidate_commit TEXT NOT NULL,
        telegram_control_chat_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS inbox_items (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        source TEXT NOT NULL,
        external_id TEXT,
        received_at TEXT NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        kind TEXT,
        status TEXT NOT NULL,
        title TEXT NOT NULL,
        priority TEXT NOT NULL,
        goal TEXT NOT NULL,
        branch_name TEXT,
        base_branch TEXT,
        worktree_path TEXT,
        contract_json TEXT,
        blocked_by_decision_ids_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS task_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        at TEXT NOT NULL,
        type TEXT NOT NULL,
        summary TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        status TEXT NOT NULL,
        task_id TEXT,
        branch TEXT,
        worktree_path TEXT,
        thread_id TEXT,
        turn_id TEXT,
        pid INTEGER,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL,
        session_type TEXT NOT NULL,
        session_id TEXT NOT NULL,
        transport TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS decision_budget_days (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        date TEXT NOT NULL,
        used INTEGER NOT NULL DEFAULT 0,
        limit_value INTEGER NOT NULL,
        reserve_critical INTEGER NOT NULL,
        PRIMARY KEY (project_id, date)
      );

      CREATE TABLE IF NOT EXISTS decision_requests (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        reason TEXT NOT NULL,
        priority TEXT NOT NULL,
        dedupe_key TEXT NOT NULL,
        options_json TEXT NOT NULL,
        default_option_id TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        impact_summary TEXT NOT NULL,
        budget_cost INTEGER NOT NULL,
        status TEXT NOT NULL,
        resolved_option_id TEXT,
        blocking_task_ids_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_decision_dedupe_open
        ON decision_requests(project_id, dedupe_key, status);

      CREATE TABLE IF NOT EXISTS telegram_messages (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        telegram_message_id TEXT,
        chat_id TEXT,
        direction TEXT NOT NULL,
        kind TEXT NOT NULL,
        text TEXT NOT NULL,
        reply_to_message_id TEXT,
        decision_id TEXT,
        recorded_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS worktrees (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        branch_name TEXT NOT NULL,
        base_branch TEXT NOT NULL,
        base_commit TEXT NOT NULL,
        app_port INTEGER,
        e2e_port INTEGER,
        pinned INTEGER NOT NULL DEFAULT 0,
        archived_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS port_leases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        worktree_id TEXT NOT NULL REFERENCES worktrees(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        port INTEGER NOT NULL,
        leased_at TEXT NOT NULL,
        released_at TEXT
      );

      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        status TEXT NOT NULL,
        run_directory TEXT NOT NULL,
        jsonl_log_path TEXT NOT NULL,
        final_message_path TEXT NOT NULL,
        max_runtime_minutes INTEGER NOT NULL,
        pid INTEGER,
        started_at TEXT NOT NULL,
        finished_at TEXT
      );

      CREATE TABLE IF NOT EXISTS deployments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        target TEXT NOT NULL,
        status TEXT NOT NULL,
        url TEXT NOT NULL,
        commit_sha TEXT NOT NULL,
        active_slot TEXT,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS manager_turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        at TEXT NOT NULL,
        summary TEXT NOT NULL,
        wake_reasons_json TEXT NOT NULL DEFAULT '[]',
        action_counts_json TEXT NOT NULL DEFAULT '{}',
        action_preview_json TEXT NOT NULL DEFAULT '{}',
        mismatch_hints_json TEXT NOT NULL DEFAULT '[]',
        raw_output_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS health_samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        sampled_at TEXT NOT NULL,
        cpu_percent REAL NOT NULL,
        memory_percent REAL NOT NULL,
        swap_active INTEGER NOT NULL,
        detail_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS cleanup_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        summary_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS release_tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        tag TEXT NOT NULL,
        commit_sha TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);

    this.ensureColumn("manager_turns", "action_preview_json", "TEXT NOT NULL DEFAULT '{}'");
    this.ensureColumn("manager_turns", "mismatch_hints_json", "TEXT NOT NULL DEFAULT '[]'");
    this.ensureColumn("manager_turns", "raw_output_json", "TEXT NOT NULL DEFAULT '{}'");
  }

  private ensureColumn(tableName: string, columnName: string, definitionSql: string): void {
    const rows = this.db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<Record<string, unknown>>;
    const hasColumn = rows.some((row) => String(row.name) === columnName);
    if (!hasColumn) {
      this.db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definitionSql}`);
    }
  }

  close(): void {
    this.db.close();
  }

  upsertProject(config: FactoryProjectConfig): ProjectRecord {
    const now = nowIso();
    const existing = this.getProjectByRepoRoot(config.repoRoot);
    const stableCommit = existing?.stableCommit ?? "";
    const candidateCommit = existing?.candidateCommit ?? "";
    this.db
      .prepare(
        `
          INSERT INTO projects (
            id, repo_root, config_path, default_branch, candidate_branch, bootstrap_status,
            project_spec_path, onboarding_summary_path, stable_commit, candidate_commit,
            telegram_control_chat_id, created_at, updated_at
          ) VALUES (
            @id, @repoRoot, @configPath, @defaultBranch, @candidateBranch, @bootstrapStatus,
            @projectSpecPath, @onboardingSummaryPath, @stableCommit, @candidateCommit,
            @telegramControlChatId, @createdAt, @updatedAt
          )
          ON CONFLICT(id) DO UPDATE SET
            repo_root = excluded.repo_root,
            config_path = excluded.config_path,
            default_branch = excluded.default_branch,
            candidate_branch = excluded.candidate_branch,
            bootstrap_status = excluded.bootstrap_status,
            project_spec_path = excluded.project_spec_path,
            onboarding_summary_path = excluded.onboarding_summary_path,
            telegram_control_chat_id = excluded.telegram_control_chat_id,
            updated_at = excluded.updated_at
        `
      )
      .run({
        id: config.projectId,
        repoRoot: config.repoRoot,
        configPath: path.join(config.repoRoot, "factory.config.ts"),
        defaultBranch: config.defaultBranch,
        candidateBranch: config.candidateBranch,
        bootstrapStatus: config.bootstrap.status,
        projectSpecPath: config.projectSpecPath,
        onboardingSummaryPath: config.bootstrap.onboardingSummaryPath,
        stableCommit,
        candidateCommit,
        telegramControlChatId: config.telegram.controlChatId || null,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      });

    return this.getProjectById(config.projectId);
  }

  getProjectById(projectId: string): ProjectRecord {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as
      | Record<string, unknown>
      | undefined;
    if (!row) {
      throw new Error(`Unknown project: ${projectId}`);
    }
    return this.projectFromRow(row);
  }

  getProjectByRepoRoot(repoRoot: string): ProjectRecord | undefined {
    const row = this.db.prepare("SELECT * FROM projects WHERE repo_root = ?").get(repoRoot) as
      | Record<string, unknown>
      | undefined;
    return row ? this.projectFromRow(row) : undefined;
  }

  updateProjectStatus(projectId: string, bootstrapStatus: ProjectRecord["bootstrapStatus"]): void {
    this.db
      .prepare("UPDATE projects SET bootstrap_status = ?, updated_at = ? WHERE id = ?")
      .run(bootstrapStatus, nowIso(), projectId);
  }

  updateProjectCommits(projectId: string, stableCommit: string, candidateCommit: string): void {
    this.db
      .prepare(
        "UPDATE projects SET stable_commit = ?, candidate_commit = ?, updated_at = ? WHERE id = ?"
      )
      .run(stableCommit, candidateCommit, nowIso(), projectId);
  }

  bindTelegramControlChat(projectId: string, chatId: string): void {
    this.db
      .prepare("UPDATE projects SET telegram_control_chat_id = ?, updated_at = ? WHERE id = ?")
      .run(chatId, nowIso(), projectId);
  }

  insertInboxItem(item: InboxItem & { projectId: string }): void {
    this.db
      .prepare(
        `
          INSERT INTO inbox_items (id, project_id, source, external_id, received_at, text, status, metadata_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, '{}')
        `
      )
      .run(
        item.id,
        item.projectId,
        item.source,
        item.externalId ?? null,
        item.receivedAt,
        item.text,
        item.status
      );
  }

  listInboxItems(projectId: string, statuses: InboxItem["status"][] = ["new", "triaged"]): InboxItem[] {
    const placeholders = statuses.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT id, source, external_id, received_at, text, status FROM inbox_items WHERE project_id = ? AND status IN (${placeholders}) ORDER BY received_at ASC`
      )
      .all(projectId, ...statuses) as Record<string, unknown>[];

    return rows.map((row) => ({
      id: String(row.id),
      source: row.source as InboxItem["source"],
      externalId: row.external_id ? String(row.external_id) : undefined,
      receivedAt: String(row.received_at),
      text: String(row.text),
      status: row.status as InboxItem["status"]
    }));
  }

  markInboxItemStatus(id: string, status: InboxItem["status"]): void {
    this.db.prepare("UPDATE inbox_items SET status = ? WHERE id = ?").run(status, id);
  }

  upsertTask(record: {
    projectId: string;
    id: string;
    kind?: TaskContract["kind"] | null;
    status: TaskStatus;
    title: string;
    priority: TaskPriority;
    goal: string;
    branchName?: string;
    baseBranch?: string;
    worktreePath?: string;
    contract?: TaskContract;
    blockedByDecisionIds?: string[];
  }): void {
    const now = nowIso();
    this.db
      .prepare(
        `
          INSERT INTO tasks (
            id, project_id, kind, status, title, priority, goal,
            branch_name, base_branch, worktree_path, contract_json,
            blocked_by_decision_ids_json, created_at, updated_at
          ) VALUES (
            @id, @projectId, @kind, @status, @title, @priority, @goal,
            @branchName, @baseBranch, @worktreePath, @contractJson,
            @blockedByDecisionIdsJson, @createdAt, @updatedAt
          )
          ON CONFLICT(id) DO UPDATE SET
            kind = excluded.kind,
            status = excluded.status,
            title = excluded.title,
            priority = excluded.priority,
            goal = excluded.goal,
            branch_name = excluded.branch_name,
            base_branch = excluded.base_branch,
            worktree_path = excluded.worktree_path,
            contract_json = excluded.contract_json,
            blocked_by_decision_ids_json = excluded.blocked_by_decision_ids_json,
            updated_at = excluded.updated_at
        `
      )
      .run({
        id: record.id,
        projectId: record.projectId,
        kind: record.kind ?? null,
        status: record.status,
        title: record.title,
        priority: record.priority,
        goal: record.goal,
        branchName: record.branchName ?? null,
        baseBranch: record.baseBranch ?? null,
        worktreePath: record.worktreePath ?? null,
        contractJson: record.contract ? serializeJson(record.contract) : null,
        blockedByDecisionIdsJson: serializeJson(record.blockedByDecisionIds ?? []),
        createdAt: now,
        updatedAt: now
      });
  }

  listTasks(projectId: string): TaskRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at ASC")
      .all(projectId) as Record<string, unknown>[];
    return rows.map((row) => this.taskFromRow(row));
  }

  getTask(taskId: string): TaskRecord | undefined {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as
      | Record<string, unknown>
      | undefined;
    return row ? this.taskFromRow(row) : undefined;
  }

  updateTaskStatus(taskId: string, status: TaskStatus): void {
    this.db.prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?").run(status, nowIso(), taskId);
  }

  insertTaskEvent(taskId: string, type: string, summary: string, payload: unknown = {}): void {
    this.db
      .prepare(
        "INSERT INTO task_events (task_id, at, type, summary, payload_json) VALUES (?, ?, ?, ?, ?)"
      )
      .run(taskId, nowIso(), type, summary, serializeJson(payload));
  }

  listRecentEvents(projectId: string, limit = 20): Array<{ at: string; type: string; summary: string }> {
    const rows = this.db
      .prepare(
        `
          SELECT task_events.at, task_events.type, task_events.summary
          FROM task_events
          JOIN tasks ON tasks.id = task_events.task_id
          WHERE tasks.project_id = ?
          ORDER BY task_events.at DESC
          LIMIT ?
        `
      )
      .all(projectId, limit) as Record<string, unknown>[];

    return rows.map((row) => ({
      at: String(row.at),
      type: String(row.type),
      summary: String(row.summary)
    }));
  }

  insertManagerTurn(options: {
    projectId: string;
    summary: string;
    wakeReasons: string[];
    actionCounts: ManagerTurnInput["recentManagerTurns"][number]["actionCounts"];
    actionPreview: ManagerTurnInput["recentManagerTurns"][number]["actionPreview"];
    mismatchHints: string[];
    rawOutput: Record<string, unknown>;
  }): void {
    this.db
      .prepare(
        "INSERT INTO manager_turns (project_id, at, summary, wake_reasons_json, action_counts_json, action_preview_json, mismatch_hints_json, raw_output_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        options.projectId,
        nowIso(),
        options.summary,
        serializeJson(options.wakeReasons),
        serializeJson(options.actionCounts),
        serializeJson(options.actionPreview),
        serializeJson(options.mismatchHints),
        serializeJson(options.rawOutput)
      );
  }

  listRecentManagerTurns(
    projectId: string,
    limit = 8
  ): ManagerTurnInput["recentManagerTurns"] {
    const rows = this.db
      .prepare(
        `
          SELECT at, summary, wake_reasons_json, action_counts_json
               , action_preview_json, mismatch_hints_json, raw_output_json
          FROM manager_turns
          WHERE project_id = ?
          ORDER BY at DESC
          LIMIT ?
        `
      )
      .all(projectId, limit) as Record<string, unknown>[];

    return rows.map((row) => ({
      at: String(row.at),
      summary: String(row.summary),
      wakeReasons: parseJson<string[]>(row.wake_reasons_json, []),
      actionCounts: parseJson<ManagerTurnInput["recentManagerTurns"][number]["actionCounts"]>(
        row.action_counts_json,
        {
          tasksToStart: 0,
          tasksToCancel: 0,
          reviewsToStart: 0,
          integrations: 0,
          deployments: 0,
          decisions: 0,
          userMessages: 0
        }
      ),
      actionPreview: parseJson<ManagerTurnInput["recentManagerTurns"][number]["actionPreview"]>(
        row.action_preview_json,
        {
          tasksToStart: [],
          tasksToCancel: [],
          reviewsToStart: [],
          integrations: [],
          deployments: [],
          decisions: [],
          userMessages: []
        }
      ),
      mismatchHints: parseJson<string[]>(row.mismatch_hints_json, []),
      rawOutput: parseJson<Record<string, unknown>>(row.raw_output_json, {})
    }));
  }

  upsertAgent(agent: Omit<AgentRecord, "updatedAt">): void {
    this.db
      .prepare(
        `
          INSERT INTO agents (
            id, project_id, role, status, task_id, branch, worktree_path,
            thread_id, turn_id, pid, metadata_json, updated_at
          ) VALUES (
            @id, @projectId, @role, @status, @taskId, @branch, @worktreePath,
            @threadId, @turnId, @pid, @metadataJson, @updatedAt
          )
          ON CONFLICT(id) DO UPDATE SET
            role = excluded.role,
            status = excluded.status,
            task_id = excluded.task_id,
            branch = excluded.branch,
            worktree_path = excluded.worktree_path,
            thread_id = excluded.thread_id,
            turn_id = excluded.turn_id,
            pid = excluded.pid,
            metadata_json = excluded.metadata_json,
            updated_at = excluded.updated_at
        `
      )
      .run({
        id: agent.id,
        projectId: agent.projectId,
        role: agent.role,
        status: agent.status,
        taskId: agent.taskId ?? null,
        branch: agent.branch ?? null,
        worktreePath: agent.worktreePath ?? null,
        threadId: agent.threadId ?? null,
        turnId: agent.turnId ?? null,
        pid: agent.pid ?? null,
        metadataJson: serializeJson(agent.metadata ?? {}),
        updatedAt: nowIso()
      });
  }

  listAgents(projectId: string): AgentRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM agents WHERE project_id = ? ORDER BY id ASC")
      .all(projectId) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id),
      projectId: String(row.project_id),
      role: row.role as AgentRecord["role"],
      status: row.status as AgentStatus,
      taskId: row.task_id ? String(row.task_id) : undefined,
      branch: row.branch ? String(row.branch) : undefined,
      worktreePath: row.worktree_path ? String(row.worktree_path) : undefined,
      threadId: row.thread_id ? String(row.thread_id) : undefined,
      turnId: row.turn_id ? String(row.turn_id) : undefined,
      pid: typeof row.pid === "number" ? row.pid : undefined,
      metadata: parseJson<Record<string, unknown>>(row.metadata_json, {}),
      updatedAt: String(row.updated_at)
    }));
  }

  setAgentSession(options: {
    id: string;
    projectId: string;
    agentId: string;
    sessionType: string;
    sessionId: string;
    transport: string;
  }): void {
    const now = nowIso();
    this.db
      .prepare(
        `
          INSERT INTO agent_sessions (id, project_id, agent_id, session_type, session_id, transport, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            session_id = excluded.session_id,
            transport = excluded.transport,
            updated_at = excluded.updated_at
        `
      )
      .run(
        options.id,
        options.projectId,
        options.agentId,
        options.sessionType,
        options.sessionId,
        options.transport,
        now,
        now
      );
  }

  getAgentSession(agentId: string, sessionType: string): { id: string; sessionId: string; transport: string } | undefined {
    const row = this.db
      .prepare("SELECT id, session_id, transport FROM agent_sessions WHERE agent_id = ? AND session_type = ?")
      .get(agentId, sessionType) as Record<string, unknown> | undefined;
    return row
      ? {
          id: String(row.id),
          sessionId: String(row.session_id),
          transport: String(row.transport)
        }
      : undefined;
  }

  getDecisionBudget(
    projectId: string,
    timezone: string,
    limit: number,
    reserveCritical: number
  ): DecisionBudgetSnapshot {
    const date = localDateString(timezone);
    const row = this.db
      .prepare(
        `
          INSERT INTO decision_budget_days (project_id, date, used, limit_value, reserve_critical)
          VALUES (?, ?, 0, ?, ?)
          ON CONFLICT(project_id, date) DO NOTHING
        `
      )
      .run(projectId, date, limit, reserveCritical);
    void row;
    const day = this.db
      .prepare("SELECT used, limit_value, reserve_critical FROM decision_budget_days WHERE project_id = ? AND date = ?")
      .get(projectId, date) as Record<string, unknown>;

    return computeDecisionBudgetSnapshot(
      date,
      Number(day.used),
      Number(day.limit_value),
      Number(day.reserve_critical)
    );
  }

  incrementDecisionBudget(projectId: string, timezone: string): void {
    const date = localDateString(timezone);
    this.db
      .prepare("UPDATE decision_budget_days SET used = used + 1 WHERE project_id = ? AND date = ?")
      .run(projectId, date);
  }

  listOpenDecisions(projectId: string): DecisionRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM decision_requests WHERE project_id = ? AND status = 'open' ORDER BY created_at ASC")
      .all(projectId) as Record<string, unknown>[];
    return rows.map((row) => this.decisionFromRow(row));
  }

  getDecision(id: string): DecisionRecord | undefined {
    const row = this.db.prepare("SELECT * FROM decision_requests WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.decisionFromRow(row) : undefined;
  }

  findOpenDecisionByDedupe(projectId: string, dedupeKey: string): DecisionRecord | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM decision_requests WHERE project_id = ? AND dedupe_key = ? AND status = 'open' LIMIT 1"
      )
      .get(projectId, dedupeKey) as Record<string, unknown> | undefined;
    return row ? this.decisionFromRow(row) : undefined;
  }

  insertDecision(
    projectId: string,
    decision: DecisionRequest,
    blockingTaskIds: string[] = []
  ): void {
    const now = nowIso();
    this.db
      .prepare(
        `
          INSERT INTO decision_requests (
            id, project_id, title, reason, priority, dedupe_key, options_json,
            default_option_id, expires_at, impact_summary, budget_cost, status,
            resolved_option_id, blocking_task_ids_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', NULL, ?, ?, ?)
        `
      )
      .run(
        decision.id,
        projectId,
        decision.title,
        decision.reason,
        decision.priority,
        decision.dedupeKey,
        serializeJson(decision.options),
        decision.defaultOptionId,
        decision.expiresAt,
        decision.impactSummary,
        decision.budgetCost,
        serializeJson(blockingTaskIds),
        now,
        now
      );
  }

  resolveDecision(id: string, status: DecisionRecord["status"], resolvedOptionId: string): void {
    this.db
      .prepare(
        "UPDATE decision_requests SET status = ?, resolved_option_id = ?, updated_at = ? WHERE id = ?"
      )
      .run(status, resolvedOptionId, nowIso(), id);
  }

  expireTimedOutDecisions(now = nowIso()): DecisionRecord[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM decision_requests WHERE status = 'open' AND expires_at <= ? ORDER BY expires_at ASC"
      )
      .all(now) as Record<string, unknown>[];
    const decisions = rows.map((row) => this.decisionFromRow(row));
    for (const decision of decisions) {
      this.resolveDecision(decision.id, "timed_out", decision.defaultOptionId);
    }
    return decisions;
  }

  requeueSatisfiedBlockedTasks(projectId: string): string[] {
    const openDecisionIds = new Set(this.listOpenDecisions(projectId).map((decision) => decision.id));
    const tasks = this.listTasks(projectId).filter((task) => task.status === "blocked");
    const requeued: string[] = [];

    for (const task of tasks) {
      const remainingBlockers = task.blockedByDecisionIds.filter((decisionId) =>
        openDecisionIds.has(decisionId)
      );
      if (remainingBlockers.length > 0) {
        continue;
      }

      this.db
        .prepare(
          "UPDATE tasks SET status = 'queued', blocked_by_decision_ids_json = '[]', updated_at = ? WHERE id = ?"
        )
        .run(nowIso(), task.id);
      requeued.push(task.id);
    }

    return requeued;
  }

  insertTelegramMessage(options: {
    id: string;
    projectId: string;
    telegramMessageId?: string;
    chatId?: string;
    direction: "inbound" | "outbound";
    kind: string;
    text: string;
    replyToMessageId?: string;
    decisionId?: string;
  }): void {
    this.db
      .prepare(
        `
          INSERT INTO telegram_messages (
            id, project_id, telegram_message_id, chat_id, direction, kind, text,
            reply_to_message_id, decision_id, recorded_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        options.id,
        options.projectId,
        options.telegramMessageId ?? null,
        options.chatId ?? null,
        options.direction,
        options.kind,
        options.text,
        options.replyToMessageId ?? null,
        options.decisionId ?? null,
        nowIso()
      );
  }

  insertWorktree(options: {
    id: string;
    projectId: string;
    taskId: string;
    worktreePath: string;
    branchName: string;
    baseBranch: string;
    baseCommit: string;
    appPort?: number;
    e2ePort?: number;
  }): void {
    const now = nowIso();
    this.db
      .prepare(
        `
          INSERT INTO worktrees (
            id, project_id, task_id, path, branch_name, base_branch, base_commit,
            app_port, e2e_port, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        options.id,
        options.projectId,
        options.taskId,
        options.worktreePath,
        options.branchName,
        options.baseBranch,
        options.baseCommit,
        options.appPort ?? null,
        options.e2ePort ?? null,
        now,
        now
      );
  }

  addPortLease(projectId: string, worktreeId: string, kind: "app" | "e2e", port: number): void {
    this.db
      .prepare(
        "INSERT INTO port_leases (project_id, worktree_id, kind, port, leased_at) VALUES (?, ?, ?, ?, ?)"
      )
      .run(projectId, worktreeId, kind, port, nowIso());
  }

  listActivePortLeases(projectId: string): Array<{ worktreeId: string; kind: "app" | "e2e"; port: number }> {
    const rows = this.db
      .prepare(
        "SELECT worktree_id, kind, port FROM port_leases WHERE project_id = ? AND released_at IS NULL"
      )
      .all(projectId) as Record<string, unknown>[];
    return rows.map((row) => ({
      worktreeId: String(row.worktree_id),
      kind: row.kind as "app" | "e2e",
      port: Number(row.port)
    }));
  }

  releasePortLeasesByWorktree(worktreeId: string): void {
    this.db
      .prepare("UPDATE port_leases SET released_at = ? WHERE worktree_id = ? AND released_at IS NULL")
      .run(nowIso(), worktreeId);
  }

  insertRun(options: {
    id: string;
    projectId: string;
    taskId: string;
    role: "code" | "review" | "test";
    attempt: number;
    status: string;
    runDirectory: string;
    jsonlLogPath: string;
    finalMessagePath: string;
    maxRuntimeMinutes: number;
    pid?: number;
  }): void {
    this.db
      .prepare(
        `
          INSERT INTO runs (
            id, project_id, task_id, role, attempt, status, run_directory,
            jsonl_log_path, final_message_path, max_runtime_minutes, pid, started_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        options.id,
        options.projectId,
        options.taskId,
        options.role,
        options.attempt,
        options.status,
        options.runDirectory,
        options.jsonlLogPath,
        options.finalMessagePath,
        options.maxRuntimeMinutes,
        options.pid ?? null,
        nowIso()
      );
  }

  finishRun(runId: string, status: string): void {
    this.db
      .prepare("UPDATE runs SET status = ?, finished_at = ? WHERE id = ?")
      .run(status, nowIso(), runId);
  }

  recordDeployment(options: {
    projectId: string;
    target: "stable" | "preview";
    status: string;
    url: string;
    commit: string;
    activeSlot?: "stable-a" | "stable-b";
    reason: string;
  }): void {
    this.db
      .prepare(
        "INSERT INTO deployments (project_id, target, status, url, commit_sha, active_slot, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        options.projectId,
        options.target,
        options.status,
        options.url,
        options.commit,
        options.activeSlot ?? null,
        options.reason,
        nowIso()
      );
  }

  listDeployments(
    projectId: string,
    target?: "stable" | "preview",
    limit = 20
  ): Array<{
    target: "stable" | "preview";
    status: string;
    url: string;
    commit: string;
    activeSlot?: "stable-a" | "stable-b";
    reason: string;
    createdAt: string;
  }> {
    const rows = target
      ? (this.db
          .prepare(
            `
              SELECT target, status, url, commit_sha, active_slot, reason, created_at
              FROM deployments
              WHERE project_id = ? AND target = ?
              ORDER BY created_at DESC
              LIMIT ?
            `
          )
          .all(projectId, target, limit) as Record<string, unknown>[])
      : (this.db
          .prepare(
            `
              SELECT target, status, url, commit_sha, active_slot, reason, created_at
              FROM deployments
              WHERE project_id = ?
              ORDER BY created_at DESC
              LIMIT ?
            `
          )
          .all(projectId, limit) as Record<string, unknown>[]);

    return rows.map((row) => ({
      target: row.target as "stable" | "preview",
      status: String(row.status),
      url: String(row.url),
      commit: String(row.commit_sha),
      activeSlot: row.active_slot ? (row.active_slot as "stable-a" | "stable-b") : undefined,
      reason: String(row.reason),
      createdAt: String(row.created_at)
    }));
  }

  getDeploymentSnapshot(projectId: string): ManagerTurnInput["deployments"] {
    const recentStableDeployments = this.listDeployments(projectId, "stable", 10);
    const currentStableCommit = recentStableDeployments[0]?.commit;
    const rollbackTarget = recentStableDeployments.find(
      (deployment) =>
        deployment.status === "healthy" &&
        deployment.commit &&
        deployment.commit !== currentStableCommit
    )?.commit;
    const stable = this.db
      .prepare(
        "SELECT status, url, commit_sha, active_slot, reason, created_at FROM deployments WHERE project_id = ? AND target = 'stable' ORDER BY created_at DESC LIMIT 1"
      )
      .get(projectId) as Record<string, unknown> | undefined;
    const preview = this.db
      .prepare(
        "SELECT status, url, commit_sha, reason, created_at FROM deployments WHERE project_id = ? AND target = 'preview' ORDER BY created_at DESC LIMIT 1"
      )
      .get(projectId) as Record<string, unknown> | undefined;

    return {
      stable: {
        status: (stable?.status as ManagerTurnInput["deployments"]["stable"]["status"]) ?? "degraded",
        url: typeof stable?.url === "string" ? stable.url : "http://127.0.0.1:3000",
        commit: typeof stable?.commit_sha === "string" ? stable.commit_sha : "",
        activeSlot:
          (stable?.active_slot as ManagerTurnInput["deployments"]["stable"]["activeSlot"]) ??
          "stable-a",
        reason: typeof stable?.reason === "string" ? stable.reason : undefined,
        updatedAt: typeof stable?.created_at === "string" ? stable.created_at : undefined,
        canRollback: Boolean(rollbackTarget),
        rollbackTargetCommit: rollbackTarget
      },
      preview: {
        status: (preview?.status as ManagerTurnInput["deployments"]["preview"]["status"]) ?? "down",
        url: typeof preview?.url === "string" ? preview.url : "http://127.0.0.1:3100",
        commit: typeof preview?.commit_sha === "string" ? preview.commit_sha : "",
        reason: typeof preview?.reason === "string" ? preview.reason : undefined,
        updatedAt: typeof preview?.created_at === "string" ? preview.created_at : undefined
      }
    };
  }

  recordHealthSample(projectId: string, sample: { cpuPercent: number; memoryPercent: number; swapActive: boolean; detail?: unknown }): void {
    this.db
      .prepare(
        "INSERT INTO health_samples (project_id, sampled_at, cpu_percent, memory_percent, swap_active, detail_json) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(
        projectId,
        nowIso(),
        sample.cpuPercent,
        sample.memoryPercent,
        sample.swapActive ? 1 : 0,
        serializeJson(sample.detail ?? {})
      );
  }

  insertReleaseTag(projectId: string, tag: string, commit: string): void {
    this.db
      .prepare("INSERT INTO release_tags (project_id, tag, commit_sha, created_at) VALUES (?, ?, ?, ?)")
      .run(projectId, tag, commit, nowIso());
  }

  getReleaseTag(projectId: string, tag: string): { tag: string; commit: string; createdAt: string } | undefined {
    const row = this.db
      .prepare("SELECT tag, commit_sha, created_at FROM release_tags WHERE project_id = ? AND tag = ?")
      .get(projectId, tag) as Record<string, unknown> | undefined;
    return row
      ? {
          tag: String(row.tag),
          commit: String(row.commit_sha),
          createdAt: String(row.created_at)
        }
      : undefined;
  }

  getLatestTelegramMessageByKind(
    projectId: string,
    kind: string
  ): { id: string; recordedAt: string; text: string } | undefined {
    const row = this.db
      .prepare(
        `
          SELECT id, recorded_at, text
          FROM telegram_messages
          WHERE project_id = ? AND kind = ? AND direction = 'outbound'
          ORDER BY recorded_at DESC
          LIMIT 1
        `
      )
      .get(projectId, kind) as Record<string, unknown> | undefined;
    return row
      ? {
          id: String(row.id),
          recordedAt: String(row.recorded_at),
          text: String(row.text)
        }
      : undefined;
  }

  getManagerInput(config: FactoryProjectConfig): ManagerTurnInput {
    const project = this.getProjectById(config.projectId);
    const openDecisions = this.listOpenDecisions(config.projectId);
    const budget = this.getDecisionBudget(
      config.projectId,
      config.timezone,
      config.decisionBudget.dailyLimit,
      config.decisionBudget.reserveCritical
    );
    const latestTaskEvents = this.db
      .prepare(
        `
          SELECT task_events.task_id, task_events.at, task_events.type, task_events.summary, task_events.payload_json
          FROM task_events
          JOIN (
            SELECT task_id, MAX(at) AS max_at
            FROM task_events
            GROUP BY task_id
          ) latest
            ON latest.task_id = task_events.task_id
           AND latest.max_at = task_events.at
          JOIN tasks ON tasks.id = task_events.task_id
          WHERE tasks.project_id = ?
        `
      )
      .all(config.projectId) as Record<string, unknown>[];
    const latestEventByTaskId = new Map(
      latestTaskEvents.map((row) => [
        String(row.task_id),
        {
          at: String(row.at),
          type: String(row.type),
          summary: String(row.summary),
          payload: parseJson<Record<string, unknown>>(row.payload_json, {})
        }
      ])
    );

    return {
      now: nowIso(),
      timezone: config.timezone,
      project: {
        id: config.projectId,
        bootstrapStatus: project.bootstrapStatus,
        projectSpecPath: project.projectSpecPath,
        onboardingSummaryPath: project.onboardingSummaryPath
      },
      repo: {
        root: project.repoRoot,
        defaultBranch: project.defaultBranch,
        candidateBranch: project.candidateBranch,
        currentStableCommit: project.stableCommit,
        currentCandidateCommit: project.candidateCommit,
        dirtyFiles: [],
        trackedFileCount: 0,
        trackedFilesSample: [],
        appearsGreenfield: false,
        branches: []
      },
      decisionBudget: budget,
      openDecisions: openDecisions.map((decision) => ({
        id: decision.id,
        title: decision.title,
        priority: decision.priority,
        dedupeKey: decision.dedupeKey,
        defaultOptionId: decision.defaultOptionId,
        expiresAt: decision.expiresAt,
        blockingTaskIds: decision.blockingTaskIds
      })),
      userMessages: this.listInboxItems(config.projectId, ["new"])
        .filter((item) => item.source === "telegram")
        .map((item) => ({
          id: item.id,
          source: "telegram" as const,
          receivedAt: item.receivedAt,
          text: item.text,
          urgent: true
        })),
      inboxItems: this.listInboxItems(config.projectId),
      agents: this.listAgents(config.projectId)
        .filter((agent) => ["idle", "running", "stalled", "failed"].includes(agent.status))
        .map((agent) => ({
          id: agent.id,
          role: agent.role,
          status: agent.status as "idle" | "running" | "stalled" | "failed",
          taskId: agent.taskId,
          branch: agent.branch,
          worktreePath: agent.worktreePath
        })),
      tasks: this.listTasks(config.projectId)
        .filter((task) => ["queued", "running", "blocked", "review", "done", "failed"].includes(task.status))
        .map((task) => {
          const latestEvent = latestEventByTaskId.get(task.id);
          return {
            id: task.id,
            status: task.status as "queued" | "running" | "blocked" | "review" | "done" | "failed",
            title: task.title,
            priority: task.priority,
            branchName: task.branchName,
            baseBranch: task.baseBranch,
            worktreePath: task.worktreePath,
            relatedTaskIds: task.contract?.context.relatedTaskIds ?? [],
            blockedByDecisionIds: task.blockedByDecisionIds,
            latestEventAt: latestEvent?.at,
            latestEventType: latestEvent?.type,
            latestEventSummary: latestEvent?.summary,
            latestEventPayload: latestEvent?.payload
          };
        }),
      deployments: this.getDeploymentSnapshot(config.projectId),
      resources: {
        cpuPercent: 0,
        memoryPercent: 0,
        swapActive: false,
        freeWorkerSlots: config.scheduler.maxWorkers,
        workerSandbox: {
          canBindListenSockets: true
        }
      },
      recentEvents: this.listRecentEvents(config.projectId),
      recentManagerTurns: this.listRecentManagerTurns(config.projectId)
    };
  }

  private projectFromRow(row: Record<string, unknown>): ProjectRecord {
    return {
      id: String(row.id),
      repoRoot: String(row.repo_root),
      configPath: String(row.config_path),
      defaultBranch: String(row.default_branch),
      candidateBranch: String(row.candidate_branch),
      bootstrapStatus: row.bootstrap_status as ProjectRecord["bootstrapStatus"],
      projectSpecPath: row.project_spec_path ? String(row.project_spec_path) : undefined,
      onboardingSummaryPath: String(row.onboarding_summary_path),
      stableCommit: String(row.stable_commit),
      candidateCommit: String(row.candidate_commit),
      telegramControlChatId: row.telegram_control_chat_id
        ? String(row.telegram_control_chat_id)
        : undefined,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    };
  }

  private taskFromRow(row: Record<string, unknown>): TaskRecord {
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      kind: (row.kind as TaskRecord["kind"]) ?? null,
      status: row.status as TaskStatus,
      title: String(row.title),
      priority: row.priority as TaskPriority,
      goal: String(row.goal),
      branchName: row.branch_name ? String(row.branch_name) : undefined,
      baseBranch: row.base_branch ? String(row.base_branch) : undefined,
      worktreePath: row.worktree_path ? String(row.worktree_path) : undefined,
      contract: row.contract_json
        ? parseJson<TaskContract>(row.contract_json, undefined as never)
        : undefined,
      blockedByDecisionIds: parseJson<string[]>(row.blocked_by_decision_ids_json, []),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    };
  }

  private decisionFromRow(row: Record<string, unknown>): DecisionRecord {
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      title: String(row.title),
      reason: String(row.reason),
      priority: row.priority as DecisionRecord["priority"],
      dedupeKey: String(row.dedupe_key),
      options: parseJson<DecisionRequest["options"]>(row.options_json, []),
      defaultOptionId: String(row.default_option_id),
      expiresAt: String(row.expires_at),
      impactSummary: String(row.impact_summary),
      budgetCost: 1,
      status: row.status as DecisionRecord["status"],
      resolvedOptionId: row.resolved_option_id ? String(row.resolved_option_id) : undefined,
      blockingTaskIds: parseJson<string[]>(row.blocking_task_ids_json, []),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    };
  }
}
