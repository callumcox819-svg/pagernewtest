import type { PagerConversation } from "./pager-client.js";

export const NO_STATUS_FOLDER_ID = "";
export const ALL_INBOX_FOLDER_ID = "*";

export type StatusFolderState = {
  id: string;
  name: string;
  /** Bot scripts / funnel processing. */
  enabled: boolean;
  /** AI agent replies. When unset, follows `enabled`. */
  aiEnabled?: boolean;
};

/** Folder / status labels that mean «no status» across UA/RU/EN. */
export function isNoStatusFolderName(name: string | undefined): boolean {
  const normalized = (name || "").trim().toLowerCase();
  if (!normalized || normalized === "—" || normalized === "-") {
    return true;
  }
  return (
    normalized.includes("без статус") ||
    normalized.includes("нет статус") ||
    normalized.includes("no status") ||
    normalized.includes("without status") ||
    normalized === "none" ||
    normalized === "null"
  );
}

export function isNoStatusConversation(conv: PagerConversation): boolean {
  if (!conv.statusId) {
    return true;
  }
  return isNoStatusFolderName(conv.status?.name);
}

export function conversationFolderKey(conv: PagerConversation): string {
  if (isNoStatusConversation(conv)) {
    return NO_STATUS_FOLDER_ID;
  }
  return conv.statusId || "";
}

export function normalizeEnabledFolders(enabled: Set<string>): {
  specific: Set<string>;
  allInbox: boolean;
} {
  const specific = new Set([...enabled].filter((id) => id !== ALL_INBOX_FOLDER_ID));
  const allInbox = enabled.has(ALL_INBOX_FOLDER_ID);
  if (specific.size > 0) {
    return { specific, allInbox: false };
  }
  return { specific, allInbox };
}

export function conversationAllowedInFolders(
  conv: PagerConversation,
  enabled: Set<string>,
): boolean {
  if (!enabled.size) {
    return false;
  }

  const { specific, allInbox } = normalizeEnabledFolders(enabled);
  if (allInbox) {
    return true;
  }
  if (!specific.size) {
    return false;
  }

  const key = conversationFolderKey(conv);
  if (specific.has(key)) {
    return true;
  }

  // Pager often exposes «Без статусу» as a real UUID status while the menu also has
  // synthetic id "". Operators may enable either — both must match no-status chats.
  if (isNoStatusConversation(conv)) {
    if (specific.has(NO_STATUS_FOLDER_ID)) {
      return true;
    }
    const statusId = (conv.statusId || "").trim();
    if (statusId && specific.has(statusId)) {
      return true;
    }
  }

  const statusId = (conv.statusId || "").trim();
  return Boolean(statusId && specific.has(statusId));
}

export function hasEnabledStatusFolders(state: {
  statusFolders?: StatusFolderState[];
  operatorSettings?: { statusFolders?: StatusFolderState[] };
}): boolean {
  const folders = state.operatorSettings?.statusFolders ?? state.statusFolders;
  return folders?.some((folder) => folder.enabled) ?? false;
}

export function getEnabledFolderIds(state: {
  statusFolders?: StatusFolderState[];
  operatorSettings?: { statusFolders?: StatusFolderState[] };
}): Set<string> | null {
  const folders = state.operatorSettings?.statusFolders ?? state.statusFolders;
  if (!folders?.length) {
    return null;
  }

  const ids = new Set(folders.filter((folder) => folder.enabled).map((folder) => folder.id));
  for (const folder of folders) {
    if (folder.enabled && isNoStatusFolderName(folder.name)) {
      ids.add(NO_STATUS_FOLDER_ID);
    }
  }
  return ids;
}

