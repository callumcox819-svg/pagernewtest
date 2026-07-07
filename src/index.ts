import { resolve } from "node:path";
import {
  STAGES,
  getChannelConfig,
  getDefaultEnabledChannel,
  getPlaybook,
  loadConfig,
} from "./config.js";
import { decideNextAction } from "./decision-engine.js";
import { loadEnv } from "./env.js";
import { classifyProofFromImage } from "./proof-classifier.js";
import { StateStore, type ChatState } from "./state-store.js";
import {
  TelegramApi,
  buildChannelKeyboard,
  buildStageKeyboard,
  buildTemplateKeyboard,
  type TelegramMessage,
  type TelegramUpdate,
} from "./telegram-api.js";

const env = loadEnv();
const config = loadConfig(resolve(process.cwd(), env.BOT_CONFIG_PATH));
const stateStore = new StateStore(resolve(process.cwd(), env.BOT_STATE_PATH));
const telegram = new TelegramApi(env.TELEGRAM_BOT_TOKEN);

async function main() {
  console.log(`Starting ${env.TELEGRAM_BOT_NAME}...`);
  let offset: number | undefined;

  while (true) {
    try {
      const updates = await telegram.getUpdates(offset);
      for (const update of updates) {
        offset = update.update_id + 1;
        await handleUpdate(update);
      }
    } catch (error) {
      console.error("Polling error:", error);
      await sleep(env.POLL_INTERVAL_MS);
    }
  }
}

async function handleUpdate(update: TelegramUpdate) {
  if (update.callback_query?.message?.chat.id) {
    const chatId = update.callback_query.message.chat.id;
    await handleCallback(chatId, update.callback_query.id, update.callback_query.data);
    return;
  }

  if (update.message) {
    await handleMessage(update.message);
  }
}

async function handleCallback(
  chatId: number,
  callbackId: string,
  data?: string,
) {
  if (!data) {
    await telegram.answerCallbackQuery(callbackId, "No callback data");
    return;
  }

  const state = getOrCreateState(chatId);
  const [kind, value] = data.split(":");

  if (kind === "channel" && value) {
    const channel = getChannelConfig(config, value);
    if (!channel) {
      await telegram.answerCallbackQuery(callbackId, "Channel not found");
      return;
    }

    stateStore.patch(chatId, {
      channelId: channel.id,
      templateBankOverride: undefined,
    });
    await telegram.answerCallbackQuery(callbackId, `Channel: ${channel.name}`);
    await telegram.sendMessage(
      chatId,
      `Selected channel: ${channel.name}\nCountry: ${channel.country}\nTemplate bank: ${channel.templateBank}`,
    );
    return;
  }

  if (kind === "template" && value) {
    stateStore.patch(chatId, { templateBankOverride: value });
    await telegram.answerCallbackQuery(callbackId, `Template bank: ${value}`);
    await telegram.sendMessage(chatId, `Template bank override set to: ${value}`);
    return;
  }

  if (kind === "stage" && value) {
    stateStore.patch(chatId, { currentStage: value as ChatState["currentStage"] });
    await telegram.answerCallbackQuery(callbackId, `Stage: ${value}`);
    await telegram.sendMessage(chatId, `Current stage manually set to: ${value}`);
    return;
  }

  await telegram.answerCallbackQuery(callbackId, "Unhandled action");
}

