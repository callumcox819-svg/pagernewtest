import { resolve } from "node:path";
import {
  getChannelConfig,
  getConfigEnabledChannelIds,
  getDefaultEnabledChannel,
  getPlaybook,
  loadConfig,
  resolvePlaybookCountry,
  statusMapForCountry,
} from "./config.js";
import { ClerkPasswordAuthClient, enrichPagerCookies, parseCookieHeader } from "./clerk-auth.js";
import { decideNextAction } from "./decision-engine.js";
import { loadEnv, shouldFetchStatsFromApi, usesHybridStats } from "./env.js";
import { PagerClient } from "./pager-client.js";
import { runPagerWorker, runPagerWorkerOnceForChat } from "./pager-worker.js";
import { CATCH_UP_READ_ACTIVE_MS, isIncomingDirection } from "./conversation-reply.js";
import { classifyProofFromImage } from "./proof-classifier.js";
import { clearTemplateReplyCache, isForeignBrandTemplateBank } from "./template-resolver.js";
import { startSavedRepliesSyncLoop } from "./saved-replies-sync.js";
import { createStateStore, type ChannelRuntimeState, type ChatState, type StateStore } from "./state-store.js";
import { createAppMetaStore, type AppMetaStore } from "./app-meta-store.js";
import {
  buildStatusFoldersFromPager,
  countApiStatusFolders,
  isAiFolderEnabled,
  setAllStatusFolders,
  setAllAiStatusFolders,
  stripChannelNamesFromFolders,
  toggleStatusFolder,
  toggleAiStatusFolder,
  hasEnabledStatusFolders,
  resolveChannelStatusFolders,
} from "./status-folders.js";
import {
  buildPagerAccountPatch,
  ensurePagerSession,
  resolvePagerOrgSlug,
} from "./pager-session.js";
import { applyPagerPause } from "./pager-pause.js";
import {
  TelegramApi,
  buildAdminPanelKeyboard,
  buildAdminRightsKeyboard,
  buildAdminUserCardKeyboard,
  buildAdminUserChannelsKeyboard,
  buildAdminUserFoldersChannelsKeyboard,
  buildAdminUserChannelFoldersKeyboard,
  buildAdminUsersKeyboard,
  ADMIN_CHANNELS_PAGE_SIZE,
  buildChannelKeyboard,
  buildChannelSettingsKeyboard,
  buildCountryKeyboard,
  buildFoldersKeyboard,
  buildAiFoldersKeyboard,
  buildFoldersRetryKeyboard,
  buildFolderIdleSignalsKeyboard,
  buildFolderIdleSignalFolderKeyboard,
  CHANNELS_PAGE_SIZE,
  FOLDERS_PAGE_SIZE,
  buildMainMenuKeyboard,
  buildOperatorReplyKeyboard,
  buildPagerAccountKeyboard,
  buildStatsCountryKeyboard,
  buildStatsIntervalKeyboard,
  buildStatsPlayersKeyboard,
  buildTemplateKeyboard,
  getDeployLabel,
  type TelegramMessage,
  type TelegramUpdate,
} from "./telegram-api.js";
import {
  ensureAccessSeeded,
  getAccessSnapshot,
  grantAdminRights,
  grantBotAccess,
  hasBotAccess,
  isAdmin,
  parseTelegramUserId,
  revokeAdminRights,
  revokeBotAccess,
  formatTelegramDisplayName,
  summarizeOperatorForAdmin,
} from "./bot-access.js";
import {
  defaultThresholdMinutesForKind,
  getFolderIdleSignalsSettings,
  listIdleSignalFoldersForUi,
  resolveFolderIdleConfig,
  type FolderIdleSignalsSettings,
} from "./folder-idle-signals.js";
import {
  configureXPartnersSessionStore,
  getXPartnersClient,
  startXPartnersKeepAlive,
  type XPartnersCountry,
  type XPartnersQuickStats,
} from "./xpartners-client.js";
import {
  cacheStale,
  formatStatsMessage,
  formatAllCountriesStats,
  formatPlayersIdsMessageParts,
  parseRefreshHours,
  type StatsRefreshHours,
} from "./xpartners-stats-ui.js";
import {
  describeXPartnersSession,
  ensureXPartnersSession,
  maskXPartnersLogin,
  warmupXPartnersSession,
} from "./xpartners-session.js";
import {
  loadGlobalPartnerStats,
  saveGlobalPartnerStats,
  type GlobalPartnerStatsState,
} from "./xpartners-stats-cache.js";
import {
  describePostbackActivity,
  formatPostbackCabinetSetupText,
  loadPostbackCountryStats,
  postbackCabinetSetups,
  startXPartnersPostbackServer,
  usesPostbackStats,
  usesPostbackStatsForFetch,
} from "./xpartners-postback.js";

import {
  defaultCountryForChannelName,
  formatRwLearningSummary,
  resolveWorkerCountryForChannel,
  type WorkerCountry,
} from "./rw-learn.js";

const COUNTRY_FOLDER_HINTS: Record<string, string[]> = {
  ZM: ["замб", "zamb", "zambia"],
  EG: ["егип", "egypt", "hapka"],
  CM: ["камер", "cameroon", "cameroun"],
  RW: ["ruand", "rwand", "rwanda", "руанд"],
  CL: ["chile", "chili", "чили"],
  MG: ["мадаг", "madag", "madagascar", "mdg"],
  DJ: ["джибут", "djibouti", "djib", "djf", "bji"],
  JO: ["йордан", "jordan", "jod", "jor"],
  KE: ["кени", "kenya", "kenia", "nairobi"],
  GT: ["гватемал", "guatemala", "guate"],
  EC: ["эквадор", "еквадор", "ecuador", "quito"],
};

const OPERATOR_COUNTRY_CODES = new Set<WorkerCountry>([
  "ZM",
  "CM",
  "EG",
  "RW",
  "CL",
  "MG",
  "DJ",
  "JO",
  "KE",
  "GT",
  "EC",
]);

const CHANNEL_COUNTRY_DISPLAY: Record<string, string> = {
  CM: "Камерун",
  EG: "Египет",
  ZM: "Замбия",
  RW: "Руанда",
  CL: "Чили",
  MG: "Мадагаскар",
  DJ: "Джибути",
  JO: "Йордания",
  KE: "Кения",
  GT: "Гватемала",
  EC: "Эквадор",
};

function formatChannelIdSuffix(id: string): string {
  const compact = id.replace(/-/g, "");
  return compact.length > 6 ? compact.slice(-6) : compact;
}

function parseOperatorCountry(value: string): WorkerCountry | undefined {
  const code = value.trim().toUpperCase();
  return OPERATOR_COUNTRY_CODES.has(code as WorkerCountry) ? (code as WorkerCountry) : undefined;
}

const env = loadEnv();
const config = loadConfig(resolve(process.cwd(), env.BOT_CONFIG_PATH));
let stateStore: StateStore;
let appMetaStore: AppMetaStore;
const telegram = new TelegramApi(env.TELEGRAM_BOT_TOKEN);