/** Catalog of folder ids/names from Pager (global), with per-channel enabled flags when set. */
export function resolveChannelStatusFolders(
  state: {
    statusFolders?: StatusFolderState[];
    operatorSettings?: { statusFolders?: StatusFolderState[] };
    channels?: Record<string, { statusFolders?: StatusFolderState[] }>;
  },
  channelId: string,
): StatusFolderState[] {
  const catalog = state.operatorSettings?.statusFolders ?? state.statusFolders ?? [];
  if (!catalog.length) {
    return [];
  }
  const channelFolders = state.channels?.[channelId]?.statusFolders;
  if (!channelFolders?.length) {
    // Migration: until the operator sets per-channel folders, use global checkmarks.
    return catalog.map((folder) => ({ ...folder }));
  }
  const enabledById = new Map(channelFolders.map((folder) => [folder.id, folder.enabled]));
  const aiById = new Map(
    channelFolders.map((folder) => [folder.id, folder.aiEnabled]),
  );
  const resolved = catalog.map((folder) => ({
    ...folder,
    enabled: enabledById.has(folder.id) ? Boolean(enabledById.get(folder.id)) : false,
    aiEnabled: aiById.has(folder.id) ? aiById.get(folder.id) : folder.aiEnabled,
  }));
  // Keep synthetic "" in sync with any live Pager «Без статусу» UUID the operator enabled.
  const noStatusLiveEnabled = resolved.some(
    (folder) =>
      folder.id !== NO_STATUS_FOLDER_ID &&
      folder.enabled &&
      isNoStatusFolderName(folder.name),
  );
  if (noStatusLiveEnabled) {
    return resolved.map((folder) =>
      folder.id === NO_STATUS_FOLDER_ID ? { ...folder, enabled: true } : folder,
    );
  }
  return resolved;
}

export function getChannelEnabledFolderIds(
  state: {
    statusFolders?: StatusFolderState[];
    operatorSettings?: { statusFolders?: StatusFolderState[] };
    channels?: Record<string, { statusFolders?: StatusFolderState[] }>;
  },
  channelId: string,
): Set<string> | null {
  const folders = resolveChannelStatusFolders(state, channelId);
  if (!folders.length) {
    return null;
  }
  const ids = new Set(folders.filter((folder) => folder.enabled).map((folder) => folder.id));
  // Enabling any live «Без статусу» UUID folder also unlocks the synthetic "" key
  // used by conversationFolderKey for no-status chats.
  for (const folder of folders) {
    if (folder.enabled && isNoStatusFolderName(folder.name)) {
      ids.add(NO_STATUS_FOLDER_ID);
    }
  }
  return ids;
}

export function unionEnabledFolderIdsForChannels(
  state: {
    statusFolders?: StatusFolderState[];
    operatorSettings?: { statusFolders?: StatusFolderState[] };
    channels?: Record<string, { statusFolders?: StatusFolderState[] }>;
  },
  channelIds: string[],
): Set<string> | null {
  const union = new Set<string>();
  for (const channelId of channelIds) {
    const ids = getChannelEnabledFolderIds(state, channelId);
    if (!ids) {
      continue;
    }
    for (const id of ids) {
      union.add(id);
    }
  }
  return union.size ? union : null;
}

export function isAiFolderEnabled(folder: StatusFolderState): boolean {
  return folder.aiEnabled ?? folder.enabled;
}

export function getAiEnabledFolderIds(state: {
  statusFolders?: StatusFolderState[];
  operatorSettings?: { statusFolders?: StatusFolderState[] };
}): Set<string> | null {
  const folders = state.operatorSettings?.statusFolders ?? state.statusFolders;
  if (!folders?.length) {
    return null;
  }

  return new Set(folders.filter((folder) => isAiFolderEnabled(folder)).map((folder) => folder.id));
}

/** Per-channel AI folder ids (where AI may reply for this channel). */
export function getChannelAiEnabledFolderIds(
  state: {
    statusFolders?: StatusFolderState[];
    operatorSettings?: { statusFolders?: StatusFolderState[] };
    channels?: Record<string, { statusFolders?: StatusFolderState[] }>;
  },
  channelId: string,
): Set<string> | null {
  const folders = resolveChannelStatusFolders(state, channelId);
  if (!folders.length) {
    return null;
  }
  const ids = new Set(folders.filter((folder) => isAiFolderEnabled(folder)).map((folder) => folder.id));
  for (const folder of folders) {
    if (isAiFolderEnabled(folder) && isNoStatusFolderName(folder.name)) {
      ids.add(NO_STATUS_FOLDER_ID);
    }
  }
  return ids;
}

export function isConversationInAiEnabledFolders(
  conv: PagerConversation,
  state: {
    statusFolders?: StatusFolderState[];
    operatorSettings?: { statusFolders?: StatusFolderState[] };
    channels?: Record<string, { statusFolders?: StatusFolderState[] }>;
  },
  channelId?: string,
): boolean {
  const enabled = channelId
    ? getChannelAiEnabledFolderIds(state, channelId)
    : getAiEnabledFolderIds(state);
  if (!enabled || enabled.size === 0) {
    return false;
  }
  return conversationAllowedInFolders(conv, enabled);
}

