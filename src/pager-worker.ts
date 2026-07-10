import { readFileSync } from "node:fs";
import {
  type BotConfig,
  type ChannelConfig,
  type Stage,
  getChannelConfig,
  getConfigEnabledChannelIds,
  isChannelConfigured,
  getPlaybook,
  resolveYamlTemplateBankName,
  statusMapForCountry,
} from "./config.js";
import { decideNextAction } from "./decision-engine.js";
import {
  assessReplyEligibility,
  conversationPriorityScore,
  findLatestIncomingMessage,
  isActionableCustomerMessage,
  parseMessageTimestamp,
  recentCustomerMessageTexts,
  shouldQueueConversation,
} from "./conversation-reply.js";
import {
  classifySpecialCustomerIntent,
  moneyRefusalText,
  phoneChatOnlyText,
  specialIntentTemplateRole,
} from "./customer-intent.js";
import { ocrLangForCountry } from "./ocr-lang.js";
import {
  classifyCmMessage,
  cmScriptSentInHistory,
  collectOutgoingTexts as collectCmOutgoingTexts,
  funnelStepFromScriptGaps as cmFunnelStepFromScriptGaps,
  inferStepFromThread as cmInferStepFromThread,
  regLinkSentInHistory as cmRegLinkSentInHistory,
  regSendTriggersInProgress as cmRegSendTriggersInProgress,
  resolveCmFunnelScripts,
  limitCmScriptsForCustomerTurn,
  CM_REG_SEND_KEYS,
  tierSentInHistory,
} from "./cm-script-engine.js";
import {
  classifyEgMessage,
  collectOutgoingTexts as collectEgOutgoingTexts,
  egScriptSentInHistory,
  explainScriptsSentInHistory,
  funnelStepFromScriptGaps as egFunnelStepFromScriptGaps,
  inferStepFromThread as egInferStepFromThread,
  regLinkSentInHistory as egRegLinkSentInHistory,
  regSendTriggersInProgress as egRegSendTriggersInProgress,
  resolveEgFunnelScripts,
  limitEgScriptsForCustomerTurn,
  EG_REG_SEND_KEYS,
} from "./eg-script-engine.js";
import {
  classifyZmMessage,
  collectOutgoingTexts as collectZmOutgoingTexts,
  explainScriptsSentInHistory as zmExplainScriptsSentInHistory,
  funnelStepFromScriptGaps as zmFunnelStepFromScriptGaps,
  inferStepFromThread as zmInferStepFromThread,
  regLinkSentInHistory as zmRegLinkSentInHistory,
  regSendTriggersInProgress as zmRegSendTriggersInProgress,
  statusMoveTriggersInProgress as zmStatusMoveTriggersInProgress,
  resolveZmFunnelScripts,
  zmScriptSentInHistory,
  limitZmScriptsForCustomerTurn,
  ZM_EXPLAIN_SEND_KEYS,
  ZM_REG_SEND_KEYS,
} from "./zm-script-engine.js";
import { resolveScriptAttachment } from "./zm-script-assets.js";
import { extractProofImageUrl, resolveMessageReaction } from "./message-attachments.js";
import {
  isDepositTierChoice,
  isCmRegistrationHelpRequest,
  isRegistrationAccountQuestion,
  isRegistrationConfirmed,
} from "./cm-intent.js";
import { isEgDepositTierChoice, isEgJoinOrRegistrationQuestion } from "./eg-intent.js";
import { isZmRegistrationAccountQuestion, isReadyForRegistration as zmIsReadyForRegistration, isRegistrationHelpRequest as zmIsRegistrationHelpRequest } from "./zm-intent.js";
import type { AppEnv } from "./env.js";
import {
  isIncomingDirection,
  isPagerSessionError,
  PagerApiError,
  PagerClient,
  type PagerConversation,
  type PagerMessage,
  resolveLastMessageAt,
} from "./pager-client.js";
import { buildPagerAccountPatch, ensurePagerSession, refreshPagerSessionWithCredentials } from "./pager-session.js";
import { classifyProofFromImage, classifyProofFromText } from "./proof-classifier.js";
import type {
  ChannelRuntimeState,
  ChatState,
  ConversationRuntimeState,
  StateStore,
} from "./state-store.js";
import { resolveCmTemplateFolderId, resolveEgTemplateFolderId, resolveScriptTextByKey, resolveTemplateText, resolveZmTemplateFolderId } from "./template-resolver.js";
import {
  countApiStatusFolders,
  isFunnelFollowUpFolderName,
  mergeStatusFolderList,
  conversationAllowedInFolders,
  getEnabledFolderIds,
  hasEnabledStatusFolders,
} from "./status-folders.js";
import type { TemplateRole } from "./config.js";
import type { TelegramApi } from "./telegram-api.js";

type WorkerDeps = {
  env: AppEnv;
  config: BotConfig;
  stateStore: StateStore;
  telegram: TelegramApi;
};

const MAX_SEND_FAILURES = 5;
const MAX_CONVERSATIONS_PER_ACCOUNT = 400;
const MAX_CONVERSATIONS_ZM_ACCOUNT = 30;
const INBOX_TOP = 25;
const INBOX_TOP_EG_CM = 30;

/** Prevents double-reply to the same customer line within one worker cycle. */
const handledCustomerTurns = new Set<string>();

function customerTurnKey(convId: string, customerMessageId: string): string {
  return `${convId}:${customerMessageId}`;
}

function markCustomerTurnHandled(convId: string, customerMessageId: string): void {
  handledCustomerTurns.add(customerTurnKey(convId, customerMessageId));
}

function isCustomerTurnHandled(convId: string, customerMessageId: string): boolean {
  return handledCustomerTurns.has(customerTurnKey(convId, customerMessageId));
}

export async function runPagerWorker(deps: WorkerDeps): Promise<never> {
  const pollMs = deps.config.bot.pollIntervalSeconds * 1000;
  console.log(`Pager worker started (every ${deps.config.bot.pollIntervalSeconds}s)`);

  while (true) {
    const started = Date.now();
    try {
      await processPagerAccounts(deps);
    } catch (error) {
      console.error("Pager worker cycle failed:", error);
    }
    const elapsed = Date.now() - started;
    await sleep(Math.max(1000, pollMs - elapsed));
  }
}

async function processPagerAccounts(deps: WorkerDeps): Promise<void> {
  const states = await deps.stateStore.listAll();
  const connected = states.filter(
    (state) =>
      state.pagerAccount?.cookies?.trim() ||
      (state.pagerAccount?.email && state.pagerAccount?.password),
  );

  if (!connected.length) {
    console.log("Pager worker: no connected Pager accounts in state store");
    return;
  }

  const ordered = [...connected].sort((left, right) => {
    const leftEgCm = accountHasEgOrCm(left, deps.config);
    const rightEgCm = accountHasEgOrCm(right, deps.config);
    if (leftEgCm !== rightEgCm) {
      return leftEgCm ? -1 : 1;
    }
    return 0;
  });

  await Promise.all(
    ordered.map((state) =>
      processOperatorAccount(deps, state).catch((error) => {
        console.error(`Pager worker: account ${state.chatId} failed:`, formatError(error));
      }),
    ),
  );
}

function accountHasEgOrCm(state: ChatState, config: BotConfig): boolean {
  for (const channelId of collectEnabledChannelIdsFromState(state)) {
    const country =
      state.channels?.[channelId]?.country ??
      getChannelConfig(config, channelId)?.country ??
      inferCountryFromChannelName(
        state.pagerAccount?.liveChannels?.find((channel) => channel.id === channelId)?.name ?? "",
      );
    if (country === "EG" || country === "CM") {
      return true;
    }
  }
  return false;
}

