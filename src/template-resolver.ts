import type { BotConfig, CountryCode, TemplateRole } from "./config.js";
import { getTemplateBank } from "./config.js";
import { loadLocalCmScript } from "./cm-local-scripts.js";
import { loadLocalEgScript } from "./eg-local-scripts.js";
import { loadLocalZmScript } from "./zm-local-scripts.js";
import {
  CM_FOLDER_NAME_HINTS,
  CM_SCRIPT_EXCLUDE_SNIPPETS,
  scriptSearchNeedles as cmScriptSearchNeedles,
  scriptSnippet as cmScriptSnippet,
} from "./cm-script-engine.js";
import {
  EG_FOLDER_NAME_HINTS,
  EG_SCRIPT_EXCLUDE_SNIPPETS,
  scriptSearchNeedles as egScriptSearchNeedles,
  scriptSnippet as egScriptSnippet,
} from "./eg-script-engine.js";
import {
  ZM_FOLDER_NAME_HINTS,
  ZM_SCRIPT_EXCLUDE_SNIPPETS,
  scriptSearchNeedles as zmScriptSearchNeedles,
  scriptSnippet as zmScriptSnippet,
} from "./zm-script-engine.js";
import type { PagerClient, PagerSavedReply } from "./pager-client.js";
import {
  isDisabledOutboundScriptKey,
  isDisabledOutboundTemplateRole,
} from "./disabled-outbound-scripts.js";

const replyCache = new Map<string, PagerSavedReply[]>();

const ROLE_SNIPPETS: Record<CountryCode, Partial<Record<TemplateRole, string[]>>> = {
  CM: {
    intro: ["01_intro", "Tu es du Cameroun", "Mon équipe cumule"],
    details: ["03_steps", "voici comment ça fonctionne", "02_age", "Quel âge"],
    registration: ["05_registration", "CASH056", "06_link", "Camerun01"],
    deposit: ["09_deposit", "bouton vert"],
    ask_id: ["08_game_id", "commence par 17"],
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
    details: ["02_how_it_works", "How it works"],
    registration: ["04_registration", "ZAM577", "05_link"],
    deposit: ["06_deposit", "click \"Deposit\""],
    ask_id: ["07_game_id", "begins with 17"],
    no_money: ["No problem", "when you are ready"],
    reactivation: ["still a spot"],
  },
};

