import {
  type BotConfig,
  type ChannelConfig,
  type Stage,
  getChannelConfig,
  getConfigEnabledChannelIds,
  getDefaultEnabledChannel,
  getPlaybook,
  resolveYamlTemplateBankName,
} from "./config.js";
import { decideNextAction } from "./decision-engine.js";
import {
  classifySpecialCustomerIntent,
  moneyRefusalText,
  specialIntentTemplateRole,
} from "./customer-intent.js";
import { ocrLangForCountry } from "./ocr-lang.js";
import {
  classifyCmMessage,
  collectOutgoingTexts,
  funnelStepFromScriptGaps,
  inferStepFromThread,
  regLinkSentInHistory,
  regSendTriggersInProgress,
  resolveCmFunnelScripts,
  tierSentInHistory,
} from "./cm-script-engine.js";
import { isDepositTierChoice, isRegistrationConfirmed } from "./cm-intent.js";
import type { AppEnv } from "./env.js";
import {
  isIncomingDirection,
  isOutgoingDirection,
  isPagerSessionError,
  PagerApiError,
  PagerClient,
  type PagerConversation,
  type PagerMessage,
} from "./pager-client.js";
import { buildPagerAccountPatch, ensurePagerSession, refreshPagerSessionWithCredentials } from "./pager-session.js";
import { classifyProofFromImage, classifyProofFromText } from "./proof-classifier.js";
import type {
  ChannelRuntimeState,
  ChatState,
  ConversationRuntimeState,
  StateStore,
} from "./state-store.js";
import { resolveCmTemplateFolderId, resolveScriptTextByKey, resolveTemplateText } from "./template-resolver.js";
import {
  countApiStatusFolders,
  isNoStatusConversation,
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

  for (const state of connected) {
    await processOperatorAccount(deps, state);
  }
}