async function processOperatorAccount(deps: WorkerDeps, state: ChatState): Promise<void> {
  handledCustomerTurns.clear();
  let freshState = hydrateOperatorState((await deps.stateStore.get(state.chatId)) ?? state);

  if (freshState.paused) {
    console.log(`Pager worker: chat ${freshState.chatId} — paused (/reset_pause to resume)`);
    return;
  }

  const sessionResult = await ensurePagerSession(
    { env: deps.env, stateStore: deps.stateStore },
    freshState,
  );
  if (!sessionResult) {
    console.warn(
      `Pager worker: chat ${freshState.chatId} — no valid Pager session. Re-login via «Email + пароль» in the bot.`,
    );
    return;
  }

  freshState = hydrateOperatorState(sessionResult.state);
  let client = sessionResult.client;

  freshState = (await refreshLiveChannelsFromApi(deps, freshState, client)) ?? freshState;
  freshState = hydrateOperatorState(freshState);

  freshState = (await normalizeEnabledChannelsToConfig(deps, freshState)) ?? freshState;
  freshState = hydrateOperatorState(freshState);

  if (countApiStatusFolders(freshState.statusFolders) === 0) {
    freshState = (await ensureStatusFolders(deps, freshState, client)) ?? freshState;
    freshState = hydrateOperatorState(freshState);
  }

  freshState = hydrateOperatorState((await deps.stateStore.get(freshState.chatId)) ?? freshState);

  if (!collectEnabledChannelIdsFromState(freshState).length) {
    freshState = (await seedEnabledChannelsFromYaml(deps, freshState)) ?? freshState;
    freshState = hydrateOperatorState(freshState);
    console.log(
      `Pager worker: chat ${freshState.chatId} — enabled ${freshState.enabledChannelIds?.length ?? 0} channel(s) from config`,
    );
  }

  const enabledChannels = getEnabledChannels(deps.config, freshState);
  const liveCoverage = getLiveChannelCoverage(deps.config, freshState);
  const enabledEgChannels = enabledChannels.filter((item) => item.runtime.country === "EG");
  const enabledEgInState = collectEnabledChannelIdsFromState(freshState).filter((channelId) => {
    const country =
      freshState.channels?.[channelId]?.country ??
      getChannelConfig(deps.config, channelId)?.country ??
      inferCountryFromChannelName(
        freshState.pagerAccount?.liveChannels?.find((channel) => channel.id === channelId)?.name ?? "",
      );
    return country === "EG";
  });

  if (!enabledChannels.length) {
    const liveCount = freshState.pagerAccount?.liveChannels?.length ?? 0;
    console.log(
      `Pager worker: chat ${freshState.chatId} — no enabled channels (live=${liveCount}). Enable a folder in «Папки» or channels in «Каналы».`,
    );
    return;
  }

  if (enabledEgInState.length && !enabledEgChannels.length) {
    console.error(
      `Pager worker: chat ${freshState.chatId} — Egypt channel enabled in settings but missing from poll list (${enabledEgInState.join(", ")}). Re-open «Каналы» and toggle Mahmoud Fathy.`,
    );
  }

  const operatorFolderIds = getEnabledFolderIds(freshState);
  const enabledFolderIds = operatorFolderIds;
  if (enabledFolderIds && enabledFolderIds.size === 0) {
    console.log(`Pager worker: chat ${freshState.chatId} — no status folders enabled`);
    return;
  }

  if (enabledFolderIds) {
    const folderNames = (freshState.statusFolders ?? [])
      .filter((folder) => folder.enabled)
      .map((folder) => folder.name)
      .join(", ");
    console.log(
      `Pager worker: chat ${freshState.chatId} — folders=[${folderNames || "all"}]`,
    );
  }

  const channelIds = enabledChannels.map((item) => item.channelId);
  const channelNames = enabledChannels.map((item) => item.channelName).join(", ");
  if (liveCoverage.missingFromLive.length) {
    console.warn(
      `Pager worker: chat ${freshState.chatId} — enabled channels missing from live session: ${liveCoverage.missingFromLive.join(", ")}`,
    );
  }

  let conversations: PagerConversation[] = [];
  try {
    const pollResult = await pollConversations(deps, freshState, client, channelIds);
    client = pollResult.client;
    conversations = pollResult.conversations;
  } catch (error) {
    console.error(
      `Pager poll failed for chat ${freshState.chatId} (orgId=${client.getOrganizationId().slice(0, 12) || "?"}):`,
      formatError(error),
    );
    return;
  }

  console.log(
    [
      `Pager worker: chat ${freshState.chatId}`,
      `channels=[${channelNames}]`,
      `fetched=${conversations.length} conversations`,
      `egPoll=${enabledEgChannels.map((item) => item.channelName).join(",") || "none"}`,
    ].join(" | "),
  );

  logConversationCountsByChannel(enabledChannels, conversations, freshState.chatId);

  if (!conversations.length) {
    return;
  }

  const folderScopedConversations = enabledFolderIds
    ? conversations.filter((conv) => conversationAllowedInFolders(conv, enabledFolderIds))
    : conversations;
  const workQueue = await buildWorkQueue(
    client,
    folderScopedConversations,
    enabledChannels,
    channelIds,
    enabledFolderIds,
  );
  const accountLimit = enabledChannels.some(
    (item) => item.runtime.country === "EG" || item.runtime.country === "CM",
  )
    ? MAX_CONVERSATIONS_PER_ACCOUNT
    : MAX_CONVERSATIONS_ZM_ACCOUNT;
  const egChannelIds = new Set(
    enabledChannels.filter((item) => item.runtime.country === "EG").map((item) => item.channelId),
  );
  const cmChannelIds = new Set(
    enabledChannels.filter((item) => item.runtime.country === "CM").map((item) => item.channelId),
  );
  const prioritizedConversations = prioritizeWorkQueue(
    workQueue,
    channelIds,
    accountLimit,
    enabledChannels.some((item) => item.runtime.country === "EG" || item.runtime.country === "CM"),
  ).sort((left, right) => {
    const leftChannelId = left.channelId || left.channel?.id || "";
    const rightChannelId = right.channelId || right.channel?.id || "";
    const score = (channelId: string) =>
      egChannelIds.has(channelId) ? 0 : cmChannelIds.has(channelId) ? 1 : 2;
    const leftScore = score(leftChannelId);
    const rightScore = score(rightChannelId);
    if (leftScore !== rightScore) {
      return leftScore - rightScore;
    }
    return conversationPriorityScore(right) - conversationPriorityScore(left);
  });
  const egInWork = workQueue.filter((conv) =>
    egChannelIds.has(conv.channelId || conv.channel?.id || ""),
  ).length;
  console.log(
    `Pager worker: chat ${freshState.chatId} — workQueue=${workQueue.length}/${folderScopedConversations.length}/${conversations.length} egWork=${egInWork} prioritized=${prioritizedConversations.length}`,
  );

  let checked = 0;
  let replied = 0;
  let skipped = 0;
  let egChecked = 0;
  let egReplied = 0;

  for (const conv of prioritizedConversations) {
    const channelId = conv.channelId || conv.channel?.id;
    if (!channelId) {
      skipped += 1;
      continue;
    }

    const runtime = enabledChannels.find((item) => item.channelId === channelId);
    if (!runtime) {
      skipped += 1;
      continue;
    }

    checked += 1;
    const isEg = runtime.runtime.country === "EG";
    if (isEg) {
      egChecked += 1;
    }
    try {
      const didReply = await processConversation(deps, freshState, client, conv, runtime);
      if (didReply) {
        replied += 1;
        if (isEg) {
          egReplied += 1;
        }
      } else {
        skipped += 1;
      }
    } catch (error) {
      if (isRecoverablePagerError(error)) {
        console.warn(
          `Conversation ${conv.id.slice(0, 8)} hit recoverable Pager error for chat ${freshState.chatId}; refreshing session and retrying once`,
        );
        const refreshed = await refreshPagerSessionWithCredentials(deps, freshState);
        if (refreshed) {
          freshState = hydrateOperatorState(refreshed.state);
          client = refreshed.client;
          try {
            const didReply = await processConversation(deps, freshState, client, conv, runtime);
            if (didReply) {
              replied += 1;
              if (isEg) {
                egReplied += 1;
              }
            } else {
              skipped += 1;
            }
            continue;
          } catch (retryError) {
            console.error(
              `Conversation ${conv.id.slice(0, 8)} retry failed for chat ${freshState.chatId}:`,
              formatError(retryError),
            );
          }
        }
      }
      console.error(
        `Conversation ${conv.id.slice(0, 8)} failed for chat ${freshState.chatId}:`,
        formatError(error),
      );
    }
  }

  console.log(
    `Pager worker: chat ${freshState.chatId} — checked=${checked} replied=${replied} skipped=${skipped} egChecked=${egChecked} egReplied=${egReplied}`,
  );
}

function prioritizeWorkQueue(
  conversations: PagerConversation[],
  channelIds: string[],
  limit: number,
  egCmAccount = false,
): PagerConversation[] {
  const scored = [...conversations].sort(
    (left, right) => conversationPriorityScore(right) - conversationPriorityScore(left),
  );
  const selected = new Map<string, PagerConversation>();
  const minPerChannel = egCmAccount
    ? Math.max(20, Math.floor(limit / Math.max(channelIds.length, 1)))
    : Math.min(25, Math.max(8, Math.floor(limit / Math.max(channelIds.length, 1))));

  for (const channelId of channelIds) {
    let picked = 0;
    for (const conv of scored) {
      const convChannelId = conv.channelId || conv.channel?.id;
      if (convChannelId !== channelId || selected.has(conv.id)) {
        continue;
      }
      selected.set(conv.id, conv);
      picked += 1;
      if (picked >= minPerChannel) {
        break;
      }
    }
  }

  for (const conv of scored) {
    if (selected.size >= limit) {
      break;
    }
    selected.set(conv.id, conv);
  }

  return [...selected.values()].sort(
    (left, right) => conversationPriorityScore(right) - conversationPriorityScore(left),
  );
}

function findLatestIncomingFromThread(
  messages: PagerMessage[],
  conv?: PagerConversation,
  country?: "ZM" | "CM" | "EG",
): PagerMessage | undefined {
  return findLatestIncomingMessage(messages, conv, undefined, country);
}

