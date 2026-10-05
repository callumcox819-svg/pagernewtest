import type { BotConfig, CountryCode, TemplateRole } from "./config.js";
import { getTemplateBank } from "./config.js";
import { loadLocalCmScript } from "./cm-local-scripts.js";
import { loadLocalRwScript, clearLocalRwScriptCache } from "./rw-local-scripts.js";
import { loadLocalZmScript } from "./zm-local-scripts.js";
import { loadLocalMgScript } from "./mg-local-scripts.js";
import { loadLocalDjScript } from "./dj-local-scripts.js";
import { loadLocalJoScript } from "./jo-local-scripts.js";
import { loadLocalKeScript } from "./ke-local-scripts.js";
import { loadLocalGtScript } from "./gt-local-scripts.js";
import { loadLocalEcScript } from "./ec-local-scripts.js";
import {
  CM_FOLDER_NAME_HINTS,
  CM_SCRIPT_EXCLUDE_SNIPPETS,
  isFullCmRegistrationPreset,
  scriptSearchNeedles as cmScriptSearchNeedles,
  scriptSnippet as cmScriptSnippet,
} from "./cm-script-engine.js";
import {
  EG_FOLDER_NAME_HINTS,
  EG_SCRIPT_EXCLUDE_SNIPPETS,
  isEgHowItWorksPitchBody,
  scriptSearchNeedles as egScriptSearchNeedles,
  scriptSnippet as egScriptSnippet,
} from "./eg-script-engine.js";
import { buildNamelessScriptTextMap } from "./nameless-saved-replies.js";
import {
  ZM_FOLDER_NAME_HINTS,
  ZM_SCRIPT_EXCLUDE_SNIPPETS,
  scriptSearchNeedles as zmScriptSearchNeedles,
  scriptSnippet as zmScriptSnippet,
} from "./zm-script-engine.js";
import {
  RW_FOLDER_NAME_HINTS,
  RW_SCRIPT_KEY_ALIASES,
  rwScriptSearchNeedles,
  rwScriptSnippet,
} from "./rw-script-engine.js";
import {
  MG_FOLDER_NAME_HINTS,
  scriptSearchNeedles as mgScriptSearchNeedles,
  scriptSnippet as mgScriptSnippet,
} from "./mg-script-engine.js";
import {
  DJ_FOLDER_NAME_HINTS,
  scriptSearchNeedles as djScriptSearchNeedles,
  scriptSnippet as djScriptSnippet,
} from "./dj-script-engine.js";
import {
  JO_FOLDER_NAME_HINTS,
  scriptSearchNeedles as joScriptSearchNeedles,
  scriptSnippet as joScriptSnippet,
} from "./jo-script-engine.js";
import {
  KE_FOLDER_NAME_HINTS,
  scriptSearchNeedles as keScriptSearchNeedles,
  scriptSnippet as keScriptSnippet,
} from "./ke-script-engine.js";
import {
  GT_FOLDER_NAME_HINTS,
  scriptSearchNeedles as gtScriptSearchNeedles,
  scriptSnippet as gtScriptSnippet,
} from "./gt-script-engine.js";
import {
  EC_FOLDER_NAME_HINTS,
  scriptSearchNeedles as ecScriptSearchNeedles,
  scriptSnippet as ecScriptSnippet,
} from "./ec-script-engine.js";
import type { PagerClient, PagerSavedReply } from "./pager-client.js";
import {
  isDisabledOutboundScriptKey,
  isDisabledOutboundTemplateRole,
} from "./disabled-outbound-scripts.js";

/** 1xBET bot geos that resolve scripts from Pager saved-reply folders. */
export type ScriptResolveCountry = CountryCode | "RW" | "MG" | "DJ" | "JO" | "KE" | "GT" | "EC";

/** Never auto-pick Melbet folders on this 1xBET bot. */
const FOREIGN_BRAND_BANK_BLOCKLIST = ["melbet", "мелбет", "mel bet", "мельбет"];

export function isForeignBrandTemplateBank(name?: string): boolean {
  const normalized = (name || "").toLowerCase();
  if (!normalized) {
    return false;
  }
  return FOREIGN_BRAND_BANK_BLOCKLIST.some((needle) => normalized.includes(needle));
}

