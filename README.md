# Permafactory

Permafactory is an always-on Codex operator for a single repository. It sits in the background, talks to you in Telegram, keeps working when you are away, only spends your attention on big product or release decisions, and ships stable versions instead of handing you half-finished branches. When workers, the manager thread, the Codex app server, or runtime processes fail, it detects that and recovers automatically.

This repo is the control plane for that system. It is Linux-first, built in Node.js and TypeScript, stores state in SQLite, and orchestrates Codex manager, coding, review, and test agents around a real git repo.

## What It Does

- Runs a long-lived `factoryd` supervisor that owns process management, worktrees, ports, deployments, Telegram I/O, and recovery.
- Runs one persistent manager Codex thread through `codex app-server`.
- Starts disposable coding, review, and test workers through `codex exec --json`.
- Uses Telegram as the control room for user messages, inline decision buttons, daily digests, secret entry, and clean shutdown.
- Keeps a `candidate` branch for integration and a separate stable branch for the last good release.
- Maintains blue/green stable slots plus a preview slot when the managed repo has real serve and healthcheck scripts.
- Tracks tasks, agents, runs, decisions, deployments, worktrees, and Telegram history in `.factory/factory.sqlite`.
- Exposes local JSON status endpoints on the dashboard port.
- Requeues or recovers from stale workers, stale manager state, stale app-server listeners, stale browser helper processes, and unhealthy runtime slots.

## How It Behaves

Permafactory is opinionated about user attention:

- Big decisions go to Telegram with buttons.
- Direct replies to your messages go to Telegram.
- Stable ship notifications go to Telegram.
- A daily digest goes to Telegram.
- Routine internal churn stays local unless it is directly answering you.

Permafactory is also opinionated about safety:

- `stable` is the last known good branch, not the place where half-done work lands.
- `candidate` is where reviewed work is integrated before promotion.
- Workers run in isolated git worktrees.
- The supervisor, not workers, is the git authority that commits worktree changes and advances branches.

## Requirements

- Linux is the intended host environment.
- Node.js 22+ and `npm`.
- `git`.
- `codex` CLI `>= 0.111.0`, installed on `PATH` and already authenticated.
- A Telegram bot token from `@BotFather`.
- `systemd` is recommended for always-on use, but local background fallback exists.
- Chrome or Chromium is useful if you want browser-based validation through `chrome-devtools-mcp`.

Recommended for real usage:

- Set a dedicated `CODEX_HOME` before starting the factory so automation does not depend on your personal Codex state.

## Quick Start

Install dependencies:

```bash
npm install
```

Initialize a target repo:

```bash
npm run factoryctl -- init \
  --repo /path/to/repo \
  --project-id my-project \
  --default-branch main \
  --sandbox-mode workspace-write
```

That command creates or updates:

- `factory.config.ts`
- `.factory/`
- `.env.factory.example`
- `.env.factory`
- `docs/factory-onboarding.md`
- `.factory/scripts/bootstrap-worktree.sh`
- `candidate` branch
- permafactory entries in `.gitignore`

Set up Telegram:

1. Create a bot with `@BotFather`.
2. Put the bot token and webhook secret into `.env.factory`.
3. Bind the control chat:

```bash
npm run factoryctl -- telegram connect \
  --repo /path/to/repo \
  --bot-token-env TELEGRAM_BOT_TOKEN
```

4. Send `/hello` to the bot in a DM or private supergroup.

Start the factory:

```bash
npm run factoryctl -- start --repo /path/to/repo
```

For a foreground dry run of one supervisor tick:

```bash
npm run factoryctl -- start --repo /path/to/repo --foreground --once
```

Give it work:

- Send a Telegram message.
- Or ingest backlog text from the CLI:

```bash
npm run factoryctl -- ingest backlog \
  --repo /path/to/repo \
  --text "Build the smallest user-testable first version of the product."
```

Check status:

```bash
npm run factoryctl -- status --repo /path/to/repo
curl http://127.0.0.1:8787/status
curl http://127.0.0.1:8787/deploy-state
```

Stop it:

```bash
npm run factoryctl -- stop --repo /path/to/repo
```

You can also send `/stop` in Telegram.

## Telegram Controls

These are implemented today:

- `/hello` during `factoryctl telegram connect` to bind the control chat.
- Normal messages to describe work, ask questions, or change direction.
- Decision buttons for manager-created choices.
- `/secret ENV_NAME value` or `/secret ENV_NAME=value` to store single-line secrets in `.env.factory`.
- `/secrets` to list configured secret names.
- `/stop` to shut the factory down cleanly.

## Runtime Model

When the managed repo has usable scripts, Permafactory can run three runtime slots:

- `stable-a`
- `stable-b`
- `preview`

Behavior:

- Stable traffic is served through a local proxy on the stable port.
- Promotions build and healthcheck on the inactive stable slot, then switch stable to that slot.
- Preview serves the latest healthy `candidate` commit.
- If the repo is still greenfield or serve scripts are placeholders, stable and preview are marked deferred or down instead of pretending the app is healthy.

Default ports from generated config:

- stable proxy: `3000`
- stable-a: `3001`
- stable-b: `3002`
- preview: `3100`
- dashboard: `8787`
- Codex app server: `7781`
- worker app ports: `3200-3299`
- worker e2e ports: `4200-4299`

## Recovery Model

This repo already implements several automatic recovery paths:

- Missing or dead worker processes are detected and their tasks are re-queued.
- Stale manager state is marked stalled and a fresh turn is scheduled.
- Repeated manager no-op loops trigger manager thread rotation.
- Stale `codex app-server`, Chrome, browser MCP, and manager MCP processes are reaped.
- Runtime slot listeners on managed ports are reclaimed.
- Runtime healthchecks restart broken slot processes.
- Example `systemd` units are included for restart-on-failure and a minute-by-minute health probe.

## Useful Commands

```bash
npm run build
npm test
npm run factoryctl -- status --repo /path/to/repo --json
npm run factoryctl -- cleanup --repo /path/to/repo --dry-run
npm run factoryctl -- cleanup --repo /path/to/repo --force
```

## Repo Layout

- `apps/factoryd`: long-running supervisor daemon.
- `apps/factoryctl`: bootstrap and operator CLI.
- `apps/factory-manager-mcp`: MCP bridge exposing manager tools over HTTP.
- `packages/runtime`: filesystem, git, env, port, schema, Telegram, and utility helpers.
- `packages/db`: SQLite schema and query layer.
- `packages/config`: generated config, bootstrap artifacts, script detection, onboarding docs.
- `packages/models`: shared TypeScript types for config, tasks, agents, decisions, and results.
- `prompts/`: manager, worker, reviewer, and tester instructions.
- `schemas/`: JSON schemas for manager and worker outputs.
- `systemd/`: example service and health timer units.
- `docs/`: project spec and onboarding notes.

## Trying This Repo Itself

You can point Permafactory at this repository for a control-plane smoke test. If you do:

- Use `master` as the default branch for this repo today.
- Expect the orchestration, Telegram, task, and recovery loops to work.
- Do not expect a meaningful stable or preview web app here, because this repo is the factory itself and its generated serve scripts are placeholders.

## Current Limits

- Single-host, local-state system. No distributed scheduler.
- One repo per running supervisor instance.
- The dashboard is JSON endpoints, not a polished web UI.
- Runtime deployment depends on the managed repo having real install, build, serve, and healthcheck commands.
- Telegram is the human interface; there is no separate product-facing admin app in this repo.
- The project is designed around Codex CLI surfaces, not experimental multi-agent features.
