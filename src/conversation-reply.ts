import type { PagerConversation, PagerMessage } from "./pager-client.js";
import {
  isCustomerMessage,
  resolveLastMessageAt,
  enrichConversationFromThread,
} from "./pager-client.js";
import type { ConversationRuntimeState } from "./state-store.js";
import type { CountryCode } from "./config.js";
import { isAutomatedFunnelOutgoing } from "./funnel-outbound.js";
import { egFunnelNeedsContinuation } from "./eg-script-engine.js";
import {
  cmAgeQuestionSentInHistory,
  cmScriptSentInHistory,
  depositSentInHistory as cmDepositSentInHistory,
  regLinkSentInHistory as cmRegLinkSentInHistory,
  stepsSentInHistory as cmStepsSentInHistory,
  tierSentInHistory as cmTierSentInHistory,
} from "./cm-script-engine.js";
import {
  isAgeAnswer,
  isClientReadyPhrase,
  isDepositTierChoice,
  isReadyForRegistration,
  isRegistrationConfirmed,
  isCmRegistrationHelpRequest,
} from "./cm-intent.js";
import {
  isInProgressStatusConversation,
  isNoStatusConversation,
} from "./status-folders.js";

export function isNewLeadConversation(conv: PagerConversation): boolean {
  return isNoStatusConversation(conv) && isIncomingDirection(conv.lastMessageDirection);
}

/** Brand-new customer messages (always processed). */
export const FRESH_CUSTOMER_MESSAGE_MS = 30 * 60 * 1000;

export type ReplyEligibility =
  | { eligible: true }
  | { eligible: false; reason: string; markSeen?: boolean };

export function parseMessageTimestamp(value?: string): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) {
    return "";
  }
  if (/^\d{10,13}$/.test(trimmed)) {
    const numeric = Number(trimmed);
    const ms = trimmed.length <= 10 ? numeric * 1000 : numeric;
    return new Date(ms).toISOString();
  }
  return trimmed;
}

export function isIncomingDirection(direction?: string): boolean {
  const value = (direction ?? "").trim().toLowerCase();
  return (
    value === "incoming" ||
    value === "in" ||
    value === "received" ||
    value === "from_client" ||
    value === "fromcustomer" ||
    value === "client" ||
    value === "customer"
  );
}

export function isOutgoingDirection(direction?: string): boolean {
  const value = (direction ?? "").trim().toLowerCase();
  return (
    value === "outgoing" ||
    value === "out" ||
    value === "sent" ||
    value === "from_page" ||
    value === "echo"
  );
}

export function isFreshCustomerMessage(createdAt?: string, nowMs = Date.now()): boolean {
  const ts = Date.parse(parseMessageTimestamp(createdAt));
  if (!Number.isFinite(ts)) {
    return false;
  }
  return nowMs - ts <= FRESH_CUSTOMER_MESSAGE_MS;
}

export function hasUnreadMarkers(conv: PagerConversation): boolean {
  const state = (conv.conversationState ?? "").trim().toLowerCase();
  if (state === "unread") {
    return true;
  }
  if (typeof conv.unreadCount === "number" && conv.unreadCount > 0) {
    return true;
  }
  if (conv.isUnread === true) {
    return true;
  }
  return false;
}

export function isConversationUnread(conv: PagerConversation): boolean {
  if (hasUnreadMarkers(conv)) {
    return true;
  }
  const state = (conv.conversationState ?? "").trim().toLowerCase();
  if (state === "read") {
    return false;
  }
  if (isFreshCustomerMessage(resolveLastMessageAt(conv))) {
    return true;
  }
  return false;
}

/** Process chats where the customer spoke last and the thread still needs a reply. */
export function shouldProcessConversation(conv: PagerConversation): boolean {
  // Bot/operator already has the last word — wait for a new customer message.
  if (isOutgoingDirection(conv.lastMessageDirection)) {
    return false;
  }
  if (isFreshCustomerMessage(resolveLastMessageAt(conv))) {
    return true;
  }
  if (hasUnreadMarkers(conv)) {
    return true;
  }
  if (isIncomingDirection(conv.lastMessageDirection)) {
    return true;
  }
  return false;
}

/** Egypt: same queue gate as CM/ZM — only unread / incoming / fresh customer turns. */
export function shouldQueueEgConversation(conv: PagerConversation): boolean {
  // Never wake a thread where the bot (or operator) already spoke last.
  if (isOutgoingDirection(conv.lastMessageDirection)) {
    return false;
  }
  return shouldProcessConversation(conv);
}

