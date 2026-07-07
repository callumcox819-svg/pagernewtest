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

export function getEnabledFolderIds(state: {
  statusFolders?: StatusFolderState[];
}): Set<string> | null {
  if (!state.statusFolders?.length) {
    return null;
  }

  return new Set(state.statusFolders.filter((folder) => folder.enabled).map((folder) => folder.id));
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
