# Pager New Test

Testable Telegram-first MVP for the new Pager bot rebuild.

It already includes:

- separate playbooks for `ZM`, `CM`, and `EG`
- per-channel enable/disable config
- per-channel country selection
- per-channel template bank selection
- Telegram long polling bot
- local chat state storage for testing
- OCR-based screenshot classification
- proof-driven transitions based on screenshots and customer confirmations
- Telegram handoff after deposit confirmation
- live Pager account validation through imported cookies
- live channel loading from the connected Pager session
- live template-bank discovery from the connected Pager session

## Core flow

The bot is designed around one shared rule:

1. customer shows interest
2. bot sends registration instructions
3. customer sends registration screenshot or visible ID
4. bot sends deposit instructions
5. customer sends screenshot with balance on the gaming account
6. bot sends the Telegram link and moves to the post-deposit stage

Status changes must happen only after customer confirmation or proof, not only because the bot sent a reply.

## What is already testable

You can already test the logic through Telegram without Pager API:

- start the bot with your Telegram token
- choose a channel/playbook with `/channels`
- toggle channel on/off, switch country, and pick a bank directly in the channel row
- green/red channel toggles with in-place menu updates (no duplicate menus)
- send text messages to trigger text rules
- send screenshots to trigger OCR proof classification
- inspect the current test state with `/status`

This makes the project useful before the Pager session/API layer is connected.

You can now also test a real Pager session:

- open `Pager аккаунт`
- choose `Импорт cookies`
- paste your Pager cookies in one line
- the bot validates the session against `/api/channel`
- after success, `Каналы` switches to the real live channel list from that account
- if Pager returns saved-reply folders, the bank button in each channel row uses those real folders

## Environment variables

Create `.env` from `.env.example`:

```env
TELEGRAM_BOT_TOKEN=put_your_botfather_token_here
TELEGRAM_BOT_NAME=Pager Test Bot
PAGER_BASE_URL=https://www.pager.co.ua
BOT_CONFIG_PATH=config/bot.config.yaml
BOT_STATE_PATH=data/chat-state.json
OCR_ENABLED=true
OCR_LANG=eng
POLL_INTERVAL_MS=2000
```

Notes:

- `TELEGRAM_BOT_TOKEN` is required
- `OCR_LANG=eng` is the safest starting point
- if you want to experiment with Arabic/French OCR later, you can try values like `eng+ara+fra`
- local chat state is stored in `data/chat-state.json`

## Telegram commands

- `/start` - show the quick usage summary
- `/channels` - choose the channel/playbook to test
- `/status` - show current chat state
- `/reset` - reset the local state for this Telegram chat

## Pager account status

At the moment:

- `cookies` auth is live and validated against real Pager API
- `email + password` auth is live and validated against real Pager API
- the bot loads saved-reply folders from Pager `/api/reply/folder` and replies from `/api/reply`
- if a specific account does not expose those endpoints in the current session, the bot falls back to country defaults from config

## Screenshot logic

Supported proof types:

- `registration_screenshot`
- `id_screenshot`
- `deposit_balance_screenshot`
- `unclear_screenshot`

Expected behavior:

- registration or ID proof -> move to registration-confirmed or deposit stage
- deposit/balance proof -> send Telegram handoff template
- unclear screenshot -> ask for a clearer image and do not advance

Current OCR logic uses text found in the screenshot plus Telegram caption text if present. For early testing, captions like `id`, `client`, `balance`, or `deposit` help the classifier a lot.

## Project structure

- `config/bot.config.yaml` - channel config, status mapping, template banks, country playbooks
- `src/config.ts` - strict config schema with `zod`
- `src/decision-engine.ts` - next-action logic for text and screenshot proofs
- `src/proof-classifier.ts` - OCR-based proof detection
- `src/telegram-api.ts` - raw Telegram Bot API wrapper
- `src/state-store.ts` - local per-chat testing state
- `src/index.ts` - bot runtime

## Run

```bash
npm install
npm run check
npm run build
npm run dev
```

## Next implementation steps

1. connect real Pager API polling for conversations and messages
2. inspect real Pager image attachments instead of Telegram-only screenshots
3. wire status changes back to Pager API using real status IDs
4. send actual Pager saved replies by folder/reply id instead of only selecting the bank name