async function main() {
  stateStore = await createStateStore(env);
  appMetaStore = await createAppMetaStore(env);
  configureXPartnersSessionStore(appMetaStore);
  await ensureAccessSeeded(env, appMetaStore, stateStore);
  console.log(`Starting ${env.TELEGRAM_BOT_NAME} build=${getDeployLabel()}...`);
  await telegram.setMyCommands([
    { command: "start", description: "Открыть меню" },
    { command: "admin", description: "Админ-панель" },
    { command: "pause", description: "Пауза авто-ответов" },
    { command: "reset_pause", description: "Снять паузу" },
    { command: "learn", description: "RW: авто-воронка (справка)" },
  ]).catch((error) => {
    console.warn("Telegram setMyCommands failed:", formatError(error));
  });
  await warmupConnectedAccounts();
  warmupXPartnersSession(env);
  startXPartnersKeepAlive(env);
  startXPartnersPostbackServer(env, appMetaStore);
  startSavedRepliesSyncLoop({ env, config, stateStore });

  await Promise.all([
    runTelegramBot(),
    runPagerWorker({ env, config, stateStore, telegram, appMetaStore }),
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
  try {
    if (update.callback_query?.message?.chat.id) {
      const chatId = update.callback_query.message.chat.id;
      const messageId = update.callback_query.message.message_id;
      await rememberTelegramProfileFromUpdate(chatId, {
        from: update.callback_query.from,
        chat: update.callback_query.message.chat,
      });
      await handleCallback(chatId, update.callback_query.id, update.callback_query.data, messageId);
      return;
    }

    if (update.message) {
      await rememberTelegramProfileFromUpdate(update.message.chat.id, {
        from: update.message.from,
        chat: update.message.chat,
      });
      await handleMessage(update.message);
    }
  } catch (error) {
    const chatId =
      update.callback_query?.message?.chat.id ?? update.message?.chat.id;
    console.error("Telegram update failed:", formatError(error));
    if (chatId) {
      try {
        if (update.callback_query?.id) {
          await telegram.answerCallbackQuery(update.callback_query.id, "Ошибка меню");
        }
        await telegram.sendMessage(
          chatId,
          `Не удалось открыть меню: ${formatError(error)}\nПопробуй ещё раз или /start.`,
          buildMainMenuKeyboard(),
        );
      } catch {
        // ignore secondary send failure
      }
    }
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

  if (!(await ensureChatAllowed(chatId))) {
    await telegram.answerCallbackQuery(callbackId, "Нет доступа");
    return;
  }

  const state = await getOrCreateState(chatId);
  const { kind, value, extra, tail } = parseCallbackData(data);

  if (kind === "admin") {
    await handleAdminCallback(chatId, callbackId, value, extra, messageId, tail ?? []);
    return;
  }

  if (kind === "channels") {
    if (value === "all_on" || value === "all_off") {
      // handled below
    } else {
      if (value === "page" && extra !== undefined) {
        await telegram.answerCallbackQuery(callbackId);
        await showChannelsMenu(chatId, state, messageId, Number(extra) || 0);
        return;
      }
      if (value === "noop") {
        await telegram.answerCallbackQuery(callbackId);
        return;
      }
      if (value === "back" || value === "refresh") {
        const nextState =
          value === "refresh"
            ? (await refreshPagerData(chatId, state)) ?? state
            : (await stateStore.get(chatId)) ?? state;
        await telegram.answerCallbackQuery(callbackId);
        await showChannelsMenu(chatId, nextState, messageId);
        return;
      }
      if (value === "catchup") {
        const activeUntil = new Date(Date.now() + CATCH_UP_READ_ACTIVE_MS).toISOString();
        await stateStore.patch(chatId, {
          catchUpRead: {
            activeUntil,
            requestedAt: new Date().toISOString(),
            windowHours: 24,
            notifiedAt: undefined,
          },
        });
        await telegram.answerCallbackQuery(callbackId, "Догоняю чаты…");
        await telegram.sendMessage(
          chatId,
          "Включён догон: все unread в «Без статусу» (любой возраст) + read/unread за 24 ч (CM/EG/ZM/RW). Несколько циклов ~35 мин…",
        );
        void runPagerWorkerOnceForChat({ env, config, stateStore, telegram }, chatId).catch((error) => {
          console.warn(`Catch-up worker kick failed chat ${chatId}:`, formatError(error));
        });
        return;
      }
      await telegram.answerCallbackQuery(callbackId);
    }
  }

  if (kind === "signals") {
    await handleFolderIdleSignalsCallback(
      chatId,
      callbackId,
      value,
      extra,
      messageId,
      tail ?? [],
      state,
    );
    return;
  }

  if (kind === "channel_open" && value) {
    const latestState = (await stateStore.get(chatId)) ?? state;
    const channel = getChannelFromCallback(latestState, value);
    if (!channel) {
      await telegram.answerCallbackQuery(callbackId, "Канал не найден — жми «Обновить»");
      return;
    }
    await telegram.answerCallbackQuery(callbackId);
    await showChannelSettingsMenu(chatId, latestState, channel.id, messageId);
    return;
  }

  if (kind === "channel_toggle" && value) {
    const latestState = (await stateStore.get(chatId)) ?? state;
    const channel = getChannelFromCallback(latestState, value);
    if (!channel) {
      await telegram.answerCallbackQuery(callbackId, "Channel not found");
      return;
    }

    const fromSettings = extra === "settings";
    const page = Number(extra ?? "0");
    const runtime = getChannelRuntime(latestState, channel.id, channel.country);
    const nextEnabled = !isChannelEnabled(latestState, channel.id, runtime.enabled);
    const nextState = await setChannelEnabled(chatId, latestState, channel.id, nextEnabled);
    await telegram.answerCallbackQuery(callbackId, nextEnabled ? "🟢 Включено" : "🔴 Выключено");
    if (fromSettings) {
      await showChannelSettingsMenu(chatId, nextState ?? latestState, channel.id, messageId);
      return;
    }
    if (messageId) {
      await telegram.editMessageReplyMarkup(
        chatId,
        messageId,
        buildChannelKeyboard(
          getSelectableChannels(nextState ?? latestState),
          Number.isFinite(page) ? page : 0,
        ),
      );
    }
    return;
  }

  if (kind === "channel_info" && value) {
    const latestState = (await stateStore.get(chatId)) ?? state;
    const channel = getChannelFromCallback(latestState, value);
    if (!channel) {
      await telegram.answerCallbackQuery(callbackId, "Канал не найден — жми «Обновить каналы»");
      return;
    }

    const row = getSelectableRowForChannel(latestState, channel.id);
    const channelNum = getChannelDisplayNumber(latestState, channel.id);
    await telegram.answerCallbackQuery(callbackId, "Смотрю последний чат…");

    try {
      const sessionResult = await ensurePagerSession({ env, stateStore }, latestState);
      if (!sessionResult) {
        await telegram.sendMessage(chatId, "Pager не подключён — не могу загрузить чаты.");
        return;
      }

      const { client } = sessionResult;
      let convs = await client.listConversations({ channelId: channel.id, pageSize: 50 });
      if (!convs.length) {
        // Fallback: org inbox can still have this channel's chats when channel filter is empty.
        const inbox = await client.listConversations({ page: 1, pageSize: 100 });
        convs = inbox.filter(
          (conv) => (conv.channelId || conv.channel?.id || "") === channel.id,
        );
      }
      if (!convs.length) {
        try {
          convs = await client.collectConversationsForChannels([channel.id], 3);
        } catch {
          // keep empty — show clear message below
        }
      }
      const sorted = [...convs].sort((a, b) => {
        const ta = Date.parse(a.lastMessageAt ?? "") || 0;
        const tb = Date.parse(b.lastMessageAt ?? "") || 0;
        return tb - ta;
      });
      const latest = sorted[0];
      let preview = "Нет чатов на этом канале (Pager не отдал conversations).";
      let lastAt = "";
      if (latest) {
        const msgs = await client.listMessages(latest.id, 1, 40);
        const incoming = [...msgs]
          .reverse()
          .filter((message) => isIncomingDirection(message.messageDirection))
          .slice(0, 3)
          .map((message) => (message.text ?? "").trim().slice(0, 120))
          .filter(Boolean);
        const fallback = msgs[msgs.length - 1];
        const fallbackText = (fallback?.text ?? "").trim().slice(0, 160);
        lastAt = latest.lastMessageAt
          ? new Date(latest.lastMessageAt).toLocaleString("ru-RU")
          : "";
        if (incoming.length) {
          preview = incoming.map((text, index) => `${index + 1}) ${text}`).join("\n");
        } else {
          preview = fallbackText || "(без текста — возможно фото или стикер)";
        }
      }

      const suffix = formatChannelIdSuffix(channel.id);
      const source = row?.channelSource ? `\nИсточник: ${row.channelSource}` : "";
      const country = row?.country ?? channel.country;
      const countryLabel = CHANNEL_COUNTRY_DISPLAY[country] ?? country;
      const bank = row?.templateBank ?? "?";
      const hints = COUNTRY_FOLDER_HINTS[country] ?? [];
      const bankMismatch =
        bank !== "?" &&
        hints.length > 0 &&
        !hints.some((hint) => bank.toLowerCase().includes(hint));
      const mismatchLine = bankMismatch
        ? `\n⚠️ Страна ${countryLabel}, а папка «${bank}» — выбери папку под ${country} или смени страну.`
        : "";

      await telegram.sendMessage(
        chatId,
        [
          `Канал #${channelNum}: ${channel.name}`,
          `ID …${suffix}${source}`,
          `Страна в боте: ${countryLabel}`,
          `Шаблоны: ${bank}${mismatchLine}`,
          "",
          `Последний чат${lastAt ? ` (${lastAt})` : ""}:`,
          preview,
          "",
          "Сверь текст с Pager/Facebook — у одинаковых имён разный ID …xxxx.",
          "Если страна неверна — жми кнопку страны (ZM/EG/CM/RW/…) у этого канала.",
        ].join("\n"),
      );
    } catch (error) {
      await telegram.sendMessage(chatId, `Не удалось загрузить чат: ${formatError(error)}`);
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
    const channel = getChannelFromCallback(state, value);
    if (!channel) {
      await telegram.answerCallbackQuery(callbackId, "Channel not found");
      return;
    }

    await telegram.answerCallbackQuery(callbackId);
    await safeEditMenu(
      chatId,
      messageId,
      `Выбери страну для ${channel.name}:`,
      buildCountryKeyboard(channel.id),
      callbackId,
    );
    return;
  }

  if (kind === "country_pick" && value && extra) {
    const channel = getChannelFromCallback(state, value);
    if (!channel) {
      await telegram.answerCallbackQuery(callbackId, "Channel not found");
      return;
    }

    const country = parseOperatorCountry(extra);
    if (!country) {
      await telegram.answerCallbackQuery(callbackId, "Неизвестная страна");
      return;
    }
    const runtime = getChannelRuntime(state, channel.id, country);
    const bank = pickTemplateBankFromLiveBanks(getLiveTemplateBanks(state), country);
    const hints = COUNTRY_FOLDER_HINTS[country] ?? [];
    const previousBankOk =
      Boolean(runtime.templateBank) &&
      hints.some((hint) => (runtime.templateBank ?? "").toLowerCase().includes(hint));
    await stateStore.patch(chatId, {
      channels: {
        ...(state.channels ?? {}),
        [channel.id]: {
          ...runtime,
          country,
          templateBank: bank?.name ?? (previousBankOk ? runtime.templateBank : undefined),
          templateBankId: bank?.id ?? (previousBankOk ? runtime.templateBankId : undefined),
        },
      },
    });
    const nextState = await stateStore.get(chatId) ?? state;
    await telegram.answerCallbackQuery(
      callbackId,
      country === "RW"
        ? "Руанда · авто-воронка"
        : country === "CL"
          ? "Чили · локальные скрипты ES/EN/FR"
          : country === "MG"
            ? "Мадагаскар · FR · MAD778"
            : country === "DJ"
              ? "Джибути · сохранённые ответы"
              : country === "JO"
                ? "Йордания · AR · JOR778"
                : country === "KE" || country === "GT" || country === "EC"
                  ? `${CHANNEL_COUNTRY_DISPLAY[country]} · сохранённые ответы Pager`
                  : CHANNEL_COUNTRY_DISPLAY[country]
                    ? `${CHANNEL_COUNTRY_DISPLAY[country]} · сохранённые ответы`
                    : `Страна: ${country}`,
    );
    await showChannelSettingsMenu(chatId, nextState, channel.id, messageId);
    return;
  }

  if (kind === "ch_folders" && value) {
    const channel = getChannelFromCallback(state, value);
    if (!channel) {
      await telegram.answerCallbackQuery(callbackId, "Канал не найден");
      return;
    }
    await telegram.answerCallbackQuery(callbackId);
    await showChannelFoldersMenu(chatId, state, channel.id, channel.name, messageId, 0);
    return;
  }

  if (kind === "ch_folders_noop") {
    await telegram.answerCallbackQuery(callbackId);
    return;
  }

  if (kind === "ch_folders_page" && value && extra !== undefined) {
    const channel = getChannelFromCallback(state, value);
    if (!channel) {
      await telegram.answerCallbackQuery(callbackId, "Канал не найден");
      return;
    }
    await telegram.answerCallbackQuery(callbackId);
    await showChannelFoldersMenu(
      chatId,
      state,
      channel.id,
      channel.name,
      messageId,
      Number(extra) || 0,
    );
    return;
  }

  if (kind === "ch_folders_all" && value && extra) {
    const channel = getChannelFromCallback(state, value);
    if (!channel) {
      await telegram.answerCallbackQuery(callbackId, "Канал не найден");
      return;
    }
    const latestState = (await stateStore.get(chatId)) ?? state;
    const folders = setAllStatusFolders(
      resolveChannelStatusFolders(latestState, channel.id),
      extra === "on",
    );
    const runtime = getChannelRuntime(
      latestState,
      channel.id,
      inferCountryFromName(channel.name),
    );
    const nextState =
      (await stateStore.patch(chatId, {
        channels: {
          ...(latestState.channels ?? {}),
          [channel.id]: {
            ...runtime,
            statusFolders: folders,
          },
        },
      })) ?? latestState;
    await telegram.answerCallbackQuery(
      callbackId,
      extra === "on" ? "Все папки канала включены" : "Папки канала сняты",
    );
    await showChannelFoldersMenu(chatId, nextState, channel.id, channel.name, messageId, 0);
    return;
  }

  if (kind === "ch_folders_refresh" && value) {
    const channel = getChannelFromCallback(state, value);
    if (!channel) {
      await telegram.answerCallbackQuery(callbackId, "Канал не найден");
      return;
    }
    await telegram.answerCallbackQuery(callbackId, "Обновляю…");
    const synced = await syncStatusFolders(chatId, state);
    if (synced.error) {
      await telegram.sendMessage(chatId, `⚠️ ${synced.error}`);
    }
    const nextState = synced.state ?? state;
    await showChannelFoldersMenu(chatId, nextState, channel.id, channel.name, messageId, 0);
    return;
  }

  if (kind === "ch_folder_toggle" && value && extra !== undefined) {
    const channel = getChannelFromCallback(state, value);
    if (!channel) {
      await telegram.answerCallbackQuery(callbackId, "Канал не найден");
      return;
    }
    const latestState = (await stateStore.get(chatId)) ?? state;
    const index = Number(extra);
    const folders = toggleStatusFolder(
      resolveChannelStatusFolders(latestState, channel.id),
      index,
    );
    const runtime = getChannelRuntime(
      latestState,
      channel.id,
      inferCountryFromName(channel.name),
    );
    const nextState =
      (await stateStore.patch(chatId, {
        channels: {
          ...(latestState.channels ?? {}),
          [channel.id]: {
            ...runtime,
            statusFolders: folders,
          },
        },
      })) ?? latestState;
    const folder = folders[index];
    await telegram.answerCallbackQuery(
      callbackId,
      folder?.enabled ? `✅ ${folder.name}` : `⬜ ${folder?.name ?? "папка"}`,
    );
    const page = Math.floor(index / FOLDERS_PAGE_SIZE);
    await showChannelFoldersMenu(chatId, nextState, channel.id, channel.name, messageId, page);
    return;
  }

  if (kind === "ch_ai_folders" && value) {
    const channel = getChannelFromCallback(state, value);
    if (!channel) {
      await telegram.answerCallbackQuery(callbackId, "Канал не найден");
      return;
    }
    await telegram.answerCallbackQuery(callbackId);
    await showChannelAiFoldersMenu(chatId, state, channel.id, channel.name, messageId, 0);
    return;
  }

  if (kind === "ch_ai_folders_noop") {
    await telegram.answerCallbackQuery(callbackId);
    return;
  }

  if (kind === "ch_ai_folders_page" && value && extra !== undefined) {
    const channel = getChannelFromCallback(state, value);
    if (!channel) {
      await telegram.answerCallbackQuery(callbackId, "Канал не найден");
      return;
    }
    await telegram.answerCallbackQuery(callbackId);
    await showChannelAiFoldersMenu(
      chatId,
      state,
      channel.id,
      channel.name,
      messageId,
      Number(extra) || 0,
    );
    return;
  }

  if (kind === "ch_ai_folders_all" && value && extra) {
    const channel = getChannelFromCallback(state, value);
    if (!channel) {
      await telegram.answerCallbackQuery(callbackId, "Канал не найден");
      return;
    }
    const latestState = (await stateStore.get(chatId)) ?? state;
    const folders = setAllAiStatusFolders(
      resolveChannelStatusFolders(latestState, channel.id),
      extra === "on",
    );
    const runtime = getChannelRuntime(
      latestState,
      channel.id,
      inferCountryFromName(channel.name),
    );
    const nextState =
      (await stateStore.patch(chatId, {
        channels: {
          ...(latestState.channels ?? {}),
          [channel.id]: {
            ...runtime,
            statusFolders: folders,
          },
        },
      })) ?? latestState;
    await telegram.answerCallbackQuery(
      callbackId,
      extra === "on" ? "AI во все папки канала" : "AI выкл. для папок канала",
    );
    await showChannelAiFoldersMenu(chatId, nextState, channel.id, channel.name, messageId, 0);
    return;
  }

  if (kind === "ch_ai_folder_toggle" && value && extra !== undefined) {
    const channel = getChannelFromCallback(state, value);
    if (!channel) {
      await telegram.answerCallbackQuery(callbackId, "Канал не найден");
      return;
    }
    const latestState = (await stateStore.get(chatId)) ?? state;
    const index = Number(extra);
    const folders = toggleAiStatusFolder(
      resolveChannelStatusFolders(latestState, channel.id),
      index,
    );
    const runtime = getChannelRuntime(
      latestState,
      channel.id,
      inferCountryFromName(channel.name),
    );
    const nextState =
      (await stateStore.patch(chatId, {
        channels: {
          ...(latestState.channels ?? {}),
          [channel.id]: {
            ...runtime,
            statusFolders: folders,
          },
        },
      })) ?? latestState;
    const folder = folders[index];
    await telegram.answerCallbackQuery(
      callbackId,
      folder ? `AI: ${isAiFolderEnabled(folder) ? "вкл" : "выкл"} — ${folder.name}` : "Готово",
    );
    const page = Math.floor(index / FOLDERS_PAGE_SIZE);
    await showChannelAiFoldersMenu(chatId, nextState, channel.id, channel.name, messageId, page);
    return;
  }

  if (kind === "channel_bank" && value) {
    const channel = getChannelFromCallback(state, value);
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
      buildTemplateKeyboard(channel.id, banks),
      callbackId,
    );
    return;
  }

  if (kind === "template_pick" && value && extra) {
    const channel = getChannelFromCallback(state, value);
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
    await showChannelSettingsMenu(chatId, nextState, channel.id, messageId);
    return;
  }

  if (kind === "folders") {
    await telegram.answerCallbackQuery(callbackId);

    if (value === "page" && extra) {
      await showFoldersMenu(chatId, state, messageId, Number(extra));
      return;
    }

    if (value === "noop") {
      return;
    }

    if (value === "refresh") {
      const synced = await syncStatusFolders(chatId, state);
      if (synced.error) {
        await telegram.sendMessage(chatId, `⚠️ ${synced.error}`);
      }
      await showFoldersMenu(chatId, synced.state ?? state, messageId);
      return;
    }

    if (value === "all_on" || value === "all_off") {
      const baseFolders = state.operatorSettings?.statusFolders ?? state.statusFolders ?? [];
      const folders = setAllStatusFolders(baseFolders, value === "all_on");
      let nextState =
        (await stateStore.patch(chatId, {
          statusFolders: folders,
          operatorSettings: buildOperatorSettings(state, { statusFolders: folders }),
        })) ?? state;
      await showFoldersMenu(chatId, nextState, messageId);
      return;
    }

    if (value === "ai") {
      await showAiFoldersMenu(chatId, state, messageId);
      return;
    }

    if (value === "back") {
      await showFoldersMenu(chatId, state, messageId);
      return;
    }
    return;
  }

  if (kind === "ai_folders" || kind === "ai_folder_toggle") {
    await telegram.answerCallbackQuery(callbackId, "Папки AI — в настройках канала");
    await showAiFoldersMenu(chatId, state, messageId);
    return;
  }

  if (kind === "folder_toggle" && value) {
    const index = Number(value);
    const baseFolders = state.operatorSettings?.statusFolders ?? state.statusFolders ?? [];
    const folders = toggleStatusFolder(baseFolders, index);
    let nextState =
      (await stateStore.patch(chatId, {
        statusFolders: folders,
        operatorSettings: buildOperatorSettings(state, { statusFolders: folders }),
      })) ?? state;
    const folder = folders[index];
    await telegram.answerCallbackQuery(
      callbackId,
      folder?.enabled ? `✅ ${folder.name}` : `⬜ ${folder?.name ?? "папка"}`,
    );
    const page = Math.floor(index / FOLDERS_PAGE_SIZE);
    await showFoldersMenu(chatId, nextState, messageId, page);
    return;
  }

  if (kind === "menu") {
    await telegram.answerCallbackQuery(callbackId);

    if (value === "main") {
      await sendMainMenu(chatId, state, messageId);
      return;
    }

    if (value === "pager_account") {
      await sendPagerAccountMenu(chatId, state);
      return;
    }

    if (value === "channels") {
      await showChannelsMenu(chatId, state, messageId);
      return;
    }

    if (value === "folders") {
      await telegram.sendMessage(
        chatId,
        "Папки обработки теперь выбираются в «Каналы» — кнопка 📁 у каждого канала (рядом с шаблонами).",
        buildMainMenuKeyboard(),
      );
      return;
    }

    if (value === "ai_folders") {
      await telegram.sendMessage(
        chatId,
        "Папки AI теперь выбираются в «Каналы» → настройки канала → «Папки AI». У каждого канала свой набор.",
        buildMainMenuKeyboard(),
      );
      return;
    }

    if (value === "status") {
      await sendStatus(chatId, state);
      return;
    }

    if (value === "stats") {
      await showStatsMenu(chatId, state, messageId);
      return;
    }

    if (value === "learn") {
      const latest = (await stateStore.get(chatId)) ?? state;
      await telegram.sendMessage(chatId, formatRwLearningSummary(latest.rwLearning), buildMainMenuKeyboard());
      return;
    }

    if (value === "admin") {
      await showAdminPanel(chatId, messageId);
      return;
    }

    if (value === "reset") {
      await stateStore.delete(chatId);
      const nextState = await getOrCreateState(chatId);
      await telegram.sendMessage(
        chatId,
        `State reset.\nChannel: ${getEffectiveChannel(nextState).name}\nStage: ${nextState.currentStage}`,
        await menuKeyboard(chatId),
      );
      return;
    }
  }

  if (kind === "stats") {
    const latest = (await stateStore.get(chatId)) ?? state;
    const globalStats = await loadGlobalPartnerStats(appMetaStore);
    if (value === "interval" && extra === "menu") {
      await telegram.answerCallbackQuery(callbackId);
      const hours = globalStats.refreshIntervalHours;
      await safeEditMenu(
        chatId,
        messageId,
        `Как часто обновлять общий кэш 1xPartners?\n\nСейчас: <b>${hours} ч</b>\n\nОдин аккаунт на сервере — все операторы видят одни цифры.`,
        buildStatsIntervalKeyboard(hours),
        callbackId,
      );
      return;
    }
    if (value === "interval" && (extra === "1" || extra === "3" || extra === "5")) {
      const hours = parseRefreshHours(extra);
      await saveGlobalPartnerStats(appMetaStore, {
        ...globalStats,
        refreshIntervalHours: hours,
      });
      await telegram.answerCallbackQuery(callbackId, `Интервал: ${hours} ч`);
      await showStatsMenu(chatId, latest, messageId);
      return;
    }
    if (value === "refresh" && extra === "all") {
      await refreshAllPartnerStats(chatId, latest, messageId, callbackId);
      return;
    }
    if (value === "country" && (extra === "CM" || extra === "EG" || extra === "ZM" || extra === "RW")) {
      await sendCountryStats(chatId, latest, extra, callbackId);
      return;
    }
    if (value === "players" && extra === "menu") {
      await telegram.answerCallbackQuery(callbackId);
      await safeEditMenu(
        chatId,
        messageId,
        "<b>1xPartners · ID игроков за сегодня</b>\n\nКак в отчёте «По игрокам»: период «сегодня» (USD). Выберите страну или «Все 4» — пришлю список ID в чат.",
        buildStatsPlayersKeyboard(),
        callbackId,
      );
      return;
    }
    if (
      value === "players" &&
      (extra === "CM" || extra === "EG" || extra === "ZM" || extra === "RW" || extra === "ALL")
    ) {
      await sendPlayersIdsExport(chatId, extra === "ALL" ? "ALL" : extra, callbackId);
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
  const text = message.text?.trim() ?? "";

  // Access gate — /start and /admin still reach the denial message helpers.
  if (!(await hasBotAccess(env, appMetaStore, chatId))) {
    if (text.startsWith("/start") || text.startsWith("/admin") || !text) {
      await telegram.sendMessage(
        chatId,
        [
          "⛔ Доступ к боту закрыт.",
          `Твой Telegram ID: ${chatId}`,
          "Напиши владельцу — он выдаст доступ в админ-панели.",
        ].join("\n"),
      );
    }
    return;
  }

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

  const menuAction = resolveMenuTextAction(message.text);
  if (menuAction) {
    await dispatchMenuAction(chatId, state, menuAction);
    return;
  }

  const effectiveChannel = getEffectiveChannel(state);
  const playbookCountry = resolvePlaybookCountry(effectiveChannel.country);
  const playbook = getPlaybook(config, playbookCountry);
  const channelForDecision = {
    ...effectiveChannel,
    country: playbookCountry,
  };

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

    const decision = decideNextAction(config, channelForDecision, {
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

  const decision = decideNextAction(config, channelForDecision, {
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
  const command = normalizeTelegramCommand(commandText);

  if (command === "/start") {
    if (state.pendingAction) {
      await stateStore.patch(chatId, { pendingAction: undefined });
    }
    await sendMainMenu(chatId, state);
    return;
  }

  if (command === "/admin") {
    if (state.pendingAction) {
      await stateStore.patch(chatId, { pendingAction: undefined });
    }
    if (!(await isAdmin(env, appMetaStore, chatId))) {
      await telegram.sendMessage(chatId, "⛔ Админ-панель только для админов.");
      return;
    }
    await showAdminPanel(chatId);
    return;
  }

  if (command === "/learn") {
    const latest = (await stateStore.get(chatId)) ?? state;
    await telegram.sendMessage(chatId, formatRwLearningSummary(latest.rwLearning), buildMainMenuKeyboard());
    return;
  }

  if (command === "/pause") {
    await applyPagerPause(stateStore, state, true);
    await telegram.sendMessage(
      chatId,
      [
        "⏸ Авто-ответы на паузе только у тебя.",
        "Другие операторы бота не затрагиваются.",
        "",
        "Снять паузу: /reset_pause",
      ].join("\n"),
      buildMainMenuKeyboard(),
    );
    return;
  }

  if (command === "/reset_pause") {
    await applyPagerPause(stateStore, state, false);
    await telegram.sendMessage(
      chatId,
      [
        "▶️ Пауза снята только у тебя.",
        "Бот продолжит обрабатывать чаты по твоим каналам и папкам.",
      ].join("\n"),
      buildMainMenuKeyboard(),
    );
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
    "Unknown command. Available: /start, /pause, /reset_pause, /account, /channels, /status, /reset",
    buildMainMenuKeyboard(),
  );
}

function normalizeTelegramCommand(commandText: string): string {
  const token = commandText.trim().split(/\s+/)[0] ?? "";
  const base = token.split("@")[0]?.toLowerCase() ?? "";
  return base.startsWith("/") ? base : `/${base}`;
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

function parseCallbackData(data: string): {
  kind: string;
  value: string;
  extra?: string;
  tail?: string[];
} {
  const sep = data.includes("|") ? "|" : ":";
  const parts = data.split(sep);
  return {
    kind: parts[0] ?? "",
    value: parts[1] ?? "",
    extra: parts[2],
    tail: parts.length > 3 ? parts.slice(3) : undefined,
  };
}

function getSelectableRowForChannel(
  state: ChatState,
  channelId: string,
): ReturnType<typeof getSelectableChannels>[number] | undefined {
  return getSelectableChannels(state).find((row) => row.id === channelId);
}

function getChannelDisplayNumber(state: ChatState, channelId: string): number {
  const index = getSelectableChannels(state).findIndex((row) => row.id === channelId);
  return index >= 0 ? index + 1 : 0;
}

function getChannelById(state: ChatState, channelId: string) {
  const row = getSelectableRowForChannel(state, channelId);
  if (!row) {
    return undefined;
  }
  return resolveChannelForState(state, row.id);
}

/** Legacy keyboards used list index; new ones use channel id. */
function getChannelFromCallback(state: ChatState, value: string) {
  if (/^\d+$/.test(value)) {
    return getChannelByIndex(state, value);
  }
  return getChannelById(state, value);
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
  keyboard: ReturnType<typeof buildMainMenuKeyboard>,
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
      const folders = resolveChannelStatusFolders(state, channel.id);
      return {
        id: channel.id,
        name: channel.name,
        channelSource: channel.channelSource ?? undefined,
        country: runtime.country,
        enabled: isChannelEnabled(state, channel.id, runtime.enabled),
        templateBank: runtime.templateBank ?? "Шаблоны",
        foldersEnabledCount: folders.filter((folder) => folder.enabled).length,
      };
    });
  }

  return config.channels.map((channel) => {
    const runtime = getChannelRuntime(state, channel.id, channel.country);
    const folders = resolveChannelStatusFolders(state, channel.id);
    return {
      id: channel.id,
      name: channel.name,
      channelSource: undefined,
      country: runtime.country,
      enabled: isChannelEnabled(state, channel.id, runtime.enabled),
      templateBank: runtime.templateBank ?? `${channel.country.toLowerCase()}-default`,
      foldersEnabledCount: folders.filter((folder) => folder.enabled).length,
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
    folderIdleSignals:
      overrides.folderIdleSignals ?? state.operatorSettings?.folderIdleSignals,
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

  const liveIds = new Set(channels.map((channel) => channel.id));
  const yamlEnabled = getConfigEnabledChannelIds(config).filter((channelId) => liveIds.has(channelId));

  if (!enabledIds.size) {
    for (const channelId of yamlEnabled) {
      enabledIds.add(channelId);
      merged[channelId] = { ...merged[channelId], enabled: true };
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
  return (state.pagerAccount?.liveTemplateBanks ?? []).filter(
    (bank) => !isForeignBrandTemplateBank(bank.name),
  );
}

function getChannelRuntime(
  state: ChatState,
  channelId: string,
  fallbackCountry: WorkerCountry,
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
  country: WorkerCountry,
) {
  if (!banks.length) {
    return undefined;
  }

  const hints = COUNTRY_FOLDER_HINTS[country] ?? [];
  const matched = banks.find((bank) => {
    const normalized = bank.name.toLowerCase();
    return hints.some((hint) => normalized.includes(hint));
  });
  if (matched) {
    return matched;
  }
  // Never fall back to banks[0] — that assigned «Бенин» to Rwanda channels.
  return undefined;
}

function buildChannelRuntimeMap(
  channels: Array<{ id: string; name: string }>,
  templateBanks: Array<{ id: string; name: string }>,
) {
  return Object.fromEntries(
    channels.map((channel) => {
      const country = defaultCountryForChannelName(channel.name);
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

function listSignalFoldersForState(state: ChatState) {
  const catalog =
    state.operatorSettings?.statusFolders ?? state.statusFolders ?? [];
  return listIdleSignalFoldersForUi(catalog);
}

function patchFolderIdleSignals(
  state: ChatState,
  next: FolderIdleSignalsSettings,
): NonNullable<ChatState["operatorSettings"]> {
  return buildOperatorSettings(state, { folderIdleSignals: next });
}

async function handleFolderIdleSignalsCallback(
  chatId: number,
  callbackId: string,
  value: string,
  extra: string | undefined,
  messageId: number | undefined,
  tail: string[],
  state: ChatState,
): Promise<void> {
  if (value === "noop") {
    await telegram.answerCallbackQuery(callbackId);
    return;
  }

  if (value === "menu" || value === "page") {
    await telegram.answerCallbackQuery(callbackId);
    const page = value === "page" ? Number(extra) || 0 : 0;
    await showFolderIdleSignalsMenu(chatId, state, messageId, page);
    return;
  }

  if (value === "toggle") {
    const current = getFolderIdleSignalsSettings(state);
    const next: FolderIdleSignalsSettings = {
      ...current,
      enabled: !current.enabled,
      folders: { ...current.folders },
    };
    const nextState =
      (await stateStore.patch(chatId, {
        operatorSettings: patchFolderIdleSignals(state, next),
      })) ?? state;
    await telegram.answerCallbackQuery(
      callbackId,
      next.enabled ? "Сигналы папок ВКЛ" : "Сигналы папок ВЫКЛ",
    );
    await showFolderIdleSignalsMenu(chatId, nextState, messageId, 0);
    return;
  }

  if (value === "max_cycle") {
    const current = getFolderIdleSignalsSettings(state);
    const cycle = [2, 3, 5];
    const idx = cycle.indexOf(current.maxPerDay);
    const maxPerDay = cycle[(idx + 1) % cycle.length] ?? 3;
    const next: FolderIdleSignalsSettings = {
      ...current,
      maxPerDay,
      folders: { ...current.folders },
    };
    const nextState =
      (await stateStore.patch(chatId, {
        operatorSettings: patchFolderIdleSignals(state, next),
      })) ?? state;
    await telegram.answerCallbackQuery(callbackId, `Макс ${maxPerDay}/день`);
    await showFolderIdleSignalsMenu(chatId, nextState, messageId, 0);
    return;
  }

  if (value === "folder" && extra !== undefined) {
    await telegram.answerCallbackQuery(callbackId);
    await showFolderIdleSignalFolderMenu(chatId, state, Number(extra), messageId);
    return;
  }

  if (value === "ftoggle" && extra !== undefined) {
    const index = Number(extra);
    const folders = listSignalFoldersForState(state);
    const folder = folders[index];
    if (!folder) {
      await telegram.answerCallbackQuery(callbackId, "Папка не найдена");
      return;
    }
    const current = getFolderIdleSignalsSettings(state);
    const row = resolveFolderIdleConfig(current, folder.id, folder.name);
    const next: FolderIdleSignalsSettings = {
      ...current,
      folders: {
        ...current.folders,
        [folder.id]: {
          ...current.folders[folder.id],
          enabled: !row.enabled,
          thresholdMinutes:
            current.folders[folder.id]?.thresholdMinutes ?? row.thresholdMinutes,
        },
      },
    };
    const nextState =
      (await stateStore.patch(chatId, {
        operatorSettings: patchFolderIdleSignals(state, next),
      })) ?? state;
    await telegram.answerCallbackQuery(
      callbackId,
      !row.enabled ? `✅ ${folder.name}` : `⬜ ${folder.name}`,
    );
    await showFolderIdleSignalFolderMenu(chatId, nextState, index, messageId);
    return;
  }

  if (value === "thr" && extra !== undefined && tail[0]) {
    const index = Number(extra);
    const minutes = Number(tail[0]);
    const folders = listSignalFoldersForState(state);
    const folder = folders[index];
    if (!folder || ![30, 60, 120].includes(minutes)) {
      await telegram.answerCallbackQuery(callbackId, "Неверный порог");
      return;
    }
    const current = getFolderIdleSignalsSettings(state);
    const row = resolveFolderIdleConfig(current, folder.id, folder.name);
    const next: FolderIdleSignalsSettings = {
      ...current,
      folders: {
        ...current.folders,
        [folder.id]: {
          ...current.folders[folder.id],
          enabled: row.enabled,
          thresholdMinutes: minutes,
        },
      },
    };
    const nextState =
      (await stateStore.patch(chatId, {
        operatorSettings: patchFolderIdleSignals(state, next),
      })) ?? state;
    await telegram.answerCallbackQuery(callbackId, `${folder.name}: ${minutes} мин`);
    await showFolderIdleSignalFolderMenu(chatId, nextState, index, messageId);
    return;
  }

  await telegram.answerCallbackQuery(callbackId);
}

async function showFolderIdleSignalsMenu(
  chatId: number,
  state: ChatState,
  messageId?: number,
  page = 0,
): Promise<void> {
  const settings = getFolderIdleSignalsSettings(state);
  const folders = listSignalFoldersForState(state);
  const rows = folders.map((folder) => {
    const config = resolveFolderIdleConfig(settings, folder.id, folder.name);
    return {
      name: folder.name,
      kind: folder.kind,
      enabled: config.enabled,
      thresholdMinutes: config.thresholdMinutes,
    };
  });
  const onCount = rows.filter((row) => row.enabled).length;
  const text = [
    "Сигналы папок",
    settings.enabled ? "Авто: ВКЛ" : "Авто: ВЫКЛ",
    `Макс пингов/день на чат: ${settings.maxPerDay}`,
    `Папок: ${onCount}/${rows.length}`,
    "",
    "Тишина = нет входящих и исходящих.",
    "Язык пинга = гео канала.",
    "По умолчанию: «в процессе» 30м, остальные 60м.",
    "Нажми папку — вкл/выкл и порог.",
  ].join("\n");
  const keyboard = buildFolderIdleSignalsKeyboard(
    settings.enabled,
    settings.maxPerDay,
    rows,
    page,
  );
  if (!messageId) {
    await telegram.sendMessage(chatId, text, keyboard);
    return;
  }
  await safeEditMenu(chatId, messageId, text, keyboard);
}

async function showFolderIdleSignalFolderMenu(
  chatId: number,
  state: ChatState,
  folderIndex: number,
  messageId?: number,
): Promise<void> {
  const folders = listSignalFoldersForState(state);
  const folder = folders[folderIndex];
  if (!folder) {
    await showFolderIdleSignalsMenu(chatId, state, messageId, 0);
    return;
  }
  const settings = getFolderIdleSignalsSettings(state);
  const config = resolveFolderIdleConfig(settings, folder.id, folder.name);
  const kindLabel =
    folder.kind === "in_progress"
      ? "регистрация"
      : folder.kind === "waiting_id"
        ? "жду ID"
        : "общий";
  const text = [
    `Сигнал: ${folder.name}`,
    `Тип: ${kindLabel}`,
    `Папка: ${config.enabled ? "ВКЛ" : "ВЫКЛ"}`,
    `Порог тишины: ${config.thresholdMinutes} мин`,
    `Дефолт типа: ${defaultThresholdMinutesForKind(folder.kind)} мин`,
    "",
    "Тексты на языке гео канала.",
  ].join("\n");
  const keyboard = buildFolderIdleSignalFolderKeyboard(
    folderIndex,
    folder.name,
    config.enabled,
    config.thresholdMinutes,
  );
  if (!messageId) {
    await telegram.sendMessage(chatId, text, keyboard);
    return;
  }
  await safeEditMenu(chatId, messageId, text, keyboard);
}

async function showChannelsMenu(chatId: number, state: ChatState, messageId?: number, page = 0) {
  const channels = getSelectableChannels(state);
  const text = buildChannelsMenuCaption(state, page);
  const keyboard = buildChannelKeyboard(channels, page);

  try {
    if (!messageId) {
      await telegram.sendMessage(chatId, text, keyboard);
      return;
    }
    await safeEditMenu(chatId, messageId, text, keyboard);
  } catch (error) {
    console.error("showChannelsMenu failed:", formatError(error));
    await telegram.sendMessage(
      chatId,
      [
        "Не удалось показать список каналов.",
        formatError(error),
        channels.length
          ? `Каналов: ${channels.length}. Нажми «Каналы» ещё раз.`
          : "Сначала подключи Pager аккаунт.",
      ].join("\n"),
      buildMainMenuKeyboard(),
    );
  }
}

async function showChannelSettingsMenu(
  chatId: number,
  state: ChatState,
  channelId: string,
  messageId?: number,
) {
  const row = getSelectableRowForChannel(state, channelId);
  const channel = getChannelFromCallback(state, channelId);
  if (!row || !channel) {
    await telegram.sendMessage(chatId, "Канал не найден — обнови список каналов.");
    return;
  }
  const num = getChannelDisplayNumber(state, channelId);
  const countryLabel = CHANNEL_COUNTRY_DISPLAY[row.country] ?? row.country;
  const folders = resolveChannelStatusFolders(state, channelId);
  const foldersOn = folders.filter((folder) => folder.enabled).length;
  const aiFoldersOn = folders.filter((folder) => isAiFolderEnabled(folder)).length;
  const text = [
    `⚙️ ${num}. ${channel.name}`,
    `Статус: ${row.enabled ? "✅ включён" : "❌ выключен"}`,
    `Страна: ${countryLabel}`,
    `Шаблоны: ${row.templateBank ?? "не выбраны"}`,
    `Папки бота: ${foldersOn} из ${folders.length}`,
    `Папки AI: ${aiFoldersOn} из ${folders.length}`,
    "",
    "Выбери настройку ниже.",
  ].join("\n");
  const keyboard = buildChannelSettingsKeyboard({
    id: channel.id,
    name: channel.name,
    country: row.country,
    enabled: row.enabled,
    templateBank: row.templateBank,
    foldersEnabledCount: foldersOn,
    aiFoldersEnabledCount: aiFoldersOn,
  });
  try {
    if (!messageId) {
      await telegram.sendMessage(chatId, text, keyboard);
      return;
    }
    await safeEditMenu(chatId, messageId, text, keyboard);
  } catch (error) {
    console.error("showChannelSettingsMenu failed:", formatError(error));
    await telegram.sendMessage(chatId, text, keyboard);
  }
}

async function ensureStatusFolderCatalog(
  chatId: number,
  state: ChatState,
): Promise<{ state: ChatState; error?: string }> {
  let currentState = state;
  if (!currentState.pagerAccount?.cookies && !currentState.pagerAccount?.password) {
    return { state: currentState, error: "Сначала подключи Pager аккаунт через «Pager аккаунт»." };
  }

  const savedFolders =
    currentState.operatorSettings?.statusFolders ?? currentState.statusFolders ?? [];

  if (countApiStatusFolders(savedFolders) === 0) {
    const synced = await syncStatusFolders(chatId, currentState);
    currentState = synced.state ?? currentState;
    if (countApiStatusFolders(currentState.statusFolders) === 0) {
      return {
        state: currentState,
        error: synced.error
          ? `Не удалось загрузить папки из Pager: ${synced.error}`
          : "Не удалось загрузить папки из Pager. Попробуй через минуту.",
      };
    }
  } else {
    currentState = {
      ...currentState,
      statusFolders: savedFolders,
    };
  }

  const folders = stripChannelNamesFromFolders(
    currentState.statusFolders ?? [],
    currentState.pagerAccount?.liveChannels,
  );
  if (folders.length !== (currentState.statusFolders ?? []).length) {
    currentState =
      (await stateStore.patch(chatId, {
        statusFolders: folders,
        operatorSettings: buildOperatorSettings(currentState, { statusFolders: folders }),
      })) ?? currentState;
  }
  return { state: currentState };
}

async function showChannelFoldersMenu(
  chatId: number,
  state: ChatState,
  channelId: string,
  channelName: string,
  messageId?: number,
  page = 0,
) {
  const ensured = await ensureStatusFolderCatalog(chatId, state);
  if (ensured.error) {
    await telegram.sendMessage(chatId, ensured.error, buildFoldersRetryKeyboard());
    return;
  }
  const currentState = ensured.state;
  const runtime = getChannelRuntime(
    currentState,
    channelId,
    inferCountryFromName(channelName),
  );
  // Persist a channel-local copy on first open so later global edits don't override.
  let menuState = currentState;
  if (!runtime.statusFolders?.length) {
    const seeded = resolveChannelStatusFolders(currentState, channelId);
    menuState =
      (await stateStore.patch(chatId, {
        channels: {
          ...(currentState.channels ?? {}),
          [channelId]: {
            ...runtime,
            statusFolders: seeded,
          },
        },
      })) ?? currentState;
  }

  const latest = (await stateStore.get(chatId)) ?? menuState;
  // Prefer any in-memory channel folders if a concurrent worker patch raced the read.
  const foldersState =
    latest.channels?.[channelId]?.statusFolders?.length
      ? latest
      : menuState.channels?.[channelId]?.statusFolders?.length
        ? menuState
        : latest;
  const folders = resolveChannelStatusFolders(foldersState, channelId);
  const enabled = folders.filter((folder) => folder.enabled).length;
  const text = [
    `Папки канала «${channelName}» — откуда бот берёт чаты:`,
    "Галочки только для этого канала.",
    "✅ включена | ⬜ выключена",
    "",
    `Включено: ${enabled} из ${folders.length}`,
    "«Без статусу» — новые чаты без статуса.",
    "«Всі» — все чаты, кроме «в процесі» (включи отдельно).",
    "Шаблоны (сохранённые ответы) — соседняя кнопка в списке каналов.",
  ].join("\n");
  const keyboard = buildFoldersKeyboard(folders, page, channelId);

  if (!messageId) {
    await telegram.sendMessage(chatId, text, keyboard);
    return;
  }
  await safeEditMenu(chatId, messageId, text, keyboard);
}

async function showFoldersMenu(
  chatId: number,
  state: ChatState,
  messageId?: number,
  page = 0,
) {
  // Legacy global menu kept for old keyboards / AI entry fallback.
  const ensured = await ensureStatusFolderCatalog(chatId, state);
  if (ensured.error) {
    await telegram.sendMessage(chatId, ensured.error, buildFoldersRetryKeyboard());
    return;
  }
  const currentState = ensured.state;
  const folders = stripChannelNamesFromFolders(
    currentState.statusFolders ?? [],
    currentState.pagerAccount?.liveChannels,
  );
  const enabled = folders.filter((folder) => folder.enabled).length;
  const text = [
    "⚠️ Глобальные папки больше не используются для обработки.",
    "Выбери папки у каждого канала в меню «Каналы» (кнопка 📁).",
    "",
    `Каталог Pager: ${enabled}/${folders.length} (старые галочки — только fallback).`,
  ].join("\n");
  const keyboard = buildFoldersKeyboard(folders, page);

  if (!messageId) {
    await telegram.sendMessage(chatId, text, keyboard);
    return;
  }
  await safeEditMenu(chatId, messageId, text, keyboard);
}

async function showChannelAiFoldersMenu(
  chatId: number,
  state: ChatState,
  channelId: string,
  channelName: string,
  messageId?: number,
  page = 0,
) {
  const ensured = await ensureStatusFolderCatalog(chatId, state);
  if (ensured.error) {
    await telegram.sendMessage(chatId, ensured.error, buildFoldersRetryKeyboard());
    return;
  }
  const currentState = ensured.state;
  const runtime = getChannelRuntime(
    currentState,
    channelId,
    inferCountryFromName(channelName),
  );
  let menuState = currentState;
  if (!runtime.statusFolders?.length) {
    const seeded = resolveChannelStatusFolders(currentState, channelId);
    menuState =
      (await stateStore.patch(chatId, {
        channels: {
          ...(currentState.channels ?? {}),
          [channelId]: {
            ...runtime,
            statusFolders: seeded,
          },
        },
      })) ?? currentState;
  }

  const latest = (await stateStore.get(chatId)) ?? menuState;
  const foldersState =
    latest.channels?.[channelId]?.statusFolders?.length
      ? latest
      : menuState.channels?.[channelId]?.statusFolders?.length
        ? menuState
        : latest;
  const folders = resolveChannelStatusFolders(foldersState, channelId);
  const aiOn = folders.filter((folder) => isAiFolderEnabled(folder)).length;
  const text = [
    `Папки AI канала «${channelName}» — где AI отвечает:`,
    "Галочки только для этого канала.",
    "🤖 AI вкл | ⬜ AI выкл",
    "",
    `AI включён в ${aiOn} из ${folders.length} папок`,
    "Папки бота (скрипты) — соседняя кнопка «Папки».",
    "Пример: скрипты в «Без статусу», AI только в «В процесі».",
  ].join("\n");
  const keyboard = buildAiFoldersKeyboard(folders, page, channelId);

  if (!messageId) {
    await telegram.sendMessage(chatId, text, keyboard);
    return;
  }
  await safeEditMenu(chatId, messageId, text, keyboard);
}

/** Legacy global AI folders menu — redirects operators to per-channel settings. */
async function showAiFoldersMenu(
  chatId: number,
  _state: ChatState,
  messageId?: number,
  _page = 0,
) {
  const text =
    "Папки AI теперь у каждого канала отдельно.\nОткрой «Каналы» → канал → «Папки AI».";
  const keyboard = buildMainMenuKeyboard();
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
    const statusFolders = buildStatusFoldersFromPager(
      statuses,
      previousFolders,
      sessionState.pagerAccount?.liveChannels,
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
    const liveChannels = session.channels.map((channel) => ({
      id: channel.id,
      name: channel.name,
      channelSource: channel.channelSource,
    }));
    const statusFolders = buildStatusFoldersFromPager(statuses, state.statusFolders, liveChannels);

    return await stateStore.patch(chatId, {
      pagerAccount: {
        ...(state.pagerAccount ?? { authMode: "cookies", connectedAt: new Date().toISOString() }),
        organizationId: session.organizationId,
        organizationName: session.organizationName,
        organizationSlug: session.organizationSlug,
        liveChannels,
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
  const resolvedCountry = resolveWorkerCountryForChannel(
    live.name,
    state.channels?.[live.id]?.country,
    country,
  );
  return {
    id: live.id,
    name: live.name,
    enabled: getChannelEnabled(state, live.id),
    country: resolvedCountry,
    templateBank:
      state.channels?.[live.id]?.templateBank ??
      pickTemplateBankFromLiveBanks(getLiveTemplateBanks(state), country)?.name ??
      "Шаблоны",
    statusMap: statusMapForCountry(config, resolvedCountry),
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
  fallback: WorkerCountry,
): WorkerCountry {
  return state.channels?.[channelId]?.country ?? fallback;
}

function inferCountryFromName(name: string): WorkerCountry {
  return defaultCountryForChannelName(name);
}

function buildPagerClient(cookieHeader: string, orgId?: string, orgSlug?: string, pagerUserId?: string) {
  const enriched = enrichPagerCookies(cookieHeader, { organizationId: orgId, pagerUserId });
  const cookies = parseCookieHeader(enriched);
  return new PagerClient({
    baseUrl: env.PAGER_BASE_URL,
    webBaseUrl: env.PAGER_WEB_URL,
    cookieHeader: enriched,
    orgId: orgId || cookies._pager_org_id,
    orgSlug: orgSlug || cookies._pager_org_slug,
    locale: "uk",
    sessionUserId: pagerUserId || cookies._pager_user_id,
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
  if (await handleAdminPendingInput(chatId, state, text)) {
    return true;
  }

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
      const liveChannels = session.channels.map((channel) => ({
        id: channel.id,
        name: channel.name,
        channelSource: channel.channelSource,
      }));
      const statusFolders = buildStatusFoldersFromPager(
        statuses,
        state.operatorSettings?.statusFolders ?? state.statusFolders,
        liveChannels,
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
      const probedUserId =
        (await buildPagerClient(
          enrichedCookies,
          session.organizationId ?? login.organizationId,
          session.organizationSlug,
          login.pagerUserId,
        ).probeOperatorUserId()) || login.pagerUserId;

      await stateStore.patch(chatId, {
        pendingAction: undefined,
        pagerAccount: {
          authMode: "credentials",
          email,
          password: text.trim(),
          cookies: enrichPagerCookies(enrichedCookies, { pagerUserId: probedUserId }),
          pagerUserId: probedUserId,
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
      const liveChannels = session.channels.map((channel) => ({
        id: channel.id,
        name: channel.name,
        channelSource: channel.channelSource,
      }));
      const statusFolders = buildStatusFoldersFromPager(
        statuses,
        state.operatorSettings?.statusFolders ?? state.statusFolders,
        liveChannels,
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

async function menuKeyboard(chatId: number) {
  const admin = await isAdmin(env, appMetaStore, chatId);
  return buildMainMenuKeyboard({ isAdmin: admin });
}

async function replyMenuKeyboard(chatId: number) {
  const admin = await isAdmin(env, appMetaStore, chatId);
  return buildOperatorReplyKeyboard({ isAdmin: admin });
}

async function ensureChatAllowed(chatId: number): Promise<boolean> {
  return hasBotAccess(env, appMetaStore, chatId);
}

async function sendMainMenu(chatId: number, state: ChatState, messageId?: number) {
  const text = buildMainMenuCaption(state);
  const keyboard = await menuKeyboard(chatId);
  if (!messageId) {
    await telegram.sendMessage(chatId, text, keyboard);
    await telegram
      .sendMessage(chatId, "Меню", await replyMenuKeyboard(chatId))
      .catch(() => {});
    return;
  }
  await safeEditMenu(chatId, messageId, text, keyboard);
}

async function showAdminPanel(chatId: number, messageId?: number): Promise<void> {
  if (!(await isAdmin(env, appMetaStore, chatId))) {
    await telegram.sendMessage(chatId, "⛔ Админ-панель только для админов.");
    return;
  }
  const snapshot = await getAccessSnapshot(env, appMetaStore);
  const text = [
    "👤 Админ-панель",
    `Доступ: ${snapshot.allowed.length} польз.`,
    `Админы: ${snapshot.admins.length}`,
    `Владельцы (env): ${snapshot.owners.length ? snapshot.owners.join(", ") : "не заданы — добавь ADMIN_IDS"}`,
    "",
    "Выбери действие ниже.",
  ].join("\n");
  const keyboard = buildAdminPanelKeyboard();
  if (!messageId) {
    await telegram.sendMessage(chatId, text, keyboard);
    return;
  }
  await safeEditMenu(chatId, messageId, text, keyboard);
}

async function requireAdmin(chatId: number, callbackId?: string): Promise<boolean> {
  if (await isAdmin(env, appMetaStore, chatId)) {
    return true;
  }
  if (callbackId) {
    await telegram.answerCallbackQuery(callbackId, "Нет прав админа");
  }
  await telegram.sendMessage(chatId, "⛔ Только для админов.");
  return false;
}

async function handleAdminCallback(
  chatId: number,
  callbackId: string,
  value: string,
  extra: string | undefined,
  messageId?: number,
  tail?: string[],
): Promise<void> {
  const parts = tail ?? [];
  if (!(await requireAdmin(chatId, callbackId))) {
    return;
  }

  if (value === "panel") {
    await telegram.answerCallbackQuery(callbackId);
    await showAdminPanel(chatId, messageId);
    return;
  }

  if (value === "stats") {
    await telegram.answerCallbackQuery(callbackId);
    await showAdminUsersMenu(chatId, messageId, 0);
    return;
  }

  if (value === "users_noop" || value === "uch_noop" || value === "uf_noop") {
    await telegram.answerCallbackQuery(callbackId);
    return;
  }

  if (value === "users_page") {
    await telegram.answerCallbackQuery(callbackId);
    await showAdminUsersMenu(chatId, messageId, Number(extra) || 0);
    return;
  }

  if (value === "user" && extra) {
    const targetId = Number(extra);
    await telegram.answerCallbackQuery(callbackId);
    await showAdminUserCard(chatId, targetId, messageId);
    return;
  }

  // admin:uch:userId:page — list all channels as toggle buttons
  if (value === "uch" && extra) {
    const targetId = Number(extra);
    const page = Number(parts[0] ?? 0) || 0;
    await telegram.answerCallbackQuery(callbackId);
    await showAdminUserChannelsMenu(chatId, targetId, messageId, page);
    return;
  }

  // admin:cht:userId:index — toggle channel enabled for that user
  if (value === "cht" && extra && parts[0] !== undefined) {
    const targetId = Number(extra);
    const index = Number(parts[0]);
    await toggleAdminTargetChannel(chatId, callbackId, targetId, index, messageId);
    return;
  }

  // legacy alias from older button
  if (value === "user_channels" && extra) {
    const targetId = Number(extra);
    const page = Number(parts[0] ?? 0) || 0;
    await telegram.answerCallbackQuery(callbackId);
    await showAdminUserChannelsMenu(chatId, targetId, messageId, page);
    return;
  }

  // legacy → bot folders
  if (value === "user_folders" && extra) {
    const targetId = Number(extra);
    await telegram.answerCallbackQuery(callbackId);
    await showAdminUserFoldersChannelsMenu(chatId, targetId, "bot", messageId, 0);
    return;
  }

  // admin:uf / uaf — enabled channels with folder counts
  if ((value === "uf" || value === "uaf") && extra) {
    const targetId = Number(extra);
    const page = Number(parts[0] ?? 0) || 0;
    await telegram.answerCallbackQuery(callbackId);
    await showAdminUserFoldersChannelsMenu(
      chatId,
      targetId,
      value === "uaf" ? "ai" : "bot",
      messageId,
      page,
    );
    return;
  }

  // admin:ufc / uafc — open channel folders
  if ((value === "ufc" || value === "uafc") && extra && parts[0] !== undefined) {
    const targetId = Number(extra);
    const channelIndex = Number(parts[0]);
    const page = Number(parts[1] ?? 0) || 0;
    await telegram.answerCallbackQuery(callbackId);
    await showAdminUserChannelFoldersMenu(
      chatId,
      targetId,
      channelIndex,
      value === "uafc" ? "ai" : "bot",
      messageId,
      page,
    );
    return;
  }

  // admin:uft / uaft — toggle one folder
  if ((value === "uft" || value === "uaft") && extra && parts[0] !== undefined && parts[1] !== undefined) {
    const targetId = Number(extra);
    const channelIndex = Number(parts[0]);
    const folderIndex = Number(parts[1]);
    await toggleAdminTargetFolder(
      chatId,
      callbackId,
      targetId,
      channelIndex,
      folderIndex,
      value === "uaft" ? "ai" : "bot",
      messageId,
    );
    return;
  }

  // admin:ufa / uafa — all on/off for channel folders
  if ((value === "ufa" || value === "uafa") && extra && parts[0] !== undefined && parts[1]) {
    const targetId = Number(extra);
    const channelIndex = Number(parts[0]);
    const turnOn = parts[1] === "on";
    await setAllAdminTargetFolders(
      chatId,
      callbackId,
      targetId,
      channelIndex,
      value === "uafa" ? "ai" : "bot",
      turnOn,
      messageId,
    );
    return;
  }

  if (value === "grant_access") {
    await stateStore.patch(chatId, { pendingAction: "await_admin_grant_access_id" });
    await telegram.answerCallbackQuery(callbackId);
    await telegram.sendMessage(
      chatId,
      "✅ Доступ к боту\nОтправь Telegram ID, кому выдать доступ.\nОтмена: /start",
    );
    return;
  }

  if (value === "revoke_access") {
    await stateStore.patch(chatId, { pendingAction: "await_admin_revoke_access_id" });
    await telegram.answerCallbackQuery(callbackId);
    await telegram.sendMessage(
      chatId,
      "❌ Забрать доступ\nОтправь Telegram ID пользователя.\nОтмена: /start",
    );
    return;
  }

  if (value === "rights") {
    await telegram.answerCallbackQuery(callbackId);
    const text = "⭐ Админ-права\nВыдать / снять право открывать эту панель.";
    if (!messageId) {
      await telegram.sendMessage(chatId, text, buildAdminRightsKeyboard());
      return;
    }
    await safeEditMenu(chatId, messageId, text, buildAdminRightsKeyboard());
    return;
  }

  if (value === "grant_admin") {
    await stateStore.patch(chatId, { pendingAction: "await_admin_grant_admin_id" });
    await telegram.answerCallbackQuery(callbackId);
    await telegram.sendMessage(chatId, "Выдай админку — отправь Telegram ID.\nОтмена: /start");
    return;
  }

  if (value === "revoke_admin") {
    await stateStore.patch(chatId, { pendingAction: "await_admin_revoke_admin_id" });
    await telegram.answerCallbackQuery(callbackId);
    await telegram.sendMessage(chatId, "Снять админку — отправь Telegram ID.\nОтмена: /start");
    return;
  }

  if (value === "list_admins") {
    await telegram.answerCallbackQuery(callbackId);
    const snapshot = await getAccessSnapshot(env, appMetaStore);
    const text = [
      "⭐ Админы",
      `Владельцы: ${snapshot.owners.join(", ") || "—"}`,
      `Админы: ${snapshot.admins.join(", ") || "—"}`,
      `Всего с доступом: ${snapshot.allowed.length}`,
    ].join("\n");
    await telegram.sendMessage(chatId, text, buildAdminRightsKeyboard());
    return;
  }

  if (value === "revoke_user" && extra) {
    const targetId = Number(extra);
    const result = await revokeBotAccess(env, appMetaStore, targetId);
    await telegram.answerCallbackQuery(
      callbackId,
      result.ok ? "Доступ забран" : result.reason ?? "Ошибка",
    );
    if (result.ok) {
      await showAdminUserCard(chatId, targetId, messageId);
      return;
    }
    await telegram.sendMessage(
      chatId,
      `Не удалось: ${result.reason}`,
      buildAdminUserCardKeyboard(targetId),
    );
    return;
  }

  await telegram.answerCallbackQuery(callbackId, "Неизвестное действие");
}

async function handleAdminPendingInput(
  chatId: number,
  state: ChatState,
  text: string,
): Promise<boolean> {
  const action = state.pendingAction;
  if (
    action !== "await_admin_stats_id" &&
    action !== "await_admin_grant_access_id" &&
    action !== "await_admin_revoke_access_id" &&
    action !== "await_admin_grant_admin_id" &&
    action !== "await_admin_revoke_admin_id"
  ) {
    return false;
  }

  if (!(await isAdmin(env, appMetaStore, chatId))) {
    await stateStore.patch(chatId, { pendingAction: undefined });
    await telegram.sendMessage(chatId, "⛔ Нет прав админа.");
    return true;
  }

  if (/^\/(start|admin|cancel)/i.test(text.trim())) {
    await stateStore.patch(chatId, { pendingAction: undefined });
    return false;
  }

  const targetId = parseTelegramUserId(text);
  if (targetId === undefined) {
    await telegram.sendMessage(chatId, "Нужен числовой Telegram ID. Пример: 5719081592");
    return true;
  }

  await stateStore.patch(chatId, { pendingAction: undefined });

  if (action === "await_admin_stats_id") {
    await showAdminUserCard(chatId, targetId);
    return true;
  }

  if (action === "await_admin_grant_access_id") {
    await grantBotAccess(env, appMetaStore, targetId);
    await telegram.sendMessage(
      chatId,
      `✅ Доступ выдан пользователю ${targetId}.\nПусть напишет /start.`,
      buildAdminPanelKeyboard(),
    );
    return true;
  }

  if (action === "await_admin_revoke_access_id") {
    const result = await revokeBotAccess(env, appMetaStore, targetId);
    await telegram.sendMessage(
      chatId,
      result.ok ? `❌ Доступ у ${targetId} забран.` : `Не удалось: ${result.reason}`,
      buildAdminPanelKeyboard(),
    );
    return true;
  }

  if (action === "await_admin_grant_admin_id") {
    const result = await grantAdminRights(env, appMetaStore, targetId);
    await telegram.sendMessage(
      chatId,
      result.ok
        ? `⭐ Админка выдана ${targetId}. У него появится «Админ-панель».`
        : `Не удалось: ${result.reason}`,
      buildAdminRightsKeyboard(),
    );
    return true;
  }

  if (action === "await_admin_revoke_admin_id") {
    const result = await revokeAdminRights(env, appMetaStore, targetId);
    await telegram.sendMessage(
      chatId,
      result.ok ? `Админка снята с ${targetId}.` : `Не удалось: ${result.reason}`,
      buildAdminRightsKeyboard(),
    );
    return true;
  }

  return false;
}

async function rememberTelegramProfileFromUpdate(
  chatId: number,
  source: {
    from?: { username?: string; first_name?: string; last_name?: string };
    chat?: { username?: string; first_name?: string; last_name?: string };
  },
): Promise<void> {
  const username = source.from?.username?.trim() || source.chat?.username?.trim();
  const firstName = source.from?.first_name?.trim() || source.chat?.first_name?.trim();
  const lastName = source.from?.last_name?.trim() || source.chat?.last_name?.trim();
  if (!username && !firstName && !lastName) {
    return;
  }
  const current = await stateStore.get(chatId);
  const prev = current?.telegramProfile;
  if (
    prev?.username === username &&
    prev?.firstName === firstName &&
    prev?.lastName === lastName
  ) {
    return;
  }
  await stateStore.patch(chatId, {
    telegramProfile: {
      username: username || undefined,
      firstName: firstName || undefined,
      lastName: lastName || undefined,
      updatedAt: new Date().toISOString(),
    },
  });
}

async function ensureTelegramProfileCached(userId: number, state?: ChatState): Promise<ChatState | undefined> {
  if (state?.telegramProfile?.username || state?.telegramProfile?.firstName) {
    return state;
  }
  const chat = await telegram.getChat(userId);
  if (!chat) {
    return state;
  }
  const telegramProfile = {
    username: chat.username?.trim() || undefined,
    firstName: chat.first_name?.trim() || undefined,
    lastName: chat.last_name?.trim() || undefined,
    updatedAt: new Date().toISOString(),
  };
  if (!telegramProfile.username && !telegramProfile.firstName && !telegramProfile.lastName) {
    return state;
  }
  return (
    (await stateStore.patch(userId, { telegramProfile })) ??
    (state ? { ...state, telegramProfile } : undefined)
  );
}

async function listAdminDirectoryUsers(): Promise<Array<{ id: number; label: string }>> {
  const snapshot = await getAccessSnapshot(env, appMetaStore);
  const states = await stateStore.listAll();
  const byId = new Map<number, ChatState>();
  for (const state of states) {
    byId.set(state.chatId, state);
  }
  const ids = [...new Set<number>([...snapshot.allowed, ...byId.keys()])].sort((a, b) => a - b);

  // Refresh missing names via getChat (best-effort, capped).
  const missing = ids.filter((id) => {
    const profile = byId.get(id)?.telegramProfile;
    return !profile?.username && !profile?.firstName;
  });
  for (const id of missing.slice(0, 12)) {
    const refreshed = await ensureTelegramProfileCached(id, byId.get(id));
    if (refreshed) {
      byId.set(id, refreshed);
    }
  }

  return ids.map((id) => {
    const state = byId.get(id);
    const enabled = Object.values(state?.channels ?? {}).filter((row) => row.enabled).length;
    const pager = Boolean(
      state?.pagerAccount?.cookies?.trim() ||
        (state?.pagerAccount?.email && state?.pagerAccount?.password),
    );
    const marks = [
      snapshot.owners.includes(id) ? "👑" : snapshot.admins.includes(id) ? "⭐" : "",
      pager ? "📡" : "",
      `кан:${enabled}`,
    ]
      .filter(Boolean)
      .join(" ");
    const name = formatTelegramDisplayName(state?.telegramProfile, id);
    const label = `${name} · ${marks}`;
    return { id, label: label.slice(0, 56) };
  });
}

async function showAdminUsersMenu(
  chatId: number,
  messageId?: number,
  page = 0,
): Promise<void> {
  const users = await listAdminDirectoryUsers();
  const text = [
    "📊 Статистика пользователей",
    `Всего: ${users.length}`,
    "Нажми пользователя — карточка (каналы, папки, доступ).",
  ].join("\n");
  const keyboard = buildAdminUsersKeyboard(users, page);
  if (!messageId) {
    await telegram.sendMessage(chatId, text, keyboard);
    return;
  }
  await safeEditMenu(chatId, messageId, text, keyboard);
}

async function showAdminUserCard(
  chatId: number,
  targetId: number,
  messageId?: number,
): Promise<void> {
  const rawState = await stateStore.get(targetId);
  const targetState = (await ensureTelegramProfileCached(targetId, rawState)) ?? rawState;
  const hasAccess = await hasBotAccess(env, appMetaStore, targetId);
  const admin = await isAdmin(env, appMetaStore, targetId);
  const text = [
    summarizeOperatorForAdmin(targetState, targetId),
    "",
    `Доступ к боту: ${hasAccess ? "✅ есть" : "❌ нет"}`,
    `Админ: ${admin ? "✅ да" : "нет"}`,
    "",
    "Выбери действие ниже.",
  ].join("\n");
  const keyboard = buildAdminUserCardKeyboard(targetId);
  if (!messageId) {
    await telegram.sendMessage(chatId, text, keyboard);
    return;
  }
  await safeEditMenu(chatId, messageId, text, keyboard);
}

function listAdminTargetChannels(state: ChatState): Array<{
  id: string;
  name: string;
  country: WorkerCountry;
  enabled: boolean;
}> {
  // Same source as the user's own «Каналы» screen — live names only, no raw IDs.
  return getSelectableChannels(state)
    .map((channel) => ({
      id: channel.id,
      name: channel.name,
      country: channel.country,
      enabled: channel.enabled,
    }))
    .sort((left, right) => {
      if (left.enabled !== right.enabled) {
        return left.enabled ? -1 : 1;
      }
      return left.name.localeCompare(right.name, "ru");
    });
}

async function showAdminUserChannelsMenu(
  chatId: number,
  targetId: number,
  messageId?: number,
  page = 0,
): Promise<void> {
  const targetState = await stateStore.get(targetId);
  if (!targetState) {
    await telegram.sendMessage(
      chatId,
      `У ${targetId} нет state — каналов нет.`,
      buildAdminUserCardKeyboard(targetId),
    );
    return;
  }
  const channels = listAdminTargetChannels(targetState);
  const on = channels.filter((channel) => channel.enabled).length;
  const totalPages = Math.max(1, Math.ceil(channels.length / ADMIN_CHANNELS_PAGE_SIZE));
  const safePage = Math.min(Math.max(page, 0), totalPages - 1);
  const pageLabel = totalPages > 1 ? ` · стр. ${safePage + 1}/${totalPages}` : "";
  const text = [
    `Каналы ${targetId}: ${on}/${channels.length}${pageLabel}`,
    "Слева — имя, справа — вкл/выкл у этого пользователя.",
  ].join("\n");
  const keyboard = buildAdminUserChannelsKeyboard(targetId, channels, safePage);
  if (!messageId) {
    await telegram.sendMessage(chatId, text, keyboard);
    return;
  }
  await safeEditMenu(chatId, messageId, text, keyboard);
}

async function toggleAdminTargetChannel(
  adminChatId: number,
  callbackId: string,
  targetId: number,
  index: number,
  messageId?: number,
): Promise<void> {
  const targetState = await stateStore.get(targetId);
  if (!targetState) {
    await telegram.answerCallbackQuery(callbackId, "Нет state");
    return;
  }
  const channels = listAdminTargetChannels(targetState);
  const channel = channels[index];
  if (!channel) {
    await telegram.answerCallbackQuery(callbackId, "Канал не найден");
    return;
  }
  const nextEnabled = !channel.enabled;
  await setChannelEnabled(targetId, targetState, channel.id, nextEnabled);
  await telegram.answerCallbackQuery(
    callbackId,
    nextEnabled ? `✅ ${channel.name}` : `⬜ ${channel.name}`,
  );
  const page = Math.floor(index / ADMIN_CHANNELS_PAGE_SIZE);
  await showAdminUserChannelsMenu(adminChatId, targetId, messageId, page);
}

type AdminFolderMode = "bot" | "ai";

function listAdminEnabledChannelsWithFolders(state: ChatState): Array<{
  id: string;
  name: string;
  country: WorkerCountry;
  botOn: number;
  aiOn: number;
  total: number;
}> {
  return getSelectableChannels(state)
    .filter((channel) => channel.enabled)
    .map((channel) => {
      const folders = resolveChannelStatusFolders(state, channel.id);
      return {
        id: channel.id,
        name: channel.name,
        country: channel.country,
        botOn: folders.filter((folder) => folder.enabled).length,
        aiOn: folders.filter((folder) => isAiFolderEnabled(folder)).length,
        total: folders.length,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name, "ru"));
}

async function showAdminUserFoldersChannelsMenu(
  chatId: number,
  targetId: number,
  mode: AdminFolderMode,
  messageId?: number,
  page = 0,
): Promise<void> {
  const targetState = await stateStore.get(targetId);
  if (!targetState) {
    await telegram.sendMessage(
      chatId,
      `У ${targetId} нет state — папок нет.`,
      buildAdminUserCardKeyboard(targetId),
    );
    return;
  }
  const channels = listAdminEnabledChannelsWithFolders(targetState);
  if (!channels.length) {
    const text = `У ${targetId} нет включённых каналов — папки смотреть негде.`;
    const keyboard = buildAdminUserCardKeyboard(targetId);
    if (!messageId) {
      await telegram.sendMessage(chatId, text, keyboard);
      return;
    }
    await safeEditMenu(chatId, messageId, text, keyboard);
    return;
  }
  const rows = channels.map((channel) => ({
    name: channel.name,
    on: mode === "ai" ? channel.aiOn : channel.botOn,
    total: channel.total,
  }));
  const withAny = rows.filter((row) => row.on > 0).length;
  const title = mode === "ai" ? "Папки AI" : "Папки бота";
  const text = [
    `${title} · ${targetId}`,
    `Включённых каналов: ${channels.length}`,
    `С папками: ${withAny}`,
    "Нажми канал — папки вкл/выкл.",
  ].join("\n");
  const keyboard = buildAdminUserFoldersChannelsKeyboard(targetId, mode, rows, page);
  if (!messageId) {
    await telegram.sendMessage(chatId, text, keyboard);
    return;
  }
  await safeEditMenu(chatId, messageId, text, keyboard);
}

async function showAdminUserChannelFoldersMenu(
  chatId: number,
  targetId: number,
  channelIndex: number,
  mode: AdminFolderMode,
  messageId?: number,
  page = 0,
): Promise<void> {
  const targetState = await stateStore.get(targetId);
  if (!targetState) {
    const text = `У ${targetId} нет state — папок нет.`;
    const keyboard = buildAdminUserCardKeyboard(targetId);
    if (!messageId) {
      await telegram.sendMessage(chatId, text, keyboard);
      return;
    }
    await safeEditMenu(chatId, messageId, text, keyboard);
    return;
  }
  const channels = listAdminEnabledChannelsWithFolders(targetState);
  const channel = channels[channelIndex];
  if (!channel) {
    await showAdminUserFoldersChannelsMenu(chatId, targetId, mode, messageId, 0);
    return;
  }
  const folders = resolveChannelStatusFolders(targetState, channel.id);
  const folderRows = folders.map((folder) => ({
    name: folder.name,
    on: mode === "ai" ? isAiFolderEnabled(folder) : folder.enabled,
  }));
  const on = folderRows.filter((folder) => folder.on).length;
  const title = mode === "ai" ? "Папки AI" : "Папки бота";
  const text = [
    `${title} · ${channel.name}`,
    `Пользователь ${targetId}`,
    `Вкл: ${on}/${folderRows.length}`,
    "Нажми папку — переключить.",
  ].join("\n");
  const keyboard = buildAdminUserChannelFoldersKeyboard(
    targetId,
    channelIndex,
    mode,
    folderRows,
    page,
  );
  if (!messageId) {
    await telegram.sendMessage(chatId, text, keyboard);
    return;
  }
  await safeEditMenu(chatId, messageId, text, keyboard);
}

async function patchTargetChannelFolders(
  targetId: number,
  targetState: ChatState,
  channelId: string,
  channelName: string,
  folders: ReturnType<typeof resolveChannelStatusFolders>,
): Promise<ChatState> {
  const runtime = getChannelRuntime(
    targetState,
    channelId,
    inferCountryFromName(channelName),
  );
  return (
    (await stateStore.patch(targetId, {
      channels: {
        ...(targetState.channels ?? {}),
        [channelId]: {
          ...runtime,
          statusFolders: folders,
        },
      },
    })) ?? targetState
  );
}

async function toggleAdminTargetFolder(
  adminChatId: number,
  callbackId: string,
  targetId: number,
  channelIndex: number,
  folderIndex: number,
  mode: AdminFolderMode,
  messageId?: number,
): Promise<void> {
  const targetState = await stateStore.get(targetId);
  if (!targetState) {
    await telegram.answerCallbackQuery(callbackId, "Нет state");
    return;
  }
  const channels = listAdminEnabledChannelsWithFolders(targetState);
  const channel = channels[channelIndex];
  if (!channel) {
    await telegram.answerCallbackQuery(callbackId, "Канал не найден");
    return;
  }
  const current = resolveChannelStatusFolders(targetState, channel.id);
  const folders =
    mode === "ai"
      ? toggleAiStatusFolder(current, folderIndex)
      : toggleStatusFolder(current, folderIndex);
  await patchTargetChannelFolders(targetId, targetState, channel.id, channel.name, folders);
  const folder = folders[folderIndex];
  const on = folder
    ? mode === "ai"
      ? isAiFolderEnabled(folder)
      : folder.enabled
    : false;
  await telegram.answerCallbackQuery(
    callbackId,
    on ? `✅ ${folder?.name ?? "папка"}` : `⬜ ${folder?.name ?? "папка"}`,
  );
  const page = Math.floor(folderIndex / FOLDERS_PAGE_SIZE);
  await showAdminUserChannelFoldersMenu(
    adminChatId,
    targetId,
    channelIndex,
    mode,
    messageId,
    page,
  );
}

async function setAllAdminTargetFolders(
  adminChatId: number,
  callbackId: string,
  targetId: number,
  channelIndex: number,
  mode: AdminFolderMode,
  turnOn: boolean,
  messageId?: number,
): Promise<void> {
  const targetState = await stateStore.get(targetId);
  if (!targetState) {
    await telegram.answerCallbackQuery(callbackId, "Нет state");
    return;
  }
  const channels = listAdminEnabledChannelsWithFolders(targetState);
  const channel = channels[channelIndex];
  if (!channel) {
    await telegram.answerCallbackQuery(callbackId, "Канал не найден");
    return;
  }
  const current = resolveChannelStatusFolders(targetState, channel.id);
  const folders =
    mode === "ai"
      ? setAllAiStatusFolders(current, turnOn)
      : setAllStatusFolders(current, turnOn);
  await patchTargetChannelFolders(targetId, targetState, channel.id, channel.name, folders);
  await telegram.answerCallbackQuery(
    callbackId,
    turnOn
      ? mode === "ai"
        ? "AI во все папки"
        : "Все папки включены"
      : mode === "ai"
        ? "AI выключен"
        : "Папки сняты",
  );
  await showAdminUserChannelFoldersMenu(
    adminChatId,
    targetId,
    channelIndex,
    mode,
    messageId,
    0,
  );
}

function buildMainMenuCaption(state: ChatState): string {
  const account = state.pagerAccount;
  const hasPager = Boolean(account?.cookies?.trim() || (account?.email && account?.password));
  if (!hasPager) {
    return `Pager не подключён — открой «Pager аккаунт».\nbuild ${getDeployLabel()}`;
  }

  const org = account?.organizationName || account?.organizationSlug || "Pager";
  const enabledChannels = getSelectableChannels(state).filter((channel) =>
    isChannelEnabled(state, channel.id, getChannelRuntime(state, channel.id, channel.country).enabled),
  );
  const liveCount = account?.liveChannels?.length ?? enabledChannels.length;
  if (!enabledChannels.length) {
    return `Pager: ${org}\nКаналы не включены (${liveCount} доступно).\nbuild ${getDeployLabel()}`;
  }

  const summary = enabledChannels
    .slice(0, 4)
    .map((channel) => `${channel.name} · ${channel.country}`)
    .join("\n");
  const extra =
    enabledChannels.length > 4 ? `\n… ещё ${enabledChannels.length - 4}` : "";
  return `Pager: ${org}\nВключено ${enabledChannels.length}/${liveCount}:\n${summary}${extra}\nbuild ${getDeployLabel()}`;
}

function buildChannelsMenuCaption(state: ChatState, page = 0): string {
  const channels = getSelectableChannels(state);
  const enabled = channels.filter((channel) =>
    isChannelEnabled(state, channel.id, getChannelRuntime(state, channel.id, channel.country).enabled),
  ).length;

  const nameCounts = new Map<string, number>();
  for (const channel of channels) {
    nameCounts.set(channel.name, (nameCounts.get(channel.name) ?? 0) + 1);
  }
  const hasDuplicateNames = [...nameCounts.values()].some((count) => count > 1);
  const totalPages = Math.max(1, Math.ceil(channels.length / CHANNELS_PAGE_SIZE));
  const safePage = Math.min(Math.max(page, 0), totalPages - 1);
  const pageLabel = totalPages > 1 ? ` · стр. ${safePage + 1}/${totalPages}` : "";

  const base = `Каналы ${enabled}/${channels.length}${pageLabel} · build ${getDeployLabel()}`;
  const hints = [
    "Слева — канал (настройки).",
    "Справа — тумблер вкл/выкл.",
  ];
  if (hasDuplicateNames) {
    hints.push("Одинаковые имена — открой канал → ℹ️.");
  }
  return `${base}\n${hints.join("\n")}`;
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

type MenuAction =
  | "main"
  | "pager_account"
  | "channels"
  | "folders"
  | "ai_folders"
  | "status"
  | "stats"
  | "learn"
  | "reset"
  | "admin";

const XP_STATS_COUNTRIES: XPartnersCountry[] = ["CM", "EG", "ZM", "RW"];

function normalizeMenuButtonText(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF\u2060]/g, "")
    .replace(/[^\p{L}\p{N}\s/:-]+/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function resolveMenuTextAction(text?: string): MenuAction | undefined {
  if (!text?.trim()) {
    return undefined;
  }
  const normalized = normalizeMenuButtonText(text);
  if (/pager\s*аккаунт|pager\s*account|^account$/.test(normalized)) {
    return "pager_account";
  }
  if (/канал|channels/.test(normalized)) {
    return "channels";
  }
  if (/выбор\s*папок|^папки$|folders/.test(normalized)) {
    return "folders";
  }
  if (/папки\s*ai|ai\s*папки|ai\s*folders/.test(normalized)) {
    return "ai_folders";
  }
  if (/^статус$|^status$|настройки|settings/.test(normalized)) {
    return "status";
  }
  if (/статистик|statistics|^stats$|1xpartners/.test(normalized)) {
    return "stats";
  }
  if (/rw\s*воронка|обучение\s*rw|^обучение$|rw\s*learn|^learn$/.test(normalized)) {
    return "learn";
  }
  if (/^сброс$|^reset$/.test(normalized)) {
    return "reset";
  }
  if (/админ|admin/.test(normalized)) {
    return "admin";
  }
  if (/^меню$|^menu$|^start$/.test(normalized)) {
    return "main";
  }
  return undefined;
}

async function dispatchMenuAction(
  chatId: number,
  state: ChatState,
  action: MenuAction,
  messageId?: number,
): Promise<void> {
  if (action === "main") {
    await sendMainMenu(chatId, state, messageId);
    return;
  }
  if (action === "admin") {
    await showAdminPanel(chatId, messageId);
    return;
  }
  if (action === "pager_account") {
    await sendPagerAccountMenu(chatId, state);
    return;
  }
  if (action === "channels") {
    await showChannelsMenu(chatId, state);
    return;
  }
  if (action === "folders") {
    await telegram.sendMessage(
      chatId,
      "Папки обработки теперь в «Каналы» — кнопка 📁 у каждого канала (рядом с шаблонами).",
      await menuKeyboard(chatId),
    );
    return;
  }
  if (action === "ai_folders") {
    await telegram.sendMessage(
      chatId,
      "Папки AI теперь в «Каналы» → открой канал → «Папки AI». У каждого канала свой AI.",
      buildMainMenuKeyboard(),
    );
    return;
  }
  if (action === "status") {
    await sendStatus(chatId, state);
    return;
  }
  if (action === "stats") {
    await showStatsMenu(chatId, state, messageId);
    return;
  }
  if (action === "learn") {
    const latest = (await stateStore.get(chatId)) ?? state;
    await telegram.sendMessage(chatId, formatRwLearningSummary(latest.rwLearning), buildMainMenuKeyboard());
    return;
  }
  if (action === "reset") {
    await stateStore.delete(chatId);
    const nextState = await getOrCreateState(chatId);
    await telegram.sendMessage(
      chatId,
      `State reset.\nChannel: ${getEffectiveChannel(nextState).name}\nStage: ${nextState.currentStage}`,
      buildMainMenuKeyboard(),
    );
  }
}

async function showStatsMenu(chatId: number, state: ChatState, messageId?: number) {
  const client = getXPartnersClient(env);
  if (!client) {
    await safeEditMenu(
      chatId,
      messageId,
      "1xPartners статистика выключена.\n\nВключите модуль в <b>Variables</b> сервиса Railway.",
      buildMainMenuKeyboard(),
    );
    return;
  }
  try {
    if (shouldFetchStatsFromApi(env)) {
      void ensureXPartnersSession(env).catch(() => {});
    }
  } catch {
    // keep-alive and stat fetches retry too
  }
  const globalStats = await loadGlobalPartnerStats(appMetaStore);
  const hours = globalStats.refreshIntervalHours;
  const stale = cacheStale(globalStats.cachedAt, hours);
  const postbackMode = usesPostbackStats(env);
  const hybridMode = usesHybridStats(env);
  const session = postbackMode && !hybridMode
    ? { connected: true, loginHint: "postback" }
    : await describeXPartnersSession(env, appMetaStore);
  const sessionLine = hybridMode
    ? session.connected
      ? "Сервер: 🟢 hybrid · отчёт из кабинета + postback live"
      : "Сервер: 🔴 hybrid · обнови XPARTNERS_COOKIE в Railway"
    : postbackMode
      ? "Сервер: 🟢 postback · счётчики с входящих {reg}/{ftd}"
      : session.connected
        ? `Сервер: 🟢 в сети · ${maskXPartnersLogin(session.loginHint)}`
        : "Сервер: 🔴 переподключение… (проверь XPARTNERS_* в Railway, если долго)";
  const postbackActivityLine =
    postbackMode || hybridMode ? escapeHtmlLite(await describePostbackActivity(appMetaStore)) : "";
  const postbackHint =
    postbackMode || hybridMode
      ? (() => {
          const cmReg = postbackCabinetSetups(env)[0];
          const cabinetBlock = cmReg
            ? [
                "<b>Форма 1xPartners (пример CM reg):</b>",
                `URL: <code>${escapeHtmlLite(cmReg.url)}</code>`,
                `Статика: <code>${escapeHtmlLite(cmReg.staticParams)}</code>`,
                `Динамика: click_id → <code>{click_id}</code>, reg → <code>{reg}</code>`,
                `Название события: <code>${escapeHtmlLite(cmReg.eventNameInSystem)}</code>`,
                "Метод: GET · 4 postback: CM/ZM × reg/ftd",
              ]
            : [];
          return [
            "",
            hybridMode ? "<b>Hybrid:</b> «Обновить все» = цифры как в «Кратком отчёте»." : "",
            ...cabinetBlock,
            "",
            postbackActivityLine,
            "Трафик только через «Ссылку для размещения» · статус Active.",
          ].filter(Boolean);
        })()
      : [];
  const lines = [
    "<b>1xPartners · Статистика</b>",
    hybridMode
      ? "Hybrid: кабинет при «Обновить все» + postback для новых событий."
      : postbackMode
        ? "Счётчики с postback — каждый {reg} и {ftd} от 1xPartners +1 в бот."
        : "Общий аккаунт на сервере — все смотрят цифры без входа на сайт.",
    hybridMode || !postbackMode ? "Сессия обновляется сама (keep-alive + при запросе статистики)." : "",
    "",
    sessionLine,
    `Кэш: ${stale ? "устарел — «Обновить все»" : "актуален"} · интервал <b>${hours} ч</b>`,
    ...postbackHint,
    "",
    "Cameroon · Egypt · Zambia · Rwanda",
  ];
  await safeEditMenu(chatId, messageId, lines.join("\n"), buildStatsCountryKeyboard());
}

async function fetchAndCacheCountryStats(
  country: XPartnersCountry,
  force: boolean,
): Promise<{ globalStats: GlobalPartnerStatsState; stats: XPartnersQuickStats }> {
  const globalStats = await loadGlobalPartnerStats(appMetaStore);
  const hours = globalStats.refreshIntervalHours;
  const cached = globalStats.byCountry?.[country];
  const cachedAt = globalStats.cachedAt;
  if (usesPostbackStatsForFetch(env)) {
    const stats = await loadPostbackCountryStats(appMetaStore, env, country);
    const nextStats: GlobalPartnerStatsState = {
      refreshIntervalHours: hours,
      cachedAt: new Date().toISOString(),
      byCountry: { ...(globalStats.byCountry ?? {}), [country]: stats },
    };
    await saveGlobalPartnerStats(appMetaStore, nextStats);
    return { globalStats: nextStats, stats };
  }
  const client = getXPartnersClient(env);
  if (!client) {
    throw new Error("1xPartners отключён (XPARTNERS_ENABLED=false).");
  }
  if (!force && cached && !cacheStale(cachedAt, hours)) {
    return { globalStats, stats: cached };
  }
  const stats = await client.fetchQuickStatsToday(country);
  const nextStats: GlobalPartnerStatsState = {
    refreshIntervalHours: hours,
    cachedAt: new Date().toISOString(),
    byCountry: { ...(globalStats.byCountry ?? {}), [country]: stats },
  };
  await saveGlobalPartnerStats(appMetaStore, nextStats);
  return { globalStats: nextStats, stats };
}

async function sendPlayersIdsExport(
  chatId: number,
  target: XPartnersCountry | "ALL",
  callbackId: string,
): Promise<void> {
  const client = getXPartnersClient(env);
  if (!client) {
    await telegram.answerCallbackQuery(callbackId, "1xPartners выключен");
    return;
  }
  await telegram.answerCallbackQuery(callbackId, "Загружаю ID игроков…");

  try {
    const countries: XPartnersCountry[] =
      target === "ALL" ? [...XP_STATS_COUNTRIES] : [target];

    const results = await Promise.allSettled(
      countries.map((c) => client.fetchPlayerIdsToday(c)),
    );

    const keyboard = buildStatsCountryKeyboard();
    if (target === "ALL") {
      let lastSuccessIndex = -1;
      for (let i = 0; i < results.length; i++) {
        if (results[i]?.status === "fulfilled") {
          lastSuccessIndex = i;
        }
      }
      for (let i = 0; i < results.length; i++) {
        const r = results[i]!;
        const country = countries[i]!;
        if (r.status === "rejected") {
          const isLast = i === results.length - 1;
          await telegram.sendMessage(
            chatId,
            `⚠️ <b>${country}</b>: ${escapeHtmlLite(formatError(r.reason))}`,
            isLast && lastSuccessIndex < 0 ? keyboard : undefined,
          );
          continue;
        }
        const e = r.value;
        const parts = formatPlayersIdsMessageParts(e.country, e);
        const isLastCountry = i === results.length - 1;
        for (let p = 0; p < parts.length; p++) {
          const isLastPart = isLastCountry && p === parts.length - 1;
          await telegram.sendMessage(chatId, parts[p]!, isLastPart ? keyboard : undefined);
        }
      }
      if (lastSuccessIndex < 0) {
        await telegram.sendMessage(chatId, "Не удалось загрузить ID ни для одной страны.", keyboard);
      }
      return;
    }

    const single = results[0];
    if (!single || single.status === "rejected") {
      throw single?.reason ?? new Error("1xPartners: нет ответа");
    }

    const data = single.value;
    const parts = formatPlayersIdsMessageParts(data.country, data);
    for (let p = 0; p < parts.length; p++) {
      await telegram.sendMessage(chatId, parts[p]!, p === parts.length - 1 ? keyboard : undefined);
    }
  } catch (error) {
    await telegram.sendMessage(
      chatId,
      `⚠️ ${formatError(error)}`,
      buildStatsCountryKeyboard(),
    );
  }
}

async function sendCountryStats(
  chatId: number,
  state: ChatState,
  country: XPartnersCountry,
  callbackId: string,
): Promise<void> {
  const client = getXPartnersClient(env);
  if (!client) {
    await telegram.answerCallbackQuery(callbackId, "1xPartners выключен");
    await telegram.sendMessage(
      chatId,
      "1xPartners не настроен — добавьте переменные в Railway Variables.",
      buildMainMenuKeyboard(),
    );
    return;
  }
  await telegram.answerCallbackQuery(callbackId, "Загрузка…");
  try {
    const { stats, globalStats } = await fetchAndCacheCountryStats(country, true);
    const text = formatStatsMessage(country, stats, globalStats.refreshIntervalHours);
    await telegram.sendMessage(chatId, text, buildStatsCountryKeyboard());
  } catch (error) {
    await telegram.sendMessage(
      chatId,
      `⚠️ ${formatError(error)}`,
      buildStatsCountryKeyboard(),
    );
  }
}

async function refreshAllPartnerStats(
  chatId: number,
  state: ChatState,
  messageId: number | undefined,
  callbackId: string,
): Promise<void> {
  const client = getXPartnersClient(env);
  if (!client) {
    await telegram.answerCallbackQuery(callbackId, "1xPartners выключен");
    return;
  }
  await telegram.answerCallbackQuery(callbackId, "Обновляю CM, EG, ZM, RW…");
  if (messageId) {
    await safeEditMenu(
      chatId,
      messageId,
      "⏳ Загрузка отчётов 1xPartners…",
      buildStatsCountryKeyboard(),
      callbackId,
    );
  }
  let globalStats = await loadGlobalPartnerStats(appMetaStore);
  const hours = globalStats.refreshIntervalHours;
  const errors: string[] = [];
  const byCountry: Partial<Record<XPartnersCountry, XPartnersQuickStats>> = {
    ...(globalStats.byCountry ?? {}),
  };
  for (const country of XP_STATS_COUNTRIES) {
    try {
      const result = await fetchAndCacheCountryStats(country, true);
      globalStats = result.globalStats;
      byCountry[country] = result.stats;
    } catch (error) {
      const msg = formatError(error);
      errors.push(`${country}: ${msg}`);
      if (isXPartnersSessionError(msg)) {
        break;
      }
    }
  }
  const blocks: string[] = [formatAllCountriesStats(byCountry, hours)];
  if (usesPostbackStats(env) || usesHybridStats(env)) {
    blocks.push("", escapeHtmlLite(await describePostbackActivity(appMetaStore)));
  }
  if (errors.length) {
    const unique = dedupeStatErrors(errors);
    blocks.push("", `<b>Ошибка:</b> ${escapeHtmlLite(unique.join(" · "))}`);
  }
  await safeEditMenu(chatId, messageId, blocks.join("\n").trim(), buildStatsCountryKeyboard(), callbackId);
}

function escapeHtmlLite(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function dedupeStatErrors(errors: string[]): string[] {
  const messages = errors.map((entry) => {
    const splitAt = entry.indexOf(": ");
    return splitAt >= 0 ? entry.slice(splitAt + 2).trim() : entry.trim();
  });
  return [...new Set(messages)];
}

function isXPartnersSessionError(message: string): boolean {
  return (
    message.includes("TOKEN_ERROR") ||
    message.includes("XPARTNERS_COOKIE") ||
    message.includes("cookie не принята") ||
    message.includes("COOKIE_REJECTED") ||
    message.includes("refresh-token") ||
    message.includes("cookie не прошёл") ||
    message.includes("автологин")
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
      `Paused: ${state.paused ? "yes" : "no"}`,
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
