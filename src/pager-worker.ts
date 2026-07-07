import {
  type BotConfig,
  type ChannelConfig,
  type Stage,
  getChannelConfig,
  getDefaultEnabledChannel,
  getPlaybook,
} from "./config.js";
import { decideNextAction } from "./decision-engine.js";
import type { AppEnv } from "./env.js";
import {
  isIncomingDirection,
  isOutgoingDirection,
  PagerClient,
  type PagerConversation,
  type PagerMessage,
} from "./pager-client.js";
import { classifyProofFromImage, classifyProofFromText } from "./proof-classifier.js";
import type {
  ChannelRuntimeState,
  ChatState,
  ConversationRuntimeState,
  StateStore,
} from "./state-store.js";
import { resolveTemplateText } from "./template-resolver.js";
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
  for (const state of states) {
    if (!state.pagerAccount?.cookies) {
      continue;
    }
    await processOperatorAccount(deps, state);
  }
}

async function processOperatorAccount(deps: WorkerDeps, state: ChatState): Promise<void> {
  const enabledChannels = getEnabledChannels(state);
  if (!enabledChannels.length) {
    return;
  }

  const client = new PagerClient({
    baseUrl: deps.env.PAGER_BASE_URL,
    cookieHeader: state.pagerAccount!.cookies!,
    orgId: state.pagerAccount?.organizationId,
    locale: "uk",
  });

  let conversations: PagerConversation[] = [];
  try {
    await client.warmSession();
    conversations = await client.collectConversationsForChannels(
      enabledChannels.map((item) => item.channelId),
    );
  } catch (error) {
    console.error(`Pager poll failed for chat ${state.chatId}:`, formatError(error));
    return;
  }

  const incoming = conversations.filter((conv) => isIncomingDirection(conv.lastMessageDirection));
  for (const conv of incoming) {
    const channelId = conv.channelId || conv.channel?.id;
    if (!channelId) {
      continue;
    }
    const runtime = enabledChannels.find((item) => item.channelId === channelId);
    if (!runtime) {
      continue;
    }

    try {
      await processConversation(deps, state, client, conv, runtime);
    } catch (error) {
      console.error(
        `Conversation ${conv.id.slice(0, 8)} failed for chat ${state.chatId}:`,
        formatError(error),
      );
    }
  }
}

async function processConversation(
  deps: WorkerDeps,
  state: ChatState,
  client: PagerClient,
  conv: PagerConversation,
  runtime: EnabledChannel,
): Promise<void> {
  const convId = conv.id;
  const convState = getConversationState(state, convId, runtime.channelId);
  if ((convState.sendFailures ?? 0) >= MAX_SEND_FAILURES) {
    return;
  }

  const messages = await client.listMessages(convId, 1, 30);
  if (!messages.length) {
    return;
  }

  const sorted = [...messages].sort(
    (left, right) => Date.parse(right.createdAt ?? "") - Date.parse(left.createdAt ?? ""),
  );
  const latest = sorted[0];
  if (deps.config.bot.requireCustomerLastMessage && isOutgoingDirection(latest.messageDirection)) {
    if (shouldSkipHumanReply(deps.config, convState, latest)) {
      return;
    }
  }

  const lastIncoming = sorted.find((message) => isIncomingDirection(message.messageDirection));
  if (!lastIncoming) {
    return;
  }

  if (convState.lastCustomerMessageId === lastIncoming.id && convState.lastReplyAt) {
    return;
  }

  const channel = buildRuntimeChannelConfig(deps.config, state, runtime);
  const playbook = getPlaybook(deps.config, channel.country);
  const latestCustomerText = (lastIncoming.text || "").trim();
  const imageUrl = extractImageUrl(lastIncoming);

  let proofKind;
  if (imageUrl) {
    try {
      const image = await client.downloadAttachment(imageUrl);
      const classification = await classifyProofFromImage(playbook, image, {
        caption: latestCustomerText,
        ocrEnabled: deps.env.OCR_ENABLED,
        ocrLang: deps.env.OCR_LANG,
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

  if (!decision?.templateRole && !decision?.templateToSend) {
    return;
  }

  const templateRole = decision.templateRole ?? "intro";
  const replyText =
    decision.templateToSend ??
    (await resolveTemplateText(deps.config, client, {
      folderId: runtime.runtime.templateBankId,
      yamlBankName: channel.templateBank,
      role: templateRole,
    }));

  if (!replyText?.trim()) {
    console.warn(`No template text resolved for ${convId.slice(0, 8)} role=${templateRole}`);
    return;
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
    if (failures >= MAX_SEND_FAILURES) {
      await deps.telegram.sendMessage(
        state.chatId,
        `⚠️ Чат ${convId.slice(0, 8)} приостановлен после ${failures} неудачных отправок.`,
      );
    }
    return;
  }

  const nextConvState: ConversationRuntimeState = {
    conversationId: convId,
    channelId: runtime.channelId,
    currentStage: decision.nextStage,
    lastCustomerMessageId: lastIncoming.id,
    lastCustomerMessageAt: lastIncoming.createdAt,
    lastReplyAt: new Date().toISOString(),
    lastReplyRole: templateRole,
    sendFailures: 0,
  };

  await patchConversationState(deps.stateStore, state.chatId, convId, nextConvState);

  const channelName = runtime.channelName;
  await deps.telegram.sendMessage(
    state.chatId,
    [
      `✅ Ответил в Pager`,
      `Канал: ${channelName}`,
      `Чат: ${convId.slice(0, 8)}…`,
      `Стадия: ${convState.currentStage} → ${decision.nextStage}`,
      `Пресет: ${templateRole}`,
      `Причина: ${decision.reason}`,
    ].join("\n"),
  );
}

type EnabledChannel = {
  channelId: string;
  channelName: string;
  runtime: ChannelRuntimeState;
};

function getEnabledChannels(state: ChatState): EnabledChannel[] {
  const liveChannels = state.pagerAccount?.liveChannels ?? [];
  const enabled: EnabledChannel[] = [];

  if (liveChannels.length) {
    for (const channel of liveChannels) {
      const runtime = state.channels?.[channel.id];
      if (!runtime?.enabled) {
        continue;
      }
      enabled.push({
        channelId: channel.id,
        channelName: channel.name,
        runtime,
      });
    }
    return enabled;
  }

  for (const channel of Object.entries(state.channels ?? {})) {
    const [channelId, runtime] = channel;
    if (!runtime.enabled) {
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
  const templateBank =
    runtime.runtime.templateBank ??
    mapped?.templateBank ??
    `${country.toLowerCase()}-default`;

  return {
    id: runtime.channelId,
    name: runtime.channelName,
    enabled: true,
    country,
    templateBank,
    statusMap: mapped?.statusMap ?? fallback.statusMap,
  };
}

function shouldSkipHumanReply(
  config: BotConfig,
  convState: ConversationRuntimeState,
  latestOutgoing: PagerMessage,
): boolean {
  const skipMinutes = config.bot.skipIfHumanRepliedRecentlyMinutes;
  if (!skipMinutes) {
    return false;
  }

  const outgoingAt = Date.parse(latestOutgoing.createdAt ?? "");
  if (!Number.isFinite(outgoingAt)) {
    return false;
  }

  const repliedRecently = Date.now() - outgoingAt < skipMinutes * 60_000;
  if (!repliedRecently) {
    return false;
  }

  const ourReplyAt = Date.parse(convState.lastReplyAt ?? "");
  if (!Number.isFinite(ourReplyAt)) {
    return true;
  }

  return outgoingAt > ourReplyAt + 5_000;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
