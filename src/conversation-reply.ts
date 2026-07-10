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
import { isInProgressStatusConversation } from "./status-folders.js";

/** Customer message is new enough to auto-reply. */
export const FRESH_CUSTOMER_MESSAGE_MS = 2 * 60 * 60 * 1000;

/** Max age when Pager omits unread flags but customer spoke last. */
export const MAX_ACTIONABLE_AGE_MS = 6 * 60 * 60 * 1000;

export function isActionableCustomerMessage(
  conv: PagerConversation,
  lastIncomingAt?: string,
): boolean {
  const at = lastIncomingAt ?? resolveLastMessageAt(conv);

  if (hasUnreadMarkers(conv)) {
    return true;
  }
  if (isFreshCustomerMessage(at)) {
    return true;
  }

  if (isInProgressStatusConversation(conv)) {
    return false;
  }

  if (!isIncomingDirection(conv.lastMessageDirection)) {
    return false;
  }

  const state = (conv.conversationState ?? "").trim().toLowerCase();
  if (state === "read") {
    return false;
  }

  const ts = Date.parse(parseMessageTimestamp(at));
  if (!Number.isFinite(ts) || Date.now() - ts > MAX_ACTIONABLE_AGE_MS) {
    return false;
  }

  return true;
}

export function shouldQueueConversation(conv: PagerConversation): boolean {
  return isActionableCustomerMessage(conv, resolveLastMessageAt(conv));
}

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

/** @deprecated Use shouldQueueConversation */
export function shouldProcessConversation(conv: PagerConversation): boolean {
  return shouldQueueConversation(conv);
}

export function shouldProcessIncomingMessage(lastIncomingAt?: string, conv?: PagerConversation): boolean {
  if (!conv) {
    return isFreshCustomerMessage(lastIncomingAt);
  }
  return isActionableCustomerMessage(conv, lastIncomingAt);
}

export function shouldOpenConversation(conv: PagerConversation): boolean {
  return shouldProcessConversation(conv);
}

export function conversationPriorityScore(conv: PagerConversation): number {
  const unread = isConversationUnread(conv);
  const incoming = isIncomingDirection(conv.lastMessageDirection);
  const fresh = isFreshCustomerMessage(resolveLastMessageAt(conv));
  const lastAt = Date.parse(resolveLastMessageAt(conv) ?? "");
  return (
    (unread ? 2_000_000 : 0) +
    (fresh ? 1_000_000 : 0) +
    (incoming ? 100_000 : 0) +
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

  return false;
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

export function assessReplyEligibility(
  conv: PagerConversation,
  convState: ConversationRuntimeState,
  lastIncoming: PagerMessage,
  sortedMessages: PagerMessage[],
  options?: { country?: "ZM" | "CM" | "EG" },
): ReplyEligibility {
  const lastIncomingAt = parseMessageTimestamp(lastIncoming.createdAt);
  const customerText = (lastIncoming.text || "").trim();

  if (!isActionableCustomerMessage(conv, lastIncomingAt)) {
    return { eligible: false, reason: "not_actionable", markSeen: true };
  }

  if (hasDeliveredReplyAfter(sortedMessages, lastIncomingAt, conv, undefined, options?.country)) {
    if (
      options?.country === "EG" &&
      isFreshCustomerMessage(lastIncomingAt) &&
      egFunnelNeedsContinuation(
        customerText,
        collectOutgoingTextsFromThread(sortedMessages),
      )
    ) {
      return { eligible: true };
    }
    return { eligible: false, reason: "replied_after_in_thread", markSeen: true };
  }

  return { eligible: true };
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