async function buildWorkQueue(
  client: PagerClient,
  folderScopedConversations: PagerConversation[],
  enabledChannels: EnabledChannel[],
  channelIds: string[],
  enabledFolderIds: Set<string> | null,
): Promise<PagerConversation[]> {
  const selected = new Map<string, PagerConversation>();

  for (const channel of enabledChannels) {
    if (channel.runtime.country !== "CM" && channel.runtime.country !== "EG") {
      continue;
    }
    const inboxTop = (
      await client.listConversations({
        channelId: channel.channelId,
        page: 1,
        pageSize: 60,
      })
    ).sort(
      (left, right) => conversationPriorityScore(right) - conversationPriorityScore(left),
    );
    let addedForChannel = 0;
    for (const conv of inboxTop) {
      if (enabledFolderIds && !conversationAllowedInFolders(conv, enabledFolderIds)) {
        continue;
      }
      if (!shouldQueueConversation(conv)) {
        continue;
      }
      selected.set(conv.id, conv);
      addedForChannel += 1;
      if (addedForChannel >= INBOX_TOP_EG_CM) {
        break;
      }
    }
    if (addedForChannel === 0) {
      let fallback = 0;
      for (const conv of folderScopedConversations) {
        if ((conv.channelId || conv.channel?.id) !== channel.channelId) {
          continue;
        }
        if (enabledFolderIds && !conversationAllowedInFolders(conv, enabledFolderIds)) {
          continue;
        }
        if (!shouldQueueConversation(conv)) {
          continue;
        }
        selected.set(conv.id, conv);
        fallback += 1;
        if (fallback >= INBOX_TOP_EG_CM) {
          break;
        }
      }
      addedForChannel = fallback;
      if (fallback) {
        console.log(
          `Pager worker: channel ${channel.channelName}/${channel.runtime.country} folder fallback=${fallback}`,
        );
      }
    }
    console.log(
      `Pager worker: channel ${channel.channelName}/${channel.runtime.country} inbox head=${addedForChannel}`,
    );
  }

  for (const conv of folderScopedConversations) {
    if (shouldQueueConversation(conv)) {
      selected.set(conv.id, conv);
    }
  }

  const channelsNeedingScan = enabledChannels.filter((channel) => {
    if (channel.runtime.country === "CM" || channel.runtime.country === "EG") {
      return false;
    }
    const queued = [...selected.values()].filter(
      (conv) => (conv.channelId || conv.channel?.id) === channel.channelId,
    ).length;
    if (channel.runtime.country === "ZM") {
      return queued < 10;
    }
    return queued === 0;
  });

  for (const channel of channelsNeedingScan) {
    if (channel.runtime.country === "ZM") {
      const inboxTop = (
        await client.listConversations({
          channelId: channel.channelId,
          page: 1,
          pageSize: 50,
        })
      ).sort(
        (left, right) => conversationPriorityScore(right) - conversationPriorityScore(left),
      );
      let addedForChannel = 0;
      for (const conv of inboxTop) {
        if (enabledFolderIds && !conversationAllowedInFolders(conv, enabledFolderIds)) {
          continue;
        }
        if (selected.has(conv.id)) {
          continue;
        }
        if (shouldQueueConversation(conv)) {
          selected.set(conv.id, conv);
          addedForChannel += 1;
        }
        if (addedForChannel >= INBOX_TOP) {
          break;
        }
      }
      if (addedForChannel) {
        console.log(
          `Pager worker: channel ${channel.channelName}/${channel.runtime.country} inbox top added=${addedForChannel}`,
        );
      }
      continue;
    }

    const recentHead = folderScopedConversations
      .filter((conv) => (conv.channelId || conv.channel?.id) === channel.channelId)
      .sort(
        (left, right) =>
          Date.parse(resolveLastMessageAt(right) ?? "") - Date.parse(resolveLastMessageAt(left) ?? ""),
      )
      .slice(0, 30);

    let addedForChannel = 0;
    for (const conv of recentHead) {
      if (selected.has(conv.id)) {
        continue;
      }
      if (shouldQueueConversation(conv)) {
        selected.set(conv.id, conv);
        addedForChannel += 1;
      }
    }
    if (addedForChannel) {
      console.log(
        `Pager worker: channel ${channel.channelName}/${channel.runtime.country} cached head added=${addedForChannel}`,
      );
    }
  }

  if (!selected.size && channelIds.length) {
    console.warn(
      `Pager worker: no actionable conversations after inbox scan (channels=${channelIds.length})`,
    );
  }

  return [...selected.values()];
}

async function processConversation(
  deps: WorkerDeps,
  state: ChatState,
  client: PagerClient,
  conv: PagerConversation,
  runtime: EnabledChannel,
): Promise<boolean> {
  const channel = buildRuntimeChannelConfig(deps.config, state, runtime);
  if (channel.country === "CM") {
    return processCmConversation(deps, state, client, conv, runtime, channel);
  }
  if (channel.country === "ZM") {
    return processZmConversation(deps, state, client, conv, runtime, channel);
  }
  if (channel.country === "EG") {
    return processEgConversation(deps, state, client, conv, runtime, channel);
  }
  return processGenericConversation(deps, state, client, conv, runtime, channel);
}

async function processCmConversation(
  deps: WorkerDeps,
  state: ChatState,
  client: PagerClient,
  conv: PagerConversation,
  runtime: EnabledChannel,
  channel: ReturnType<typeof buildRuntimeChannelConfig>,
): Promise<boolean> {
  const convId = conv.id;

  const currentState = (await deps.stateStore.get(state.chatId)) ?? state;
  const convState = getConversationState(currentState, convId, runtime.channelId);
  if ((convState.sendFailures ?? 0) >= MAX_SEND_FAILURES) {
    return false;
  }

  const messages = await client.listMessages(convId, 1, 80);
  if (!messages.length) {
    return false;
  }

  const sorted = [...messages].sort(
    (left, right) => Date.parse(right.createdAt ?? "") - Date.parse(left.createdAt ?? ""),
  );
  const lastIncoming = findLatestIncomingFromThread(sorted, conv, "CM");
  if (!lastIncoming) {
    return false;
  }

  const outgoingTexts = collectCmOutgoingTexts(messages);
  const latestCustomerText = (lastIncoming.text || "").trim();
  const recentCustomerTexts = recentCustomerMessageTexts(sorted, conv);
  const tierChosenRecently = recentCustomerTexts.some((line) => isDepositTierChoice(line));
  const awaitingRegAfterTierChoice =
    tierSentInHistory(outgoingTexts) &&
    !cmRegLinkSentInHistory(outgoingTexts) &&
    (isDepositTierChoice(latestCustomerText) ||
      tierChosenRecently ||
      isRegistrationAccountQuestion(latestCustomerText) ||
      isCmRegistrationHelpRequest(latestCustomerText));

  const operatorUserId = await client.probeOperatorUserId();

  if (
    !(await ensureCustomerMessageEligible(
      deps,
      state,
      conv,
      convId,
      convState,
      lastIncoming,
      sorted,
      {
        bypass: awaitingRegAfterTierChoice,
        forceContinuation: awaitingRegAfterTierChoice,
        operatorUserId,
        countryLabel: "CM",
        country: "CM",
      },
    ))
  ) {
    return false;
  }

  if (isCustomerTurnHandled(convId, lastIncoming.id) && !awaitingRegAfterTierChoice) {
    return false;
  }

  await tryTakeConversationForProcessing(client, convId);

  const threadStep = cmInferStepFromThread(messages);
  const gapStep = cmFunnelStepFromScriptGaps(outgoingTexts, convState.funnelStep ?? 0);
  const effectiveStep = Math.max(threadStep, gapStep, convState.funnelStep ?? 0);
  const imageUrl = extractProofImageUrl(lastIncoming);
  const messageReaction = resolveMessageReaction(lastIncoming);
  const playbook = getPlaybook(deps.config, channel.country);

  const specialHandled = await trySendSpecialCustomerResponse(deps, {
    state,
    client,
    conv,
    runtime,
    channel,
    convState,
    convId,
    lastIncoming,
    text: latestCustomerText,
    playbook,
  });
  if (specialHandled) {
    return true;
  }

  if (imageUrl) {
    const imageHandled = await tryHandleCustomerImage(deps, {
      state,
      client,
      conv,
      runtime,
      channel,
      convState,
      convId,
      lastIncoming,
      text: latestCustomerText,
      imageUrl,
      playbook,
      outgoingTexts,
    });
    if (imageHandled) {
      return true;
    }
  }

  const intent = classifyCmMessage(latestCustomerText, {
    hasImage: Boolean(imageUrl),
    funnelStep: effectiveStep,
    messageReaction,
  });

  let scriptKeys = resolveCmFunnelScripts(
    effectiveStep,
    latestCustomerText,
    intent,
    outgoingTexts,
    { hasImage: Boolean(imageUrl), messageReaction, recentCustomerTexts },
  );
  scriptKeys = limitCmScriptsForCustomerTurn(scriptKeys, outgoingTexts);

  if (!scriptKeys.length) {
    console.log(
      `Pager worker: skip ${convId.slice(0, 8)} CM — no script (step=${effectiveStep}, intent=${intent}, text=${truncate(latestCustomerText)})`,
    );
    return false;
  }

  console.log(
    `Pager worker: CM ${convId.slice(0, 8)} step=${effectiveStep} intent=${intent} scripts=[${scriptKeys.join(",")}]`,
  );

  const folderId = await resolveCmTemplateFolderId(
    client,
    runtime.runtime.templateBankId,
    currentState.pagerAccount?.liveTemplateBanks,
  );

  let sentAny = false;
  const allowMultiSend =
    scriptKeys.includes("01_intro") || scriptKeys.some((key) => CM_REG_SEND_KEYS.has(key));
  for (const scriptKey of scriptKeys) {
    const replyText = await resolveScriptTextByKey(client, {
      folderId,
      liveBanks: currentState.pagerAccount?.liveTemplateBanks,
      scriptKey,
      country: "CM",
    });
    if (!replyText?.trim()) {
      if (scriptKey === "01_intro_2") {
        console.warn(`CM script optional miss ${convId.slice(0, 8)}: ${scriptKey}`);
        continue;
      }
      if (scriptKey === "06_link" && sentAny) {
        const fallbackLink = "https://tinyurl.com/Camerun01";
        const sent = await client.sendMessageReliable(convId, fallbackLink, {
          channelId: runtime.channelId,
          conv,
        });
        if (sent) {
          sentAny = true;
          await sleep(500);
        }
        continue;
      }
      console.warn(
        `CM script missing folder=${folderId?.slice(0, 8) ?? "?"} key=${scriptKey} liveBanks=${currentState.pagerAccount?.liveTemplateBanks?.map((bank) => bank.name).join(",") ?? "none"}`,
      );
      continue;
    }

    const sent = await client.sendMessageReliable(convId, replyText.trim(), {
      channelId: runtime.channelId,
      conv,
    });
    if (!sent) {
      const failures = (convState.sendFailures ?? 0) + 1;
      await patchConversationState(deps.stateStore, state.chatId, convId, {
        sendFailures: failures,
      });
      console.error(`Pager worker: CM send failed ${convId.slice(0, 8)} key=${scriptKey}`);
      return sentAny;
    }
    sentAny = true;
    markCustomerTurnHandled(convId, lastIncoming.id);
    await patchConversationState(deps.stateStore, state.chatId, convId, {
      conversationId: convId,
      channelId: runtime.channelId,
      lastCustomerMessageId: lastIncoming.id,
      lastCustomerMessageAt: lastIncoming.createdAt,
      lastReplyAt: new Date().toISOString(),
      lastReplyRole: scriptKey,
      sendFailures: 0,
    });
    await sleep(500);
    if (!allowMultiSend) {
      break;
    }
  }

  if (!sentAny) {
    return false;
  }

  if (cmRegSendTriggersInProgress(scriptKeys)) {
    const statusId = findFunnelFollowUpStatusId(currentState);
    const operatorId = await client.probeOperatorUserId();
    if (statusId && operatorId) {
      try {
        await client.patchConversationStatus(convId, statusId, operatorId);
        console.log(`Pager worker: CM ${convId.slice(0, 8)} status -> in progress`);
      } catch (error) {
        console.warn(`Pager worker: status patch failed ${convId.slice(0, 8)}:`, formatError(error));
      }
    }
  }

  await patchConversationState(deps.stateStore, state.chatId, convId, {
    conversationId: convId,
    channelId: runtime.channelId,
    currentStage: effectiveStep >= 5 ? "registered" : effectiveStep >= 1 ? "engaged" : "new_lead",
    funnelStep: Math.max(effectiveStep, scriptKeys.includes("09_deposit") ? 6 : effectiveStep),
    lastCustomerMessageId: lastIncoming.id,
    lastCustomerMessageAt: lastIncoming.createdAt,
    lastReplyAt: new Date().toISOString(),
    lastReplyRole: scriptKeys[scriptKeys.length - 1],
    sendFailures: 0,
  });

  return true;
}

