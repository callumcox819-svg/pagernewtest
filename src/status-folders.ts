import type { PagerConversation } from "./pager-client.js";

export const NO_STATUS_FOLDER_ID = "";
export const ALL_INBOX_FOLDER_ID = "*";

export type StatusFolderState = {
  id: string;
  name: string;
  enabled: boolean;
};

export function isNoStatusConversation(conv: PagerConversation): boolean {
  if (!conv.statusId) {
    return true;
  }
  const name = (conv.status?.name || "").trim().toLowerCase();
  return name.includes("без статус") || name === "" || name === "—" || name === "-";
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

  return specific.has(conversationFolderKey(conv));
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
}): Set<string> | null {
  if (!state.statusFolders?.length) {
    return null;
  }

  return new Set(state.statusFolders.filter((folder) => folder.enabled).map((folder) => folder.id));
}

export function isInProgressStatusConversation(conv: PagerConversation): boolean {
  const name = (conv.status?.name || "").trim().toLowerCase();
  return isFunnelFollowUpFolderName(name);
}

/** Status folders the bot moves chats into mid-funnel — must still receive follow-up replies. */
export function isFunnelFollowUpFolderName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return (
    isZmInProgressRegistrationStatusName(normalized) ||
    isZmRegistrationCompleteStatusName(normalized) ||
    /в процес|процес|process|рега|реєстраці|чекаю id|не заверш|en cours/i.test(normalized)
  );
}

export function isZmInProgressRegistrationStatusName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return /в процес[сіi].*реєстраці|процес[іi].*реєстраці|in registration process/i.test(normalized);
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

export function expandEnabledFolderIds(
  state: { statusFolders?: StatusFolderState[] },
  enabledFolderIds: Set<string> | null,
): Set<string> | null {
  if (!enabledFolderIds) {
    return null;
  }
  if (enabledFolderIds.has(ALL_INBOX_FOLDER_ID)) {
    return enabledFolderIds;
  }

  const expanded = new Set(enabledFolderIds);
  for (const folder of state.statusFolders ?? []) {
    if (folder.id && isFunnelFollowUpFolderName(folder.name)) {
      expanded.add(folder.id);
    }
  }
  return expanded;
}

export function countApiStatusFolders(folders?: StatusFolderState[]): number {
  return folders?.filter((folder) => folder.id !== "" && folder.id !== "*").length ?? 0;
}

export function stripChannelNamesFromFolders(
  folders: StatusFolderState[],
  liveChannels?: Array<{ id: string; name: string }>,
): StatusFolderState[] {
  if (!liveChannels?.length) {
    return folders;
  }

  const channelIds = new Set(liveChannels.map((channel) => channel.id).filter(Boolean));
  const channelNames = new Set(
    liveChannels.map((channel) => channel.name.trim().toLowerCase()).filter(Boolean),
  );

  return folders.filter((folder) => {
    if (folder.id === NO_STATUS_FOLDER_ID || folder.id === ALL_INBOX_FOLDER_ID) {
      return true;
    }
    if (channelIds.has(folder.id)) {
      return false;
    }
    return !channelNames.has(folder.name.trim().toLowerCase());
  });
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
  const preserved = new Map((existing ?? []).map((folder) => [folder.id, folder.enabled]));
  const hasExisting = Boolean(existing?.length);

  const folders: StatusFolderState[] = [
    {
      id: NO_STATUS_FOLDER_ID,
      name: "Без статусу",
      enabled: preserved.get(NO_STATUS_FOLDER_ID) ?? false,
    },
    {
      id: ALL_INBOX_FOLDER_ID,
      name: "Всі",
      enabled: preserved.get(ALL_INBOX_FOLDER_ID) ?? !hasExisting,
    },
  ];

  for (const status of apiStatuses) {
    folders.push({
      id: status.id,
      name: status.name,
      enabled: preserved.get(status.id) ?? false,
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
