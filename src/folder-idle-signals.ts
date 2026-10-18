import type { WorkerCountry } from "./rw-learn.js";
import type { ConversationRuntimeState, ChatState } from "./state-store.js";
import type { PagerConversation, PagerMessage } from "./pager-client.js";
import { resolveLastMessageAt } from "./pager-client.js";
import {
  isIncomingDirection,
  isOutgoingDirection,
  parseMessageTimestamp,
} from "./conversation-reply.js";
import {
  ALL_INBOX_FOLDER_ID,
  NO_STATUS_FOLDER_ID,
  conversationFolderKey,
  isFunnelFollowUpFolderName,
  isNoStatusConversation,
  isNoStatusFolderName,
  type StatusFolderState,
} from "./status-folders.js";

/** Language packs for idle pings (by geo). */
export type IdleSignalLang = "en" | "fr" | "es" | "ar";

export type IdleSignalFolderKind = "in_progress" | "waiting_id" | "generic" | "skip";

export type FolderIdleSignalFolderConfig = {
  /** Default true for non-skip folders when master toggle is on. */
  enabled?: boolean;
  /** Silence threshold in minutes before a ping. */
  thresholdMinutes?: number;
};

export type FolderIdleSignalsSettings = {
  enabled: boolean;
  /** Max pings per conversation per UTC calendar day. */
  maxPerDay: number;
  folders: Record<string, FolderIdleSignalFolderConfig>;
};

export const FOLDER_IDLE_DEFAULT_MAX_PER_DAY = 3;
export const FOLDER_IDLE_DEFAULT_THRESHOLD_IN_PROGRESS_MIN = 30;
export const FOLDER_IDLE_DEFAULT_THRESHOLD_OTHER_MIN = 60;
export const FOLDER_IDLE_COOLDOWN_MS = 25 * 60 * 1000;

const MESSAGES: Record<IdleSignalFolderKind, Record<IdleSignalLang, string[]>> = {
  skip: { en: [], fr: [], es: [], ar: [] },
  in_progress: {
    en: [
      "Have you finished registration?",
      "Where did you get stuck in registration?",
      "Are you still on the registration step?",
    ],
    fr: [
      "Avez-vous terminé l'inscription ?",
      "À quelle étape de l'inscription êtes-vous bloqué(e) ?",
      "Êtes-vous toujours en train de vous inscrire ?",
    ],
    es: [
      "¿Ya terminaste el registro?",
      "¿En qué etapa del registro te quedaste?",
      "¿Sigues en el proceso de registro?",
    ],
    ar: [
      "هل أنهيت التسجيل؟",
      "في أي مرحلة من التسجيل توقفت؟",
      "هل ما زلت في خطوة التسجيل؟",
    ],
  },
  waiting_id: {
    en: [
      "Is everything going well?",
      "Did you manage to get your ID?",
      "Where are you stuck with the ID step?",
    ],
    fr: [
      "Est-ce que tout se passe bien ?",
      "Avez-vous réussi à obtenir votre ID ?",
      "À quelle étape de l'ID êtes-vous bloqué(e) ?",
    ],
    es: [
      "¿Te está saliendo todo bien?",
      "¿Lograste conseguir tu ID?",
      "¿En qué etapa del ID te quedaste?",
    ],
    ar: [
      "هل كل شيء تمام؟",
      "هل حصلت على الآي دي؟",
      "في أي مرحلة من خطوة الآي دي توقفت؟",
    ],
  },
  generic: {
    en: [
      "Are you ready to continue?",
      "Is everything working out for you?",
      "Where did you get stuck?",
    ],
    fr: [
      "Êtes-vous prêt(e) à continuer ?",
      "Est-ce que tout se passe bien pour vous ?",
      "À quelle étape êtes-vous bloqué(e) ?",
    ],
    es: [
      "¿Estás listo para continuar?",
      "¿Te está saliendo todo bien?",
      "¿En qué etapa te quedaste?",
    ],
    ar: [
      "هل أنت مستعد للمتابعة؟",
      "هل كل شيء تمام عندك؟",
      "في أي مرحلة توقفت؟",
    ],
  },
};