async function processZmConversation(
  deps: WorkerDeps,
  state: ChatState,
  client: PagerClient,
  conv: PagerConversation,
  runtime: EnabledChannel,
  channel: ReturnType<typeof buildRuntimeChannelConfig>,
): Promise<boolean> {
  const convId = conv.id;

  const currentState = (await deps.stateStore.get(state.chatId)) ?? state;
  const convState = getConversationState(currentState, convId, runtime.channelId);
  if ((convState.sendFailures ?? 0) >= MAX_SEND_FAILURES) {
    return false;
  }

  const messages = await client.listMessages(convId, 1, 80);
  if (!messages.length) {
    return false;
  }

  const sorted = [...messages].sort(
    (left, right) => Date.parse(right.createdAt ?? "") - Date.parse(left.createdAt ?? ""),
  );
  const lastIncoming = findLatestIncomingFromThread(sorted, conv, "ZM");
  if (!lastIncoming) {
    return false;
  }

  const outgoingTexts = collectZmOutgoingTexts(messages);
  const latestCustomerText = (lastIncoming.text || "").trim();
  const recentCustomerTexts = recentCustomerMessageTexts(sorted, conv);
  const operatorUserId = await client.probeOperatorUserId();

  if (
    !(await ensureCustomerMessageEligible(
      deps,
      state,
      conv,
      convId,
      convState,
      lastIncoming,
      sorted,
      {
        operatorUserId,
        countryLabel: "ZM",
        country: "ZM",
      },
    ))
  ) {
    return false;
  }

  if (isCustomerTurnHandled(convId, lastIncoming.id)) {
    return false;
  }

  await tryTakeConversationForProcessing(client, convId);

  const threadStep = zmInferStepFromThread(messages);
  const gapStep = zmFunnelStepFromScriptGaps(outgoingTexts, convState.funnelStep ?? 0);
  const effectiveStep = Math.max(threadStep, gapStep, convState.funnelStep ?? 0);
  const imageUrl = extractProofImageUrl(lastIncoming);
  const messageReaction = resolveMessageReaction(lastIncoming);
  const playbook = getPlaybook(deps.config, channel.country);

  const specialHandled = await trySendSpecialCustomerResponse(deps, {
    state,
    client,
    conv,
    runtime,
    channel,
    convState,
    convId,
    lastIncoming,
    text: latestCustomerText,
    playbook,
  });
  if (specialHandled) {
    return true;
  }

  if (imageUrl) {
    const imageHandled = await tryHandleCustomerImage(deps, {
      state,
      client,
      conv,
      runtime,
      channel,
      convState,
      convId,
      lastIncoming,
      text: latestCustomerText,
      imageUrl,
      playbook,
      outgoingTexts,
    });
    if (imageHandled) {
      return true;
    }
  }

  const intent = classifyZmMessage(latestCustomerText, {
    hasImage: Boolean(imageUrl),
    funnelStep: effectiveStep,
    messageReaction,
  });

  let scriptKeys = resolveZmFunnelScripts(
    effectiveStep,
    latestCustomerText,
    intent,
    outgoingTexts,
    { hasImage: Boolean(imageUrl), messageReaction, recentCustomerTexts },
  );
  scriptKeys = limitZmScriptsForCustomerTurn(scriptKeys, outgoingTexts);

  if (!scriptKeys.length) {
    console.log(
      `Pager worker: skip ${convId.slice(0, 8)} ZM — no script (step=${effectiveStep}, intent=${intent}, text=${truncate(latestCustomerText)})`,
    );
    return false;
  }

  console.log(
    `Pager worker: ZM ${convId.slice(0, 8)} step=${effectiveStep} intent=${intent} scripts=[${scriptKeys.join(",")}]`,
  );

  const folderId = await resolveZmTemplateFolderId(
    client,
    runtime.runtime.templateBankId,
    currentState.pagerAccount?.liveTemplateBanks,
  );

  let sentAny = false;
  const allowMultiSend =
    scriptKeys.includes("01_intro") ||
    scriptKeys.some((key) => ZM_EXPLAIN_SEND_KEYS.has(key)) ||
    scriptKeys.some((key) => ZM_REG_SEND_KEYS.has(key));
  for (const scriptKey of scriptKeys) {
    const replyText = await resolveScriptTextByKey(client, {
      folderId,
      liveBanks: currentState.pagerAccount?.liveTemplateBanks,
      scriptKey,
      country: "ZM",
    });
    if (!replyText?.trim()) {
      if (scriptKey === "05_link" && sentAny) {
        const fallbackLink = "https://tinyurl.com/ZAM577";
        const sent = await client.sendMessageReliable(convId, fallbackLink, {
          channelId: runtime.channelId,
          conv,
        });
        if (sent) {
          sentAny = true;
          await sleep(500);
        }
        continue;
      }
      console.warn(
        `ZM script missing folder=${folderId?.slice(0, 8) ?? "?"} key=${scriptKey} liveBanks=${currentState.pagerAccount?.liveTemplateBanks?.map((bank) => bank.name).join(",") ?? "none"}`,
      );
      continue;
    }

    const sent = await client.sendMessageReliable(convId, replyText.trim(), {
      channelId: runtime.channelId,
      conv,
    });
    if (!sent) {
      const failures = (convState.sendFailures ?? 0) + 1;
      await patchConversationState(deps.stateStore, state.chatId, convId, {
        sendFailures: failures,
      });
      console.error(`Pager worker: ZM send failed ${convId.slice(0, 8)} key=${scriptKey}`);
      return sentAny;
    }
    sentAny = true;
    markCustomerTurnHandled(convId, lastIncoming.id);
    await patchConversationState(deps.stateStore, state.chatId, convId, {
      conversationId: convId,
      channelId: runtime.channelId,
      lastCustomerMessageId: lastIncoming.id,
      lastCustomerMessageAt: lastIncoming.createdAt,
      lastReplyAt: new Date().toISOString(),
      lastReplyRole: scriptKey,
      sendFailures: 0,
    });
    if (scriptKey === "07_game_id") {
      const attachment = resolveScriptAttachment("ZM", scriptKey);
      if (attachment) {
        try {
          const imageSent = await client.sendImageReliable(
            convId,
            {
              buffer: readFileSync(attachment.path),
              mimeType: attachment.mimeType,
              filename: attachment.filename,
            },
            {
              channelId: runtime.channelId,
              conv,
            },
          );
          if (!imageSent) {
            console.warn(`Pager worker: ZM image miss ${convId.slice(0, 8)} key=${scriptKey}`);
          }
        } catch (error) {
          console.warn(
            `Pager worker: ZM image failed ${convId.slice(0, 8)} key=${scriptKey}:`,
            formatError(error),
          );
        }
      }
    }
    await sleep(500);
    if (!allowMultiSend) {
      break;
    }
  }

  if (!sentAny) {
    return false;
  }

  if (zmRegSendTriggersInProgress(scriptKeys) || zmStatusMoveTriggersInProgress(scriptKeys)) {
    const statusId = findFunnelFollowUpStatusId(currentState);
    const operatorId = await client.probeOperatorUserId();
    if (statusId && operatorId) {
      try {
        await client.patchConversationStatus(convId, statusId, operatorId);
        console.log(`Pager worker: ZM ${convId.slice(0, 8)} status -> in progress`);
      } catch (error) {
        console.warn(`Pager worker: status patch failed ${convId.slice(0, 8)}:`, formatError(error));
      }
    }
  }

  await patchConversationState(deps.stateStore, state.chatId, convId, {
    conversationId: convId,
    channelId: runtime.channelId,
    currentStage: effectiveStep >= 5 ? "registered" : effectiveStep >= 1 ? "engaged" : "new_lead",
    funnelStep: Math.max(effectiveStep, scriptKeys.includes("06_deposit") ? 6 : effectiveStep),
    lastCustomerMessageId: lastIncoming.id,
    lastCustomerMessageAt: lastIncoming.createdAt,
    lastReplyAt: new Date().toISOString(),
    lastReplyRole: scriptKeys[scriptKeys.length - 1],
    sendFailures: 0,
  });

  return true;
}

