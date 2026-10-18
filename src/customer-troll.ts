import { normalizeCustomerText } from "./customer-intent.js";
import {
  isDepositTierChoice,
  isCmRegistrationHelpRequest,
  wantsRegistrationLink,
  isRegistrationAccountQuestion,
  isReadyForRegistration,
  isFunnelPositiveReaction,
} from "./cm-intent.js";
import { isCustomerClarificationMessage, isLinkAccessProblemMessage } from "./customer-clarity.js";
import { extractCmClientLoginId17 } from "./cm-proof.js";
import { isWaitingNudgeAfterChoice } from "./funnel-common.js";

/** Markets where off-topic / spam detection is enabled (French funnels). */
export type TrollDetectionCountry = "CM" | "CL" | "DJ" | "MG";

export function isTrollDetectionCountry(country: string): country is TrollDetectionCountry {
  return country === "CM" || country === "CL" || country === "DJ" || country === "MG";
}

const FUNNEL_TOPIC =
  /\b(casino|inscri|enregistr|compte|d[eé]p[oô]t|cfa|franc|mga|ariary|djf|lien|link|gagn|invest|promo|cash056|cmr056|cle333|1xbet|plateforme|strat[eé]g|tactique|montant|profit|age|âge|premier|1er|option|choix)\b/i;

const OFF_TOPIC_STRONG =
  /\b(nike|blazer|adidas|puma|iphone|samsung|huawei|windows\s*(10|11)?|hotel|h[oô]tel|sticker|musique|musiques|chanson|spotify|youtube|tiktok|film|cin[eé]ma|netflix|football|basket|maillot|sneaker|good deal|black friday|promo nike)\b/i;

const JOURNEE_SPAM = /(de la journ[eé]e[\s,.]*){3,}/i;
const GIBBERISH_LETTER = /\b([a-zàâäéèêëïîôùûüç])\1{5,}/i;
const RAMBLING_SPAM =
  /\b(groupe scolaire|petite famille|excellente fin de semaine|bonne vacances).{0,120}(musique|musiques|bonne id[eé]e de toi)\b/i;

const INTERESTED =
  /\b(cela m'int[eé]resse|ça m'int[eé]resse|interess[eé]|comment ça marche|comment ça fonctionne|explique|détails|details|je veux|je suis partant)\b/i;

/** Clear soft-refuse / sob-story spam after the money table — not a deposit choice. */
const HARD_SOFT_REFUSE =
  /\b(orphelin|orphelins|je\s*travail+e?\s*pas|travaille?\s*pas|ch[oô]meur|pas\s*d['']?argent|n['']ai\s*pas\s*(d['']?)?argent)\b/i;

/**
 * Explicit «nothing suits me / not interested» — move to SPAM after offer table.
 * Covers typos like «Chuis ne prefere pas».
 */