export function isInProgressStatusConversation(conv: PagerConversation): boolean {
  const name = (conv.status?.name || "").trim().toLowerCase();
  return isFunnelFollowUpFolderName(name);
}

/**
 * «Завершено» / Completed — bot AND AI must never process these chats.
 * Keep the matcher tight (not «в процесі», not SPAM).
 */
export function isCompletedStatusName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  if (/в\s*процес|у\s*процес|in\s*progress|en\s*cours|не\s*заверш/i.test(normalized)) {
    return false;
  }
  return (
    /^заверш/i.test(normalized) ||
    /\bзавершено\b/i.test(normalized) ||
    /^completed?$/i.test(normalized) ||
    /\bcompleted?\b/i.test(normalized) ||
    /^finished$/i.test(normalized) ||
    /^done$/i.test(normalized)
  );
}

export function isCompletedStatusConversation(conv: PagerConversation): boolean {
  const name = (conv.status?.name || "").trim();
  return name.length > 0 && isCompletedStatusName(name);
}

/** Status folders the bot moves chats into mid-funnel — must still receive follow-up replies. */
export function isClosedRegistrationStatusConversation(conv: PagerConversation): boolean {
  const name = (conv.status?.name || "").trim().toLowerCase();
  if (!name) {
    return false;
  }
  if (isIgnoreStatusName(name)) {
    return true;
  }
  if (isCompletedStatusName(name)) {
    return true;
  }
  if (isNoMoneyStatusName(name) || isNotReadyStatusName(name)) {
    return true;
  }
  return /скасован|cancel|cancelled|canceled|registered|^win$|выигр/i.test(name);
}

/** Follow-up only when operator explicitly enabled the «в процессе» status folder (not via «Всі»). */
export function isInProgressFollowUpFolderEnabled(
  conv: PagerConversation,
  folders: StatusFolderState[] | undefined,
): boolean {
  if (!isInProgressStatusConversation(conv)) {
    return false;
  }
  const statusId = (conv.statusId || "").trim();
  const statusName = (conv.status?.name || "").trim().toLowerCase();
  if (!statusId && !statusName) {
    return false;
  }

  for (const folder of folders ?? []) {
    if (!folder.enabled) {
      continue;
    }
    if (folder.id === ALL_INBOX_FOLDER_ID || folder.id === NO_STATUS_FOLDER_ID) {
      continue;
    }
    const folderName = folder.name.trim().toLowerCase();
    const matchesStatus =
      (statusId && folder.id === statusId) ||
      (statusName && folderName === statusName) ||
      (statusName && isFunnelFollowUpFolderName(folder.name) && isFunnelFollowUpFolderName(statusName));
    if (!matchesStatus) {
      continue;
    }
    return isFunnelFollowUpFolderName(folder.name) || isFunnelFollowUpFolderName(statusName);
  }
  return false;
}

export function isFunnelFollowUpFolderName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return (
    isZmInProgressRegistrationStatusName(normalized) ||
    isZmRegistrationCompleteStatusName(normalized) ||
    /в процес|у процес|процес|process|рега|реєстраці|чекаю id|не заверш|en cours|in progress/i.test(
      normalized,
    )
  );
}

export function isZmInProgressRegistrationStatusName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  // UA: «В процесі реєстрації» · RU: «В процессе регистрации» · EN
  return (
    /в\s*процес[сеіi]*.{0,8}ре(єстр|гистр|еєстр|г[іиi]стр)/i.test(normalized) ||
    /у\s*процес[сеіi]*.{0,8}ре(єстр|гистр)/i.test(normalized) ||
    /процес[сеіi]*.{0,8}ре(єстр|гистр)/i.test(normalized) ||
    /in\s*registration\s*process|registration\s*process|en\s*cours.*inscri/i.test(normalized)
  );
}

export function isZmRegistrationCompleteStatusName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  if (isZmInProgressRegistrationStatusName(normalized)) {
    return false;
  }
  if (/^реєстрація$|^registration$/i.test(normalized)) {
    return true;
  }
  return normalized.includes("реєстраці") && !normalized.includes("процес");
}