async function processEgConversation(
  deps: WorkerDeps,
  state: ChatState,
  client: PagerClient,
  conv: PagerConversation,
  runtime: EnabledChannel,
  channel: ReturnType<typeof buildRuntimeChannelConfig>,
): Promise<boolean> {
  const convId = conv.id;

  const currentState = (await deps.stateStore.get(state.chatId)) ?? state;
  const convState = getConversationState(currentState, convId, runtime.channelId);
  if ((convState.sendFailures ?? 0) >= MAX_SEND_FAILURES) {
    return false;
  }

  const messages = await client.listMessages(convId, 1, 80);
  if (!messages.length) {
    return false;
  }

  const sorted = [...messages].sort(
    (left, right) => Date.parse(right.createdAt ?? "") - Date.parse(left.createdAt ?? ""),
  );
  const lastIncoming = findLatestIncomingFromThread(sorted, conv, "EG");
  if (!lastIncoming) {
    console.log(
      `Pager worker: EG ${convId.slice(0, 8)} — no_customer_message (msgs=${messages.length}, dir=${sorted[0]?.messageDirection ?? "?"})`,
    );
    return false;
  }

  const outgoingTexts = collectEgOutgoingTexts(messages);
  const latestCustomerText = (lastIncoming.text || "").trim();
  const recentCustomerTexts = recentCustomerMessageTexts(sorted, conv);
  const tierChosenRecently = recentCustomerTexts.some((line) => isEgDepositTierChoice(line));
  const awaitingRegAfterTierChoice =
    explainScriptsSentInHistory(outgoingTexts) &&
    !egRegLinkSentInHistory(outgoingTexts) &&
    (isEgDepositTierChoice(latestCustomerText) || tierChosenRecently);

  const operatorUserId = await client.probeOperatorUserId();

  if (
    !(await ensureCustomerMessageEligible(
      deps,
      state,
      conv,
      convId,
      convState,
      lastIncoming,
      sorted,
      {
        bypass: awaitingRegAfterTierChoice,
        forceContinuation: awaitingRegAfterTierChoice,
        operatorUserId,
        countryLabel: "EG",
        country: "EG",
      },
    ))
  ) {
    return false;
  }

  if (isCustomerTurnHandled(convId, lastIncoming.id) && !awaitingRegAfterTierChoice) {
    return false;
  }

  await tryTakeConversationForProcessing(client, convId, "EG");

  const threadStep = egInferStepFromThread(messages);
  const gapStep = egFunnelStepFromScriptGaps(outgoingTexts, convState.funnelStep ?? 0);
  const effectiveStep = Math.max(threadStep, gapStep, convState.funnelStep ?? 0);
  const imageUrl = extractProofImageUrl(lastIncoming);
  const messageReaction = resolveMessageReaction(lastIncoming);
  const playbook = getPlaybook(deps.config, channel.country);

  const specialHandled = await trySendSpecialCustomerResponse(deps, {
    state,
    client,
    conv,
    runtime,
    channel,
    convState,
    convId,
    lastIncoming,
    text: latestCustomerText,
    playbook,
  });
  if (specialHandled) {
    return true;
  }

  if (imageUrl) {
    const imageHandled = await tryHandleCustomerImage(deps, {
      state,
      client,
      conv,
      runtime,
      channel,
      convState,
      convId,
      lastIncoming,
      text: latestCustomerText,
      imageUrl,
      playbook,
      outgoingTexts,
    });
    if (imageHandled) {
      return true;
    }
  }

  const intent = classifyEgMessage(latestCustomerText, {
    hasImage: Boolean(imageUrl),
    funnelStep: effectiveStep,
    messageReaction,
  });

  let scriptKeys = resolveEgFunnelScripts(
    effectiveStep,
    latestCustomerText,
    intent,
    outgoingTexts,
    { hasImage: Boolean(imageUrl), messageReaction, recentCustomerTexts },
  );
  scriptKeys = limitEgScriptsForCustomerTurn(scriptKeys, outgoingTexts);

  if (!scriptKeys.length) {
    console.log(
      `Pager worker: skip ${convId.slice(0, 8)} EG — no script (step=${effectiveStep}, intent=${intent}, text=${truncate(latestCustomerText)})`,
    );
    return false;
  }

  console.log(
    `Pager worker: EG ${convId.slice(0, 8)} step=${effectiveStep} intent=${intent} scripts=[${scriptKeys.join(",")}]`,
  );

  const folderId = await resolveEgTemplateFolderId(
    client,
    runtime.runtime.templateBankId,
    currentState.pagerAccount?.liveTemplateBanks,
  );

  let sentAny = false;
  const allowMultiSend =
    scriptKeys.includes("01_intro") ||
    scriptKeys.includes("02_how_it_works") ||
    scriptKeys.some((key) => EG_REG_SEND_KEYS.has(key));
  for (const scriptKey of scriptKeys) {
    const replyText = await resolveScriptTextByKey(client, {
      folderId,
      liveBanks: currentState.pagerAccount?.liveTemplateBanks,
      scriptKey,
      country: "EG",
    });
    if (!replyText?.trim()) {
      if (scriptKey === "05_link" && sentAny) {
        const fallbackLink = "https://tinyurl.com/Egypt0011";
        const sent = await client.sendMessageReliable(convId, fallbackLink, {
          channelId: runtime.channelId,
          conv,
        });
        if (sent) {
          sentAny = true;
          await sleep(500);
        }
        continue;
      }
      console.warn(
        `EG script missing folder=${folderId?.slice(0, 8) ?? "?"} key=${scriptKey} liveBanks=${currentState.pagerAccount?.liveTemplateBanks?.map((bank) => bank.name).join(",") ?? "none"}`,
      );
      continue;
    }

    const sent = await client.sendMessageReliable(convId, replyText.trim(), {
      channelId: runtime.channelId,
      conv,
    });
    if (!sent) {
      const failures = (convState.sendFailures ?? 0) + 1;
      await patchConversationState(deps.stateStore, state.chatId, convId, {
        sendFailures: failures,
      });
      console.error(`Pager worker: EG send failed ${convId.slice(0, 8)} key=${scriptKey}`);
      return sentAny;
    }
    sentAny = true;
    markCustomerTurnHandled(convId, lastIncoming.id);
    await patchConversationState(deps.stateStore, state.chatId, convId, {
      conversationId: convId,
      channelId: runtime.channelId,
      lastCustomerMessageId: lastIncoming.id,
      lastCustomerMessageAt: lastIncoming.createdAt,
      lastReplyAt: new Date().toISOString(),
      lastReplyRole: scriptKey,
      sendFailures: 0,
    });
    await sleep(500);
    if (!allowMultiSend) {
      break;
    }
  }

  if (!sentAny) {
    return false;
  }

  if (egRegSendTriggersInProgress(scriptKeys)) {
    const statusId = findFunnelFollowUpStatusId(currentState);
    const operatorId = await client.probeOperatorUserId();
    if (statusId && operatorId) {
      try {
        await client.patchConversationStatus(convId, statusId, operatorId);
        console.log(`Pager worker: EG ${convId.slice(0, 8)} status -> in progress`);
      } catch (error) {
        console.warn(`Pager worker: status patch failed ${convId.slice(0, 8)}:`, formatError(error));
      }
    }
  }

  await patchConversationState(deps.stateStore, state.chatId, convId, {
    conversationId: convId,
    channelId: runtime.channelId,
    currentStage: effectiveStep >= 5 ? "registered" : effectiveStep >= 1 ? "engaged" : "new_lead",
    funnelStep: Math.max(effectiveStep, scriptKeys.includes("06_deposit") ? 6 : effectiveStep),
    lastCustomerMessageId: lastIncoming.id,
    lastCustomerMessageAt: lastIncoming.createdAt,
    lastReplyAt: new Date().toISOString(),
    lastReplyRole: scriptKeys[scriptKeys.length - 1],
    sendFailures: 0,
  });

  return true;
}

