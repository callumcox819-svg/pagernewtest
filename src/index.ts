import { resolve } from "node:path";
import {
  getChannelConfig,
  getDefaultEnabledChannel,
  getPlaybook,
  loadConfig,
} from "./config.js";
import { ClerkPasswordAuthClient } from "./clerk-auth.js";
import { decideNextAction } from "./decision-engine.js";
import { loadEnv } from "./env.js";
import { PagerClient } from "./pager-client.js";
import { classifyProofFromImage } from "./proof-classifier.js";
import { StateStore, type ChatState } from "./state-store.js";
import {
  TelegramApi,
  buildChannelKeyboard,
  buildCountryKeyboard,
  buildMainMenuKeyboard,
  buildPagerAccountKeyboard,
  buildTemplateKeyboard,
  type TelegramMessage,
  type TelegramUpdate,
} from "./telegram-api.js";

const COUNTRY_FOLDER_HINTS: Record<"ZM" | "CM" | "EG", string[]> = {
  ZM: ["замб", "zamb", "zambia"],
  EG: ["егип", "egypt", "hapka"],
  CM: ["камер", "cameroon"],
};

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
    const messageId = update.callback_query.message.message_id;
    await handleCallback(chatId, update.callback_query.id, update.callback_query.data, messageId);
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
  messageId?: number,
) {
  if (!data) {
    await telegram.answerCallbackQuery(callbackId, "No callback data");
    return;
  }

  const state = getOrCreateState(chatId);
  const [kind, value, extra] = data.split(":");

  if (kind === "channels") {
    await telegram.answerCallbackQuery(callbackId);
    if (value === "back" || value === "refresh") {
      const nextState =
        value === "refresh" ? (await refreshPagerData(chatId, state)) ?? state : state;
      await showChannelsMenu(chatId, nextState, messageId);
      return;
    }
  }

  if (kind === "channel_toggle" && value) {
    const channel = resolveChannelForState(state, value);
    if (!channel) {
      await telegram.answerCallbackQuery(callbackId, "Channel not found");
      return;
    }

    const runtime = getChannelRuntime(state, channel.id, channel.country);
    const nextEnabled = !runtime.enabled;
    stateStore.patch(chatId, {
      channels: {
        ...(state.channels ?? {}),
        [channel.id]: {
          ...runtime,
          enabled: nextEnabled,
        },
      },
    });
    const nextState = stateStore.get(chatId) ?? state;
    await telegram.answerCallbackQuery(callbackId, nextEnabled ? "🟢 Включено" : "🔴 Выключено");
    if (messageId) {
      await telegram.editMessageReplyMarkup(
        chatId,
        messageId,
        buildChannelKeyboard(getSelectableChannels(nextState)),
      );
    }
    return;
  }

  if (kind === "channel_country" && value) {
    const channel = resolveChannelForState(state, value);
    if (!channel) {
      await telegram.answerCallbackQuery(callbackId, "Channel not found");
      return;
    }

    await telegram.answerCallbackQuery(callbackId);
    if (messageId) {
      await telegram.editMessageText(
        chatId,
        messageId,
        `Выбери страну для ${channel.name}:`,
        buildCountryKeyboard(channel.id),
      );
    }
    return;
  }

  if (kind === "country_pick" && value && extra) {
    const country = extra as "ZM" | "CM" | "EG";
    const runtime = getChannelRuntime(state, value, country);
    const bank = pickTemplateBankFromLiveBanks(getLiveTemplateBanks(state), country);
    stateStore.patch(chatId, {
      channels: {
        ...(state.channels ?? {}),
        [value]: {
          ...runtime,
          country,
          templateBank: bank?.name ?? runtime.templateBank,
          templateBankId: bank?.id ?? runtime.templateBankId,
        },
      },
    });
    const nextState = stateStore.get(chatId) ?? state;
    await telegram.answerCallbackQuery(callbackId, `Страна: ${country}`);
    await showChannelsMenu(chatId, nextState, messageId);
    return;
  }

  if (kind === "channel_bank" && value) {
    const channel = resolveChannelForState(state, value);
    if (!channel) {
      await telegram.answerCallbackQuery(callbackId, "Channel not found");
      return;
    }

    const banks = getLiveTemplateBanks(state);
    if (!banks.length) {
      await telegram.answerCallbackQuery(callbackId, "Папки не загружены — нажми Обновить");
      return;
    }

    await telegram.answerCallbackQuery(callbackId);
    if (messageId) {
      await telegram.editMessageText(
        chatId,
        messageId,
        `Выбери папку шаблонов для ${channel.name}:`,
        buildTemplateKeyboard(channel.id, banks),
      );
    }
    return;
  }

  if (kind === "template_pick" && value && extra) {
    const channel = resolveChannelForState(state, value);
    if (!channel) {
      await telegram.answerCallbackQuery(callbackId, "Channel not found");
      return;
    }

    const bank = getLiveTemplateBanks(state).find((item) => item.id === extra);
    if (!bank) {
      await telegram.answerCallbackQuery(callbackId, "Папка не найдена");
      return;
    }

    const runtime = getChannelRuntime(state, channel.id, channel.country);
    stateStore.patch(chatId, {
      channels: {
        ...(state.channels ?? {}),
        [channel.id]: {
          ...runtime,
          templateBank: bank.name,
          templateBankId: bank.id,
        },
      },
    });
    const nextState = stateStore.get(chatId) ?? state;
    await telegram.answerCallbackQuery(callbackId, `Папка: ${bank.name}`);
    await showChannelsMenu(chatId, nextState, messageId);
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
      await showChannelsMenu(chatId, state);
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
      "No rule matched this message yet. Use /status, /channels, or send a clearer text or screenshot.",
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
    await showChannelsMenu(chatId, state);
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
    "Unknown command. Available: /start, /account, /channels, /status, /reset",
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
    channels: Object.fromEntries(
      config.channels.map((item) => [
        item.id,
        {
          enabled: false,
          country: item.country,
          templateBank: `${item.country.toLowerCase()}-default`,
        },
      ]),
    ),
    updatedAt: new Date().toISOString(),
  });
}

