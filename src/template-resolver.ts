import type { BotConfig, CountryCode, TemplateRole } from "./config.js";
import { getTemplateBank } from "./config.js";
import {
  CM_FOLDER_NAME_HINTS,
  scriptSearchNeedles,
} from "./cm-script-engine.js";
import type { PagerClient, PagerSavedReply } from "./pager-client.js";

const replyCache = new Map<string, PagerSavedReply[]>();

const ROLE_SNIPPETS: Record<CountryCode, Partial<Record<TemplateRole, string[]>>> = {
  CM: {
    intro: ["01_intro", "Tu es du Cameroun", "Mon équipe cumule"],
    details: ["03_steps", "voici comment ça fonctionne", "02_age", "Quel âge"],
    registration: ["05_registration", "CASH056", "06_link", "Camerun01"],
    deposit: ["09_deposit", "bouton vert"],
    ask_id: ["08_game_id", "commence par 17"],
    telegram_handoff: ["11_tg_link", "XtIY04zvcVw2YzZi", "10_tg_invite"],
    no_money: ["pas d'argent", "plus tard"],
    reactivation: ["Il reste encore"],
  },
  EG: {
    intro: ["01_intro", "إنت من مصر"],
    details: ["02_how_it_works", "تمام كده"],
    registration: ["04_registration", "هبعتلك اللينك", "05_link", "Egypt0011"],
    deposit: ["06_deposit", "الأخضر"],
    ask_id: ["07_game_id", "يبدأ ب 17"],
    telegram_handoff: ["10_tg_link", "t7iYS46b2Ls2YWRk", "09_tg_invite"],
    no_money: ["مش معايه فلوس", "no money"],
    reactivation: ["لسه عندنا"],
  },
  ZM: {
    intro: ["01_intro", "Hi! I want to show you"],
    details: ["02_how_it_works", "How it works"],
    registration: ["04_registration", "ZAM577", "05_link"],
    deposit: ["06_deposit", "click \"Deposit\""],
    ask_id: ["07_game_id", "begins with 17"],
    telegram_handoff: ["09_tg_link", "t.me/+"],
    no_money: ["No problem", "when you are ready"],
    reactivation: ["still a spot"],
  },
};

export async function resolveCmTemplateFolderId(
  client: PagerClient,
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
    if (CM_FOLDER_NAME_HINTS.some((hint) => normalized.includes(hint))) {
      const replies = await loadFolderReplies(client, bank.id).catch(() => []);
      if (replies.length) {
        return bank.id;
      }
    }
  }

  const banks = await client.getTemplateBanks().catch(() => []);
  for (const bank of banks) {
    const normalized = bank.name.toLowerCase();
    if (!CM_FOLDER_NAME_HINTS.some((hint) => normalized.includes(hint))) {
      continue;
    }
    const replies = await loadFolderReplies(client, bank.id).catch(() => []);
    if (replies.length) {
      return bank.id;
    }
  }

  return preferredId || liveBanks?.[0]?.id || banks[0]?.id;
}

export async function resolveScriptTextByKey(
  client: PagerClient,
  options: {
    folderId?: string;
    liveBanks?: Array<{ id: string; name: string }>;
    scriptKey: string;
  },
): Promise<string | undefined> {
  const folderId = await resolveCmTemplateFolderId(
    client,
    options.folderId,
    options.liveBanks,
  );
  if (!folderId) {
    return undefined;
  }

  const replies = await loadFolderReplies(client, folderId);
  const fromPager = matchReplyByScriptKey(replies, options.scriptKey);
  return fromPager?.text;
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
  if (cached) {
    return cached;
  }

  const replies = await client.getSavedReplies(folderId);
  replyCache.set(folderId, replies);
  return replies;
}

function matchReplyByScriptKey(
  replies: PagerSavedReply[],
  scriptKey: string,
): PagerSavedReply | undefined {
  const keyNeedle = scriptKey.toLowerCase();
  const byName = replies.filter((reply) => (reply.name ?? "").toLowerCase().includes(keyNeedle));
  if (byName.length) {
    return byName[byName.length - 1];
  }

  const needles = scriptSearchNeedles(scriptKey);
  let lastHit: PagerSavedReply | undefined;
  for (const reply of replies) {
    const name = (reply.name ?? "").toLowerCase();
    const body = normalizeNeedle(reply.text);
    for (const needle of needles) {
      const normalized = needle.trim().toLowerCase();
      if (!normalized) {
        continue;
      }
      if (name.includes(normalized) || body.includes(normalized) || normalized.includes(body.slice(0, 48))) {
        lastHit = reply;
        break;
      }
    }
  }
  return lastHit;
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
