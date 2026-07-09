import type { PagerConversation, PagerMessage } from "./pager-client.js";
import { isCustomerMessage, resolveLastMessageAt } from "./pager-client.js";
import type { ConversationRuntimeState } from "./state-store.js";

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
  if (isFreshCustomerMessage(resolveLastMessageAt(conv))) {
    return true;
  }
  if (hasUnreadMarkers(conv)) {
    return true;
  }
  if (isIncomingDirection(conv.lastMessageDirection)) {
    if ((conv.conversationState ?? "").trim().toLowerCase() === "read") {
      return false;
    }
    return true;
  }
  return false;
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
): PagerMessage | undefined {
  return sortMessagesNewestFirst(messages).find((message) =>
    isCustomerMessage(message, conv, operatorUserId),
  );
}

export function hasOperatorReplyAfter(
  messages: PagerMessage[],
  afterCustomerAt: string,
  conv?: PagerConversation,
  operatorUserId?: string,
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
): boolean {
  return hasOperatorReplyAfter(messages, lastIncomingAt, conv, operatorUserId);
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
  if (hasOperatorReplyAfter(messages, customerAt, conv)) {
    return false;
  }

  if (shouldProcessIncomingMessage(customerAt, conv)) {
    return true;
  }

  if (hasUnreadMarkers(conv)) {
    return true;
  }

  const state = (conv.conversationState ?? "").trim().toLowerCase();
  if (state === "read" || conv.isUnread === false) {
    return false;
  }

  const latest = sortMessagesNewestFirst(messages)[0];
  if (latest && isCustomerMessage(latest, conv)) {
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

  if (hasDeliveredReplyAfter(sortedMessages, lastIncomingAt, conv)) {
    return { eligible: false, reason: "replied_after_in_thread", markSeen: true };
  }

  if (shouldProcessIncomingMessage(lastIncomingAt, conv)) {
    return { eligible: true };
  }

  if (isCustomerWaitingInThread(conv, sortedMessages, { country: options?.country })) {
    return { eligible: true };
  }

  if (convState.lastCustomerMessageId === lastIncoming.id && !convState.lastReplyAt) {
    return { eligible: false, reason: "already_skipped_message" };
  }

  return { eligible: false, reason: "stale_read_conversation" };
}
