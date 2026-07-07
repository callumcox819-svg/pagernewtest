# Pager New Test

Clean foundation for a new Pager bot with:

- separate playbooks for `ZM`, `CM`, and `EG`
- per-channel enable/disable toggles
- per-channel country selection
- per-channel template bank selection
- proof-driven transitions based on screenshots and customer confirmations
- Telegram handoff after deposit confirmation

## Core flow

The bot is designed around one shared rule:

1. customer shows interest
2. bot sends registration instructions
3. customer sends registration screenshot or visible ID
4. bot sends deposit instructions
5. customer sends screenshot with balance on the gaming account
6. bot sends the Telegram link and moves to the post-deposit stage

Status changes must happen only after customer confirmation or proof, not only because the bot sent a reply.

## Project structure

- `config/bot.config.yaml` - channel config, status mapping, template banks, country playbooks
- `src/config.ts` - strict config schema with `zod`
- `src/decision-engine.ts` - next-action logic for text and screenshot proofs
- `src/index.ts` - small runnable demo

## Config highlights

Each channel defines:

- `enabled`
- `country`
- `templateBank`
- `statusMap`

This matches the desired UI model where the operator can:

- toggle the channel on or off
- choose the country/playbook
- choose the saved-reply bank separately

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

## Commands

```bash
npm install
npm run check
npm run build
npm run dev
```

## Next implementation steps

1. connect real Pager API polling for conversations and messages
2. bind real saved replies from Pager instead of static template text
3. add screenshot inspection from real message attachments
4. wire status changes back to Pager API using real status IDs
5. add an operator UI for channel toggle, country selector, and template bank selector
