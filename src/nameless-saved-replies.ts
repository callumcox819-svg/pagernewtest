import type { CountryCode } from "./config.js";
import type { PagerSavedReply } from "./pager-client.js";
import { buildEgScriptTextMap } from "./eg-script-engine.js";
import { isTablePresetText } from "./folder-presets.js";

/** Same geos as template-resolver ScriptResolveCountry (avoid circular import). */
export type NamelessScriptCountry = CountryCode | "RW" | "MG" | "DJ" | "JO" | "KE" | "GT" | "EC";

/**
 * 1xBET: Pager saved replies have no titles — map folder bubbles → script keys
 * by body heuristics + folder order. Melbet-style idea, separate from Melbet code.
 */

/** Typical folder order for each 1xBET engine (operator can rearrange; content wins first). */
const ORDERED_FUNNEL_KEYS: Record<NamelessScriptCountry, string[]> = {
  CM: [
    "01_intro",
    "01_intro_2",
    "01_intro_3",
    "02_age",
    "03_steps",
    "04_tier",
    "05_registration",
    "06_link",
    "07_chrome",
    "09_deposit",
    "08_game_id",
  ],
  EG: ["01_intro", "02_how_it_works", "03_egp_table", "04_registration", "05_link"],
  ZM: [
    "01_intro",
    "02_how_it_works",
    "03_zmw_table",
    "04_registration",
    "05_link",
    "06_deposit",
    "07_game_id",
  ],
  RW: ["01_intro", "02_how_it_works", "03_deposit_table", "04_registration", "05_link"],
  MG: ["01_intro", "02_how_it_works", "03_mga_table", "04_registration", "05_link"],
  DJ: [
    "01_intro",
    "02_how_it_works",
    "03_djf_table",
    "04_ready_ask",
    "05_registration",
    "06_link",
    "07_promo",
  ],
  JO: ["01_intro", "02_how_it_works", "03_jod_table", "04_registration", "05_link"],
  KE: [
    "01_intro",
    "02_how_it_works",
    "03_kes_table",
    "04_registration",
    "05_link",
    "06_deposit",
    "07_game_id",
  ],
  GT: [
    "01_intro",
    "01_intro_2",
    "02_age",
    "03_steps",
    "04_tier",
    "05_registration",
    "06_link",
    "07_chrome",
    "09_deposit",
    "08_game_id",
  ],
  EC: [
    "01_intro",
    "01_intro_2",
    "02_age",
    "03_steps",
    "04_tier",
    "05_registration",
    "06_link",
    "07_chrome",
    "09_deposit",
    "08_game_id",
  ],
};

const LINK_KEYS: Partial<Record<NamelessScriptCountry, string>> = {
  CM: "06_link",
  EG: "05_link",
  ZM: "05_link",
  RW: "05_link",
  MG: "05_link",
  DJ: "06_link",
  JO: "05_link",
  KE: "05_link",
  GT: "06_link",
  EC: "06_link",
};

const CHROME_KEYS: Partial<Record<NamelessScriptCountry, string>> = {
  CM: "07_chrome",
  GT: "07_chrome",
  EC: "07_chrome",
};

const TABLE_KEYS: Partial<Record<NamelessScriptCountry, string>> = {
  CM: "04_tier",
  EG: "03_egp_table",
  ZM: "03_zmw_table",
  RW: "03_deposit_table",
  MG: "03_mga_table",
  DJ: "03_djf_table",
  JO: "03_jod_table",
  KE: "03_kes_table",
  GT: "04_tier",
  EC: "04_tier",
};

function isBareUrl(text: string): boolean {
  const trimmed = text.trim();
  return /^https?:\/\/\S+$/i.test(trimmed) || (/tinyurl\.com\//i.test(trimmed) && trimmed.length < 120);
}

function isChromeTip(text: string): boolean {
  const lower = text.trim().toLowerCase();
  if (lower.length > 220) {
    return false;
  }
  return (
    (lower.includes("chrome") || lower.includes("google chrome") || lower.includes("navigateur")) &&
    (lower.includes("copiez") ||
      lower.includes("collez") ||
      lower.includes("pegue") ||
      lower.includes("paste") ||
      lower.includes("lien"))
  );
}

function structuralKey(country: NamelessScriptCountry, text: string): string | undefined {
  if (isBareUrl(text)) {
    return LINK_KEYS[country];
  }
  if (isTablePresetText(text)) {
    return TABLE_KEYS[country];
  }
  if (isChromeTip(text)) {
    return CHROME_KEYS[country];
  }
  return undefined;
}

function scoreNeedleMatch(text: string, needles: string[]): number {
  const body = text.toLowerCase();
  let best = 0;
  for (const needle of needles) {
    const n = needle.trim().toLowerCase();
    if (n.length >= 4 && body.includes(n)) {
      best = Math.max(best, n.length);
    }
  }
  return best;
}

export type NamelessNeedleLookup = {
  needlesForKey: (key: string) => string[];
  excludesForKey: (key: string) => string[];
};

/**
 * Map nameless saved replies → script texts for any 1xBET country.
 * Content / structural match first; remaining bubbles fill ordered funnel slots.
 */
export function buildNamelessScriptTextMap(
  replies: PagerSavedReply[],
  country: NamelessScriptCountry,
  lookup: NamelessNeedleLookup,
): Map<string, string> {
  if (country === "EG") {
    return buildEgScriptTextMap(replies);
  }

  const orderedKeys = ORDERED_FUNNEL_KEYS[country] ?? [];
  const sorted = [...replies]
    .filter((reply) => (reply.text || "").trim())
    .sort((left, right) => (left.order ?? 0) - (right.order ?? 0));
  const map = new Map<string, string>();

  // 1) Structural (URL / table / chrome tip)
  for (const reply of sorted) {
    const text = (reply.text || "").trim();
    const key = structuralKey(country, text);
    if (key && !map.has(key)) {
      map.set(key, text);
    }
  }

  // 2) Best needle match per unused reply
  for (const reply of sorted) {
    const text = (reply.text || "").trim();
    if ([...map.values()].includes(text)) {
      continue;
    }
    let bestKey: string | undefined;
    let bestScore = 0;
    for (const key of orderedKeys) {
      if (map.has(key)) {
        continue;
      }
      const excludes = lookup.excludesForKey(key);
      const lower = text.toLowerCase();
      if (excludes.some((snippet) => snippet && lower.includes(snippet.toLowerCase()))) {
        continue;
      }
      const score = scoreNeedleMatch(text, lookup.needlesForKey(key));
      if (score > bestScore) {
        bestScore = score;
        bestKey = key;
      }
    }
    if (bestKey && bestScore >= 6) {
      map.set(bestKey, text);
    }
  }

  // 3) Folder-order fallback for leftover bubbles → unused funnel keys
  const used = new Set(map.values());
  const leftover = sorted.filter((reply) => !used.has((reply.text || "").trim()));
  let slot = 0;
  for (const reply of leftover) {
    const text = (reply.text || "").trim();
    if (isBareUrl(text)) {
      const linkKey = LINK_KEYS[country];
      if (linkKey && !map.has(linkKey)) {
        map.set(linkKey, text);
      }
      continue;
    }
    while (slot < orderedKeys.length && map.has(orderedKeys[slot]!)) {
      slot += 1;
    }
    if (slot >= orderedKeys.length) {
      break;
    }
    map.set(orderedKeys[slot]!, text);
    slot += 1;
  }

  return map;
}

export function orderedFunnelKeysForCountry(country: NamelessScriptCountry): string[] {
  return [...(ORDERED_FUNNEL_KEYS[country] ?? [])];
}
