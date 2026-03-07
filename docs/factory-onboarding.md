# Factory Onboarding Summary

## Immediate Next Step: Telegram Bootstrap

The factory is waiting for a Telegram control chat before it can operate normally.

1. Open Telegram and start a chat with `@BotFather`.
2. Send `/newbot`.
3. Choose a display name and a bot username ending in `bot`.
4. Copy the HTTP API token from BotFather into `.env.factory` as `TELEGRAM_BOT_TOKEN=...`.
5. Easiest path: plan to use a direct message with the bot as the control chat.
6. If you prefer a shared control room, add the bot to a supergroup instead.
7. If this bot will read normal messages in a control supergroup, send `/setprivacy` in BotFather, choose this bot, and disable privacy mode.
8. Generate a webhook secret and store it as `TELEGRAM_WEBHOOK_SECRET`.

## Local Env File

Create `.env.factory` in the repo root. You can start from `.env.factory.example`.

Example:

```env
TELEGRAM_BOT_TOKEN=replace-me
TELEGRAM_WEBHOOK_SECRET=replace-me
```

Generate the webhook secret with:

```bash
openssl rand -hex 32
```

## Control Chat Binding

1. Choose one of these control chat modes.
Direct message the bot from your own Telegram account, or add the bot to a control supergroup.
2. From a shell with `.env.factory` loaded, run:

```bash
factoryctl telegram connect --repo /home/sergey/code/permafactory --bot-token-env TELEGRAM_BOT_TOKEN
```

3. Send `/hello` to the bot in your DM or in the control supergroup.
4. The CLI captures the chat id automatically; you do not need to look it up yourself.
5. If you already have the public dashboard URL, rerun with `--webhook-url https://your-host/telegram/webhook`.

## Notes

- `factoryctl telegram connect` binds the chat, records the first admin user, and can configure the production webhook.
- Until Telegram is connected, bootstrap status remains `waiting_for_telegram`.
