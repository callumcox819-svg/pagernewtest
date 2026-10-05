import type { BotConfig } from "./config.js";
import type { AppEnv } from "./env.js";
import type { PagerClient } from "./pager-client.js";
import { ensurePagerSession } from "./pager-session.js";
import type { StateStore, ChatState } from "./state-store.js";
import {
  clearTemplateReplyCache,
  prefetchSavedReplyFolder,
  resolveCmTemplateFolderId,
  resolveDjTemplateFolderId,
  resolveEcTemplateFolderId,
  resolveEgTemplateFolderId,
  resolveGtTemplateFolderId,
  resolveJoTemplateFolderId,
  resolveKeTemplateFolderId,
  resolveMgTemplateFolderId,
  resolveRwTemplateFolderId,
  resolveZmTemplateFolderId,
  type ScriptResolveCountry,
} from "./template-resolver.js";

/** Melbet-style periodic pull — 1xBET only, every ~3.5 hours. */
export const SAVED_REPLIES_SYNC_INTERVAL_MS = Math.round(3.5 * 60 * 60 * 1000);

const SCRIPT_COUNTRIES: ScriptResolveCountry[] = [
  "CM",
  "EG",
  "ZM",
  "RW",
  "MG",
  "DJ",
  "JO",
  "KE",
  "GT",
  "EC",
];

type SyncDeps = {
  env: AppEnv;
  config: BotConfig;
  stateStore: StateStore;
};

async function resolveFolderForCountry(
  client: PagerClient,
  country: ScriptResolveCountry,
  preferredId: string | undefined,
  liveBanks: Array<{ id: string; name: string }> | undefined,
): Promise<string | undefined> {
  switch (country) {
    case "EG":
      return resolveEgTemplateFolderId(client, preferredId, liveBanks);
    case "ZM":
      return resolveZmTemplateFolderId(client, preferredId, liveBanks);
    case "RW":
      return resolveRwTemplateFolderId(client, preferredId, liveBanks);
    case "MG":
      return resolveMgTemplateFolderId(client, preferredId, liveBanks);
    case "DJ":
      return resolveDjTemplateFolderId(client, preferredId, liveBanks);
    case "JO":
      return resolveJoTemplateFolderId(client, preferredId, liveBanks);
    case "KE":
      return resolveKeTemplateFolderId(client, preferredId, liveBanks);
    case "GT":
      return resolveGtTemplateFolderId(client, preferredId, liveBanks);
    case "EC":
      return resolveEcTemplateFolderId(client, preferredId, liveBanks);
    default:
      return resolveCmTemplateFolderId(client, preferredId, liveBanks);
  }
}

function preferredFolderIds(state: ChatState): Map<ScriptResolveCountry, string> {
  const byCountry = new Map<ScriptResolveCountry, string>();
  for (const [channelId, runtime] of Object.entries(state.channels ?? {})) {
    void channelId;
    const country = runtime.country as ScriptResolveCountry;
    if (!SCRIPT_COUNTRIES.includes(country)) {
      continue;
    }
    if (runtime.templateBankId && !byCountry.has(country)) {
      byCountry.set(country, runtime.templateBankId);
    }
  }
  return byCountry;
}

export async function syncSavedRepliesForChat(
  deps: SyncDeps,
  state: ChatState,
): Promise<{ folders: number; replies: number }> {
  const session = await ensurePagerSession(
    { env: deps.env, stateStore: deps.stateStore },
    state,
  );
  if (!session) {
    return { folders: 0, replies: 0 };
  }

  const liveBanks = session.state.pagerAccount?.liveTemplateBanks;
  const preferred = preferredFolderIds(session.state);
  const seen = new Set<string>();
  let folders = 0;
  let replies = 0;

  for (const country of SCRIPT_COUNTRIES) {
    const folderId = await resolveFolderForCountry(
      session.client,
      country,
      preferred.get(country),
      liveBanks,
    );
    if (!folderId || seen.has(folderId)) {
      continue;
    }
    seen.add(folderId);
    const count = await prefetchSavedReplyFolder(session.client, folderId).catch(() => 0);
    if (count > 0) {
      folders += 1;
      replies += count;
      console.log(
        `1xBET saved-replies sync chat=${state.chatId} country=${country} folder=${folderId.slice(0, 8)} replies=${count}`,
      );
    }
  }

  return { folders, replies };
}

export async function syncAllSavedReplies(deps: SyncDeps): Promise<void> {
  clearTemplateReplyCache();
  const states = await deps.stateStore.listAll();
  let totalFolders = 0;
  let totalReplies = 0;
  for (const state of states) {
    if (!state.pagerAccount?.cookies?.trim() && !(state.pagerAccount?.email && state.pagerAccount?.password)) {
      continue;
    }
    try {
      const result = await syncSavedRepliesForChat(deps, state);
      totalFolders += result.folders;
      totalReplies += result.replies;
    } catch (error) {
      console.warn(
        `1xBET saved-replies sync failed chat=${state.chatId}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  console.log(
    `1xBET saved-replies sync done folders=${totalFolders} replies=${totalReplies} next≈${Math.round(SAVED_REPLIES_SYNC_INTERVAL_MS / 3_600_000)}h`,
  );
}

export function startSavedRepliesSyncLoop(deps: SyncDeps): void {
  const run = () => {
    void syncAllSavedReplies(deps).catch((error) => {
      console.error("1xBET saved-replies sync cycle failed:", error);
    });
  };
  // First pull shortly after boot, then every 3–4 hours.
  setTimeout(run, 45_000);
  setInterval(run, SAVED_REPLIES_SYNC_INTERVAL_MS);
  console.log(
    `1xBET saved-replies auto-sync every ${Math.round(SAVED_REPLIES_SYNC_INTERVAL_MS / 3_600_000 * 10) / 10}h`,
  );
}