const replyCache = new Map<string, { loadedAt: number; replies: PagerSavedReply[] }>();
/** Short TTL so Pager saved-reply edits show up quickly without waiting for «Обновить». */
const REPLY_CACHE_TTL_MS = 15_000;

const ROLE_SNIPPETS: Record<CountryCode, Partial<Record<TemplateRole, string[]>>> = {
  CM: {
    intro: ["01_intro", "Tu es du Cameroun", "L'IA analyse", "Mon équipe cumule"],
    details: ["03_steps", "voici comment ça fonctionne", "02_age", "Quel âge"],
    registration: [
      "05_registration",
      "Je vais vous envoyer un lien d'inscription spécial",
      "06_link",
      "tinyurl.com/CMR056",
    ],
    deposit: ["09_deposit", "bouton vert"],
    ask_id: ["08_game_id", "commence par +"],
    no_money: ["pas d'argent", "plus tard"],
    reactivation: ["Il reste encore"],
  },
  EG: {
    intro: ["01_intro", "إنت من مصر"],
    details: ["02_how_it_works", "تمام كده"],
    registration: ["04_registration", "هبعتلك اللينك", "05_link", "Egypt0011"],
    deposit: ["06_deposit", "الأخضر"],
    ask_id: ["07_game_id", "يبدأ ب 17"],
    no_money: ["مش معايه فلوس", "no money"],
    reactivation: ["لسه عندنا"],
  },
  ZM: {
    intro: ["01_intro", "Hi! I want to show you"],
    details: ["02_how_it_works", "03_zmw_table", "How it works"],
    registration: ["04_registration", "ZAM577", "05_link", "zam577"],
    deposit: ["06_deposit", "click \"Deposit\""],
    ask_id: ["07_game_id", "begins with 17"],
    no_money: ["No problem", "when you are ready"],
    reactivation: ["still a spot"],
  },
};

function bankMatchesHints(name: string, hints: string[]): boolean {
  const normalized = name.toLowerCase();
  if (isForeignBrandTemplateBank(normalized)) {
    return false;
  }
  return hints.some((hint) => normalized.includes(hint.toLowerCase()));
}

async function resolveTemplateFolderId(
  client: PagerClient,
  hints: string[],
  preferredId?: string,
  liveBanks?: Array<{ id: string; name: string }>,
): Promise<string | undefined> {
  // Operator-linked folder on this 1xBET channel wins (even if name is odd).
  if (preferredId) {
    const preferredMeta = (liveBanks ?? []).find((bank) => bank.id === preferredId);
    if (!preferredMeta || !isForeignBrandTemplateBank(preferredMeta.name)) {
      const replies = await loadFolderReplies(client, preferredId).catch(() => []);
      if (replies.length) {
        return preferredId;
      }
    } else {
      console.warn(
        `1xBET template: skip Melbet-linked folder ${preferredId.slice(0, 8)} (${preferredMeta.name})`,
      );
    }
  }

  const live = (liveBanks ?? []).filter((bank) => !isForeignBrandTemplateBank(bank.name));
  for (const bank of live) {
    if (bankMatchesHints(bank.name, hints)) {
      const replies = await loadFolderReplies(client, bank.id).catch(() => []);
      if (replies.length) {
        return bank.id;
      }
    }
  }

  const banks = (await client.getTemplateBanks().catch(() => [])).filter(
    (bank) => !isForeignBrandTemplateBank(bank.name),
  );
  for (const bank of banks) {
    if (!bankMatchesHints(bank.name, hints)) {
      continue;
    }
    const replies = await loadFolderReplies(client, bank.id).catch(() => []);
    if (replies.length) {
      return bank.id;
    }
  }

  for (const bank of live) {
    if (bankMatchesHints(bank.name, hints)) {
      return bank.id;
    }
  }

  return undefined;
}

export async function resolveCmTemplateFolderId(
  client: PagerClient,
  preferredId?: string,
  liveBanks?: Array<{ id: string; name: string }>,
): Promise<string | undefined> {
  return resolveTemplateFolderId(client, CM_FOLDER_NAME_HINTS, preferredId, liveBanks);
}

export async function resolveZmTemplateFolderId(
  client: PagerClient,
  preferredId?: string,
  liveBanks?: Array<{ id: string; name: string }>,
): Promise<string | undefined> {
  return resolveTemplateFolderId(client, ZM_FOLDER_NAME_HINTS, preferredId, liveBanks);
}

