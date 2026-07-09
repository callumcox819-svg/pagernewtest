import type { PagerConversation, PagerMessage } from "./pager-client.js";
import type { ConversationRuntimeState } from "./state-store.js";

/** Incoming customer messages newer than this are always eligible. */
export const FRESH_CUSTOMER_MESSAGE_MS = 15 * 60 * 1000;

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

export function isConversationUnread(conv: PagerConversation): boolean {
  const state = (conv.conversationState ?? "").trim().toLowerCase();
  if (state === "unread") {
    return true;
  }
  if (state === "read") {
    return false;
  }
  if (typeof conv.unreadCount === "number") {
    return conv.unreadCount > 0;
  }
  if (conv.isUnread === true) {
    return true;
  }
  if (conv.isUnread === false) {
    return false;
  }

  const lastAt = Date.parse(conv.lastMessageAt ?? "");
  if (Number.isFinite(lastAt) && Date.now() - lastAt > FRESH_CUSTOMER_MESSAGE_MS) {
    return false;
  }

  return true;
}

export function isFreshCustomerMessage(createdAt?: string, nowMs = Date.now()): boolean {
  const ts = Date.parse(createdAt ?? "");
  if (!Number.isFinite(ts)) {
    return false;
  }
  return nowMs - ts <= FRESH_CUSTOMER_MESSAGE_MS;
}

export function assessReplyEligibility(
  conv: PagerConversation,
  convState: ConversationRuntimeState,
  lastIncoming: PagerMessage,
  sortedMessages: PagerMessage[],
): ReplyEligibility {
  const lastIncomingAt = lastIncoming.createdAt ?? "";
  const unread = isConversationUnread(conv);

  if (convState.lastCustomerMessageId === lastIncoming.id && convState.lastReplyAt) {
    return { eligible: false, reason: "already_replied_to_message" };
  }

  if (convState.lastCustomerMessageId === lastIncoming.id && !convState.lastReplyAt) {
    if (unread) {
      return { eligible: true };
    }
    return { eligible: false, reason: "already_skipped_message" };
  }

  if (hasDeliveredReplyAfter(sortedMessages, lastIncomingAt)) {
    return { eligible: false, reason: "replied_after_in_thread", markSeen: true };
  }

  if (isFreshCustomerMessage(lastIncomingAt)) {
    return { eligible: true };
  }

  if (unread) {
    return { eligible: true };
  }

  return { eligible: false, reason: "stale_read_conversation", markSeen: true };
}
