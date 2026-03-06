import path from "node:path";
import { pathToFileURL } from "node:url";
import type { FactoryProjectConfig } from "@permafactory/models";
import {
  DEFAULT_CANDIDATE_BRANCH,
  DEFAULT_ONBOARDING_SUMMARY_PATH,
  DEFAULT_PROJECT_SPEC_PATH
} from "@permafactory/models";
import {
  ensureDir,
  fileExists,
  getFactoryPaths,
  readJson,
  readText,
  writeText,
  writeTextIfAbsent
} from "@permafactory/runtime";

export interface InitConfigOptions {
  repoRoot: string;
  projectId: string;
  defaultBranch: string;
  projectSpecPath?: string;
}

export interface ScriptDetection {
  packageManager: "npm" | "pnpm" | "yarn" | "bun";
  scripts: FactoryProjectConfig["scripts"];
}

const DEFAULT_CONFIG_FILE_NAME = "factory.config.ts";

export function getConfigPath(repoRoot: string): string {
  return path.join(repoRoot, DEFAULT_CONFIG_FILE_NAME);
}

export async function loadProjectConfig(repoRoot: string): Promise<FactoryProjectConfig> {
  const configPath = getConfigPath(repoRoot);
  if (!(await fileExists(configPath))) {
    throw new Error(`Missing config file: ${configPath}`);
  }

  const moduleUrl = `${pathToFileURL(configPath).href}?t=${Date.now()}`;
  const imported = (await import(moduleUrl)) as { default?: unknown };
  const config = imported.default;
  if (!config || typeof config !== "object") {
    throw new Error(`Config file ${configPath} does not export a default object`);
  }

  return config as FactoryProjectConfig;
}

export async function detectPackageManagerAndScripts(repoRoot: string): Promise<ScriptDetection> {
  const packageJsonPath = path.join(repoRoot, "package.json");
  const packageJson = (await fileExists(packageJsonPath))
    ? await readJson<{ scripts?: Record<string, string>; packageManager?: string }>(packageJsonPath)
    : {};

  const scripts = packageJson.scripts ?? {};
  const packageManager = await detectPackageManager(repoRoot, packageJson.packageManager);
  const pmRun = (scriptName: string) => `${packageManager} run ${scriptName}`;

  return {
    packageManager,
    scripts: {
      bootstrapWorktree: ".factory/scripts/bootstrap-worktree.sh",
      install: packageManager === "npm" ? "npm ci" : `${packageManager} install --frozen-lockfile`,
      lint: scripts.lint ? pmRun("lint") : "echo 'lint script not configured'",
      test: scripts.test ? pmRun("test") : "echo 'test script not configured'",
      build: scripts.build ? pmRun("build") : "echo 'build script not configured'",
      smoke: scripts.smoke ? pmRun("smoke") : scripts.test ? pmRun("test") : "echo 'smoke script not configured'",
      serveStable: chooseServeScript(packageManager, scripts, ["start", "serve", "preview"]),
      servePreview: chooseServeScript(packageManager, scripts, ["preview", "dev", "start"]),
      serveWorker: chooseServeScript(packageManager, scripts, ["dev", "preview", "start"]),
      e2e: chooseServeScript(packageManager, scripts, ["e2e", "test:e2e", "playwright"]),
      healthcheck:
        scripts.healthcheck !== undefined
          ? pmRun("healthcheck")
          : "node -e \"fetch('http://127.0.0.1:' + (process.env.PORT || process.env.FACTORY_APP_PORT) + '/').then(() => process.exit(0)).catch(() => process.exit(1))\""
    }
  };
}

function chooseServeScript(
  packageManager: ScriptDetection["packageManager"],
  scripts: Record<string, string>,
  candidates: string[]
): string {
  const winner = candidates.find((candidate) => scripts[candidate] !== undefined);
  return winner ? `${packageManager} run ${winner}` : "echo 'serve script not configured'";
}

async function detectPackageManager(
  repoRoot: string,
  declaredPackageManager?: string
): Promise<ScriptDetection["packageManager"]> {
  if (declaredPackageManager) {
    if (declaredPackageManager.startsWith("pnpm")) return "pnpm";
    if (declaredPackageManager.startsWith("yarn")) return "yarn";
    if (declaredPackageManager.startsWith("bun")) return "bun";
  }

  if (await fileExists(path.join(repoRoot, "pnpm-lock.yaml"))) return "pnpm";
  if (await fileExists(path.join(repoRoot, "yarn.lock"))) return "yarn";
  if (await fileExists(path.join(repoRoot, "bun.lockb"))) return "bun";
  return "npm";
}

export async function detectProjectSpecPath(
  repoRoot: string,
  explicitPath?: string
): Promise<string> {
  const candidates = explicitPath
    ? [explicitPath]
    : [
        DEFAULT_PROJECT_SPEC_PATH,
        "docs/spec.md",
        "SPEC.md",
        "spec.md",
        "README.md"
      ];

  for (const candidate of candidates) {
    if (await fileExists(path.join(repoRoot, candidate))) {
      return candidate;
    }
  }

  return explicitPath ?? DEFAULT_PROJECT_SPEC_PATH;
}