export async function resolveEgTemplateFolderId(
  client: PagerClient,
  preferredId?: string,
  liveBanks?: Array<{ id: string; name: string }>,
): Promise<string | undefined> {
  return resolveTemplateFolderId(client, EG_FOLDER_NAME_HINTS, preferredId, liveBanks);
}

export async function resolveRwTemplateFolderId(
  client: PagerClient,
  preferredId?: string,
  liveBanks?: Array<{ id: string; name: string }>,
): Promise<string | undefined> {
  return resolveTemplateFolderId(client, RW_FOLDER_NAME_HINTS, preferredId, liveBanks);
}

export async function resolveMgTemplateFolderId(
  client: PagerClient,
  preferredId?: string,
  liveBanks?: Array<{ id: string; name: string }>,
): Promise<string | undefined> {
  return resolveTemplateFolderId(client, MG_FOLDER_NAME_HINTS, preferredId, liveBanks);
}

export async function resolveDjTemplateFolderId(
  client: PagerClient,
  preferredId?: string,
  liveBanks?: Array<{ id: string; name: string }>,
): Promise<string | undefined> {
  return resolveTemplateFolderId(client, DJ_FOLDER_NAME_HINTS, preferredId, liveBanks);
}

export async function resolveKeTemplateFolderId(
  client: PagerClient,
  preferredId?: string,
  liveBanks?: Array<{ id: string; name: string }>,
): Promise<string | undefined> {
  return resolveTemplateFolderId(client, KE_FOLDER_NAME_HINTS, preferredId, liveBanks);
}

export async function resolveGtTemplateFolderId(
  client: PagerClient,
  preferredId?: string,
  liveBanks?: Array<{ id: string; name: string }>,
): Promise<string | undefined> {
  return resolveTemplateFolderId(client, GT_FOLDER_NAME_HINTS, preferredId, liveBanks);
}

export async function resolveEcTemplateFolderId(
  client: PagerClient,
  preferredId?: string,
  liveBanks?: Array<{ id: string; name: string }>,
): Promise<string | undefined> {
  return resolveTemplateFolderId(client, EC_FOLDER_NAME_HINTS, preferredId, liveBanks);
}

export async function resolveJoTemplateFolderId(
  client: PagerClient,
  preferredId?: string,
  liveBanks?: Array<{ id: string; name: string }>,
): Promise<string | undefined> {
  return resolveTemplateFolderId(client, JO_FOLDER_NAME_HINTS, preferredId, liveBanks);
}