export function shouldProcessIncomingMessage(lastIncomingAt?: string, conv?: PagerConversation): boolean {
  if (isFreshCustomerMessage(lastIncomingAt)) {
    return true;
  }
  if (conv && hasUnreadMarkers(conv)) {
    return true;
  }
  if (conv && isConversationUnread(conv)) {
    return true;
  }
  return false;
}

export function shouldOpenConversation(conv: PagerConversation): boolean {
  return shouldProcessConversation(conv);
}

export function conversationPriorityScore(conv: PagerConversation): number {
  const unread = isConversationUnread(conv);
  const incoming = isIncomingDirection(conv.lastMessageDirection);
  const fresh = isFreshCustomerMessage(resolveLastMessageAt(conv));
  const newLead = isNewLeadConversation(conv);
  const staleInProgress =
    isInProgressStatusConversation(conv) &&
    !unread &&
    !incoming &&
    !fresh &&
    !newLead &&
    !isNoStatusConversation(conv);
  const lastAt = Date.parse(resolveLastMessageAt(conv) ?? "");
  return (
    (newLead ? 3_000_000 : 0) +
    (unread ? 2_000_000 : 0) +
    (fresh ? 1_000_000 : 0) +
    (incoming ? 100_000 : 0) +
    (staleInProgress ? -1_000_000 : 0) +
    (Number.isFinite(lastAt) ? Math.floor(lastAt / 1000) : 0)
  );
}

export function sortMessagesNewestFirst(messages: PagerMessage[]): PagerMessage[] {
  return [...messages].sort(
    (left, right) =>
      Date.parse(parseMessageTimestamp(right.createdAt)) -
      Date.parse(parseMessageTimestamp(left.createdAt)),
  );
}

export function findLatestIncomingMessage(
  messages: PagerMessage[],
  conv?: PagerConversation,
  operatorUserId?: string,
  country?: CountryCode,
): PagerMessage | undefined {
  const enriched = conv ? enrichConversationFromThread(conv, messages, operatorUserId) : conv;
  return sortMessagesNewestFirst(messages).find((message) => {
    if (!isCustomerMessage(message, enriched, operatorUserId)) {
      return false;
    }
    // Never drop clearly incoming customer messages — short Arabic/French phrases
    // can look like script needles and were wrongly filtered as bot echoes.
    if (isIncomingDirection(message.messageDirection)) {
      return true;
    }
    const text = (message.text || "").trim();
    if (text && country && isAutomatedFunnelOutgoing(text, country)) {
      return false;
    }
    return true;
  });
}

/** Recent customer lines (newest first) for funnel context when the latest message is a follow-up. */
export function recentCustomerMessageTexts(
  messages: PagerMessage[],
  conv?: PagerConversation,
  limit = 6,
): string[] {
  const enriched = conv ? enrichConversationFromThread(conv, messages) : conv;
  const texts: string[] = [];
  for (const message of sortMessagesNewestFirst(messages)) {
    if (!isCustomerMessage(message, enriched)) {
      continue;
    }
    const text = (message.text || "").trim();
    if (text) {
      texts.push(text);
    }
    if (texts.length >= limit) {
      break;
    }
  }
  return texts;
}

export function hasOperatorReplyAfter(
  messages: PagerMessage[],
  afterCustomerAt: string,
  conv?: PagerConversation,
  operatorUserId?: string,
  country?: CountryCode,
): boolean {
  const afterTs = Date.parse(parseMessageTimestamp(afterCustomerAt));
  if (!Number.isFinite(afterTs)) {
    return false;
  }

  for (const message of messages) {
    if (isCustomerMessage(message, conv, operatorUserId)) {
      continue;
    }
    const outgoingTs = Date.parse(parseMessageTimestamp(message.createdAt));
    if (!Number.isFinite(outgoingTs) || outgoingTs <= afterTs) {
      continue;
    }
    const text = (message.text || "").trim();
    if (country && text && isAutomatedFunnelOutgoing(text, country)) {
      continue;
    }
    if (text || message.isDelivered || message.facebookMessageId) {
      return true;
    }
  }
  return false;
}

export function hasDeliveredReplyAfter(
  messages: PagerMessage[],
  lastIncomingAt: string,
  conv?: PagerConversation,
  operatorUserId?: string,
  country?: CountryCode,
): boolean {
  return hasOperatorReplyAfter(messages, lastIncomingAt, conv, operatorUserId, country);
}

