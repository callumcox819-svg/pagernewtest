import { resolve } from "node:path";
import {
  getChannelConfig,
  getDefaultEnabledChannel,
  getPlaybook,
  loadConfig,
} from "./config.js";
import { ClerkPasswordAuthClient, enrichPagerCookies, parseCookieHeader } from "./clerk-auth.js";
import { decideNextAction } from "./decision-engine.js";
import { loadEnv } from "./env.js";
import { PagerClient } from "./pager-client.js";
import { runPagerWorker } from "./pager-worker.js";
import { classifyProofFromImage } from "./proof-classifier.js";
import { clearTemplateReplyCache } from "./template-resolver.js";
import { createStateStore, type ChannelRuntimeState, type ChatState, type StateStore } from "./state-store.js";
import {
  countApiStatusFolders,
  mergeStatusFolderList,
  setAllStatusFolders,
  toggleStatusFolder,
} from "./status-folders.js";
import {
  buildPagerAccountPatch,
  ensurePagerSession,
  resolvePagerOrgSlug,
} from "./pager-session.js";
import {
  TelegramApi,
  buildChannelKeyboard,
  buildCountryKeyboard,
  buildFoldersKeyboard,
  buildFoldersRetryKeyboard,
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
let stateStore: StateStore;
const telegram = new TelegramApi(env.TELEGRAM_BOT_TOKEN);

async function main() {
  stateStore = await createStateStore(env);
  console.log(`Starting ${env.TELEGRAM_BOT_NAME}...`);
  await warmupConnectedAccounts();

  await Promise.all([
    runTelegramBot(),
    runPagerWorker({ env, config, stateStore, telegram }),
  ]);
}

async function warmupConnectedAccounts(): Promise<void> {
  const states = await stateStore.listAll();
  for (const state of states) {
    if (!state.pagerAccount?.cookies?.trim() && !(state.pagerAccount?.email && state.pagerAccount?.password)) {
      continue;
    }
    try {
      await ensurePagerSession({ env, stateStore }, state);
    } catch (error) {
      console.warn(`Startup session warmup failed for chat ${state.chatId}:`, formatError(error));
    }
  }
}

async function runTelegramBot(): Promise<never> {
  try {
    await telegram.deleteWebhook();
    console.log("Telegram: webhook cleared, using long polling");
  } catch (error) {
    console.warn("Telegram: could not delete webhook:", formatError(error));
  }

  let offset: number | undefined;

  while (true) {
    try {
      const updates = await telegram.getUpdates(offset);
      for (const update of updates) {
        offset = update.update_id + 1;
        await handleUpdate(update);
      }
    } catch (error) {
      const message = formatError(error);
      if (message.includes("409")) {
        console.warn(
          "Telegram 409 conflict — another bot instance may be running. Retrying in 10s...",
        );
        await sleep(10_000);
        continue;
      }
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

  const state = await getOrCreateState(chatId);
  const [kind, value, extra] = data.split(":");

  if (kind === "channels") {
    if (value === "all_on" || value === "all_off") {
      // handled below
    } else {
      await telegram.answerCallbackQuery(callbackId);
      if (value === "back" || value === "refresh") {
        const nextState =
          value === "refresh" ? (await refreshPagerData(chatId, state)) ?? state : state;
        await showChannelsMenu(chatId, nextState, messageId);
        return;
      }
    }
  }

  if (kind === "channel_toggle" && value) {
    const latestState = (await stateStore.get(chatId)) ?? state;
    const channel = getChannelByIndex(latestState, value);
    if (!channel) {
      await telegram.answerCallbackQuery(callbackId, "Channel not found");
      return;
    }

    const runtime = getChannelRuntime(latestState, channel.id, channel.country);
    const nextEnabled = !isChannelEnabled(latestState, channel.id, runtime.enabled);
    const nextState = await setChannelEnabled(chatId, latestState, channel.id, nextEnabled);
    await telegram.answerCallbackQuery(callbackId, nextEnabled ? "🟢 Включено" : "🔴 Выключено");
    if (messageId) {
      await telegram.editMessageReplyMarkup(
        chatId,
        messageId,
        buildChannelKeyboard(getSelectableChannels(nextState ?? latestState)),
      );
    }
    return;
  }

  if (kind === "channels" && value === "all_on") {
    const latestState = (await stateStore.get(chatId)) ?? state;
    const nextState = await setAllChannelsEnabled(chatId, latestState, true);
    await telegram.answerCallbackQuery(callbackId, "Все каналы включены");
    if (messageId) {
      await telegram.editMessageReplyMarkup(
        chatId,
        messageId,
        buildChannelKeyboard(getSelectableChannels(nextState ?? latestState)),
      );
    }
    return;
  }

  if (kind === "channels" && value === "all_off") {
    const latestState = (await stateStore.get(chatId)) ?? state;
    const nextState = await setAllChannelsEnabled(chatId, latestState, false);
    await telegram.answerCallbackQuery(callbackId, "Все каналы выключены");
    if (messageId) {
      await telegram.editMessageReplyMarkup(
        chatId,
        messageId,
        buildChannelKeyboard(getSelectableChannels(nextState ?? latestState)),
      );
    }
    return;
  }

  if (kind === "channel_country" && value) {
    const channel = getChannelByIndex(state, value);
    if (!channel) {
      await telegram.answerCallbackQuery(callbackId, "Channel not found");
      return;
    }

    await telegram.answerCallbackQuery(callbackId);
    await safeEditMenu(
      chatId,
      messageId,
      `Выбери страну для ${channel.name}:`,
      buildCountryKeyboard(Number(value)),
      callbackId,
    );
    return;
  }

  if (kind === "country_pick" && value && extra) {
    const channel = getChannelByIndex(state, value);
    if (!channel) {
      await telegram.answerCallbackQuery(callbackId, "Channel not found");
      return;
    }

    const country = extra as "ZM" | "CM" | "EG";
    const runtime = getChannelRuntime(state, channel.id, country);
    const bank = pickTemplateBankFromLiveBanks(getLiveTemplateBanks(state), country);
    await stateStore.patch(chatId, {
      channels: {
        ...(state.channels ?? {}),
        [channel.id]: {
          ...runtime,
          country,
          templateBank: bank?.name ?? runtime.templateBank,
          templateBankId: bank?.id ?? runtime.templateBankId,
        },
      },
    });
    const nextState = await stateStore.get(chatId) ?? state;
    await telegram.answerCallbackQuery(callbackId, `Страна: ${country}`);
    await showChannelsMenu(chatId, nextState, messageId);
    return;
  }

  if (kind === "channel_bank" && value) {
    const channel = getChannelByIndex(state, value);
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
    await safeEditMenu(
      chatId,
      messageId,
      `Выбери папку шаблонов для ${channel.name}:`,
      buildTemplateKeyboard(Number(value), banks),
      callbackId,
    );
    return;
  }

  if (kind === "template_pick" && value && extra) {
    const channel = getChannelByIndex(state, value);
    if (!channel) {
      await telegram.answerCallbackQuery(callbackId, "Channel not found");
      return;
    }

    const bank = getLiveTemplateBanks(state)[Number(extra)];
    if (!bank) {
      await telegram.answerCallbackQuery(callbackId, "Папка не найдена");
      return;
    }

    const runtime = getChannelRuntime(state, channel.id, channel.country);
    await stateStore.patch(chatId, {
      channels: {
        ...(state.channels ?? {}),
        [channel.id]: {
          ...runtime,
          templateBank: bank.name,
          templateBankId: bank.id,
        },
      },
    });
    const nextState = await stateStore.get(chatId) ?? state;
    await telegram.answerCallbackQuery(callbackId, `Папка: ${bank.name}`);
    await showChannelsMenu(chatId, nextState, messageId);
    return;
  }

  if (kind === "folders") {
    await telegram.answerCallbackQuery(callbackId);

    if (value === "refresh") {
      const synced = await syncStatusFolders(chatId, state);
      if (synced.error) {
        await telegram.sendMessage(chatId, `⚠️ ${synced.error}`);
      }
      await showFoldersMenu(chatId, synced.state ?? state, messageId);
      return;
    }

    if (value === "all_on" || value === "all_off") {
    const folders = setAllStatusFolders(state.statusFolders ?? [], value === "all_on");
    const nextState =
      (await stateStore.patch(chatId, {
        statusFolders: folders,
        operatorSettings: buildOperatorSettings(state, { statusFolders: folders }),
      })) ?? state;
      await showFoldersMenu(chatId, nextState, messageId);
      return;
    }
    return;
  }

  if (kind === "folder_toggle" && value) {
    const index = Number(value);
    const folders = toggleStatusFolder(state.statusFolders ?? [], index);
    const nextState =
      (await stateStore.patch(chatId, {
        statusFolders: folders,
        operatorSettings: buildOperatorSettings(state, { statusFolders: folders }),
      })) ?? state;
    await telegram.answerCallbackQuery(callbackId);
    await showFoldersMenu(chatId, nextState, messageId);
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

    if (value === "folders") {
      await showFoldersMenu(chatId, state);
      return;
    }

    if (value === "status") {
      await sendStatus(chatId, state);
      return;
    }

    if (value === "reset") {
      await stateStore.delete(chatId);
      const nextState = await getOrCreateState(chatId);
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
      await stateStore.patch(chatId, {
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
      await stateStore.patch(chatId, {
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
      await stateStore.patch(chatId, {
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
  const state = await getOrCreateState(chatId);

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

    await stateStore.patch(chatId, { currentStage: decision.nextStage });
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

  await stateStore.patch(chatId, { currentStage: decision.nextStage });
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
    await stateStore.delete(chatId);
    const nextState = await getOrCreateState(chatId);
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

async function getOrCreateState(chatId: number): Promise<ChatState> {
  const existing = await stateStore.get(chatId);
  if (existing) {
    return existing;
  }

  const channel = getDefaultEnabledChannel(config);
  return await stateStore.upsert({
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

function getChannelByIndex(state: ChatState, indexRaw: string) {
  const index = Number(indexRaw);
  if (!Number.isInteger(index) || index < 0) {
    return undefined;
  }

  const row = getSelectableChannels(state)[index];
  if (!row) {
    return undefined;
  }

  return resolveChannelForState(state, row.id);
}

async function safeEditMenu(
  chatId: number,
  messageId: number | undefined,
  text: string,
  keyboard: ReturnType<typeof buildChannelKeyboard>,
  callbackId?: string,
) {
  if (!messageId) {
    await telegram.sendMessage(chatId, text, keyboard);
    return;
  }

  try {
    await telegram.editMessageText(chatId, messageId, text, keyboard);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("message is not modified")) {
      return;
    }
    console.error("Failed to edit Telegram menu:", error);
    if (callbackId) {
      await telegram.answerCallbackQuery(callbackId, "Открываю меню заново");
    }
    await telegram.sendMessage(chatId, text, keyboard);
  }
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
        enabled: isChannelEnabled(state, channel.id, runtime.enabled),
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
      enabled: isChannelEnabled(state, channel.id, runtime.enabled),
      templateBank: runtime.templateBank ?? `${channel.country.toLowerCase()}-default`,
    };
  });
}

function isChannelEnabled(
  state: ChatState,
  channelId: string,
  runtimeEnabled = false,
): boolean {
  if (state.operatorSettings?.enabledChannelIds?.includes(channelId)) {
    return true;
  }
  if (state.enabledChannelIds?.includes(channelId)) {
    return true;
  }
  return runtimeEnabled;
}

function collectEnabledChannelIds(state: ChatState): string[] {
  const enabled = new Set(state.operatorSettings?.enabledChannelIds ?? []);
  for (const id of state.enabledChannelIds ?? []) {
    enabled.add(id);
  }
  for (const [channelId, runtime] of Object.entries(state.channels ?? {})) {
    if (runtime.enabled) {
      enabled.add(channelId);
    }
  }
  return [...enabled];
}

async function setChannelEnabled(
  chatId: number,
  state: ChatState,
  channelId: string,
  enabled: boolean,
): Promise<ChatState | undefined> {
  const liveChannel = state.pagerAccount?.liveChannels?.find((channel) => channel.id === channelId);
  const fallbackCountry = liveChannel
    ? inferCountryFromName(liveChannel.name)
    : (getChannelConfig(config, channelId)?.country ?? "ZM");
  const runtime = getChannelRuntime(state, channelId, fallbackCountry);
  const enabledIds = new Set(collectEnabledChannelIds(state));
  if (enabled) {
    enabledIds.add(channelId);
  } else {
    enabledIds.delete(channelId);
  }

  return stateStore.patch(chatId, {
    enabledChannelIds: [...enabledIds],
    channels: {
      [channelId]: {
        ...runtime,
        enabled,
      },
    },
    operatorSettings: buildOperatorSettings(state, { enabledChannelIds: [...enabledIds] }),
  });
}

async function setAllChannelsEnabled(
  chatId: number,
  state: ChatState,
  enabled: boolean,
): Promise<ChatState | undefined> {
  const selectable = getSelectableChannels(state);
  const enabledIds = enabled ? selectable.map((channel) => channel.id) : [];
  const channels: Record<string, ChannelRuntimeState> = { ...(state.channels ?? {}) };

  for (const channel of selectable) {
    const runtime = getChannelRuntime(state, channel.id, channel.country);
    channels[channel.id] = {
      ...runtime,
      enabled,
    };
  }

  return stateStore.patch(chatId, {
    enabledChannelIds: enabledIds,
    channels,
    operatorSettings: buildOperatorSettings(state, { enabledChannelIds: enabledIds }),
  });
}

function buildOperatorSettings(
  state: ChatState,
  overrides: Partial<NonNullable<ChatState["operatorSettings"]>>,
): NonNullable<ChatState["operatorSettings"]> {
  return {
    enabledChannelIds:
      overrides.enabledChannelIds ??
      state.operatorSettings?.enabledChannelIds ??
      collectEnabledChannelIds(state),
    statusFolders:
      overrides.statusFolders ??
      state.operatorSettings?.statusFolders ??
      state.statusFolders,
  };
}

function mergeChannelsOnLogin(
  state: ChatState,
  channels: Array<{ id: string; name: string }>,
  templateBanks: Array<{ id: string; name: string }>,
): { channels: Record<string, ChannelRuntimeState>; enabledChannelIds: string[] } {
  const defaults = buildChannelRuntimeMap(channels, templateBanks);
  const enabledIds = new Set(
    state.operatorSettings?.enabledChannelIds?.length
      ? state.operatorSettings.enabledChannelIds
      : collectEnabledChannelIds(state),
  );

  const merged: Record<string, ChannelRuntimeState> = { ...defaults };
  for (const [channelId, runtime] of Object.entries(state.channels ?? {})) {
    if (merged[channelId]) {
      merged[channelId] = { ...merged[channelId], ...runtime };
    }
  }

  if (!enabledIds.size) {
    for (const channel of channels) {
      enabledIds.add(channel.id);
      merged[channel.id] = { ...merged[channel.id], enabled: true };
    }
  } else {
    for (const channelId of enabledIds) {
      if (merged[channelId]) {
        merged[channelId] = { ...merged[channelId], enabled: true };
      }
    }
  }

  return { channels: merged, enabledChannelIds: [...enabledIds] };
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
    "Слева 🟢/🔴 — вкл/выкл канал, по центру страна, справа — папка шаблонов (saved replies). Статусные папки чатов — в меню «Папки».";
  const keyboard = buildChannelKeyboard(getSelectableChannels(state));

  if (!messageId) {
    await telegram.sendMessage(chatId, text, keyboard);
    return;
  }

  await safeEditMenu(chatId, messageId, text, keyboard);
}

async function showFoldersMenu(chatId: number, state: ChatState, messageId?: number) {
  let currentState = state;
  if (!currentState.pagerAccount?.cookies && !currentState.pagerAccount?.password) {
    await telegram.sendMessage(
      chatId,
      "Сначала подключи Pager аккаунт через «Pager аккаунт».",
      buildMainMenuKeyboard(),
    );
    return;
  }

  const savedFolders =
    currentState.operatorSettings?.statusFolders ?? currentState.statusFolders ?? [];

  if (countApiStatusFolders(savedFolders) === 0) {
    const synced = await syncStatusFolders(chatId, currentState);
    currentState = synced.state ?? currentState;
    if (countApiStatusFolders(currentState.statusFolders) === 0) {
      await telegram.sendMessage(
        chatId,
        [
          "Не удалось загрузить папки из Pager.",
          synced.error ? `Причина: ${synced.error}` : "Сессия обновляется автоматически, попробуй через минуту.",
        ].join("\n"),
        buildFoldersRetryKeyboard(),
      );
      return;
    }
  } else {
    currentState = {
      ...currentState,
      statusFolders: savedFolders,
    };
  }

  const folders = currentState.statusFolders ?? [];
  const enabled = folders.filter((folder) => folder.enabled).length;
  const apiFolderCount = folders.filter(
    (folder) => folder.id !== "" && folder.id !== "*",
  ).length;
  const text = [
    "Папки Pager — откуда бот берёт чаты для автоответа:",
    "✅ включена | ⬜ выключена",
    "",
    `Включено: ${enabled} из ${folders.length}`,
    apiFolderCount
      ? `Загружено из Pager: ${apiFolderCount} папок`
      : "⚠️ Список из Pager пуст — нажми «Обновить папки».",
    "«Всі» — все чаты. «Без статусу» — только новые без статуса.",
    "Для чатов в «Думають», «В процесі», «рега» — включи эти папки или «Всі».",
  ].join("\n");
  const keyboard = buildFoldersKeyboard(folders);

  if (!messageId) {
    await telegram.sendMessage(chatId, text, keyboard);
    return;
  }

  await safeEditMenu(chatId, messageId, text, keyboard);
}

async function syncStatusFolders(
  chatId: number,
  state: ChatState,
): Promise<{ state?: ChatState; error?: string }> {
  const previousFolders = state.operatorSettings?.statusFolders ?? state.statusFolders;
  const previousApiFolderCount = countApiStatusFolders(previousFolders);

  try {
    const sessionResult = await ensurePagerSession({ env, stateStore }, state);
    if (!sessionResult) {
      return { state, error: "Pager сессия недоступна" };
    }

    const { client, state: sessionState } = sessionResult;
    const statuses = await client.loadAllStatuses();
    const statusFolders = mergeStatusFolderList(
      statuses,
      previousFolders,
    );
    const apiCount = countApiStatusFolders(statusFolders);
    const patch: Partial<Omit<ChatState, "chatId">> = {
      pagerAccount: buildPagerAccountPatch(sessionState, {
        organizationId: sessionState.pagerAccount?.organizationId,
        organizationSlug: sessionState.pagerAccount?.organizationSlug,
        organizationName: sessionState.pagerAccount?.organizationName,
        cookieHeader: client.getCookieHeader(),
      }),
      operatorSettings: buildOperatorSettings(sessionState, { statusFolders }),
    };
    if (apiCount > 0 || !previousApiFolderCount) {
      patch.statusFolders = statusFolders;
    }

    const patched = await stateStore.patch(chatId, patch);
    if (apiCount <= 0 && previousApiFolderCount > 0) {
      return {
        state: patched ?? state,
        error:
          "Pager не отдал список папок — оставил прежний список. Сессия обновлена, перелогин не нужен.",
      };
    }
    if (apiCount <= 0) {
      return {
        state: patched,
        error: "Pager не отдал список папок. Попробуй ещё раз через минуту.",
      };
    }
    return { state: patched };
  } catch (error) {
    console.error("syncStatusFolders failed:", error);
    return {
      state,
      error: `Не удалось обновить папки: ${formatError(error)}. Прежний список сохранён.`,
    };
  }
}

async function refreshPagerData(chatId: number, state: ChatState): Promise<ChatState | undefined> {
  const cookies = state.pagerAccount?.cookies;
  if (!cookies) {
    return state;
  }

  try {
    clearTemplateReplyCache();
    const session = await buildPagerClient(
      cookies,
      state.pagerAccount?.organizationId,
      resolvePagerOrgSlug(state),
    ).validateSession();
    const defaults = buildChannelRuntimeMap(
      session.channels.map((channel) => ({ id: channel.id, name: channel.name })),
      session.templateBanks.map((bank) => ({ id: bank.id, name: bank.name })),
    );
    const mergedChannels = { ...defaults, ...(state.channels ?? {}) };
    const enabledChannelIds = collectEnabledChannelIds({
      ...state,
      channels: mergedChannels,
    });
    const client = buildPagerClient(
      cookies,
      state.pagerAccount?.organizationId,
      resolvePagerOrgSlug(state),
    );
    const statuses = await client.loadAllStatuses().catch(() => []);
    const statusFolders = mergeStatusFolderList(statuses, state.statusFolders);

    return await stateStore.patch(chatId, {
      pagerAccount: {
        ...(state.pagerAccount ?? { authMode: "cookies", connectedAt: new Date().toISOString() }),
        organizationId: session.organizationId,
        organizationName: session.organizationName,
        organizationSlug: session.organizationSlug,
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
      enabledChannelIds,
      statusFolders,
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
  const runtime = state.channels?.[channelId];
  return isChannelEnabled(state, channelId, runtime?.enabled ?? false);
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

function buildPagerClient(cookieHeader: string, orgId?: string, orgSlug?: string) {
  const enriched = enrichPagerCookies(cookieHeader, { organizationId: orgId });
  const cookies = parseCookieHeader(enriched);
  return new PagerClient({
    baseUrl: env.PAGER_BASE_URL,
    cookieHeader: enriched,
    orgId: orgId || cookies._pager_org_id,
    orgSlug: orgSlug || cookies._pager_org_slug,
    locale: "uk",
  });
}

function buildClerkAuthClient() {
  return new ClerkPasswordAuthClient({
    frontendApi: "clerk.pager.co.ua",
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
    await stateStore.patch(chatId, {
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

      const login = await buildClerkAuthClient().signInWithPassword(email, text.trim());
      const session = await buildPagerClient(
        login.cookieHeader,
        login.organizationId,
      ).validateSession();
      const statusClient = buildPagerClient(
        login.cookieHeader,
        session.organizationId ?? login.organizationId,
        session.organizationSlug,
      );
      const statuses = await statusClient.loadAllStatuses().catch(() => []);
      const statusFolders = mergeStatusFolderList(
        statuses,
        state.operatorSettings?.statusFolders ?? state.statusFolders,
      );
      const merged = mergeChannelsOnLogin(
        state,
        session.channels.map((channel) => ({ id: channel.id, name: channel.name })),
        session.templateBanks.map((bank) => ({ id: bank.id, name: bank.name })),
      );
      const enrichedCookies = enrichPagerCookies(login.cookieHeader, {
        organizationId: session.organizationId ?? login.organizationId,
        pagerUserId: login.pagerUserId,
      });

      await stateStore.patch(chatId, {
        pendingAction: undefined,
        pagerAccount: {
          authMode: "credentials",
          email,
          password: text.trim(),
          cookies: enrichedCookies,
          organizationId: session.organizationId ?? login.organizationId,
          organizationName: session.organizationName,
          organizationSlug: session.organizationSlug,
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
          connectedAt: state.pagerAccount?.connectedAt ?? new Date().toISOString(),
        },
        channels: merged.channels,
        enabledChannelIds: merged.enabledChannelIds,
        statusFolders,
        operatorSettings: buildOperatorSettings(state, {
          enabledChannelIds: merged.enabledChannelIds,
          statusFolders,
        }),
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
          `Папки чатов: ${statusFolders.length} (по умолчанию включено «Всі»)`,
        ].join("\n"),
        buildPagerAccountKeyboard(true),
      );
    } catch (error) {
      await stateStore.patch(chatId, {
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
      const statusClient = buildPagerClient(
        text.trim(),
        session.organizationId,
        session.organizationSlug,
      );
      const statuses = await statusClient.loadAllStatuses().catch(() => []);
      const statusFolders = mergeStatusFolderList(
        statuses,
        state.operatorSettings?.statusFolders ?? state.statusFolders,
      );
      const merged = mergeChannelsOnLogin(
        state,
        session.channels.map((channel) => ({ id: channel.id, name: channel.name })),
        session.templateBanks.map((bank) => ({ id: bank.id, name: bank.name })),
      );
      const enrichedCookies = enrichPagerCookies(text.trim(), {
        organizationId: session.organizationId,
      });
      await stateStore.patch(chatId, {
        pendingAction: undefined,
        pagerAccount: {
          authMode: "cookies",
          cookies: enrichedCookies,
          organizationId: session.organizationId,
          organizationName: session.organizationName,
          organizationSlug: session.organizationSlug,
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
          connectedAt: state.pagerAccount?.connectedAt ?? new Date().toISOString(),
        },
        channels: merged.channels,
        enabledChannelIds: merged.enabledChannelIds,
        statusFolders,
        operatorSettings: buildOperatorSettings(state, {
          enabledChannelIds: merged.enabledChannelIds,
          statusFolders,
        }),
        draftPagerEmail: undefined,
      });
      await telegram.sendMessage(
        chatId,
        [
          "Cookies сохранены и проверены.",
          `Организация: ${session.organizationName ?? session.organizationId ?? "unknown"}`,
          `Каналов найдено: ${session.channelCount}`,
          `Банков шаблонов: ${session.templateBanks.length}`,
          `Папки чатов: ${statusFolders.length} (по умолчанию включено «Всі»)`,
          "Теперь кнопка `Каналы` будет показывать живые каналы аккаунта.",
        ].join("\n"),
        buildPagerAccountKeyboard(true),
      );
    } catch (error) {
      await stateStore.patch(chatId, {
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
      `Enabled channels: ${collectEnabledChannelIds(state).length}`,
      `Live channels: ${state.pagerAccount?.liveChannels?.length ?? 0}`,
      `Status folders enabled: ${state.statusFolders?.filter((folder) => folder.enabled).length ?? "all (not configured)"}`,
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