async function processGenericConversation(
  deps: WorkerDeps,
  state: ChatState,
  client: PagerClient,
  conv: PagerConversation,
  runtime: EnabledChannel,
  channel: ReturnType<typeof buildRuntimeChannelConfig>,
): Promise<boolean> {
  const convId = conv.id;

  const currentState = (await deps.stateStore.get(state.chatId)) ?? state;
  const convState = getConversationState(currentState, convId, runtime.channelId);

  if ((convState.sendFailures ?? 0) >= MAX_SEND_FAILURES) {
    return false;
  }

  const messages = await client.listMessages(convId, 1, 50);
  if (!messages.length) {
    return false;
  }

  const sorted = [...messages].sort(
    (left, right) => Date.parse(right.createdAt ?? "") - Date.parse(left.createdAt ?? ""),
  );
  const lastIncoming = findLatestIncomingFromThread(sorted, conv, channel.country);
  if (!lastIncoming) {
    return false;
  }

  const operatorUserId = await client.probeOperatorUserId();

  if (
    !(await ensureCustomerMessageEligible(
      deps,
      state,
      conv,
      convId,
      convState,
      lastIncoming,
      sorted,
      { operatorUserId, country: channel.country },
    ))
  ) {
    return false;
  }

  await tryTakeConversationForProcessing(client, convId);

  const playbook = getPlaybook(deps.config, channel.country);
  const latestCustomerText = (lastIncoming.text || "").trim();
  const imageUrl = extractProofImageUrl(lastIncoming);

  const specialHandled = await trySendSpecialCustomerResponse(deps, {
    state,
    client,
    conv,
    runtime,
    channel,
    convState,
    convId,
    lastIncoming,
    text: latestCustomerText,
    playbook,
  });
  if (specialHandled) {
    return true;
  }

  let proofKind;
  if (imageUrl) {
    try {
      const image = await client.downloadAttachment(imageUrl);
      const classification = await classifyProofFromImage(playbook, image, {
        caption: latestCustomerText,
        ocrEnabled: deps.env.OCR_ENABLED,
        ocrLang: ocrLangForCountry(channel.country),
      });
      proofKind = classification.proofKind;
    } catch (error) {
      console.warn(`OCR failed for ${convId.slice(0, 8)}:`, formatError(error));
      const classification = classifyProofFromText(playbook, latestCustomerText);
      proofKind = classification.proofKind;
    }
  }

  const decision = decideNextAction(deps.config, channel, {
    channelId: channel.id,
    currentStage: convState.currentStage,
    latestCustomerText: latestCustomerText || (imageUrl ? "(image)" : undefined),
    proofKind,
  });

  if (!decision?.templateRole) {
    console.log(
      `Pager worker: skip ${convId.slice(0, 8)} — no rule matched (stage=${convState.currentStage}, text=${truncate(latestCustomerText)})`,
    );
    return false;
  }

  const templateRole = decision.templateRole;
  const replyText = await resolveTemplateText(deps.config, client, {
    folderId: runtime.runtime.templateBankId,
    yamlBankName: channel.templateBank,
    role: templateRole,
    country: channel.country,
  });

  if (!replyText?.trim()) {
    console.warn(`No template text resolved for ${convId.slice(0, 8)} role=${templateRole}`);
    return false;
  }

  console.log(
    `Pager worker: sending to ${convId.slice(0, 8)} channel=${runtime.channelName} role=${templateRole} bank=${runtime.runtime.templateBankId?.slice(0, 8) ?? "yaml"}`,
  );

  const sent = await client.sendMessageReliable(convId, replyText.trim(), {
    channelId: runtime.channelId,
    conv,
  });

  if (!sent) {
    const failures = (convState.sendFailures ?? 0) + 1;
    await patchConversationState(deps.stateStore, state.chatId, convId, {
      sendFailures: failures,
    });
    console.error(`Pager worker: send failed for ${convId.slice(0, 8)} (failures=${failures})`);
    return false;
  }

  await patchConversationState(deps.stateStore, state.chatId, convId, {
    conversationId: convId,
    channelId: runtime.channelId,
    currentStage: decision.nextStage,
    lastCustomerMessageId: lastIncoming.id,
    lastCustomerMessageAt: lastIncoming.createdAt,
    lastReplyAt: new Date().toISOString(),
    lastReplyRole: templateRole,
    sendFailures: 0,
  });

  return true;
}

function findFunnelFollowUpStatusId(state: ChatState): string | undefined {
  for (const folder of state.statusFolders ?? []) {
    if (isFunnelFollowUpFolderName(folder.name)) {
      return folder.id;
    }
  }
  return undefined;
}

type EnabledChannel = {
  channelId: string;
  channelName: string;
  runtime: ChannelRuntimeState;
};

function isChannelAllowed(config: BotConfig, state: ChatState, channelId: string): boolean {
  if (isChannelConfigured(config, channelId)) {
    return true;
  }
  return Boolean(state.channels?.[channelId]?.country);
}

function getEnabledChannels(config: BotConfig, state: ChatState): EnabledChannel[] {
  const enabledIds = new Set(
    collectEnabledChannelIdsFromState(state).filter((channelId) =>
      isChannelAllowed(config, state, channelId),
    ),
  );
  const liveChannels = state.pagerAccount?.liveChannels ?? [];
  const enabled: EnabledChannel[] = [];

  if (liveChannels.length) {
    const added = new Set<string>();
    for (const channel of liveChannels) {
      if (!enabledIds.has(channel.id)) {
        continue;
      }
      const yamlChannel = getChannelConfig(config, channel.id);
      const country =
        state.channels?.[channel.id]?.country ??
        yamlChannel?.country ??
        inferCountryFromChannelName(channel.name);
      const bank = pickLiveTemplateBank(state, country);
      const runtime =
        state.channels?.[channel.id] ??
        ({
          enabled: true,
          country,
          templateBank: yamlChannel?.templateBank ?? bank?.name,
          templateBankId: bank?.id,
        } satisfies ChannelRuntimeState);
      enabled.push({
        channelId: channel.id,
        channelName: channel.name,
        runtime,
      });
      added.add(channel.id);
    }
    for (const channelId of enabledIds) {
      if (added.has(channelId)) {
        continue;
      }
      const yamlChannel = getChannelConfig(config, channelId);
      const liveChannel = liveChannels.find((channel) => channel.id === channelId);
      const country =
        state.channels?.[channelId]?.country ??
        yamlChannel?.country ??
        inferCountryFromChannelName(liveChannel?.name ?? yamlChannel?.name ?? "");
      const bank = pickLiveTemplateBank(state, country);
      const runtime =
        state.channels?.[channelId] ??
        ({
          enabled: true,
          country,
          templateBank: yamlChannel?.templateBank ?? bank?.name,
          templateBankId: bank?.id,
        } satisfies ChannelRuntimeState);
      enabled.push({
        channelId,
        channelName: liveChannel?.name ?? yamlChannel?.name ?? channelId.slice(0, 8),
        runtime,
      });
    }
    return enabled;
  }

  for (const channelId of enabledIds) {
    const yamlChannel = getChannelConfig(config, channelId);
    const country =
      state.channels?.[channelId]?.country ??
      yamlChannel?.country ??
      inferCountryFromChannelName(yamlChannel?.name ?? "");
    const bank = pickLiveTemplateBank(state, country);
    const runtime =
      state.channels?.[channelId] ??
      ({
        enabled: true,
        country,
        templateBank: yamlChannel?.templateBank ?? bank?.name,
        templateBankId: bank?.id,
      } satisfies ChannelRuntimeState);
    enabled.push({
      channelId,
      channelName: yamlChannel?.name ?? channelId.slice(0, 8),
      runtime,
    });
  }
  return enabled;
}

function logConversationCountsByChannel(
  enabledChannels: EnabledChannel[],
  conversations: PagerConversation[],
  chatId: number,
): void {
  const counts = new Map<string, number>();
  for (const conv of conversations) {
    const channelId = conv.channelId || conv.channel?.id;
    if (!channelId) {
      continue;
    }
    counts.set(channelId, (counts.get(channelId) ?? 0) + 1);
  }

  const parts = enabledChannels.map((channel) => {
    const count = counts.get(channel.channelId) ?? 0;
    return `${channel.channelName}/${channel.runtime.country}=${count}`;
  });
  console.log(`Pager worker: chat ${chatId} — perChannel=[${parts.join(", ")}]`);
}