export function idleSignalLangForCountry(country: WorkerCountry): IdleSignalLang {
  if (country === "EG" || country === "JO" || country === "PK") {
    return "ar";
  }
  if (
    country === "CM" ||
    country === "MG" ||
    country === "DJ" ||
    country === "MA" ||
    country === "MR" ||
    country === "BF" ||
    country === "BJ" ||
    country === "SN"
  ) {
    return "fr";
  }
  if (country === "CL" || country === "GT" || country === "EC") {
    return "es";
  }
  return "en";
}

export function isWaitingIdFolderName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return /чекаю\s*id|waiting.*id|жду\s*айди|attente.*id|awaiting.*id/i.test(normalized);
}

export function isIgnoreLikeFolderName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return /ігнор|игнор|ignore|спам|troll|бан/i.test(normalized);
}

export function isClosedLikeFolderName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  if (isIgnoreLikeFolderName(normalized)) {
    return true;
  }
  return /скасован|cancel|cancelled|canceled|заверш|complete|completed|registered|^win$|deposit|выигр/i.test(
    normalized,
  );
}

export function classifyIdleSignalFolderKind(folderName: string): IdleSignalFolderKind {
  const name = folderName.trim();
  if (!name || isNoStatusFolderName(name)) {
    return "skip";
  }
  if (isIgnoreLikeFolderName(name) || isClosedLikeFolderName(name)) {
    return "skip";
  }
  if (isWaitingIdFolderName(name)) {
    return "waiting_id";
  }
  // in-progress registration (not waiting-id; funnel helper also matches waiting-id)
  if (
    isFunnelFollowUpFolderName(name) &&
    !isWaitingIdFolderName(name)
  ) {
    return "in_progress";
  }
  if (
    /в процес|у процес|процес|process|рега|реєстраці|регистрац|не заверш|en cours|in progress/i.test(
      name.toLowerCase(),
    )
  ) {
    return "in_progress";
  }
  return "generic";
}

export function defaultThresholdMinutesForKind(kind: IdleSignalFolderKind): number {
  if (kind === "in_progress") {
    return FOLDER_IDLE_DEFAULT_THRESHOLD_IN_PROGRESS_MIN;
  }
  if (kind === "skip") {
    return FOLDER_IDLE_DEFAULT_THRESHOLD_OTHER_MIN;
  }
  return FOLDER_IDLE_DEFAULT_THRESHOLD_OTHER_MIN;
}

export function getFolderIdleSignalsSettings(
  state: Pick<ChatState, "operatorSettings">,
): FolderIdleSignalsSettings {
  const raw = state.operatorSettings?.folderIdleSignals;
  return {
    enabled: Boolean(raw?.enabled),
    maxPerDay: Math.max(1, Math.min(10, Number(raw?.maxPerDay) || FOLDER_IDLE_DEFAULT_MAX_PER_DAY)),
    folders: raw?.folders ?? {},
  };
}

export function isFolderIdleSignalsEnabled(state: Pick<ChatState, "operatorSettings">): boolean {
  return getFolderIdleSignalsSettings(state).enabled;
}

export function resolveFolderIdleConfig(
  settings: FolderIdleSignalsSettings,
  folderId: string,
  folderName: string,
): { kind: IdleSignalFolderKind; enabled: boolean; thresholdMinutes: number } {
  const kind = classifyIdleSignalFolderKind(folderName);
  const row = settings.folders[folderId];
  const enabled = kind === "skip" ? false : row?.enabled !== false;
  const thresholdMinutes = Math.max(
    10,
    Math.min(
      24 * 60,
      Number(row?.thresholdMinutes) || defaultThresholdMinutesForKind(kind),
    ),
  );
  return { kind, enabled, thresholdMinutes };
}

function stableHash(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}