async function resolveFolderIdForCountry(
  client: PagerClient,
  country: ScriptResolveCountry,
  preferredId?: string,
  liveBanks?: Array<{ id: string; name: string }>,
): Promise<string | undefined> {
  switch (country) {
    case "RW":
      return resolveRwTemplateFolderId(client, preferredId, liveBanks);
    case "ZM":
      return resolveZmTemplateFolderId(client, preferredId, liveBanks);
    case "EG":
      return resolveEgTemplateFolderId(client, preferredId, liveBanks);
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

function loadLocalScriptForCountry(
  country: ScriptResolveCountry,
  scriptKey: string,
): string | undefined {
  switch (country) {
    case "RW":
      return loadLocalRwScript(scriptKey);
    case "ZM":
      return loadLocalZmScript(scriptKey);
    case "EG":
      return undefined;
    case "MG":
      return loadLocalMgScript(scriptKey);
    case "DJ":
      return loadLocalDjScript(scriptKey);
    case "JO":
      return loadLocalJoScript(scriptKey);
    case "KE":
      return loadLocalKeScript(scriptKey);
    case "GT":
      return loadLocalGtScript(scriptKey, "es");
    case "EC":
      return loadLocalEcScript(scriptKey, "es");
    default:
      return loadLocalCmScript(scriptKey);
  }
}

/**
 * 1xBET: ALWAYS use Pager saved replies from the country folder.
 * Egypt has no local .txt fallback. Other countries may still use local files
 * only if Pager has no match for that script key.
 */
export async function resolveScriptTextByKey(
  client: PagerClient,
  options: {
    folderId?: string;
    liveBanks?: Array<{ id: string; name: string }>;
    scriptKey: string;
    country?: ScriptResolveCountry;
    refreshSavedReplies?: boolean;
  },
): Promise<string | undefined> {
  const country = options.country ?? "CM";
  if (isDisabledOutboundScriptKey(options.scriptKey)) {
    console.warn(`${country} script blocked (telegram removed): key=${options.scriptKey}`);
    return undefined;
  }

  const folderId = await resolveFolderIdForCountry(
    client,
    country,
    options.folderId,
    options.liveBanks,
  );

  if (folderId) {
    // Always re-fetch from Pager unless caller explicitly opts into cache.
    const forceRefresh = options.refreshSavedReplies !== false;
    const replies = await loadFolderReplies(client, folderId, forceRefresh);

    // Pager presets have no titles — map by body / folder order for every 1xBET geo.
    const namelessMap = buildNamelessScriptTextMap(replies, country, {
      needlesForKey: (key) => scriptSearchNeedlesForCountry(country)(key),
      excludesForKey: (key) => scriptExcludesForCountry(country, key),
    });
    const mapped = namelessMap.get(options.scriptKey)?.trim();
    if (mapped) {
      console.log(
        `${country} script from nameless saved replies key=${options.scriptKey} chars=${mapped.length} folder=${folderId.slice(0, 8)} mapped=${[...namelessMap.keys()].join(",")}`,
      );
      return finalizeScriptText(mapped, options.scriptKey, country);
    }

    const exactName = findReplyByExactScriptName(replies, options.scriptKey, country);
    if (
      exactName?.text?.trim() &&
      isScriptReplyAcceptable(exactName.text, options.scriptKey, country)
    ) {
      console.log(
        `${country} script from saved replies key=${options.scriptKey} name=${exactName.name ?? "?"} folder=${folderId.slice(0, 8)}`,
      );
      return finalizeScriptText(exactName.text, options.scriptKey, country);
    }
    const fromPager = matchReplyByScriptKey(replies, options.scriptKey, country);
    if (fromPager?.text?.trim() && isScriptReplyAcceptable(fromPager.text, options.scriptKey, country)) {
      console.log(
        `${country} script from saved replies key=${options.scriptKey} matched=${fromPager.name ?? "body"} folder=${folderId.slice(0, 8)}`,
      );
      return finalizeScriptText(fromPager.text, options.scriptKey, country);
    }
    // Never accept weak short scraps for CM registration / link / chrome.
    if (
      fromPager?.text?.trim() &&
      !(country === "CM" && ["05_registration", "06_link", "07_chrome"].includes(options.scriptKey))
    ) {
      console.warn(
        `${country} script pager weak match accepted key=${options.scriptKey} chars=${fromPager.text.length}`,
      );
      return finalizeScriptText(fromPager.text, options.scriptKey, country);
    }
    console.warn(
      `${country} script pager miss key=${options.scriptKey} folder=${folderId.slice(0, 8)} replies=${replies.length}`,
    );
  } else {
    console.warn(`${country} script no saved-reply folder for key=${options.scriptKey}`);
  }

  // Egypt: never fall back to bundled/local .txt — operators edit Pager saved replies.
  if (country === "EG") {
    return undefined;
  }

  const local = loadLocalScriptForCountry(country, options.scriptKey);
  if (local?.trim()) {
    console.log(`${country} script local fallback key=${options.scriptKey}`);
    return finalizeScriptText(local, options.scriptKey, country);
  }

  return undefined;
}

/** CM: registration script and link are separate bubbles — never embed the URL in 05_registration. */
function stripCmRegistrationEmbeddedLink(text: string): string {
  return text
    .replace(/\n?https?:\/\/\S+/gi, "")
    .replace(/\n?(?:www\.)?tinyurl\.com\/\S+/gi, "")
    .replace(/\n?camerun01\b/gi, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}

function stripZmRegistrationEmbeddedLink(text: string): string {
  return text
    .replace(/\n?https?:\/\/\S+/gi, "")
    .replace(/\n?(?:www\.)?tinyurl\.com\/\S+/gi, "")
    .replace(/\n?here is the link:\s*$/i, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}

function stripRwRegistrationEmbeddedLink(text: string): string {
  return stripZmRegistrationEmbeddedLink(text);
}

export async function resolveTemplateText(
  config: BotConfig,
  client: PagerClient,
  options: {
    folderId?: string;
    yamlBankName: string;
    role: TemplateRole;
    country: CountryCode;
  },
): Promise<string | undefined> {
  if (isDisabledOutboundTemplateRole(options.role)) {
    console.warn(`${options.country} template blocked (telegram removed): role=${options.role}`);
    return undefined;
  }
  if (options.folderId) {
    const replies = await loadFolderReplies(client, options.folderId);
    const fromPager = matchReplyByRole(replies, options.country, options.role);
    if (fromPager?.text) {
      return fromPager.text;
    }
  }

  const yamlBank = getTemplateBank(config, options.yamlBankName);
  return yamlBank.roles[options.role];
}

async function loadFolderReplies(
  client: PagerClient,
  folderId: string,
  forceRefresh = false,
): Promise<PagerSavedReply[]> {
  const cached = replyCache.get(folderId);
  if (!forceRefresh && cached && Date.now() - cached.loadedAt < REPLY_CACHE_TTL_MS) {
    return cached.replies;
  }

  const replies = await client.getSavedReplies(folderId);
  if (replies.length) {
    replyCache.set(folderId, { loadedAt: Date.now(), replies });
  } else if (forceRefresh) {
    // Don't keep serving a stale non-empty folder after Pager returns empty/failed sync.
    replyCache.delete(folderId);
  }
  return replies;
}

/** Force-refresh one folder into the in-memory cache (used by 3–4h sync). */
export async function prefetchSavedReplyFolder(
  client: PagerClient,
  folderId: string,
): Promise<number> {
  const replies = await loadFolderReplies(client, folderId, true);
  return replies.length;
}

export function getCachedSavedReplyFolderCount(): number {
  return replyCache.size;
}

function finalizeScriptText(text: string, scriptKey: string, country: ScriptResolveCountry): string {
  if (country === "CM" && scriptKey === "05_registration") {
    return stripCmRegistrationEmbeddedLink(text);
  }
  if (
    (country === "ZM" || country === "RW" || country === "MG" || country === "DJ" || country === "JO" || country === "KE") &&
    (scriptKey === "04_registration" || scriptKey === "05_registration")
  ) {
    return stripZmRegistrationEmbeddedLink(text);
  }
  return text;
}

function findReplyByExactScriptName(
  replies: PagerSavedReply[],
  scriptKey: string,
  country: ScriptResolveCountry,
): PagerSavedReply | undefined {
  const keys = scriptKeysForLookup(scriptKey, country);
  for (const key of keys) {
    const matched = replies.find(
      (reply) => scriptNameMatchesKey(reply.name, key) && (reply.text || "").trim(),
    );
    if (matched) {
      return matched;
    }
  }
  return undefined;
}

function scriptKeysForLookup(scriptKey: string, country: ScriptResolveCountry): string[] {
  if (country === "RW") {
    return [scriptKey, ...(RW_SCRIPT_KEY_ALIASES[scriptKey] ?? [])];
  }
  return [scriptKey];
}

function matchReplyByScriptKey(
  replies: PagerSavedReply[],
  scriptKey: string,
  country: ScriptResolveCountry,
): PagerSavedReply | undefined {
  for (const key of scriptKeysForLookup(scriptKey, country)) {
    const matched = matchReplyByScriptKeyOnce(replies, key, country);
    if (matched) {
      return matched;
    }
  }
  return undefined;
}

function matchReplyByScriptKeyOnce(
  replies: PagerSavedReply[],
  scriptKey: string,
  country: ScriptResolveCountry,
): PagerSavedReply | undefined {
  const snippetForCountry = scriptSnippetForCountry(country);
  const needlesForCountry = scriptSearchNeedlesForCountry(country);
  const excludes = scriptExcludesForCountry(country, scriptKey);
  const primary = snippetForCountry(scriptKey).trim().toLowerCase();

  const candidates = replies.filter((reply) => {
    const text = (reply.text || "").trim();
    if (!text) {
      return false;
    }
    return !hasExcludedSnippet(text, excludes);
  });

  const byExactName = candidates.filter((reply) => scriptNameMatchesKey(reply.name, scriptKey));
  if (byExactName.length) {
    return pickBestScriptReply(byExactName, scriptKey);
  }

  if (primary) {
    const byPrimary = candidates.filter((reply) => normalizeNeedle(reply.text).includes(primary));
    if (byPrimary.length) {
      return pickBestScriptReply(byPrimary, scriptKey);
    }
  }

  const needles = needlesForCountry(scriptKey).map((needle) => needle.trim().toLowerCase()).filter(Boolean);
  const byNeedles = candidates.filter((reply) => {
    const body = normalizeNeedle(reply.text);
    const name = (reply.name ?? "").toLowerCase();
    return needles.some((needle) => name.includes(needle) || body.includes(needle));
  });
  if (byNeedles.length) {
    return pickBestScriptReply(byNeedles, scriptKey);
  }

  const keyNeedle = scriptKey.toLowerCase();
  const byLooseName = candidates.filter((reply) => (reply.name ?? "").toLowerCase().includes(keyNeedle));
  if (byLooseName.length) {
    return pickBestScriptReply(byLooseName, scriptKey);
  }

  return undefined;
}

function scriptNameMatchesKey(name: string | undefined, scriptKey: string): boolean {
  const normalized = (name ?? "").trim().toLowerCase().replace(/\.txt$/, "");
  const key = scriptKey.trim().toLowerCase();
  return normalized === key || normalized.endsWith(`/${key}`) || normalized.includes(key);
}

function hasExcludedSnippet(text: string, excludes: string[]): boolean {
  const body = text.trim().toLowerCase();
  return excludes.some((snippet) => body.includes(snippet.trim().toLowerCase()));
}

function pickBestScriptReply(replies: PagerSavedReply[], scriptKey: string): PagerSavedReply {
  if (scriptKey === "06_link" || scriptKey === "05_link") {
    // Prefer bare URL bubble, not a long instruction that happens to contain the link.
    const urls = replies.filter((reply) => /^https?:\/\/\S+$/i.test((reply.text || "").trim()));
    const pool = urls.length ? urls : replies;
    return [...pool].sort((left, right) => (left.text?.length ?? 0) - (right.text?.length ?? 0))[0]!;
  }
  if (scriptKey === "07_chrome") {
    return [...replies].sort((left, right) => (left.text?.length ?? 0) - (right.text?.length ?? 0))[0]!;
  }
  if (scriptKey === "05_registration") {
    const full = replies.filter((reply) => isFullCmRegistrationPreset(reply.text || ""));
    const pool = full.length ? full : replies;
    return [...pool].sort((left, right) => (right.text?.length ?? 0) - (left.text?.length ?? 0))[0]!;
  }
  return [...replies].sort((left, right) => (right.text?.length ?? 0) - (left.text?.length ?? 0))[0]!;
}

function scriptSnippetForCountry(country: ScriptResolveCountry): (key: string) => string {
  if (country === "RW") {
    return rwScriptSnippet;
  }
  if (country === "ZM") {
    return zmScriptSnippet;
  }
  if (country === "EG") {
    return egScriptSnippet;
  }
  if (country === "MG") {
    return mgScriptSnippet;
  }
  if (country === "DJ") {
    return djScriptSnippet;
  }
  if (country === "JO") {
    return joScriptSnippet;
  }
  if (country === "KE") {
    return keScriptSnippet;
  }
  if (country === "GT") {
    return gtScriptSnippet;
  }
  if (country === "EC") {
    return ecScriptSnippet;
  }
  return cmScriptSnippet;
}

function scriptSearchNeedlesForCountry(country: ScriptResolveCountry): (key: string) => string[] {
  if (country === "RW") {
    return rwScriptSearchNeedles;
  }
  if (country === "ZM") {
    return zmScriptSearchNeedles;
  }
  if (country === "EG") {
    return egScriptSearchNeedles;
  }
  if (country === "MG") {
    return mgScriptSearchNeedles;
  }
  if (country === "DJ") {
    return djScriptSearchNeedles;
  }
  if (country === "JO") {
    return joScriptSearchNeedles;
  }
  if (country === "KE") {
    return keScriptSearchNeedles;
  }
  if (country === "GT") {
    return gtScriptSearchNeedles;
  }
  if (country === "EC") {
    return ecScriptSearchNeedles;
  }
  return cmScriptSearchNeedles;
}

function scriptExcludesForCountry(country: ScriptResolveCountry, scriptKey: string): string[] {
  if (country === "RW" || country === "MG" || country === "DJ" || country === "JO" || country === "KE" || country === "GT" || country === "EC") {
    return [];
  }
  if (country === "ZM") {
    return ZM_SCRIPT_EXCLUDE_SNIPPETS[scriptKey] ?? [];
  }
  if (country === "EG") {
    return EG_SCRIPT_EXCLUDE_SNIPPETS[scriptKey] ?? [];
  }
  return CM_SCRIPT_EXCLUDE_SNIPPETS[scriptKey] ?? [];
}

function isScriptReplyAcceptable(text: string, scriptKey: string, country: ScriptResolveCountry): boolean {
  const snippetForCountry = scriptSnippetForCountry(country);
  const excludes = scriptExcludesForCountry(country, scriptKey);
  const body = text.trim().toLowerCase();
  if (!body || hasExcludedSnippet(body, excludes)) {
    return false;
  }

  const primary = snippetForCountry(scriptKey).trim().toLowerCase();
  if (primary && body.includes(primary)) {
    return true;
  }

  if (scriptKey === "05_registration" && country === "CM") {
    return isFullCmRegistrationPreset(text);
  }

  if (scriptKey === "06_link" && country === "CM") {
    const trimmed = text.trim();
    return (
      /^https?:\/\/\S+$/i.test(trimmed) ||
      (/tinyurl\.com\/cmr056/i.test(trimmed) && trimmed.length < 80)
    );
  }

  if (scriptKey === "07_chrome" && country === "CM") {
    return (
      body.includes("google chrome") &&
      (body.includes("copiez ce lien") || body.includes("collez-le")) &&
      !body.includes("cash056") &&
      body.length < 160
    );
  }

  if (scriptKey === "04_registration" && country === "ZM") {
    return (
      body.includes("promo code") ||
      body.includes("special registration link") ||
      body.includes("paste it into your google chrome") ||
      body.includes("google chrome")
    );
  }

  if (scriptKey === "04_registration" && country === "RW") {
    return (
      body.includes("registration link") ||
      body.includes("google chrome") ||
      body.includes("promo code") ||
      body.includes("here is the link")
    );
  }

  if (scriptKey === "03_deposit_table" && country === "RW") {
    return body.includes("rwf") || body.includes("profit") || body.includes("ready to start");
  }

  if (scriptKey === "04_registration" && country === "EG") {
    if (isEgHowItWorksPitchBody(text)) {
      return false;
    }
    return /[\u0600-\u06FF]/.test(body) ? body.length >= 20 : body.length >= 40;
  }

  if (country === "EG") {
    if (scriptKey === "05_link") {
      return body.includes("tinyurl.com/") || body.includes("http://") || body.includes("https://");
    }
    // Trust Pager saved replies even when wording differs from old local snippets.
    if (/[\u0600-\u06FF]/.test(body)) {
      return body.length >= 20;
    }
    const needles = scriptSearchNeedlesForCountry(country)(scriptKey);
    if (needles.some((needle) => body.includes(needle.trim().toLowerCase()))) {
      return true;
    }
    return body.length >= 40;
  }

  if (scriptKey === "05_link") {
    return (
      body.includes("tinyurl.com/") ||
      body.includes("http://") ||
      body.includes("https://")
    );
  }

  if (country === "RW") {
    const needles = scriptSearchNeedlesForCountry(country)(scriptKey);
    if (needles.some((needle) => body.includes(needle.trim().toLowerCase()))) {
      return true;
    }
  }

  return body.length >= 40;
}

function matchReplyByRole(
  replies: PagerSavedReply[],
  country: CountryCode,
  role: TemplateRole,
): PagerSavedReply | undefined {
  const hints = ROLE_SNIPPETS[country]?.[role] ?? [];
  for (const hint of hints) {
    const needle = hint.trim().toLowerCase();
    if (!needle) {
      continue;
    }
    const matched = replies.find((reply) => {
      const name = (reply.name ?? "").toLowerCase();
      const body = normalizeNeedle(reply.text);
      return name.includes(needle) || body.includes(needle) || needle.includes(body.slice(0, 40));
    });
    if (matched) {
      return matched;
    }
  }
  return undefined;
}

function normalizeNeedle(value: string): string {
  return value.trim().toLowerCase().slice(0, 120);
}

export function clearTemplateReplyCache(): void {
  replyCache.clear();
  clearLocalRwScriptCache();
}
