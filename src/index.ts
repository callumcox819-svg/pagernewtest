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
import { PagerClient } from "./pager-client.js";
import { classifyProofFromImage } from "./proof-classifier.js";
import { StateStore, type ChatState } from "./state-store.js";
import {
  TelegramApi,
  buildChannelKeyboard,
  buildMainMenuKeyboard,
  buildPagerAccountKeyboard,
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
    const channel = resolveChannelForState(state, value);
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
      [
        `Selected channel: ${channel.name}`,
        `Country: ${channel.country}`,
        `Template bank: ${channel.templateBank}`,
        channel.isLive ? "Source: live Pager account" : "Source: local config",
      ].join("\n"),
      buildMainMenuKeyboard(),
    );
    return;
  }

  if (kind === "template" && value) {
    stateStore.patch(chatId, { templateBankOverride: value });
    await telegram.answerCallbackQuery(callbackId, `Template bank: ${value}`);
    await telegram.sendMessage(
      chatId,
      `Template bank override set to: ${value}`,
      buildMainMenuKeyboard(),
    );
    return;
  }

  if (kind === "stage" && value) {
    stateStore.patch(chatId, { currentStage: value as ChatState["currentStage"] });
    await telegram.answerCallbackQuery(callbackId, `Stage: ${value}`);
    await telegram.sendMessage(
      chatId,
      `Current stage manually set to: ${value}`,
      buildMainMenuKeyboard(),
    );
    return;
  }

  if (kind === "menu") {
    await telegram.answerCallbackQuery(callbackId);

    if (value === "main") {
      await sendMainMenu(chatId, state);
      return;
    }

    if (value === "pager_account") {
      await sendPagerAccountMenu(chatId, state);
      return;
    }

    if (value === "channels") {
      await telegram.sendMessage(
        chatId,
        "Choose the channel to test:",
        buildChannelKeyboard(getSelectableChannels(state)),
      );
      return;
    }

    if (value === "templates") {
      const effectiveChannel = getEffectiveChannel(state);
      await telegram.sendMessage(
        chatId,
        `Choose the template bank override for ${effectiveChannel.name}:`,
        buildTemplateKeyboard(getTemplateOptionsForChannel(effectiveChannel.country)),
      );
      return;
    }

    if (value === "stages") {
      await telegram.sendMessage(
        chatId,
        "Choose the current stage:",
        buildStageKeyboard([...STAGES]),
      );
      return;
    }

    if (value === "status") {
      await sendStatus(chatId, state);
      return;
    }

    if (value === "reset") {
      stateStore.delete(chatId);
      const nextState = getOrCreateState(chatId);
      await telegram.sendMessage(
        chatId,
        `State reset.\nChannel: ${getEffectiveChannel(nextState).name}\nStage: ${nextState.currentStage}`,
        buildMainMenuKeyboard(),
      );
      return;
    }
  }

  if (kind === "pager") {
    await telegram.answerCallbackQuery(callbackId);

    if (value === "login_password") {
      stateStore.patch(chatId, {
        pendingAction: "await_pager_email",
        draftPagerEmail: undefined,
      });
      await telegram.sendMessage(
        chatId,
        "Введи email от Pager аккаунта следующим сообщением.",
      );
      return;
    }

    if (value === "import_cookies") {
      stateStore.patch(chatId, {
        pendingAction: "await_pager_cookies",
        draftPagerEmail: undefined,
      });
      await telegram.sendMessage(
        chatId,
        "Отправь cookies одной строкой следующим сообщением.",
      );
      return;
    }

    if (value === "disconnect") {
      stateStore.patch(chatId, {
        pagerAccount: undefined,
        pendingAction: undefined,
        draftPagerEmail: undefined,
      });
      await telegram.sendMessage(
        chatId,
        "Pager аккаунт очищен из локального состояния бота.",
        buildPagerAccountKeyboard(false),
      );
      return;
    }

    if (value === "back") {
      await sendMainMenu(chatId, state);
      return;
    }
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

  if (message.text && state.pendingAction) {
    const handled = await handlePendingInput(chatId, state, message.text);
    if (handled) {
      return;
    }
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
        buildMainMenuKeyboard(),
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
      buildMainMenuKeyboard(),
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
      buildMainMenuKeyboard(),
    );
    return;
  }

  stateStore.patch(chatId, { currentStage: decision.nextStage });
  await telegram.sendMessage(
    chatId,
    `Rule matched.\nNext stage: ${decision.nextStage}\nReason: ${decision.reason}`,
    buildMainMenuKeyboard(),
  );
  if (decision.templateToSend) {
    await telegram.sendMessage(chatId, decision.templateToSend);
  }
}