async function resolveTemplateFolderId(
  client: PagerClient,
  hints: string[],
  preferredId?: string,
  liveBanks?: Array<{ id: string; name: string }>,
): Promise<string | undefined> {
  if (preferredId) {
    const replies = await loadFolderReplies(client, preferredId).catch(() => []);
    if (replies.length) {
      return preferredId;
    }
  }

  for (const bank of liveBanks ?? []) {
    const normalized = bank.name.toLowerCase();
    if (hints.some((hint) => normalized.includes(hint))) {
      const replies = await loadFolderReplies(client, bank.id).catch(() => []);
      if (replies.length) {
        return bank.id;
      }
    }
  }

  const banks = await client.getTemplateBanks().catch(() => []);
  for (const bank of banks) {
    const normalized = bank.name.toLowerCase();
    if (!hints.some((hint) => normalized.includes(hint))) {
      continue;
    }
    const replies = await loadFolderReplies(client, bank.id).catch(() => []);
    if (replies.length) {
      return bank.id;
    }
  }

  for (const bank of liveBanks ?? []) {
    const normalized = bank.name.toLowerCase();
    if (hints.some((hint) => normalized.includes(hint))) {
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

export async function resolveScriptTextByKey(
  client: PagerClient,
  options: {
    folderId?: string;
    liveBanks?: Array<{ id: string; name: string }>;
    scriptKey: string;
    country?: CountryCode;
  },
): Promise<string | undefined> {
  const country = options.country ?? "CM";
  if (isDisabledOutboundScriptKey(options.scriptKey)) {
    console.warn(`${country} script blocked (telegram removed): key=${options.scriptKey}`);
    return undefined;
  }
  const folderId =
    country === "ZM"
      ? await resolveZmTemplateFolderId(client, options.folderId, options.liveBanks)
      : country === "EG"
        ? await resolveEgTemplateFolderId(client, options.folderId, options.liveBanks)
        : await resolveCmTemplateFolderId(client, options.folderId, options.liveBanks);

  if (folderId) {
    const replies = await loadFolderReplies(client, folderId);
    const fromPager = matchReplyByScriptKey(replies, options.scriptKey, country);
    if (fromPager?.text?.trim() && isScriptReplyAcceptable(fromPager.text, options.scriptKey, country)) {
      return fromPager.text;
    }
    if (
      country === "CM" &&
      options.scriptKey === "06_link" &&
      fromPager?.text?.trim() &&
      /^https?:\/\/\S+$/i.test(fromPager.text.trim())
    ) {
      const fullReg = loadLocalCmScript("05_registration");
      if (fullReg?.trim()) {
        console.warn(`${country} script bare link replaced with 05_registration for key=06_link`);
        return fullReg;
      }
    }
    if (fromPager?.text?.trim()) {
      console.warn(
        `${country} script pager rejected weak match key=${options.scriptKey} chars=${fromPager.text.length}`,
      );
    } else {
      console.warn(
        `${country} script pager miss key=${options.scriptKey} folder=${folderId.slice(0, 8)} replies=${replies.length}`,
      );
    }
  }

  const local =
    country === "ZM"
      ? loadLocalZmScript(options.scriptKey)
      : country === "EG"
        ? loadLocalEgScript(options.scriptKey)
        : loadLocalCmScript(options.scriptKey);
  if (local?.trim()) {
    console.log(`${country} script local fallback key=${options.scriptKey}`);
    return local;
  }

  return undefined;
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

async function loadFolderReplies(client: PagerClient, folderId: string): Promise<PagerSavedReply[]> {
  const cached = replyCache.get(folderId);
  if (cached?.length) {
    return cached;
  }

  const replies = await client.getSavedReplies(folderId);
  if (replies.length) {
    replyCache.set(folderId, replies);
  }
  return replies;
}

function matchReplyByScriptKey(
  replies: PagerSavedReply[],
  scriptKey: string,
  country: CountryCode,
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
  if (scriptKey === "06_link") {
    return [...replies].sort((left, right) => (right.text?.length ?? 0) - (left.text?.length ?? 0))[0];
  }
  if (scriptKey === "05_link" || scriptKey === "07_chrome") {
    return [...replies].sort((left, right) => (left.text?.length ?? 0) - (right.text?.length ?? 0))[0];
  }
  return [...replies].sort((left, right) => (right.text?.length ?? 0) - (left.text?.length ?? 0))[0];
}

function scriptSnippetForCountry(country: CountryCode): (key: string) => string {
  if (country === "ZM") {
    return zmScriptSnippet;
  }
  if (country === "EG") {
    return egScriptSnippet;
  }
  return cmScriptSnippet;
}

function scriptSearchNeedlesForCountry(country: CountryCode): (key: string) => string[] {
  if (country === "ZM") {
    return zmScriptSearchNeedles;
  }
  if (country === "EG") {
    return egScriptSearchNeedles;
  }
  return cmScriptSearchNeedles;
}

function scriptExcludesForCountry(country: CountryCode, scriptKey: string): string[] {
  if (country === "ZM") {
    return ZM_SCRIPT_EXCLUDE_SNIPPETS[scriptKey] ?? [];
  }
  if (country === "EG") {
    return EG_SCRIPT_EXCLUDE_SNIPPETS[scriptKey] ?? [];
  }
  return CM_SCRIPT_EXCLUDE_SNIPPETS[scriptKey] ?? [];
}

function isScriptReplyAcceptable(text: string, scriptKey: string, country: CountryCode): boolean {
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
    return (
      body.includes("cash056") ||
      body.includes("je vous envoie le lien") ||
      body.includes("télécharger l'application")
    );
  }

  if (scriptKey === "07_chrome" && country === "CM") {
    return (
      body.includes("google chrome") &&
      (body.includes("copiez ce lien") || body.includes("collez-le"))
    );
  }

  if (scriptKey === "04_registration" && country === "ZM") {
    return (
      body.includes("promo code zam577") ||
      body.includes("special registration link") ||
      body.includes("paste it into your google chrome")
    );
  }

  if (scriptKey === "04_registration" && country === "EG") {
    return body.includes("eg011") || body.includes("هبعتلك اللينك") || body.includes("google chrome");
  }

  if (scriptKey === "05_link") {
    return (
      body.includes("tinyurl.com/zam577") ||
      body.includes("tinyurl.com/camerun01") ||
      body.includes("tinyurl.com/egypt0011")
    );
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
}