export async function scaffoldProjectSpec(
  repoRoot: string,
  projectId: string,
  projectSpecPath: string
): Promise<void> {
  const absolutePath = path.join(repoRoot, projectSpecPath);
  await writeTextIfAbsent(
    absolutePath,
    `# ${projectId} Project Spec\n\n## Product Summary\n\nDescribe the product goals and current scope.\n\n## Users\n\nDescribe the primary user types.\n\n## Current Priorities\n\n- bootstrap operability\n- document release expectations\n\n## Constraints\n\n- stable should remain usable\n- browser-console actions should share the same action registry as the UI\n`
  );
}

export function buildFactoryConfig(
  options: InitConfigOptions,
  detection: ScriptDetection
): FactoryProjectConfig {
  return {
    projectId: options.projectId,
    repoRoot: options.repoRoot,
    defaultBranch: options.defaultBranch,
    candidateBranch: DEFAULT_CANDIDATE_BRANCH,
    projectSpecPath: options.projectSpecPath ?? DEFAULT_PROJECT_SPEC_PATH,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
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
      onboardingSummaryPath: DEFAULT_ONBOARDING_SUMMARY_PATH
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
    scripts: detection.scripts,
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

export function renderFactoryConfig(config: FactoryProjectConfig): string {
  return `const config = ${JSON.stringify(config, null, 2)};\n\nexport default config;\n`;
}

export function renderEnvExample(config: FactoryProjectConfig): string {
  return `${config.telegram.botTokenEnvVar}=replace-me\n${config.telegram.webhookSecretEnvVar}=replace-me\n`;
}

export function renderAgentsStub(projectId: string): string {
  return `# ${projectId} Factory Policy\n\n- Keep \`stable\` safe.\n- Prefer small, reviewable changes.\n- Route user-triggerable frontend actions through the shared browser action registry.\n`;
}

export function renderBootstrapScript(): string {
  return `#!/usr/bin/env bash
set -euo pipefail

WORKTREE_PATH="\${1:?worktree path required}"
cd "$WORKTREE_PATH"

if [[ -f package-lock.json ]]; then
  npm ci
elif [[ -f pnpm-lock.yaml ]]; then
  pnpm install --frozen-lockfile
elif [[ -f yarn.lock ]]; then
  yarn install --frozen-lockfile
fi

if [[ -f .factory.env ]]; then
  set -a
  source .factory.env
  set +a
fi
`;
}

export async function initializeFactoryLayout(repoRoot: string): Promise<void> {
  const paths = getFactoryPaths(repoRoot);
  await Promise.all([
    ensureDir(paths.factoryRoot),
    ensureDir(paths.tasksDir),
    ensureDir(paths.logsDir),
    ensureDir(paths.worktreesDir),
    ensureDir(paths.runsDir),
    ensureDir(paths.scriptsDir)
  ]);
}

export async function writeBootstrapArtifacts(
  config: FactoryProjectConfig,
  projectId: string
): Promise<void> {
  const paths = getFactoryPaths(config.repoRoot);
  await writeText(paths.configPath, renderFactoryConfig(config));
  await writeText(path.join(config.repoRoot, ".env.factory.example"), renderEnvExample(config));
  await writeTextIfAbsent(path.join(config.repoRoot, "AGENTS.md"), renderAgentsStub(projectId));
  await writeText(paths.bootstrapScriptPath, renderBootstrapScript());
  await ensureDir(path.dirname(path.join(config.repoRoot, config.bootstrap.onboardingSummaryPath)));
  await writeTextIfAbsent(
    path.join(config.repoRoot, config.bootstrap.onboardingSummaryPath),
    "# Factory Onboarding Summary\n\nThis file will be populated by bootstrap runs.\n"
  );
}

export async function detectLikelyDefaultBranch(repoRoot: string): Promise<string | undefined> {
  const gitConfigPath = path.join(repoRoot, ".git", "HEAD");
  if (!(await fileExists(gitConfigPath))) {
    return undefined;
  }

  const head = await readText(gitConfigPath);
  const match = head.match(/refs\/heads\/(.+)\s*$/);
  return match?.[1];
}

export async function readRepoPackageJson(
  repoRoot: string
): Promise<{ scripts?: Record<string, string> } | undefined> {
  const packageJsonPath = path.join(repoRoot, "package.json");
  if (!(await fileExists(packageJsonPath))) {
    return undefined;
  }

  return await readJson<{ scripts?: Record<string, string> }>(packageJsonPath);
}

export async function detectBacklogFile(repoRoot: string): Promise<string | undefined> {
  for (const candidate of [".factory/backlog.md", "BACKLOG.md"]) {
    if (await fileExists(path.join(repoRoot, candidate))) {
      return candidate;
    }
  }

  return undefined;
}

export async function ensureProjectSpecAndConfig(
  options: InitConfigOptions
): Promise<FactoryProjectConfig> {
  await initializeFactoryLayout(options.repoRoot);
  const detection = await detectPackageManagerAndScripts(options.repoRoot);
  const projectSpecPath = await detectProjectSpecPath(options.repoRoot, options.projectSpecPath);
  await scaffoldProjectSpec(options.repoRoot, options.projectId, projectSpecPath);
  const config = buildFactoryConfig({ ...options, projectSpecPath }, detection);
  await writeBootstrapArtifacts(config, options.projectId);
  return config;
}
