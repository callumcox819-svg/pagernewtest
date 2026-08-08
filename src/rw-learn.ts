import type { PagerConversation, PagerMessage } from "./pager-client.js";
import {
  isInProgressStatusConversation,
  isNoStatusConversation,
  isRwCompletedConversation,
} from "./status-folders.js";

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
  | "operator_message"
  | "completed_harvest"
  | "transcript_customer"
  | "transcript_operator";

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
  /** Уже снята полная переписка из «Завершено». */
  harvestedCompleted?: Record<
    string,
    { at: string; channelName: string; turns: number }
  >;
};

const MAX_EVENTS = 800;
const MAX_TRANSCRIPT_TURNS = 80;

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
    harvestedCompleted?: Record<string, { at: string; channelName: string; turns: number }>;
  },
): RwLearningState {
  const watch = { ...(current?.watch ?? {}), ...(patch.watch ?? {}) };
  const events = [...(current?.events ?? []), ...(patch.events ?? [])].slice(-MAX_EVENTS);
  const harvestedCompleted = {
    ...(current?.harvestedCompleted ?? {}),
    ...(patch.harvestedCompleted ?? {}),
  };
  return { watch, events, harvestedCompleted };
}

export function harvestRwCompletedConversation(input: {
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

  if (learning?.harvestedCompleted?.[convId]) {
    return { next: learning, newEvents: [] };
  }

  const statusName = (conv.status?.name || "Завершено").trim();
  const sorted = [...messages].sort(
    (a, b) => Date.parse(a.createdAt ?? "") - Date.parse(b.createdAt ?? ""),
  );

  const newEvents: RwLearningEvent[] = [
    {
      at: now,
      channelId,
      channelName,
      conversationId: convId,
      kind: "completed_harvest",
      statusName,
      textPreview: `${sorted.length} сообщ. в треде`,
    },
  ];

  let turns = 0;
  for (const message of sorted) {
    if (turns >= MAX_TRANSCRIPT_TURNS) {
      break;
    }
    const text = (message.text || "").trim();
    if (!text) {
      continue;
    }
    if (isCustomerMessage(message, conv)) {
      newEvents.push({
        at: message.createdAt ?? now,
        channelId,
        channelName,
        conversationId: convId,
        kind: "transcript_customer",
        statusName,
        textPreview: truncateText(text, 240),
      });
      turns += 1;
    } else if (isOperatorMessage(message, conv, operatorUserId)) {
      newEvents.push({
        at: message.createdAt ?? now,
        channelId,
        channelName,
        conversationId: convId,
        kind: "transcript_operator",
        statusName,
        textPreview: truncateText(text, 240),
      });
      turns += 1;
    }
  }

  const next = mergeRwLearningState(learning, {
    events: newEvents,
    harvestedCompleted: {
      [convId]: { at: now, channelName, turns },
    },
  });

  for (const event of newEvents) {
    console.log(
      `RW learn · ${event.channelName} · ${event.conversationId.slice(0, 8)} · ${event.kind}${event.textPreview ? ` · ${event.textPreview}` : ""}`,
    );
  }

  return { next, newEvents };
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
    if (isInProgressStatusConversation(conv)) {
      console.log(
        `RW learn · ${channelName} · ${convId.slice(0, 8)} · funnel: «Без статусу» → «В процессе» (как CM/ZM, свои шаблоны позже)`,
      );
    }
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

  const sawNewLead = newEvents.some((e) => e.kind === "no_status_lead");

  if (latestCustomer?.id) {
    lastCustomerMessageId = latestCustomer.id;
    const isNewCustomerMsg =
      latestCustomer.id !== prev?.lastCustomerMessageId &&
      (prev != null || sawNewLead);
    if (isNewCustomerMsg) {
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
    const isNewOperatorMsg =
      latestOperator.id !== prev?.lastOperatorMessageId &&
      (prev != null || sawNewLead);
    if (isNewOperatorMsg) {
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

  const watchEntry: RwLearningWatchEntry | undefined =
    isNoStatusConversation(conv) ||
    prev ||
    newEvents.some((e) => e.kind === "status_changed" || e.kind === "customer_message")
      ? {
          channelId,
          channelName,
          statusId,
          statusName,
          lastCustomerMessageId,
          lastOperatorMessageId,
          firstSeenAt: prev?.firstSeenAt ?? now,
          updatedAt: now,
        }
      : undefined;

  const next = mergeRwLearningState(learning, {
    watch: watchEntry ? { [convId]: watchEntry } : undefined,
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
  const harvested = learning?.harvestedCompleted
    ? Object.keys(learning.harvestedCompleted).length
    : 0;
  if (!learning?.events.length) {
    return [
      "Руанда (обучение): событий пока нет.",
      "",
      "Живое: «Без статусу» → оператор → «В процессе».",
      "Эталоны: папка «Завершено» на 3 RW-каналах (полная переписка, без авто-ответов).",
      "Нужно: каналы RW включены; «Без статусу» в боте — для новых лидов.",
    ].join("\n");
  }
  const recent = learning.events.slice(-15).reverse();
  const lines = recent.map((event) => {
    const head = `${event.at.slice(11, 19)} ${event.channelName} ${event.conversationId.slice(0, 8)}`;
    if (event.kind === "status_changed") {
      const toProgress = /процес|process/i.test(event.statusName ?? "");
      return `${head}: ${event.previousStatusName} → ${event.statusName}${toProgress ? " ✓" : ""}`;
    }
    if (event.kind === "no_status_lead") {
      return `${head}: лид «Без статусу»`;
    }
    if (event.kind === "completed_harvest") {
      return `${head}: 📁 Завершено — ${event.textPreview ?? "переписка"}`;
    }
    if (event.kind === "transcript_operator") {
      return `${head}: оператор — ${event.textPreview ?? ""}`;
    }
    if (event.kind === "transcript_customer") {
      return `${head}: клиент — ${event.textPreview ?? ""}`;
    }
    if (event.kind === "operator_message") {
      return `${head}: оператор [${event.statusName ?? "?"}] — ${event.textPreview ?? ""}`;
    }
    if (event.kind === "customer_message") {
      return `${head}: клиент — ${event.textPreview ?? ""}`;
    }
    return `${head}: ${event.kind}`;
  });
  const watching = Object.keys(learning.watch).length;
  return [
    `Руанда (обучение) · watchlist ${watching} · эталонов «Завершено»: ${harvested}`,
    "Живое: Без статусу → оператор → В процессе · Эталон: полный диалог в «Завершено»",
    "",
    lines.join("\n"),
  ].join("\n");
}
