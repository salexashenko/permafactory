const config = {
  "projectId": "permafactory",
  "repoRoot": "/home/sergey/code/permafactory",
  "defaultBranch": "master",
  "candidateBranch": "candidate",
  "projectSpecPath": "docs/project-spec.md",
  "timezone": "America/New_York",
  "codex": {
    "versionFloor": "0.111.0",
    "model": "gpt-5.4",
    "managerModel": "gpt-5.4",
    "approvalPolicy": "never",
    "sandboxMode": "workspace-write",
    "appServerUrl": "ws://127.0.0.1:7781",
    "searchEnabled": true,
    "codingReasoningPolicy": {
      "simple": "medium",
      "complex": "extra-high",
      "fallbackHighestSupported": "high"
    }
  },
  "telegram": {
    "botTokenEnvVar": "TELEGRAM_BOT_TOKEN",
    "webhookSecretEnvVar": "TELEGRAM_WEBHOOK_SECRET",
    "controlChatId": "",
    "allowedAdminUserIds": [],
    "allowAdminDm": false
  },
  "intake": {
    "sources": [
      "telegram",
      "backlog_file"
    ],
    "backlogFile": ".factory/backlog.md"
  },
  "bootstrap": {
    "status": "waiting_for_telegram",
    "onboardingSummaryPath": "docs/factory-onboarding.md"
  },
  "scheduler": {
    "tickSeconds": 15,
    "minWorkers": 1,
    "maxWorkers": 3,
    "workerStallSeconds": 600,
    "managerStallSeconds": 600,
    "messageResponseSlaSeconds": 60
  },
  "ports": {
    "stableProxy": 3000,
    "stableA": 3001,
    "stableB": 3002,
    "preview": 3100,
    "dashboard": 8787,
    "appServer": 7781,
    "workerStart": 3200,
    "workerEnd": 3299,
    "e2eStart": 4200,
    "e2eEnd": 4299
  },
  "scripts": {
    "bootstrapWorktree": ".factory/scripts/bootstrap-worktree.sh",
    "install": "npm ci",
    "lint": "echo 'lint script not configured'",
    "test": "npm run test",
    "build": "npm run build",
    "smoke": "npm run test",
    "serveStable": "echo 'serve script not configured'",
    "servePreview": "echo 'serve script not configured'",
    "serveWorker": "echo 'serve script not configured'",
    "e2e": "echo 'serve script not configured'",
    "healthcheck": "node -e \"fetch('http://127.0.0.1:' + (process.env.PORT || process.env.FACTORY_APP_PORT) + '/').then(() => process.exit(0)).catch(() => process.exit(1))\""
  },
  "browserActions": {
    "enabled": true,
    "namespace": "__factory"
  },
  "decisionBudget": {
    "dailyLimit": 15,
    "reserveCritical": 3
  }
};

export default config;