export function isConversationInOperatorEnabledFolders(
  conv: PagerConversation,
  state: {
    statusFolders?: StatusFolderState[];
    operatorSettings?: { statusFolders?: StatusFolderState[] };
  },
): boolean {
  const folders = state.operatorSettings?.statusFolders ?? state.statusFolders;
  // Folders configured but none enabled → process nothing (never fall back to all inbox).
  if (folders?.length) {
    const enabled = getEnabledFolderIds(state);
    if (!enabled || enabled.size === 0) {
      return false;
    }
    return conversationAllowedInFolders(conv, enabled);
  }
  // No folder menu yet — do not process until the operator picks folders.
  return false;
}

/** @deprecated use isCompletedStatusName — kept for RW harvest helpers. */
export function isRwCompletedStatusName(name: string): boolean {
  return isCompletedStatusName(name);
}

export function isRwCompletedConversation(conv: PagerConversation): boolean {
  return isCompletedStatusConversation(conv);
}

export function isSpamStatusName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return /спам|\bspam\b/i.test(normalized);
}

export function isIgnoreStatusName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  // «СПАМ» (Cyrillic) must match — /spam/ alone does not.
  return (
    /^игнор$|^ignore$|игнорир|не\s*серьез|not\s*serious|troll|\bspam\b|спам/i.test(normalized)
  );
}

export function isIgnoreStatusConversation(conv: PagerConversation): boolean {
  const name = (conv.status?.name || "").trim();
  return name.length > 0 && isIgnoreStatusName(name);
}

export function findIgnoreStatusId(state: {
  statusFolders?: StatusFolderState[];
  operatorSettings?: { statusFolders?: StatusFolderState[] };
}): string | undefined {
  const folders = state.operatorSettings?.statusFolders ?? state.statusFolders ?? [];
  // Prefer explicit SPAM / СПАМ over generic «Игнор».
  for (const folder of folders) {
    if (!folder.id || folder.id === NO_STATUS_FOLDER_ID || folder.id === ALL_INBOX_FOLDER_ID) {
      continue;
    }
    if (isSpamStatusName(folder.name)) {
      return folder.id;
    }
  }
  for (const folder of folders) {
    if (!folder.id || folder.id === NO_STATUS_FOLDER_ID || folder.id === ALL_INBOX_FOLDER_ID) {
      continue;
    }
    if (isIgnoreStatusName(folder.name)) {
      return folder.id;
    }
  }
  return undefined;
}

export function findCompletedFolderIds(folders: StatusFolderState[]): string[] {
  return folders
    .filter(
      (folder) =>
        folder.id &&
        folder.id !== NO_STATUS_FOLDER_ID &&
        folder.id !== ALL_INBOX_FOLDER_ID &&
        isCompletedStatusName(folder.name),
    )
    .map((folder) => folder.id);
}

/** Best «Завершено» / Completed status id for moving a chat after deposit proof. */
export function findCompletedStatusId(folders: StatusFolderState[] | undefined): string | undefined {
  const ids = findCompletedFolderIds(folders ?? []);
  return ids[0];
}

export function isNoMoneyStatusName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    /нет\s*денег|нету\s*денег|нет\s*бабок|no\s*money|pas\s*d['']?argent|sans\s*argent|без\s*денег/i.test(
      normalized,
    ) || /^no\s*money$/i.test(normalized)
  );
}

export function isNotReadyStatusName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  if (isNoMoneyStatusName(normalized)) {
    return false;
  }
  return (
    /не\s*готов|неготов|not\s*ready|pas\s*pr[eê]t|не\s*сейчас|позже|later/i.test(normalized) ||
    /^not\s*ready$/i.test(normalized)
  );
}

export function isNoMoneyStatusConversation(conv: PagerConversation): boolean {
  return isNoMoneyStatusName(conv.status?.name || "");
}

export function isNotReadyStatusConversation(conv: PagerConversation): boolean {
  return isNotReadyStatusName(conv.status?.name || "");
}

function scoreParkingFolderName(
  name: string,
  kind: "no_money" | "not_ready",
): number {
  const normalized = name.trim().toLowerCase().replace(/\s+/g, " ");
  if (kind === "no_money") {
    if (normalized === "нету денег" || normalized === "нет денег") {
      return 100;
    }
    return isNoMoneyStatusName(name) ? 50 : 0;
  }
  if (normalized === "не готов" || normalized === "неготов") {
    return 100;
  }
  return isNotReadyStatusName(name) ? 50 : 0;
}