function getEffectiveChannel(state: ChatState) {
  const channel = resolveChannelForState(state, state.channelId);
  if (!channel) {
    throw new Error(`Unknown channel in state: ${state.channelId}`);
  }

  if (!state.templateBankOverride) {
    return {
      ...channel,
      templateBank:
        state.channels?.[channel.id]?.templateBank ?? channel.templateBank,
    };
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
      const fallbackCountry = inferCountryFromName(channel.name);
      const runtime = getChannelRuntime(state, channel.id, fallbackCountry);
      return {
        id: channel.id,
        name: channel.name,
        country: runtime.country,
        enabled: runtime.enabled,
        templateBank: runtime.templateBank ?? "Шаблоны",
      };
    });
  }

  return config.channels.map((channel) => {
    const runtime = getChannelRuntime(state, channel.id, channel.country);
    return {
      id: channel.id,
      name: channel.name,
      country: runtime.country,
      enabled: runtime.enabled,
      templateBank: runtime.templateBank ?? `${channel.country.toLowerCase()}-default`,
    };
  });
}

function getLiveTemplateBanks(state: ChatState) {
  return state.pagerAccount?.liveTemplateBanks ?? [];
}

function getChannelRuntime(
  state: ChatState,
  channelId: string,
  fallbackCountry: "ZM" | "CM" | "EG",
) {
  const existing = state.channels?.[channelId];
  if (existing) {
    return existing;
  }

  const bank = pickTemplateBankFromLiveBanks(getLiveTemplateBanks(state), fallbackCountry);
  return {
    enabled: false,
    country: fallbackCountry,
    templateBank: bank?.name,
    templateBankId: bank?.id,
  };
}

function pickTemplateBankFromLiveBanks(
  banks: Array<{ id: string; name: string }>,
  country: "ZM" | "CM" | "EG",
) {
  if (!banks.length) {
    return undefined;
  }

  const hints = COUNTRY_FOLDER_HINTS[country];
  const matched = banks.find((bank) => {
    const normalized = bank.name.toLowerCase();
    return hints.some((hint) => normalized.includes(hint));
  });
  return matched ?? banks[0];
}

function buildChannelRuntimeMap(
  channels: Array<{ id: string; name: string }>,
  templateBanks: Array<{ id: string; name: string }>,
) {
  return Object.fromEntries(
    channels.map((channel) => {
      const country = inferCountryFromName(channel.name);
      const bank = pickTemplateBankFromLiveBanks(templateBanks, country);
      return [
        channel.id,
        {
          enabled: false,
          country,
          templateBank: bank?.name,
          templateBankId: bank?.id,
        },
      ];
    }),
  );
}

async function showChannelsMenu(chatId: number, state: ChatState, messageId?: number) {
  const text =
    "Слева 🟢/🔴 — вкл/выкл (по умолчанию все выкл), по центру страна, справа папка шаблонов.";
  const keyboard = buildChannelKeyboard(getSelectableChannels(state));

  if (messageId) {
    try {
      await telegram.editMessageText(chatId, messageId, text, keyboard);
      return;
    } catch {
      // fall through to a fresh message
    }
  }

  await telegram.sendMessage(chatId, text, keyboard);
}