async function refreshLiveChannelsFromApi(
  deps: WorkerDeps,
  state: ChatState,
  client: PagerClient,
): Promise<ChatState | undefined> {
  try {
    const liveChannels = await client.getChannels();
    if (!liveChannels.length) {
      return state;
    }

    const liveTemplateBanks = await client.getTemplateBanks().catch(() => []);
    const channels: Record<string, ChannelRuntimeState> = { ...(state.channels ?? {}) };
    for (const channel of liveChannels) {
      const existing = channels[channel.id];
      const yamlChannel = getChannelConfig(deps.config, channel.id);
      const country =
        existing?.country ??
        yamlChannel?.country ??
        inferCountryFromChannelName(channel.name);
      const bank = pickLiveTemplateBank(
        {
          ...state,
          pagerAccount: {
            ...(state.pagerAccount ?? { authMode: "cookies", connectedAt: state.updatedAt }),
            liveTemplateBanks: liveTemplateBanks.map((item) => ({
              id: item.id,
              name: item.name,
              replyCount: item.replyCount,
            })),
          },
        },
        country,
      );
      channels[channel.id] = {
        enabled: existing?.enabled ?? collectEnabledChannelIdsFromState(state).includes(channel.id),
        country,
        templateBank: existing?.templateBank ?? yamlChannel?.templateBank ?? bank?.name,
        templateBankId: existing?.templateBankId ?? bank?.id,
      };
    }

    return deps.stateStore.patch(state.chatId, {
      channels,
      pagerAccount: {
        ...(state.pagerAccount ?? { authMode: "cookies", connectedAt: state.updatedAt }),
        liveChannels: liveChannels.map((channel) => ({
          id: channel.id,
          name: channel.name,
          channelSource: channel.channelSource,
        })),
        liveTemplateBanks: liveTemplateBanks.map((bank) => ({
          id: bank.id,
          name: bank.name,
          replyCount: bank.replyCount,
        })),
      },
    });
  } catch (error) {
    console.warn(
      `Pager worker: chat ${state.chatId} — live channel refresh failed:`,
      formatError(error),
    );
    return state;
  }
}

async function tryTakeConversationForProcessing(
  client: PagerClient,
  convId: string,
  countryLabel?: string,
): Promise<void> {
  const operatorId = await client.probeOperatorUserId();
  if (!operatorId) {
    return;
  }
  try {
    const taken = await client.takeConversation(convId, operatorId);
    if (taken) {
      const label = countryLabel ? ` ${countryLabel}` : "";
      console.log(`Pager worker: take ${convId.slice(0, 8)}${label} ok`);
    }
  } catch (error) {
    console.warn(`Pager worker: take ${convId.slice(0, 8)} failed:`, formatError(error));
  }
}

function getLiveChannelCoverage(config: BotConfig, state: ChatState): {
  enabledIds: string[];
  missingFromLive: string[];
} {
  const enabledIds = collectEnabledChannelIdsFromState(state).filter((channelId) =>
    isChannelAllowed(config, state, channelId),
  );
  const liveIds = new Set((state.pagerAccount?.liveChannels ?? []).map((channel) => channel.id));
  return {
    enabledIds,
    missingFromLive: enabledIds.filter((channelId) => !liveIds.has(channelId)),
  };
}