export function pickFolderIdleSignalMessage(
  kind: IdleSignalFolderKind,
  lang: IdleSignalLang,
  convId: string,
  dayKey: string,
  countToday: number,
): string | undefined {
  const pool = MESSAGES[kind]?.[lang] ?? [];
  if (!pool.length) {
    return undefined;
  }
  const index = stableHash(`${convId}:${dayKey}:${countToday}:${kind}`) % pool.length;
  return pool[index];
}

export function utcDayKey(nowMs = Date.now()): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

export function resolveConversationFolderMeta(conv: PagerConversation): {
  folderId: string;
  folderName: string;
} {
  if (isNoStatusConversation(conv)) {
    return { folderId: NO_STATUS_FOLDER_ID, folderName: conv.status?.name || "Без статусу" };
  }
  return {
    folderId: conversationFolderKey(conv) || (conv.statusId || "").trim(),
    folderName: (conv.status?.name || "").trim() || "?",
  };
}

/** Last activity from either side (any non-empty message). */
export function resolveLastAnyActivityMs(messages: PagerMessage[]): number | null {
  let newest: number | null = null;
  for (const message of messages) {
    const hasTraffic =
      isIncomingDirection(message.messageDirection) ||
      isOutgoingDirection(message.messageDirection) ||
      Boolean(message.isDelivered || message.facebookMessageId);
    if (!hasTraffic) {
      continue;
    }
    const ts = Date.parse(parseMessageTimestamp(message.createdAt));
    if (!Number.isFinite(ts)) {
      continue;
    }
    if (newest === null || ts > newest) {
      newest = ts;
    }
  }
  return newest;
}

export function folderIdleSignalDayCount(
  convState: ConversationRuntimeState | undefined,
  nowMs = Date.now(),
): { dayKey: string; count: number } {
  const dayKey = utcDayKey(nowMs);
  if (!convState?.folderIdleSignalDay || convState.folderIdleSignalDay !== dayKey) {
    return { dayKey, count: 0 };
  }
  return { dayKey, count: Math.max(0, Number(convState.folderIdleSignalCountToday) || 0) };
}

export function isFolderIdleSignalCoolingDown(
  convState: ConversationRuntimeState | undefined,
  nowMs = Date.now(),
): boolean {
  const lastMs = Date.parse(convState?.folderIdleSignalLastSentAt ?? "");
  if (!Number.isFinite(lastMs)) {
    return false;
  }
  return nowMs - lastMs < FOLDER_IDLE_COOLDOWN_MS;
}

/**
 * Fast inbox filter: feature on, folder eligible, silence by lastMessageAt, under daily cap.
 */
export function shouldQueueFolderIdleSignal(
  conv: PagerConversation,
  state: ChatState,
  folderCatalog: StatusFolderState[],
  nowMs = Date.now(),
): boolean {
  const settings = getFolderIdleSignalsSettings(state);
  if (!settings.enabled) {
    return false;
  }
  const { folderId, folderName } = resolveConversationFolderMeta(conv);
  if (folderId === ALL_INBOX_FOLDER_ID) {
    return false;
  }
  const catalogName =
    folderCatalog.find((folder) => folder.id === folderId)?.name?.trim() || folderName;
  const resolved = resolveFolderIdleConfig(settings, folderId, catalogName);
  if (!resolved.enabled || resolved.kind === "skip") {
    return false;
  }

  const convState = state.conversations?.[conv.id];
  if (convState?.ignoredAt?.trim() || convState?.inProgressMutedAt?.trim()) {
    return false;
  }
  const { count } = folderIdleSignalDayCount(convState, nowMs);
  if (count >= settings.maxPerDay) {
    return false;
  }
  if (isFolderIdleSignalCoolingDown(convState, nowMs)) {
    return false;
  }

  const lastAt = resolveLastMessageAt(conv);
  const lastMs = Date.parse(lastAt ?? "");
  if (!Number.isFinite(lastMs)) {
    return false;
  }
  const thresholdMs = resolved.thresholdMinutes * 60 * 1000;
  return nowMs - lastMs >= thresholdMs;
}