export function isExplicitFunnelDecline(text: string): boolean {
  const raw = (text || "").trim();
  if (!raw) {
    return false;
  }
  const t = normalizeCustomerText(raw);
  if (/^(non|nah|nope|jamais|rien|non merci)\.?!*$/i.test(t)) {
    return true;
  }
  return (
    /\b(pas interess[eé]|non merci|stop|arr[eê]te|arnaque|scam|laisse[- ]moi|fous[- ]moi|degage)\b/i.test(
      t,
    ) ||
    /\b(ne|n')\s*(me\s*)?(pr[eé]f[eè]re|veux|veut|veux|aime|interesse)\s*pas\b/i.test(t) ||
    /\b(je\s*)?(ne\s*)?(pr[eé]f[eè]re|veux|aime)\s*pas\b/i.test(t) ||
    /\b(chuis|je\s*suis)\s+ne\b/i.test(t) ||
    /\b(rien|aucun|aucune)\s*(ne\s*)?(me\s*)?(va|convient|interesse|plait|pla[iî]t)\b/i.test(t) ||
    /\b(pas pour moi|rien pour moi|aucun montant|aucune option|rien de tout)\b/i.test(t) ||
    /\b(je\s*)?(ne\s*)?(prends|choisis|veux)\s*(rien|aucun)\b/i.test(t)
  );
}

export type TrollGateOptions = {
  /** Tier table / reg link / deposit scripts already sent in thread. */
  hasFunnelProgress: boolean;
  latestHasImage: boolean;
};

function looksLikeTableOrdinalPick(text: string): boolean {
  const raw = (text || "").trim();
  if (!raw || raw.length > 24) {
    return false;
  }
  const compact = raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");
  return /^(le)?(1er|1ere|2e|2eme|3e|3eme|4e|4eme|premier|premiere|deuxieme|second|troisieme|quatrieme)$/i.test(
    compact,
  );
}

function isLegitimateCustomerMessage(text: string, funnelStep = 0): boolean {
  const t = (text || "").trim();
  if (!t) {
    return false;
  }
  if (isWaitingNudgeAfterChoice(t) || looksLikeTableOrdinalPick(t)) {
    return true;
  }
  if (isDepositTierChoice(t) || isCmRegistrationHelpRequest(t) || wantsRegistrationLink(t)) {
    return true;
  }
  if (isRegistrationAccountQuestion(t) || isReadyForRegistration(t)) {
    return true;
  }
  if (isCustomerClarificationMessage(t) || isLinkAccessProblemMessage(t)) {
    return true;
  }
  if (extractCmClientLoginId17(t)) {
    return true;
  }
  if (INTERESTED.test(normalizeCustomerText(t))) {
    return true;
  }
  if (isFunnelPositiveReaction(t, funnelStep)) {
    return true;
  }
  if (FUNNEL_TOPIC.test(normalizeCustomerText(t))) {
    return true;
  }
  if (/^\d{2,4}$/.test(t.replace(/\s/g, ""))) {
    return true;
  }
  return false;
}

/** 0 = ok, 1 = suspicious, 2+ = clear off-topic / trolling. */
export function scoreOffTopicTrollMessage(text: string): number {
  const raw = (text || "").trim();
  if (!raw || raw.length < 2) {
    return 0;
  }
  const t = normalizeCustomerText(raw);
  if (isLegitimateCustomerMessage(raw)) {
    return 0;
  }

  let score = 0;

  if (OFF_TOPIC_STRONG.test(t)) {
    score += 2;
  }
  if (JOURNEE_SPAM.test(t)) {
    score += 2;
  }
  if (GIBBERISH_LETTER.test(t)) {
    score += 2;
  }
  if (RAMBLING_SPAM.test(t)) {
    score += 2;
  }
  if (/^(windows|nike|hyy+|lol+|mdr+|haha+)[.!\s]*$/i.test(t)) {
    score += 2;
  }
  if (HARD_SOFT_REFUSE.test(t) || isExplicitFunnelDecline(raw)) {
    score += 2;
  }
  // Random keyboard smash only — never short real words like «et alors».
  if (/^[a-zàâäéèêëïîôùûüç]{1,3}(\s+[a-zàâäéèêëïîôùûüç]{1,3}){0,2}$/i.test(raw) && !/[aeiouyàâäéèêëïîôùûü]/i.test(raw)) {
    score += 2;
  }
  if (t.length > 80 && !FUNNEL_TOPIC.test(t) && /\b(je vous souhaite|tu veux que je|musique|vacances|famille)\b/i.test(t)) {
    score += 1;
  }
  if (raw.length > 120 && !FUNNEL_TOPIC.test(t) && (raw.match(/\?/g)?.length ?? 0) === 0) {
    score += 1;
  }

  return score;
}

/**
 * Conservative: SPAM only for clear nonsense / refuse — never mid-funnel picks or waiting nudges.
 */
export function shouldIgnoreTrollCustomer(
  latestText: string,
  recentCustomerTexts: string[],
  options: TrollGateOptions,
  funnelStep = 0,
): boolean {
  if (options.latestHasImage) {
    return false;
  }
  if (isLegitimateCustomerMessage(latestText, funnelStep)) {
    return false;
  }
  // If the thread recently picked a table option, never spam on a short follow-up.
  if (
    recentCustomerTexts.some((line) => looksLikeTableOrdinalPick(line) || isDepositTierChoice(line))
  ) {
    return false;
  }

  const latestScore = scoreOffTopicTrollMessage(latestText);
  // Only hard signals (score ≥ 2) move to SPAM — never “unknown short message”.
  if (latestScore >= 2) {
    return true;
  }

  const recent = [latestText, ...recentCustomerTexts.filter((line) => line !== latestText)].slice(0, 5);
  let hardHits = 0;
  for (const line of recent) {
    if (isLegitimateCustomerMessage(line, funnelStep)) {
      continue;
    }
    if (scoreOffTopicTrollMessage(line) >= 2) {
      hardHits += 1;
    }
  }

  // Stacked hard refuse / off-topic in recent bubbles (e.g. orphan + no work + sorry).
  if (hardHits >= 2) {
    return true;
  }

  return false;
}