export function findNoMoneyStatusId(folders: StatusFolderState[] | undefined): string | undefined {
  let best: { id: string; score: number } | undefined;
  for (const folder of folders ?? []) {
    if (!folder.id || folder.id === NO_STATUS_FOLDER_ID || folder.id === ALL_INBOX_FOLDER_ID) {
      continue;
    }
    const score = scoreParkingFolderName(folder.name, "no_money");
    if (score <= 0) {
      continue;
    }
    if (!best || score > best.score) {
      best = { id: folder.id, score };
    }
  }
  return best?.id;
}

export function findNotReadyStatusId(folders: StatusFolderState[] | undefined): string | undefined {
  let best: { id: string; score: number } | undefined;
  for (const folder of folders ?? []) {
    if (!folder.id || folder.id === NO_STATUS_FOLDER_ID || folder.id === ALL_INBOX_FOLDER_ID) {
      continue;
    }
    const score = scoreParkingFolderName(folder.name, "not_ready");
    if (score <= 0) {
      continue;
    }
    if (!best || score > best.score) {
      best = { id: folder.id, score };
    }
  }
  return best?.id;
}

/** RW: всегда смотрим «Завершено» + папки, включённые оператором в боте. */
export function expandRwLearnFolderIds(
  enabledFolderIds: Set<string> | null,
  statusFolders: StatusFolderState[] | undefined,
): Set<string> | null {
  const completedIds = findCompletedFolderIds(statusFolders ?? []);
  if (!completedIds.length && (!enabledFolderIds || enabledFolderIds.size === 0)) {
    return enabledFolderIds;
  }
  const merged = new Set(enabledFolderIds ?? []);
  for (const id of completedIds) {
    merged.add(id);
  }
  return merged;
}

/** Operator folders are strict — never auto-add «в процессе» / mid-funnel folders. */
export function expandEnabledFolderIds(
  _state: { statusFolders?: StatusFolderState[] },
  enabledFolderIds: Set<string> | null,
): Set<string> | null {
  return enabledFolderIds;
}

export function countApiStatusFolders(folders?: StatusFolderState[]): number {
  return folders?.filter((folder) => folder.id !== "" && folder.id !== "*").length ?? 0;
}

export function stripChannelNamesFromFolders(
  folders: StatusFolderState[],
  liveChannels?: Array<{ id: string; name: string }>,
): StatusFolderState[] {
  const channelIds = new Set(
    (liveChannels ?? []).map((channel) => channel.id).filter(Boolean),
  );
  const channelNames = new Set(
    (liveChannels ?? [])
      .map((channel) => channel.name.trim().toLowerCase())
      .filter(Boolean),
  );

  return folders.filter((folder) => {
    if (folder.id === NO_STATUS_FOLDER_ID || folder.id === ALL_INBOX_FOLDER_ID) {
      return true;
    }
    if (channelIds.has(folder.id)) {
      return false;
    }
    const name = folder.name.trim().toLowerCase();
    if (channelNames.has(name)) {
      return false;
    }
    // Pager sometimes leaks messenger/page channels into the status list.
    if (looksLikeLeakedChannelFolder(folder.name)) {
      return false;
    }
    return true;
  });
}

/** Heuristic: person-name / page-style channel labels that are not real status folders. */
export function looksLikeLeakedChannelFolder(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 60) {
    return false;
  }
  const lower = trimmed.toLowerCase();
  if (isKnownChatStatusFolderName(lower)) {
    return false;
  }
  // "Brice Moukoko", "Mahmoud Fathy" — messenger page / agent names.
  if (/^[A-ZÀ-ÖØ-Þ][\p{L}'’.-]*(?:\s+[A-ZÀ-ÖØ-Þ][\p{L}'’.-]*){1,3}$/u.test(trimmed)) {
    return true;
  }
  // "ZenHaven", "EcoRiors" — single-word CamelCase channel/page brands.
  if (/^[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+$/.test(trimmed)) {
    return true;
  }
  return false;
}

function isKnownChatStatusFolderName(lower: string): boolean {
  return /без статус|всі|все|в процес|процес|реєстрац|регистрац|заверш|чекаю|waiting|interested|complete|completed|deposit|en cours|registration|registered|process|^win$|игнор|ignore/i.test(
    lower,
  );
}