export function evaluateFolderIdleSignalSend(input: {
  conv: PagerConversation;
  state: ChatState;
  country: WorkerCountry;
  messages: PagerMessage[];
  folderCatalog: StatusFolderState[];
  nowMs?: number;
}): {
  ok: true;
  text: string;
  kind: IdleSignalFolderKind;
  folderId: string;
  dayKey: string;
  nextCount: number;
} | { ok: false; reason: string } {
  const nowMs = input.nowMs ?? Date.now();
  const settings = getFolderIdleSignalsSettings(input.state);
  if (!settings.enabled) {
    return { ok: false, reason: "disabled" };
  }
  const { folderId, folderName } = resolveConversationFolderMeta(input.conv);
  const catalogName =
    input.folderCatalog.find((folder) => folder.id === folderId)?.name?.trim() || folderName;
  const config = resolveFolderIdleConfig(settings, folderId, catalogName);
  if (!config.enabled || config.kind === "skip") {
    return { ok: false, reason: "folder_skip" };
  }

  const convState = input.state.conversations?.[input.conv.id];
  if (convState?.ignoredAt?.trim()) {
    return { ok: false, reason: "ignored" };
  }
  if (convState?.inProgressMutedAt?.trim() && config.kind === "in_progress") {
    return { ok: false, reason: "muted" };
  }

  const { dayKey, count } = folderIdleSignalDayCount(convState, nowMs);
  if (count >= settings.maxPerDay) {
    return { ok: false, reason: "daily_cap" };
  }
  if (isFolderIdleSignalCoolingDown(convState, nowMs)) {
    return { ok: false, reason: "cooldown" };
  }

  const lastActivityMs = resolveLastAnyActivityMs(input.messages);
  if (lastActivityMs === null) {
    return { ok: false, reason: "no_activity" };
  }
  const thresholdMs = config.thresholdMinutes * 60 * 1000;
  if (nowMs - lastActivityMs < thresholdMs) {
    return { ok: false, reason: "not_silent_yet" };
  }

  const lang = idleSignalLangForCountry(input.country);
  const text = pickFolderIdleSignalMessage(config.kind, lang, input.conv.id, dayKey, count);
  if (!text) {
    return { ok: false, reason: "no_text" };
  }

  return {
    ok: true,
    text,
    kind: config.kind,
    folderId,
    dayKey,
    nextCount: count + 1,
  };
}

export function buildFolderIdleSignalSentPatch(
  convId: string,
  channelId: string,
  dayKey: string,
  nextCount: number,
  kind: IdleSignalFolderKind,
  nowMs = Date.now(),
): Partial<ConversationRuntimeState> {
  const iso = new Date(nowMs).toISOString();
  const patch: Partial<ConversationRuntimeState> = {
    conversationId: convId,
    channelId,
    folderIdleSignalDay: dayKey,
    folderIdleSignalCountToday: nextCount,
    folderIdleSignalLastSentAt: iso,
    folderIdleSignalLastKind: kind,
    lastReplyAt: iso,
    lastReplyRole: "folder_idle_signal",
    sendFailures: 0,
  };
  if (kind === "in_progress") {
    // Keep legacy plan-ask flow able to react if customer answers.
    patch.inProgressFollowUpSentAt = iso;
  }
  return patch;
}

/** Catalog rows shown in the bot UI (skip synthetic all-inbox). */
export function listIdleSignalFoldersForUi(folders: StatusFolderState[]): Array<{
  id: string;
  name: string;
  kind: IdleSignalFolderKind;
}> {
  return folders
    .filter((folder) => folder.id && folder.id !== ALL_INBOX_FOLDER_ID)
    .map((folder) => ({
      id: folder.id,
      name: folder.name,
      kind: classifyIdleSignalFolderKind(folder.name),
    }))
    .filter((folder) => folder.kind !== "skip");
}
