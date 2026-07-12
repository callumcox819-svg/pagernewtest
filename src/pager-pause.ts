import type { ChatState, StateStore } from "./state-store.js";

export function pagerOrganizationKey(state: ChatState): string | undefined {
  const orgId = state.pagerAccount?.organizationId?.trim();
  if (orgId) {
    return `id:${orgId}`;
  }
  const slug = state.pagerAccount?.organizationSlug?.trim();
  if (slug) {
    return `slug:${slug.toLowerCase()}`;
  }
  return undefined;
}

function sharesPagerLogin(left: ChatState, right: ChatState): boolean {
  const leftKey = pagerOrganizationKey(left);
  const rightKey = pagerOrganizationKey(right);
  if (leftKey && rightKey) {
    return leftKey === rightKey;
  }
  return left.chatId === right.chatId;
}

export async function applyPagerPause(
  store: StateStore,
  source: ChatState,
  paused: boolean,
): Promise<ChatState[]> {
  const all = await store.listAll();
  const touched: ChatState[] = [];

  for (const state of all) {
    if (!sharesPagerLogin(source, state)) {
      continue;
    }
    const next = await store.patch(state.chatId, { paused });
    if (next) {
      touched.push(next);
    }
  }

  if (!touched.length) {
    const fallback = await store.patch(source.chatId, { paused });
    if (fallback) {
      touched.push(fallback);
    }
  }

  return touched;
}

export function describePagerAccount(state: ChatState): string {
  const name =
    state.pagerAccount?.organizationName?.trim() ||
    state.pagerAccount?.organizationSlug?.trim() ||
    state.pagerAccount?.email?.trim() ||
    "Pager";
  return `${name} (chat ${state.chatId})`;
}