async function refreshPagerData(chatId: number, state: ChatState): Promise<ChatState | undefined> {
  const cookies = state.pagerAccount?.cookies;
  if (!cookies) {
    return state;
  }

  try {
    const session = await buildPagerClient(
      cookies,
      state.pagerAccount?.organizationId,
    ).validateSession();
    const defaults = buildChannelRuntimeMap(
      session.channels.map((channel) => ({ id: channel.id, name: channel.name })),
      session.templateBanks.map((bank) => ({ id: bank.id, name: bank.name })),
    );
    const mergedChannels = { ...defaults, ...(state.channels ?? {}) };

    return stateStore.patch(chatId, {
      pagerAccount: {
        ...(state.pagerAccount ?? { authMode: "cookies", connectedAt: new Date().toISOString() }),
        organizationId: session.organizationId,
        organizationName: session.organizationName,
        liveChannels: session.channels.map((channel) => ({
          id: channel.id,
          name: channel.name,
          channelSource: channel.channelSource,
        })),
        liveTemplateBanks: session.templateBanks.map((bank) => ({
          id: bank.id,
          name: bank.name,
          replyCount: bank.replyCount,
        })),
      },
      channels: mergedChannels,
    });
  } catch (error) {
    console.error("refreshPagerData failed:", error);
    return state;
  }
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
    enabled: getChannelEnabled(state, live.id),
    country: getChannelCountry(state, live.id, country),
    templateBank:
      state.channels?.[live.id]?.templateBank ??
      pickTemplateBankFromLiveBanks(getLiveTemplateBanks(state), country)?.name ??
      "Шаблоны",
    statusMap: getDefaultEnabledChannel(config).statusMap,
    isLive: true,
  };
}

function getChannelEnabled(state: ChatState, channelId: string): boolean {
  return state.channels?.[channelId]?.enabled ?? false;
}

function getChannelCountry(
  state: ChatState,
  channelId: string,
  fallback: "ZM" | "CM" | "EG",
): "ZM" | "CM" | "EG" {
  return state.channels?.[channelId]?.country ?? fallback;
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

function buildPagerClient(cookieHeader: string, orgId?: string) {
  return new PagerClient({
    baseUrl: env.PAGER_BASE_URL,
    cookieHeader,
    orgId,
    locale: "uk",
  });
}

function buildClerkAuthClient() {
  return new ClerkPasswordAuthClient({
    frontendApi: "clerk.pager.co.ua",
  });
}

function buildCookieHeaderFromJwt(jwt: string) {
  const clientUat = Math.floor(Date.now() / 1000);
  return `__session=${jwt}; __client_uat=${clientUat}`;
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
    try {
      const email = state.draftPagerEmail?.trim();
      if (!email) {
        throw new Error("Pager email is missing. Start the login flow again.");
      }

      const jwt = await buildClerkAuthClient().signInWithPassword(email, text.trim());
      const cookieHeader = buildCookieHeaderFromJwt(jwt);
      const session = await buildPagerClient(cookieHeader).validateSession();

      stateStore.patch(chatId, {
        pendingAction: undefined,
        pagerAccount: {
          authMode: "credentials",
          email,
          password: text.trim(),
          cookies: cookieHeader,
          organizationId: session.organizationId,
          organizationName: session.organizationName,
          liveChannels: session.channels.map((channel) => ({
            id: channel.id,
            name: channel.name,
            channelSource: channel.channelSource,
          })),
          liveTemplateBanks: session.templateBanks.map((bank) => ({
            id: bank.id,
            name: bank.name,
            replyCount: bank.replyCount,
          })),
          connectedAt: new Date().toISOString(),
        },
        channels: buildChannelRuntimeMap(
          session.channels.map((channel) => ({ id: channel.id, name: channel.name })),
          session.templateBanks.map((bank) => ({ id: bank.id, name: bank.name })),
        ),
        draftPagerEmail: undefined,
      });

      await telegram.sendMessage(
        chatId,
        [
          "Pager аккаунт подключён через email + пароль.",
          `Email: ${maskEmail(email)}`,
          `Организация: ${session.organizationName ?? session.organizationId ?? "unknown"}`,
          `Каналов найдено: ${session.channelCount}`,
          `Банков шаблонов: ${session.templateBanks.length}`,
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
        `Не удалось войти по email + пароль: ${formatError(error)}`,
        buildPagerAccountKeyboard(false),
      );
    }
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
          liveTemplateBanks: session.templateBanks.map((bank) => ({
            id: bank.id,
            name: bank.name,
            replyCount: bank.replyCount,
          })),
          connectedAt: new Date().toISOString(),
        },
        channels: buildChannelRuntimeMap(
          session.channels.map((channel) => ({ id: channel.id, name: channel.name })),
          session.templateBanks.map((bank) => ({ id: bank.id, name: bank.name })),
        ),
        draftPagerEmail: undefined,
      });
      await telegram.sendMessage(
        chatId,
        [
          "Cookies сохранены и проверены.",
          `Организация: ${session.organizationName ?? session.organizationId ?? "unknown"}`,
          `Каналов найдено: ${session.channelCount}`,
          `Банков шаблонов: ${session.templateBanks.length}`,
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
      `Банк шаблонов: ${state.templateBankOverride ?? effectiveChannel.templateBank}`,
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
        account.liveTemplateBanks?.length
          ? `Банки шаблонов: ${account.liveTemplateBanks.length}`
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