export function buildStatusFoldersFromPager(
  apiStatuses: Array<{ id: string; name: string }>,
  existing?: StatusFolderState[],
  liveChannels?: Array<{ id: string; name: string }>,
): StatusFolderState[] {
  return stripChannelNamesFromFolders(mergeStatusFolderList(apiStatuses, existing), liveChannels);
}

export function mergeStatusFolderList(
  apiStatuses: Array<{ id: string; name: string }>,
  existing?: StatusFolderState[],
): StatusFolderState[] {
  const hasSavedApiFolders = existing?.some(
    (folder) => folder.id !== NO_STATUS_FOLDER_ID && folder.id !== ALL_INBOX_FOLDER_ID,
  );
  if (!apiStatuses.length && hasSavedApiFolders) {
    return existing!;
  }
  return buildStatusFolderList(apiStatuses, existing);
}

export function buildStatusFolderList(
  apiStatuses: Array<{ id: string; name: string }>,
  existing?: StatusFolderState[],
): StatusFolderState[] {
  const preserved = new Map(
    (existing ?? []).map((folder) => [folder.id, { enabled: folder.enabled, aiEnabled: folder.aiEnabled }]),
  );
  const hasExisting = Boolean(existing?.length);

  const folders: StatusFolderState[] = [
    {
      id: NO_STATUS_FOLDER_ID,
      name: "Без статусу",
      enabled: preserved.get(NO_STATUS_FOLDER_ID)?.enabled ?? false,
      aiEnabled: preserved.get(NO_STATUS_FOLDER_ID)?.aiEnabled,
    },
    {
      id: ALL_INBOX_FOLDER_ID,
      name: "Всі",
      enabled: preserved.get(ALL_INBOX_FOLDER_ID)?.enabled ?? !hasExisting,
      aiEnabled: preserved.get(ALL_INBOX_FOLDER_ID)?.aiEnabled,
    },
  ];

  for (const status of apiStatuses) {
    const saved = preserved.get(status.id);
    folders.push({
      id: status.id,
      name: status.name,
      enabled: saved?.enabled ?? false,
      aiEnabled: saved?.aiEnabled,
    });
  }

  return folders;
}

export function setAllStatusFolders(
  folders: StatusFolderState[],
  enabled: boolean,
): StatusFolderState[] {
  return folders.map((folder) => ({ ...folder, enabled }));
}

/** Enable every folder except «Завершено» / Completed (those stay off) — bot + AI. */
export function setAllStatusFoldersExceptCompleted(
  folders: StatusFolderState[],
): StatusFolderState[] {
  return folders.map((folder) => {
    const on = !isCompletedStatusName(folder.name);
    return {
      ...folder,
      enabled: on,
      aiEnabled: on,
    };
  });
}

/** Disable bot + AI on every folder. */
export function setAllStatusFoldersOff(folders: StatusFolderState[]): StatusFolderState[] {
  return folders.map((folder) => ({
    ...folder,
    enabled: false,
    aiEnabled: false,
  }));
}

/** True when every non-Completed folder is on for both bot and AI. */
export function areAllFoldersEnabledExceptCompleted(
  folders: StatusFolderState[],
): boolean {
  const actionable = folders.filter((folder) => !isCompletedStatusName(folder.name));
  if (!actionable.length) {
    return false;
  }
  return actionable.every((folder) => folder.enabled && isAiFolderEnabled(folder));
}

export function toggleStatusFolder(
  folders: StatusFolderState[],
  index: number,
): StatusFolderState[] {
  const next = [...folders];
  const folder = next[index];
  if (!folder) {
    return folders;
  }
  next[index] = { ...folder, enabled: !folder.enabled };
  return next;
}

export function toggleAiStatusFolder(
  folders: StatusFolderState[],
  index: number,
): StatusFolderState[] {
  const next = [...folders];
  const folder = next[index];
  if (!folder) {
    return folders;
  }
  const current = isAiFolderEnabled(folder);
  next[index] = { ...folder, aiEnabled: !current };
  return next;
}

export function setAllAiStatusFolders(
  folders: StatusFolderState[],
  aiEnabled: boolean,
): StatusFolderState[] {
  return folders.map((folder) => ({ ...folder, aiEnabled }));
}
