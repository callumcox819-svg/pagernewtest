import type { PagerConversation, PagerMessage } from "./pager-client.js";
import { isNoStatusConversation } from "./status-folders.js";

/** Каналы с первого скрина — наблюдение до полноценных шаблонов RW. */
export const RW_LEARN_CHANNEL_HINTS = [
  "remorseful respectful",
  "ekambi aboubakar",
  "patrick uwimana",
] as const;

export type WorkerCountry = "ZM" | "CM" | "EG" | "RW";

export type RwLearningEventKind =
  | "no_status_lead"
  | "status_changed"
  | "customer_message"
  | "operator_message";

export type RwLearningEvent = {
  at: string;
  channelId: string;
  channelName: string;
  conversationId: string;
  kind: RwLearningEventKind;
  statusName?: string;
  previousStatusName?: string;
  textPreview?: string;
};

export type RwLearningWatchEntry = {
  channelId: string;
  channelName: string;
  statusId?: string;
  statusName?: string;
  lastCustomerMessageId?: string;
  lastOperatorMessageId?: string;
  firstSeenAt: string;
  updatedAt: string;
};

export type RwLearningState = {
  watch: Record<string, RwLearningWatchEntry>;
  events: RwLearningEvent[];
};

const MAX_EVENTS = 300;

export function isRwLearnChannelName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return RW_LEARN_CHANNEL_HINTS.some((hint) => {
    const parts = hint.split(/\s+/).filter(Boolean);
    return parts.every((part) => normalized.includes(part));
  });
}

export function defaultCountryForChannelName(name: string): WorkerCountry {
  if (isRwLearnChannelName(name)) {
    return "RW";
  }
  const normalized = name.toLowerCase();
  if (/mahmoud|anas|ahmad|moulaye|egypt|eg/.test(normalized)) {
    return "EG";
  }
  if (/moukoko|ndzi|cameroon|cm|tchouameni/.test(normalized)) {
    return "CM";
  }
  return "ZM";
}

function truncateText(text: string, max = 120): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) {
    return t;
  }
  return `${t.slice(0, max - 1)}…`;
}

function isOperatorMessage(
  message: PagerMessage,
  conv: PagerConversation,
  operatorUserId?: string,
): boolean {
  const direction = (message.messageDirection || "").toLowerCase();
  if (direction.includes("out") || direction.includes("operator")) {
    return true;
  }
  const author = (message.authorId || "").trim();
  if (operatorUserId && author && author === operatorUserId) {
    return true;
  }
  if (author && !author.startsWith("user_")) {
    return true;
  }
  return direction.includes("incoming") === false && Boolean(message.text?.trim());
}

function isCustomerMessage(message: PagerMessage, conv: PagerConversation): boolean {
  const direction = (message.messageDirection || "").toLowerCase();
  if (direction.includes("in") || direction.includes("customer")) {
    return true;
  }
  const author = (message.authorId || "").trim();
  return author.startsWith("user_") || direction.includes("incoming");
}

export function mergeRwLearningState(
  current: RwLearningState | undefined,
  patch: {
    watch?: Record<string, RwLearningWatchEntry>;
    events?: RwLearningEvent[];
  },
): RwLearningState {
  const watch = { ...(current?.watch ?? {}), ...(patch.watch ?? {}) };
  const events = [...(current?.events ?? []), ...(patch.events ?? [])].slice(-MAX_EVENTS);
  return { watch, events };
}