function collectEnabledChannelIdsFromState(state: ChatState): string[] {
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

function hydrateOperatorState(state: ChatState): ChatState {
  const enabledChannelIds = collectEnabledChannelIdsFromState(state);
  const statusFolders = state.operatorSettings?.statusFolders ?? state.statusFolders;
  return {
    ...state,
    enabledChannelIds,
    statusFolders,
  };
}

async function normalizeEnabledChannelsToConfig(
  deps: WorkerDeps,
  state: ChatState,
): Promise<ChatState | undefined> {
  const current = collectEnabledChannelIdsFromState(state);
  const filtered = current.filter((channelId) => isChannelAllowed(deps.config, state, channelId));
  if (filtered.length === current.length) {
    return state;
  }

  const channels: Record<string, ChannelRuntimeState> = { ...(state.channels ?? {}) };
  for (const [channelId, runtime] of Object.entries(channels)) {
    channels[channelId] = { ...runtime, enabled: filtered.includes(channelId) };
  }

  const statusFolders = state.operatorSettings?.statusFolders ?? state.statusFolders;
  console.log(
    `Pager worker: chat ${state.chatId} — trimmed enabled channels ${current.length} → ${filtered.length} (config whitelist)`,
  );
  return deps.stateStore.patch(state.chatId, {
    enabledChannelIds: filtered,
    channels,
    operatorSettings: {
      enabledChannelIds: filtered,
      statusFolders,
    },
  });
}

async function seedEnabledChannelsFromYaml(
  deps: WorkerDeps,
  state: ChatState,
): Promise<ChatState | undefined> {
  const live = state.pagerAccount?.liveChannels ?? [];
  if (!live.length) {
    return state;
  }

  const liveIds = new Set(live.map((channel) => channel.id));
  let enabledChannelIds = getConfigEnabledChannelIds(deps.config).filter((channelId) =>
    liveIds.has(channelId),
  );
  if (!enabledChannelIds.length) {
    enabledChannelIds = deps.config.channels
      .map((channel) => channel.id)
      .filter((channelId) => liveIds.has(channelId));
  }
  if (!enabledChannelIds.length) {
    return state;
  }

  const channels: Record<string, ChannelRuntimeState> = { ...(state.channels ?? {}) };
  for (const channel of live) {
    const existing = channels[channel.id];
    const yamlChannel = getChannelConfig(deps.config, channel.id);
    const country = existing?.country ?? yamlChannel?.country ?? inferCountryFromChannelName(channel.name);
    const bank = pickLiveTemplateBank(state, country);
    channels[channel.id] = {
      enabled: enabledChannelIds.includes(channel.id),
      country,
      templateBank: existing?.templateBank ?? yamlChannel?.templateBank ?? bank?.name,
      templateBankId: existing?.templateBankId ?? bank?.id,
    };
  }

  const statusFolders = state.operatorSettings?.statusFolders ?? state.statusFolders;
  return deps.stateStore.patch(state.chatId, {
    enabledChannelIds,
    channels,
    operatorSettings: {
      enabledChannelIds,
      statusFolders,
    },
  });
}

async function ensureCustomerMessageEligible(
  deps: WorkerDeps,
  state: ChatState,
  conv: PagerConversation,
  convId: string,
  convState: ConversationRuntimeState,
  lastIncoming: PagerMessage,
  sorted: PagerMessage[],
  options?: {
    bypass?: boolean;
    forceContinuation?: boolean;
    operatorUserId?: string;
    countryLabel?: string;
    country?: "ZM" | "CM" | "EG";
  },
): Promise<boolean> {
  const lastIncomingAt = parseMessageTimestamp(lastIncoming.createdAt);
  if (!options?.bypass && !isActionableCustomerMessage(conv, lastIncomingAt)) {
    const label = options?.countryLabel ? ` ${options.countryLabel}` : "";
    console.log(
      `Pager worker: skip ${convId.slice(0, 8)}${label} — not_actionable (text=${truncate((lastIncoming.text || "").trim())})`,
    );
    if (convState.lastCustomerMessageId !== lastIncoming.id) {
      await patchConversationState(deps.stateStore, state.chatId, convId, {
        lastCustomerMessageId: lastIncoming.id,
        lastCustomerMessageAt: lastIncoming.createdAt,
      });
    }
    return false;
  }

  const eligibility = assessReplyEligibility(conv, convState, lastIncoming, sorted, {
    country: options?.country ?? (options?.countryLabel as "ZM" | "CM" | "EG" | undefined),
    forceContinuation: options?.forceContinuation,
    operatorUserId: options?.operatorUserId,
  });
  if (eligibility.eligible) {
    return true;
  }

  if (eligibility.markSeen) {
    await patchConversationState(deps.stateStore, state.chatId, convId, {
      lastCustomerMessageId: lastIncoming.id,
      lastCustomerMessageAt: lastIncoming.createdAt,
    });
  }

  const label = options?.countryLabel ? ` ${options.countryLabel}` : "";
  console.log(
    `Pager worker: skip ${convId.slice(0, 8)}${label} — ${eligibility.reason} (text=${truncate((lastIncoming.text || "").trim())})`,
  );
  return false;
}

function inferCountryFromChannelName(name: string): "ZM" | "CM" | "EG" {
  const normalized = name.toLowerCase();
  if (/mahmoud|anas|ahmad|moulaye|egypt|eg/.test(normalized)) {
    return "EG";
  }
  if (/moukoko|ndzi|ekambi|cameroon|cm|tchouameni/.test(normalized)) {
    return "CM";
  }
  return "ZM";
}

function pickLiveTemplateBank(
  state: ChatState,
  country: "ZM" | "CM" | "EG",
): { id: string; name: string } | undefined {
  const banks = state.pagerAccount?.liveTemplateBanks ?? [];
  if (!banks.length) {
    return undefined;
  }
  const hints: Record<"ZM" | "CM" | "EG", string[]> = {
    ZM: ["замб", "zamb", "zambia"],
    EG: ["егип", "egypt", "hapka"],
    CM: ["камер", "cameroon", "cameroun"],
  };
  const matched = banks.find((bank) => {
    const normalized = bank.name.toLowerCase();
    return hints[country].some((hint) => normalized.includes(hint));
  });
  return matched ?? banks[0];
}

function getConversationState(
  state: ChatState,
  conversationId: string,
  channelId: string,
): ConversationRuntimeState {
  return (
    state.conversations?.[conversationId] ?? {
      conversationId,
      channelId,
      currentStage: "new_lead",
    }
  );
}

async function patchConversationState(
  stateStore: StateStore,
  chatId: number,
  conversationId: string,
  patch: Partial<ConversationRuntimeState>,
): Promise<void> {
  const current = await stateStore.get(chatId);
  if (!current) {
    return;
  }

  const existing = current.conversations?.[conversationId];
  const base =
    existing ??
    ({
      conversationId,
      channelId: patch.channelId ?? "",
      currentStage: "new_lead" as Stage,
    } satisfies ConversationRuntimeState);

  await stateStore.patch(chatId, {
    conversations: {
      ...(current.conversations ?? {}),
      [conversationId]: {
        ...base,
        ...patch,
        conversationId,
      },
    },
  });
}

function buildRuntimeChannelConfig(
  config: BotConfig,
  state: ChatState,
  runtime: EnabledChannel,
): ChannelConfig {
  const mapped = getChannelConfig(config, runtime.channelId);
  const country = runtime.runtime.country;
  const templateBank = resolveYamlTemplateBankName(config, country, runtime.channelId);

  return {
    id: runtime.channelId,
    name: runtime.channelName,
    enabled: true,
    country,
    templateBank,
    statusMap: mapped?.statusMap ?? statusMapForCountry(config, country),
  };
}

function truncate(value: string, max = 40): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max - 1)}…`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type SpecialResponseContext = {
  state: ChatState;
  client: PagerClient;
  conv: PagerConversation;
  runtime: EnabledChannel;
  channel: ChannelConfig;
  convState: ConversationRuntimeState;
  convId: string;
  lastIncoming: PagerMessage;
  text: string;
  playbook: ReturnType<typeof getPlaybook>;
};

async function trySendSpecialCustomerResponse(
  deps: WorkerDeps,
  ctx: SpecialResponseContext,
): Promise<boolean> {
  const special = classifySpecialCustomerIntent(ctx.playbook, ctx.text);
  if (special === "declined" || special === "scam_accusation") {
    console.log(
      `Pager worker: skip ${ctx.convId.slice(0, 8)} ${ctx.channel.country} — ${special} (text=${truncate(ctx.text)})`,
    );
    await patchConversationState(deps.stateStore, ctx.state.chatId, ctx.convId, {
      lastCustomerMessageId: ctx.lastIncoming.id,
      lastCustomerMessageAt: ctx.lastIncoming.createdAt,
      currentStage: special === "declined" ? "dormant" : ctx.convState.currentStage,
    });
    return false;
  }

  let replyText: string | undefined;
  let templateRole: TemplateRole | undefined;
  let nextStage: Stage = ctx.convState.currentStage;

  if (special === "money_request") {
    replyText = moneyRefusalText(ctx.channel.country);
    nextStage = "engaged";
  } else if (special === "phone_request") {
    replyText = phoneChatOnlyText(ctx.channel.country);
    nextStage = "engaged";
  } else {
    templateRole = specialIntentTemplateRole(special);
    if (!templateRole) {
      return false;
    }
    replyText = await resolveTemplateText(deps.config, ctx.client, {
      folderId: ctx.runtime.runtime.templateBankId,
      yamlBankName: ctx.channel.templateBank,
      role: templateRole,
      country: ctx.channel.country,
    });
    nextStage = special === "deferral" ? "not_ready" : "no_money";
  }

  if (!replyText?.trim()) {
    return false;
  }

  console.log(
    `Pager worker: ${ctx.channel.country} ${ctx.convId.slice(0, 8)} special=${special} role=${templateRole ?? "money_refusal"}`,
  );

  const sent = await ctx.client.sendMessageReliable(ctx.convId, replyText.trim(), {
    channelId: ctx.runtime.channelId,
    conv: ctx.conv,
  });
  if (!sent) {
    return false;
  }

  await patchConversationState(deps.stateStore, ctx.state.chatId, ctx.convId, {
    conversationId: ctx.convId,
    channelId: ctx.runtime.channelId,
    currentStage: nextStage,
    lastCustomerMessageId: ctx.lastIncoming.id,
    lastCustomerMessageAt: ctx.lastIncoming.createdAt,
    lastReplyAt: new Date().toISOString(),
    lastReplyRole: templateRole ?? special,
    sendFailures: 0,
  });
  return true;
}

async function tryHandleCustomerImage(
  deps: WorkerDeps,
  ctx: SpecialResponseContext & {
    imageUrl: string;
    outgoingTexts: string[];
  },
): Promise<boolean> {
  if (!ctx.imageUrl) {
    return false;
  }

  let proofKind;
  try {
    const image = await ctx.client.downloadAttachment(ctx.imageUrl);
    const classification = await classifyProofFromImage(ctx.playbook, image, {
      caption: ctx.text,
      ocrEnabled: deps.env.OCR_ENABLED,
      ocrLang: ocrLangForCountry(ctx.channel.country),
    });
    proofKind = classification.proofKind;
  } catch (error) {
    console.warn(`CM OCR failed ${ctx.convId.slice(0, 8)}:`, formatError(error));
    proofKind = classifyProofFromText(ctx.playbook, ctx.text).proofKind;
  }

  if (proofKind === "unclear_screenshot") {
    const regLinkSent =
      ctx.channel.country === "ZM"
        ? zmRegLinkSentInHistory(ctx.outgoingTexts)
        : ctx.channel.country === "EG"
          ? egRegLinkSentInHistory(ctx.outgoingTexts)
          : cmRegLinkSentInHistory(ctx.outgoingTexts);
    if (!regLinkSent) {
      return false;
    }
    const replyText = await resolveTemplateText(deps.config, ctx.client, {
      folderId: ctx.runtime.runtime.templateBankId,
      yamlBankName: ctx.channel.templateBank,
      role: "ask_clear_screenshot",
      country: ctx.channel.country,
    });
    if (!replyText?.trim()) {
      return false;
    }
    const sent = await ctx.client.sendMessageReliable(ctx.convId, replyText.trim(), {
      channelId: ctx.runtime.channelId,
      conv: ctx.conv,
    });
    if (!sent) {
      return false;
    }
    await patchConversationState(deps.stateStore, ctx.state.chatId, ctx.convId, {
      conversationId: ctx.convId,
      channelId: ctx.runtime.channelId,
      currentStage: "waiting_id",
      lastCustomerMessageId: ctx.lastIncoming.id,
      lastCustomerMessageAt: ctx.lastIncoming.createdAt,
      lastReplyAt: new Date().toISOString(),
      lastReplyRole: "ask_clear_screenshot",
      sendFailures: 0,
    });
    return true;
  }

  return false;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function isRecoverablePagerError(error: unknown): boolean {
  return (
    isPagerSessionError(error) ||
    (error instanceof PagerApiError &&
      error.status === 400 &&
      error.body.toLowerCase().includes("organization id"))
  );
}

async function pollConversations(
  deps: WorkerDeps,
  state: ChatState,
  client: PagerClient,
  channelIds: string[],
): Promise<{ conversations: PagerConversation[]; client: PagerClient }> {
  try {
    await client.syncOrgIdFromChannels();
    const conversations = await client.collectConversationsForChannels(channelIds, 10);
    return { conversations, client };
  } catch (error) {
    if (!isRecoverablePagerError(error) || !state.pagerAccount?.password) {
      throw error;
    }
    console.warn(`Pager poll retry with credential refresh for chat ${state.chatId}`);
    const refreshed = await refreshPagerSessionWithCredentials(deps, state);
    if (!refreshed) {
      throw error;
    }
    const conversations = await refreshed.client.collectConversationsForChannels(channelIds, 10);
    return { conversations, client: refreshed.client };
  }
}

async function ensureStatusFolders(
  deps: WorkerDeps,
  state: ChatState,
  client: PagerClient,
): Promise<ChatState | undefined> {
  try {
    const session = await client.bootstrapSession();
    const statuses = await client.loadAllStatuses().catch(() => []);
    const statusFolders = mergeStatusFolderList(
      statuses,
      state.operatorSettings?.statusFolders ?? state.statusFolders,
    );
    return deps.stateStore.patch(state.chatId, {
      statusFolders,
      operatorSettings: {
        enabledChannelIds:
          state.operatorSettings?.enabledChannelIds ?? collectEnabledChannelIdsFromState(state),
        statusFolders,
      },
      pagerAccount: {
        ...(state.pagerAccount ?? { authMode: "cookies", connectedAt: new Date().toISOString() }),
        cookies: session.cookieHeader,
        organizationId: session.organizationId,
        organizationSlug: session.organizationSlug || state.pagerAccount?.organizationSlug,
        organizationName: session.organizationName ?? state.pagerAccount?.organizationName,
      },
    });
  } catch (error) {
    console.error(`ensureStatusFolders failed for chat ${state.chatId}:`, formatError(error));
    return state;
  }
}