async function processOperatorAccount(deps: WorkerDeps, state: ChatState): Promise<void> {
  let freshState = hydrateOperatorState((await deps.stateStore.get(state.chatId)) ?? state);

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

  freshState = (await normalizeEnabledChannelsToConfig(deps, freshState)) ?? freshState;
  freshState = hydrateOperatorState(freshState);

  if (countApiStatusFolders(freshState.statusFolders) === 0) {
    freshState = (await ensureStatusFolders(deps, freshState, client)) ?? freshState;
    freshState = hydrateOperatorState(freshState);
  }

  freshState = hydrateOperatorState((await deps.stateStore.get(freshState.chatId)) ?? freshState);

  if (
    !collectEnabledChannelIdsFromState(freshState).length &&
    hasEnabledStatusFolders(freshState)
  ) {
    freshState = (await seedEnabledChannelsFromYaml(deps, freshState)) ?? freshState;
    freshState = hydrateOperatorState(freshState);
    console.log(
      `Pager worker: chat ${freshState.chatId} — enabled ${freshState.enabledChannelIds?.length ?? 0} channel(s) from config`,
    );
  }

  const enabledChannels = getEnabledChannels(deps.config, freshState);

  if (!enabledChannels.length) {
    const liveCount = freshState.pagerAccount?.liveChannels?.length ?? 0;
    console.log(
      `Pager worker: chat ${freshState.chatId} — no enabled channels (live=${liveCount}). Enable a folder in «Папки» or channels in «Каналы».`,
    );
    return;
  }

  const enabledFolderIds = getEnabledFolderIds(freshState);
  if (enabledFolderIds && enabledFolderIds.size === 0) {
    console.log(`Pager worker: chat ${freshState.chatId} — no status folders enabled`);
    return;
  }

  if (enabledFolderIds) {
    const folderNames = (freshState.statusFolders ?? [])
      .filter((folder) => folder.enabled)
      .map((folder) => folder.name)
      .join(", ");
    console.log(`Pager worker: chat ${freshState.chatId} — folders=[${folderNames || "all"}]`);
  }

  const channelIds = enabledChannels.map((item) => item.channelId);
  const channelNames = enabledChannels.map((item) => item.channelName).join(", ");

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
    ].join(" | "),
  );

  if (!conversations.length) {
    return;
  }

  let checked = 0;
  let replied = 0;
  let skipped = 0;

  for (const conv of conversations) {
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

    if (enabledFolderIds && !conversationAllowedInFolders(conv, enabledFolderIds)) {
      skipped += 1;
      continue;
    }

    checked += 1;
    try {
      const didReply = await processConversation(deps, freshState, client, conv, runtime);
      if (didReply) {
        replied += 1;
      } else {
        skipped += 1;
      }
    } catch (error) {
      console.error(
        `Conversation ${conv.id.slice(0, 8)} failed for chat ${freshState.chatId}:`,
        formatError(error),
      );
    }
  }

  console.log(
    `Pager worker: chat ${freshState.chatId} — checked=${checked} replied=${replied} skipped=${skipped}`,
  );
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
  if (!isIncomingDirection(conv.lastMessageDirection)) {
    return false;
  }

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
  const latest = sorted[0];
  if (!isIncomingDirection(latest.messageDirection)) {
    return false;
  }

  const lastIncoming = latest;
  const lastIncomingAt = lastIncoming.createdAt ?? "";
  const outgoingTexts = collectOutgoingTexts(messages);
  const latestCustomerText = (lastIncoming.text || "").trim();
  const awaitingRegAfterTierChoice =
    tierSentInHistory(outgoingTexts) &&
    !regLinkSentInHistory(outgoingTexts) &&
    isDepositTierChoice(latestCustomerText);

  if (convState.lastCustomerMessageId === lastIncoming.id && convState.lastReplyAt) {
    if (!awaitingRegAfterTierChoice) {
      return false;
    }
  }

  if (hasDeliveredReplyAfter(sorted, lastIncomingAt)) {
    if (!awaitingRegAfterTierChoice) {
      if (convState.lastCustomerMessageId !== lastIncoming.id) {
        await patchConversationState(deps.stateStore, state.chatId, convId, {
          lastCustomerMessageId: lastIncoming.id,
          lastCustomerMessageAt: lastIncoming.createdAt,
        });
      }
      return false;
    }
  }

  const incomingAgeMs = Date.now() - Date.parse(lastIncomingAt);
  const statusName = (conv.status?.name ?? "").toLowerCase();
  const inProgressStatus =
    !isNoStatusConversation(conv) &&
    (/процес|process|registered|рега/i.test(statusName) || regLinkSentInHistory(outgoingTexts));
  if (
    inProgressStatus &&
    Number.isFinite(incomingAgeMs) &&
    incomingAgeMs > 2 * 60 * 60 * 1000 &&
    outgoingTexts.length >= 2
  ) {
    return false;
  }

  const threadStep = inferStepFromThread(messages);
  const gapStep = funnelStepFromScriptGaps(outgoingTexts, convState.funnelStep ?? 0);
  const effectiveStep = Math.max(threadStep, gapStep, convState.funnelStep ?? 0);
  const imageUrl = extractImageUrl(lastIncoming);
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
  });

  const scriptKeys = resolveCmFunnelScripts(
    effectiveStep,
    latestCustomerText,
    intent,
    outgoingTexts,
    { hasImage: Boolean(imageUrl) },
  );

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
  for (const scriptKey of scriptKeys) {
    const replyText = await resolveScriptTextByKey(client, {
      folderId,
      liveBanks: currentState.pagerAccount?.liveTemplateBanks,
      scriptKey,
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
    await sleep(500);
  }

  if (!sentAny) {
    return false;
  }

  if (regSendTriggersInProgress(scriptKeys)) {
    const statusId = findInProgressStatusId(currentState);
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

async function processGenericConversation(
  deps: WorkerDeps,
  state: ChatState,
  client: PagerClient,
  conv: PagerConversation,
  runtime: EnabledChannel,
  channel: ReturnType<typeof buildRuntimeChannelConfig>,
): Promise<boolean> {
  const convId = conv.id;

  if (!isIncomingDirection(conv.lastMessageDirection)) {
    return false;
  }

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
  const latest = sorted[0];

  if (!isIncomingDirection(latest.messageDirection)) {
    return false;
  }

  const lastIncoming = latest;
  const lastIncomingAt = lastIncoming.createdAt ?? "";

  if (convState.lastCustomerMessageId === lastIncoming.id && convState.lastReplyAt) {
    return false;
  }

  if (hasDeliveredReplyAfter(sorted, lastIncomingAt)) {
    if (convState.lastCustomerMessageId !== lastIncoming.id) {
      await patchConversationState(deps.stateStore, state.chatId, convId, {
        lastCustomerMessageId: lastIncoming.id,
        lastCustomerMessageAt: lastIncoming.createdAt,
      });
    }
    return false;
  }

  const playbook = getPlaybook(deps.config, channel.country);
  const latestCustomerText = (lastIncoming.text || "").trim();
  const imageUrl = extractImageUrl(lastIncoming);

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

function findInProgressStatusId(state: ChatState): string | undefined {
  for (const folder of state.statusFolders ?? []) {
    const name = folder.name.toLowerCase();
    if (/в процес|процес|process/i.test(name)) {
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

function getEnabledChannels(config: BotConfig, state: ChatState): EnabledChannel[] {
  const configAllowed = new Set(getConfigEnabledChannelIds(config));
  const enabledIds = new Set(
    collectEnabledChannelIdsFromState(state).filter((channelId) => configAllowed.has(channelId)),
  );
  const liveChannels = state.pagerAccount?.liveChannels ?? [];
  const enabled: EnabledChannel[] = [];

  if (liveChannels.length) {
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
    }
    return enabled;
  }

  for (const channelId of enabledIds) {
    const runtime = state.channels?.[channelId];
    if (!runtime) {
      continue;
    }
    enabled.push({
      channelId,
      channelName: channelId.slice(0, 8),
      runtime,
    });
  }
  return enabled;
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
  const allowed = new Set(getConfigEnabledChannelIds(deps.config));
  const current = collectEnabledChannelIdsFromState(state);
  const filtered = current.filter((channelId) => allowed.has(channelId));
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
  const enabledChannelIds = getConfigEnabledChannelIds(deps.config).filter((channelId) =>
    liveIds.has(channelId),
  );
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

function hasDeliveredReplyAfter(messages: PagerMessage[], lastIncomingAt: string): boolean {
  const incomingTs = Date.parse(lastIncomingAt);
  if (!Number.isFinite(incomingTs)) {
    return false;
  }

  for (const message of messages) {
    if (!isOutgoingDirection(message.messageDirection)) {
      continue;
    }
    const outgoingTs = Date.parse(message.createdAt ?? "");
    if (!Number.isFinite(outgoingTs) || outgoingTs <= incomingTs) {
      continue;
    }
    const text = (message.text || "").trim();
    if (!text) {
      continue;
    }
    if (message.isDelivered || message.facebookMessageId) {
      return true;
    }
  }
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
  const fallback = getDefaultEnabledChannel(config);
  const country = runtime.runtime.country;
  const templateBank = resolveYamlTemplateBankName(config, country, runtime.channelId);

  return {
    id: runtime.channelId,
    name: runtime.channelName,
    enabled: true,
    country,
    templateBank,
    statusMap: mapped?.statusMap ?? fallback.statusMap,
  };
}

function extractImageUrl(message: PagerMessage): string | undefined {
  for (const attachment of message.attachments ?? []) {
    if (attachment.type === "image") {
      const url = attachment.payload?.url;
      if (url) {
        return url;
      }
    }
  }
  return undefined;
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

  if (proofKind === "unclear_screenshot" && regLinkSentInHistory(ctx.outgoingTexts)) {
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
    const conversations = await client.collectConversationsForChannels(channelIds);
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
    const conversations = await refreshed.client.collectConversationsForChannels(channelIds);
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