export function observeRwConversation(input: {
  conv: PagerConversation;
  channelId: string;
  channelName: string;
  messages: PagerMessage[];
  operatorUserId?: string;
  learning?: RwLearningState;
}): { next: RwLearningState; newEvents: RwLearningEvent[] } {
  const { conv, channelId, channelName, messages, operatorUserId, learning } = input;
  const convId = conv.id;
  const now = new Date().toISOString();
  const prev = learning?.watch[convId];
  const statusId = conv.statusId ?? "";
  const statusName = (conv.status?.name || (isNoStatusConversation(conv) ? "Без статусу" : "")).trim();

  const sorted = [...messages].sort(
    (a, b) => Date.parse(a.createdAt ?? "") - Date.parse(b.createdAt ?? ""),
  );

  const newEvents: RwLearningEvent[] = [];

  if (!prev && isNoStatusConversation(conv)) {
    newEvents.push({
      at: now,
      channelId,
      channelName,
      conversationId: convId,
      kind: "no_status_lead",
      statusName,
    });
  }

  if (prev && (prev.statusId !== statusId || prev.statusName !== statusName)) {
    newEvents.push({
      at: now,
      channelId,
      channelName,
      conversationId: convId,
      kind: "status_changed",
      previousStatusName: prev.statusName || "—",
      statusName: statusName || "—",
    });
  }

  let lastCustomerMessageId = prev?.lastCustomerMessageId;
  let lastOperatorMessageId = prev?.lastOperatorMessageId;

  let latestCustomer: PagerMessage | undefined;
  let latestOperator: PagerMessage | undefined;
  for (const message of sorted) {
    if (isCustomerMessage(message, conv)) {
      latestCustomer = message;
    } else if (isOperatorMessage(message, conv, operatorUserId)) {
      latestOperator = message;
    }
  }

  if (latestCustomer?.id) {
    lastCustomerMessageId = latestCustomer.id;
    if (prev?.lastCustomerMessageId && prev.lastCustomerMessageId !== latestCustomer.id) {
      newEvents.push({
        at: now,
        channelId,
        channelName,
        conversationId: convId,
        kind: "customer_message",
        statusName,
        textPreview: truncateText(latestCustomer.text || "[media]"),
      });
    }
  }

  if (latestOperator?.id) {
    lastOperatorMessageId = latestOperator.id;
    if (prev?.lastOperatorMessageId && prev.lastOperatorMessageId !== latestOperator.id) {
      newEvents.push({
        at: now,
        channelId,
        channelName,
        conversationId: convId,
        kind: "operator_message",
        statusName,
        textPreview: truncateText(latestOperator.text || "[media/template]"),
      });
    }
  }

  const watchEntry: RwLearningWatchEntry = {
    channelId,
    channelName,
    statusId,
    statusName,
    lastCustomerMessageId,
    lastOperatorMessageId,
    firstSeenAt: prev?.firstSeenAt ?? now,
    updatedAt: now,
  };

  const next = mergeRwLearningState(learning, {
    watch: { [convId]: watchEntry },
    events: newEvents,
  });

  for (const event of newEvents) {
    console.log(
      `RW learn · ${event.channelName} · ${event.conversationId.slice(0, 8)} · ${event.kind}${event.statusName ? ` · ${event.statusName}` : ""}${event.textPreview ? ` · ${event.textPreview}` : ""}`,
    );
  }

  return { next, newEvents };
}

export function formatRwLearningSummary(learning?: RwLearningState): string {
  if (!learning?.events.length) {
    return "Руанда (обучение): событий пока нет. Включите каналы Remorseful / Ekambi / Patrick, страна «Руанда», папку «Без статусу».";
  }
  const recent = learning.events.slice(-12).reverse();
  const lines = recent.map((event) => {
    const head = `${event.at.slice(11, 19)} ${event.channelName} ${event.conversationId.slice(0, 8)}`;
    if (event.kind === "status_changed") {
      return `${head}: статус ${event.previousStatusName} → ${event.statusName}`;
    }
    if (event.kind === "no_status_lead") {
      return `${head}: новый «Без статусу»`;
    }
    return `${head}: ${event.kind}${event.textPreview ? ` — ${event.textPreview}` : ""}`;
  });
  const watching = Object.keys(learning.watch).length;
  return `Руанда (обучение) · смотрим ${watching} чат(ов)\n\n${lines.join("\n")}`;
}