export function isOperatorOutgoingMessage(
  message: PagerMessage,
  conv?: PagerConversation,
  operatorUserId?: string,
  country?: CountryCode,
): boolean {
  // Never treat inbound customer traffic as our reply (script-needle false positives).
  if (isIncomingDirection(message.messageDirection)) {
    return false;
  }
  const text = (message.text || "").trim();
  if (isOutgoingDirection(message.messageDirection)) {
    return true;
  }
  if (country && text && isAutomatedFunnelOutgoing(text, country)) {
    return true;
  }
  const author = (message.authorId ?? "").trim();
  if (operatorUserId && author && author === operatorUserId) {
    return true;
  }
  if (isCustomerMessage(message, conv, operatorUserId)) {
    return false;
  }
  return Boolean(text && (message.isDelivered || message.facebookMessageId));
}

export function hasBotReplyAfterCustomerMessage(
  messages: PagerMessage[],
  lastIncoming: PagerMessage,
  conv?: PagerConversation,
  operatorUserId?: string,
  country?: CountryCode,
): boolean {
  const chronological = [...messages].sort(
    (left, right) =>
      Date.parse(parseMessageTimestamp(left.createdAt)) -
      Date.parse(parseMessageTimestamp(right.createdAt)),
  );
  const customerIdx = chronological.findIndex((message) => message.id === lastIncoming.id);
  if (customerIdx >= 0) {
    for (let index = customerIdx + 1; index < chronological.length; index++) {
      const message = chronological[index]!;
      if (!isOperatorOutgoingMessage(message, conv, operatorUserId, country)) {
        continue;
      }
      // Only real deliveries lock the chat — failed/optimistic outgoings must not.
      if (message.isDelivered || message.facebookMessageId) {
        return true;
      }
    }
    return false;
  }

  const afterTs = Date.parse(parseMessageTimestamp(lastIncoming.createdAt));
  if (!Number.isFinite(afterTs)) {
    return false;
  }
  for (const message of messages) {
    if (!isOperatorOutgoingMessage(message, conv, operatorUserId, country)) {
      continue;
    }
    const outgoingTs = Date.parse(parseMessageTimestamp(message.createdAt));
    if (!Number.isFinite(outgoingTs) || outgoingTs <= afterTs) {
      continue;
    }
    if (message.isDelivered || message.facebookMessageId) {
      return true;
    }
  }
  return false;
}

export function isCustomerWaitingInThread(
  conv: PagerConversation,
  messages: PagerMessage[],
  options?: { country?: "ZM" | "CM" | "EG" },
): boolean {
  const latestCustomer = findLatestIncomingMessage(messages, conv);
  if (!latestCustomer) {
    return false;
  }

  const customerAt = parseMessageTimestamp(latestCustomer.createdAt);
  if (hasOperatorReplyAfter(messages, customerAt, conv, undefined, options?.country)) {
    return false;
  }

  if (shouldProcessIncomingMessage(customerAt, conv)) {
    return true;
  }

  if (hasUnreadMarkers(conv)) {
    return true;
  }

  const latest = sortMessagesNewestFirst(messages)[0];
  if (latest && isCustomerMessage(latest, conv)) {
    return true;
  }

  return false;
}