async function handleMessage(message: TelegramMessage) {
  const chatId = message.chat.id;
  const state = getOrCreateState(chatId);

  if (message.text?.startsWith("/")) {
    await handleCommand(chatId, message.text, state);
    return;
  }

  const effectiveChannel = getEffectiveChannel(state);
  const playbook = getPlaybook(config, effectiveChannel.country);

  if (message.photo?.length) {
    const largestPhoto = [...message.photo].sort(
      (left, right) => (right.file_size ?? 0) - (left.file_size ?? 0),
    )[0];

    const file = await telegram.getFile(largestPhoto.file_id);
    if (!file.file_path) {
      await telegram.sendMessage(chatId, "Could not fetch Telegram image file.");
      return;
    }

    const image = await telegram.downloadFile(file.file_path, env.TELEGRAM_BOT_TOKEN);
    const classification = await classifyProofFromImage(playbook, image, {
      caption: message.caption,
      ocrEnabled: env.OCR_ENABLED,
      ocrLang: env.OCR_LANG,
    });

    const decision = decideNextAction(config, effectiveChannel, {
      channelId: effectiveChannel.id,
      currentStage: state.currentStage,
      latestCustomerText: message.caption,
      proofKind: classification.proofKind,
    });

    if (!decision) {
      await telegram.sendMessage(
        chatId,
        [
          `Screenshot classified as: ${classification.proofKind}`,
          `Reason: ${classification.reason}`,
          "No next action matched. Use /status or /stages if you want to adjust the flow manually.",
        ].join("\n"),
      );
      return;
    }

    stateStore.patch(chatId, { currentStage: decision.nextStage });
    await telegram.sendMessage(
      chatId,
      [
        `Screenshot classified as: ${classification.proofKind}`,
        `Reason: ${classification.reason}`,
        `Next stage: ${decision.nextStage}`,
        `Decision reason: ${decision.reason}`,
      ].join("\n"),
    );

    if (decision.templateToSend) {
      await telegram.sendMessage(chatId, decision.templateToSend);
    }
    return;
  }

  const decision = decideNextAction(config, effectiveChannel, {
    channelId: effectiveChannel.id,
    currentStage: state.currentStage,
    latestCustomerText: message.text,
  });

  if (!decision) {
    await telegram.sendMessage(
      chatId,
      "No rule matched this message yet. Use /status, /channels, /templates, or send a clearer text or screenshot.",
    );
    return;
  }

  stateStore.patch(chatId, { currentStage: decision.nextStage });
  await telegram.sendMessage(
    chatId,
    `Rule matched.\nNext stage: ${decision.nextStage}\nReason: ${decision.reason}`,
  );
  if (decision.templateToSend) {
    await telegram.sendMessage(chatId, decision.templateToSend);
  }
}

async function handleCommand(chatId: number, commandText: string, state: ChatState) {
  const command = commandText.trim();
  const effectiveChannel = getEffectiveChannel(state);

  if (command === "/start") {
    await telegram.sendMessage(
      chatId,
      [
        "Pager test bot is running.",
        "Use /channels to choose a channel, /templates to override template bank, /stages to set a stage, /status to inspect current state.",
        "Then send text or a screenshot to test the flow.",
      ].join("\n"),
    );
    return;
  }

  if (command === "/channels") {
    await telegram.sendMessage(
      chatId,
      "Choose the channel to test:",
      buildChannelKeyboard(config.channels),
    );
    return;
  }

  if (command === "/templates") {
    await telegram.sendMessage(
      chatId,
      "Choose the template bank override:",
      buildTemplateKeyboard(config.templateBanks.map((bank) => bank.name)),
    );
    return;
  }

  if (command === "/stages") {
    await telegram.sendMessage(
      chatId,
      "Choose the current stage:",
      buildStageKeyboard([...STAGES]),
    );
    return;
  }

  if (command === "/reset") {
    stateStore.delete(chatId);
    const nextState = getOrCreateState(chatId);
    await telegram.sendMessage(
      chatId,
      `State reset.\nChannel: ${getEffectiveChannel(nextState).name}\nStage: ${nextState.currentStage}`,
    );
    return;
  }

  if (command === "/status") {
    await telegram.sendMessage(
      chatId,
      [
        `Channel: ${effectiveChannel.name}`,
        `Country: ${effectiveChannel.country}`,
        `Stage: ${state.currentStage}`,
        `Template bank: ${state.templateBankOverride ?? effectiveChannel.templateBank}`,
      ].join("\n"),
    );
    return;
  }

  await telegram.sendMessage(
    chatId,
    "Unknown command. Available: /start, /channels, /templates, /stages, /status, /reset",
  );
}

function getOrCreateState(chatId: number): ChatState {
  const existing = stateStore.get(chatId);
  if (existing) {
    return existing;
  }

  const channel = getDefaultEnabledChannel(config);
  return stateStore.upsert({
    chatId,
    channelId: channel.id,
    currentStage: "new_lead",
    updatedAt: new Date().toISOString(),
  });
}

function getEffectiveChannel(state: ChatState) {
  const channel = getChannelConfig(config, state.channelId);
  if (!channel) {
    throw new Error(`Unknown channel in state: ${state.channelId}`);
  }

  if (!state.templateBankOverride) {
    return channel;
  }

  return {
    ...channel,
    templateBank: state.templateBankOverride,
  };
}

function sleep(ms: number) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

main().catch((error) => {
  console.error("Fatal bot error:", error);
  process.exit(1);
});
