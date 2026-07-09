import type { PagerConversation, PagerMessage } from "./pager-client.js";
import type { ConversationRuntimeState } from "./state-store.js";

/** Brand-new customer messages (always processed). */
export const FRESH_CUSTOMER_MESSAGE_MS = 30 * 60 * 1000;

export type ReplyEligibility =
  | { eligible: true }
  | { eligible: false; reason: string; markSeen?: boolean };

export function isIncomingDirection(direction?: string): boolean {
  const value = (direction ?? "").trim().toLowerCase();
  return value === "incoming" || value === "in";
}

export function isOutgoingDirection(direction?: string): boolean {
  const value = (direction ?? "").trim().toLowerCase();
  return value === "outgoing" || value === "out";
}

export function isFreshCustomerMessage(createdAt?: string, nowMs = Date.now()): boolean {
  const ts = Date.parse(createdAt ?? "");
  if (!Number.isFinite(ts)) {
    return false;
  }
  return nowMs - ts <= FRESH_CUSTOMER_MESSAGE_MS;
}

function isExplicitlyRead(conv: PagerConversation): boolean {
  const state = (conv.conversationState ?? "").trim().toLowerCase();
  return state === "read" || conv.isUnread === false;
}

export function isConversationUnread(conv: PagerConversation): boolean {
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
  if (isExplicitlyRead(conv)) {
    return false;
  }
  if (isFreshCustomerMessage(conv.lastMessageAt)) {
    return true;
  }
  return false;
}

/** Process only new incoming messages or older still-unread inbox chats. */
export function shouldProcessConversation(conv: PagerConversation): boolean {
  if (isExplicitlyRead(conv)) {
    return false;
  }
  if (isConversationUnread(conv)) {
    return true;
  }
  if (isFreshCustomerMessage(conv.lastMessageAt)) {
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
  const fresh = isFreshCustomerMessage(conv.lastMessageAt);
  const lastAt = Date.parse(conv.lastMessageAt ?? "");
  return (
    (unread ? 2_000_000 : 0) +
    (fresh ? 1_000_000 : 0) +
    (incoming ? 100_000 : 0) +
    (Number.isFinite(lastAt) ? Math.floor(lastAt / 1000) : 0)
  );
}

export function findLatestIncomingMessage(messages: PagerMessage[]): PagerMessage | undefined {
  const sorted = [...messages].sort(
    (left, right) => Date.parse(right.createdAt ?? "") - Date.parse(left.createdAt ?? ""),
  );
  return sorted.find((message) => isIncomingDirection(message.messageDirection));
}

export function hasDeliveredReplyAfter(messages: PagerMessage[], lastIncomingAt: string): boolean {
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

export function assessReplyEligibility(
  conv: PagerConversation,
  convState: ConversationRuntimeState,
  lastIncoming: PagerMessage,
  sortedMessages: PagerMessage[],
): ReplyEligibility {
  const lastIncomingAt = lastIncoming.createdAt ?? "";

  if (convState.lastCustomerMessageId === lastIncoming.id && convState.lastReplyAt) {
    return { eligible: false, reason: "already_replied_to_message" };
  }

  if (hasDeliveredReplyAfter(sortedMessages, lastIncomingAt)) {
    return { eligible: false, reason: "replied_after_in_thread", markSeen: true };
  }

  if (isFreshCustomerMessage(lastIncomingAt)) {
    return { eligible: true };
  }

  if (isConversationUnread(conv)) {
    return { eligible: true };
  }

  if (convState.lastCustomerMessageId === lastIncoming.id && !convState.lastReplyAt) {
    return { eligible: false, reason: "already_skipped_message" };
  }

  return { eligible: false, reason: "stale_read_conversation" };
}