async function handleCommand(chatId: number, commandText: string, state: ChatState) {
  const command = commandText.trim();
  const effectiveChannel = getEffectiveChannel(state);

  if (command === "/start") {
    await sendMainMenu(chatId, state);
    return;
  }

  if (command === "/channels") {
    await telegram.sendMessage(
      chatId,
      "Choose the channel to test:",
      buildChannelKeyboard(getSelectableChannels(state)),
    );
    return;
  }

  if (command === "/templates") {
    const effectiveChannel = getEffectiveChannel(state);
    await telegram.sendMessage(
      chatId,
      `Choose the template bank override for ${effectiveChannel.name}:`,
      buildTemplateKeyboard(getTemplateOptionsForChannel(effectiveChannel.country)),
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
      buildMainMenuKeyboard(),
    );
    return;
  }

  if (command === "/status") {
    await sendStatus(chatId, state);
    return;
  }

  if (command === "/account") {
    await sendPagerAccountMenu(chatId, state);
    return;
  }

  await telegram.sendMessage(
    chatId,
    "Unknown command. Available: /start, /account, /channels, /templates, /stages, /status, /reset",
    buildMainMenuKeyboard(),
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
  const channel = resolveChannelForState(state, state.channelId);
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

function getSelectableChannels(state: ChatState) {
  const liveChannels = state.pagerAccount?.liveChannels ?? [];
  if (liveChannels.length > 0) {
    return liveChannels.map((channel) => {
      const mapped = getChannelConfig(config, channel.id);
      return {
        id: channel.id,
        name: channel.name,
        country: mapped?.country ?? inferCountryFromName(channel.name),
        enabled: true,
      };
    });
  }

  return config.channels;
}

function getTemplateOptionsForChannel(country: string) {
  const exactMatches = config.templateBanks
    .map((bank) => bank.name)
    .filter((name) => name.startsWith(country.toLowerCase()));

  return exactMatches.length > 0
    ? exactMatches
    : config.templateBanks.map((bank) => bank.name);
}

function resolveChannelForState(state: ChatState, channelId: string) {
  const mapped = getChannelConfig(config, channelId);
  if (mapped) {
    return { ...mapped, isLive: false };
  }

  const live = state.pagerAccount?.liveChannels?.find((channel) => channel.id === channelId);
  if (!live) {
    return undefined;
  }

  const country = inferCountryFromName(live.name);
  return {
    id: live.id,
    name: live.name,
    enabled: true,
    country,
    templateBank: `${country.toLowerCase()}-default`,
    statusMap: getDefaultEnabledChannel(config).statusMap,
    isLive: true,
  };
}

function inferCountryFromName(name: string): "ZM" | "CM" | "EG" {
  const normalized = name.toLowerCase();
  if (/mahmoud|anas|ahmad|moulaye|egypt|eg/.test(normalized)) {
    return "EG";
  }
  if (/moukoko|ndzi|ekambi|cameroon|cm|tchouameni/.test(normalized)) {
    return "CM";
  }
  return "ZM";
}

function buildPagerClient(cookieHeader: string) {
  return new PagerClient({
    baseUrl: env.PAGER_BASE_URL,
    cookieHeader,
  });
}

function sleep(ms: number) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function handlePendingInput(
  chatId: number,
  state: ChatState,
  text: string,
): Promise<boolean> {
  if (state.pendingAction === "await_pager_email") {
    stateStore.patch(chatId, {
      draftPagerEmail: text.trim(),
      pendingAction: "await_pager_password",
    });
    await telegram.sendMessage(chatId, "Теперь отправь пароль от Pager аккаунта.");
    return true;
  }

  if (state.pendingAction === "await_pager_password") {
    const nextState = stateStore.patch(chatId, {
      pendingAction: undefined,
      pagerAccount: {
        authMode: "credentials",
        email: state.draftPagerEmail,
        password: text.trim(),
        connectedAt: new Date().toISOString(),
      },
      draftPagerEmail: undefined,
    });

    await telegram.sendMessage(
      chatId,
      [
        "Pager аккаунт сохранен.",
        `Email: ${maskEmail(nextState?.pagerAccount?.email)}`,
        "Режим: email + пароль",
      ].join("\n"),
      buildPagerAccountKeyboard(true),
    );
    return true;
  }

  if (state.pendingAction === "await_pager_cookies") {
    try {
      const session = await buildPagerClient(text.trim()).validateSession();
      stateStore.patch(chatId, {
        pendingAction: undefined,
        pagerAccount: {
          authMode: "cookies",
          cookies: text.trim(),
          organizationId: session.organizationId,
          organizationName: session.organizationName,
          liveChannels: session.channels.map((channel) => ({
            id: channel.id,
            name: channel.name,
            channelSource: channel.channelSource,
          })),
          connectedAt: new Date().toISOString(),
        },
        draftPagerEmail: undefined,
      });
      await telegram.sendMessage(
        chatId,
        [
          "Cookies сохранены и проверены.",
          `Организация: ${session.organizationName ?? session.organizationId ?? "unknown"}`,
          `Каналов найдено: ${session.channelCount}`,
          "Теперь кнопка `Каналы` будет показывать живые каналы аккаунта.",
        ].join("\n"),
        buildPagerAccountKeyboard(true),
      );
    } catch (error) {
      stateStore.patch(chatId, {
        pendingAction: undefined,
        draftPagerEmail: undefined,
      });
      await telegram.sendMessage(
        chatId,
        `Не удалось авторизовать cookies: ${formatError(error)}`,
        buildPagerAccountKeyboard(false),
      );
    }
    return true;
  }

  return false;
}

async function sendMainMenu(chatId: number, state: ChatState) {
  const effectiveChannel = getEffectiveChannel(state);
  await telegram.sendMessage(
    chatId,
    [
      "Pager test bot is running.",
      `Канал: ${effectiveChannel.name} | ${effectiveChannel.country}`,
      `Шаблоны: ${state.templateBankOverride ?? effectiveChannel.templateBank}`,
      `Этап: ${state.currentStage}`,
      `Pager: ${state.pagerAccount?.organizationName ?? (state.pagerAccount ? "connected" : "not connected")}`,
      "Выбери нужное действие кнопками ниже.",
    ].join("\n"),
    buildMainMenuKeyboard(),
  );
}

async function sendPagerAccountMenu(chatId: number, state: ChatState) {
  const account = state.pagerAccount;
  const lines = account
    ? [
        "Pager аккаунт подключён",
        `Режим: ${account.authMode === "credentials" ? "email + пароль" : "cookies"}`,
        account.email ? `Email: ${maskEmail(account.email)}` : undefined,
        account.organizationName
          ? `Org: ${account.organizationName}`
          : account.organizationId
            ? `Org ID: ${account.organizationId}`
            : undefined,
        account.liveChannels?.length
          ? `Каналы: ${account.liveChannels.length}`
          : undefined,
        `Подключен: ${new Date(account.connectedAt).toLocaleString("ru-RU")}`,
      ].filter(Boolean)
    : [
        "Pager аккаунт не подключён",
        "Можно войти через email + пароль или сохранить cookies.",
        "Для реального live-подключения сейчас уже работает вариант через cookies.",
      ];

  await telegram.sendMessage(
    chatId,
    lines.join("\n"),
    buildPagerAccountKeyboard(Boolean(account)),
  );
}

async function sendStatus(chatId: number, state: ChatState) {
  const effectiveChannel = getEffectiveChannel(state);
  await telegram.sendMessage(
    chatId,
    [
      `Channel: ${effectiveChannel.name}`,
      `Country: ${effectiveChannel.country}`,
      `Stage: ${state.currentStage}`,
      `Template bank: ${state.templateBankOverride ?? effectiveChannel.templateBank}`,
      `Pager account: ${state.pagerAccount ? "saved" : "not connected"}`,
      `Live channels: ${state.pagerAccount?.liveChannels?.length ?? 0}`,
      `Pending action: ${state.pendingAction ?? "none"}`,
    ].join("\n"),
    buildMainMenuKeyboard(),
  );
}

function maskEmail(email?: string): string {
  if (!email) {
    return "unknown";
  }

  const [name, domain] = email.split("@");
  if (!domain) {
    return email;
  }

  if (name.length <= 2) {
    return `${name[0] ?? "*"}*@${domain}`;
  }

  return `${name.slice(0, 2)}***@${domain}`;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

main().catch((error) => {
  console.error("Fatal bot error:", error);
  process.exit(1);
});