/** Re-open mid-funnel CM chats when the customer gave a clear next-step signal. */
export function cmFunnelNeedsContinuation(
  customerText: string,
  outgoingTexts: string[],
): boolean {
  const text = (customerText || "").trim();
  if (!text) {
    return false;
  }
  const introSent = cmScriptSentInHistory(outgoingTexts, "01_intro");
  const ageSent = cmAgeQuestionSentInHistory(outgoingTexts);
  const stepsSent = cmStepsSentInHistory(outgoingTexts);
  const tierSent = cmTierSentInHistory(outgoingTexts);
  const linkSent = cmRegLinkSentInHistory(outgoingTexts);
  const depositSent = cmDepositSentInHistory(outgoingTexts);
  const ready =
    isClientReadyPhrase(text) ||
    isReadyForRegistration(text) ||
    /^(oui|ok|okay|yes|d'accord)\b/i.test(text) ||
    /intéresse|interes|investir|je veux/i.test(text);

  if (!introSent) {
    return true;
  }
  if (!ageSent) {
    return ready || /explique|comment|gagner/i.test(text);
  }
  if (!stepsSent) {
    return isAgeAnswer(text) || ready || /\d{1,2}\s*ans?\b/i.test(text);
  }
  if (!tierSent) {
    return ready || /applique|lien|aide|explique|comment|pr[eê]t/i.test(text);
  }
  if (!linkSent) {
    return (
      isDepositTierChoice(text) ||
      ready ||
      isCmRegistrationHelpRequest(text) ||
      /^\d[\d\s]*$/.test(text)
    );
  }
  if (!depositSent) {
    return (
      isRegistrationConfirmed(text) ||
      ready ||
      /inscrit|cr[eé][eé]|compte|d[eé]p[oô]t|application/i.test(text)
    );
  }
  // After deposit ask: only continue for proof / confirmed registration — not bare Oui.
  return (
    isRegistrationConfirmed(text) ||
    /d[eé]p[oô]t|screenshot|preuve|image|inscrit|cr[eé][eé]/i.test(text)
  );
}

export function shouldQueueConversationFromThread(
  conv: PagerConversation,
  messages: PagerMessage[],
  country?: "ZM" | "CM" | "EG",
): boolean {
  if (shouldProcessConversation(conv)) {
    return true;
  }
  return isCustomerWaitingInThread(conv, messages, { country });
}

function collectOutgoingTextsFromThread(messages: PagerMessage[]): string[] {
  const texts: string[] = [];
  for (const message of messages) {
    if (!isOutgoingDirection(message.messageDirection)) {
      continue;
    }
    const text = (message.text || "").trim();
    if (text) {
      texts.push(text);
    }
  }
  return texts;
}

export function assessReplyEligibility(
  conv: PagerConversation,
  convState: ConversationRuntimeState,
  lastIncoming: PagerMessage,
  sortedMessages: PagerMessage[],
  options?: { country?: "ZM" | "CM" | "EG"; operatorUserId?: string },
): ReplyEligibility {
  const lastIncomingAt = parseMessageTimestamp(lastIncoming.createdAt);
  const isNewCustomerTurn = convState.lastCustomerMessageId !== lastIncoming.id;
  const alreadyRepliedInState =
    !isNewCustomerTurn &&
    convState.lastCustomerMessageId === lastIncoming.id &&
    Boolean(convState.lastReplyAt);

  if (alreadyRepliedInState) {
    if (
      options?.country === "EG" &&
      egFunnelNeedsContinuation(
        (lastIncoming.text || "").trim(),
        collectOutgoingTextsFromThread(sortedMessages),
      )
    ) {
      return { eligible: true };
    }
    if (
      options?.country === "CM" &&
      cmFunnelNeedsContinuation(
        (lastIncoming.text || "").trim(),
        collectOutgoingTextsFromThread(sortedMessages),
      )
    ) {
      return { eligible: true };
    }
    const botReplied = hasBotReplyAfterCustomerMessage(
      sortedMessages,
      lastIncoming,
      conv,
      options?.operatorUserId,
      options?.country,
    );
    if (
      options?.country !== "EG" &&
      !botReplied &&
      (hasUnreadMarkers(conv) || isIncomingDirection(conv.lastMessageDirection))
    ) {
      return { eligible: true };
    }
    return { eligible: false, reason: "awaiting_customer_reply" };
  }

  if (
    !isNewCustomerTurn &&
    hasBotReplyAfterCustomerMessage(
      sortedMessages,
      lastIncoming,
      conv,
      options?.operatorUserId,
      options?.country,
    )
  ) {
    if (
      options?.country === "EG" &&
      egFunnelNeedsContinuation(
        (lastIncoming.text || "").trim(),
        collectOutgoingTextsFromThread(sortedMessages),
      )
    ) {
      return { eligible: true };
    }
    if (
      options?.country === "CM" &&
      cmFunnelNeedsContinuation(
        (lastIncoming.text || "").trim(),
        collectOutgoingTextsFromThread(sortedMessages),
      )
    ) {
      return { eligible: true };
    }
    return { eligible: false, reason: "awaiting_customer_reply" };
  }

  if (isNewCustomerTurn) {
    return { eligible: true };
  }

  if (hasDeliveredReplyAfter(sortedMessages, lastIncomingAt, conv, undefined, options?.country)) {
    if (
      options?.country === "EG" &&
      egFunnelNeedsContinuation((lastIncoming.text || "").trim(), collectOutgoingTextsFromThread(sortedMessages))
    ) {
      return { eligible: true };
    }
    if (
      options?.country === "CM" &&
      cmFunnelNeedsContinuation(
        (lastIncoming.text || "").trim(),
        collectOutgoingTextsFromThread(sortedMessages),
      )
    ) {
      return { eligible: true };
    }
    // Do NOT markSeen/acknowledge — that permanently silences unread chats overnight.
    return { eligible: false, reason: "replied_after_in_thread" };
  }

  if (hasUnreadMarkers(conv)) {
    return { eligible: true };
  }

  if (isIncomingDirection(conv.lastMessageDirection)) {
    return { eligible: true };
  }

  if (convState.lastCustomerMessageId === lastIncoming.id && !convState.lastReplyAt) {
    if (hasUnreadMarkers(conv) || isIncomingDirection(conv.lastMessageDirection)) {
      return { eligible: true };
    }
    return { eligible: false, reason: "already_skipped_message" };
  }

  return { eligible: false, reason: "stale_read_conversation" };
}
