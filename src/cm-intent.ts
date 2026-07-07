export type CmIntent =
  | "interested"
  | "positive"
  | "ready"
  | "question"
  | "declined"
  | "unknown"
  | "joined"
  | "deposit_done"
  | "game_id_text"
  | "image_only";

const FR_POSITIVE =
  /\b(oui|ok|d'accord|dac|dacc|bien|super|parfait|merci|yes|yeah|yep)\b/i;
const FR_INTERESTED =
  /\b(je veux|interesse|intéressé|m'intéresse|ca m'intéresse|ça m'intéresse|comment|explique|details|détails|investir|gagner)\b/i;
const FR_DECLINED =
  /\b(pas intéressé|pas interesse|je ne suis pas intéressé|non merci|stop|arrête|arnaque|escroc|nigerian)\b/i;
const FR_REG_DONE =
  /(déjà|deja).{0,24}(inscription|inscrit|enregistr)|compte.{0,16}(ouvert|créé|cree)|j[' ]?ai (fini|créé|cree).{0,16}(inscription|compte)/i;
const FR_REG_PENDING =
  /\b(pas encore|pas fini|je m'inscris|j['']?inscris|en cours)\b/i;
const POSITIVE_EMOJI = /[👍👌✅🔥❤️🙏😊🙂]/;

export function classifyCmIntent(
  text: string,
  options?: {
    hasImage?: boolean;
    funnelStep?: number;
    messageReaction?: string;
  },
): CmIntent {
  const t = (text || "").trim();
  const step = options?.funnelStep ?? 0;

  if (FR_DECLINED.test(t) || /nigerian|scam|arnaque|escroc/i.test(t)) {
    return "declined";
  }
  if (isAgeAnswer(t) && step >= 1 && step < 5) {
    return "positive";
  }
  if (isDepositTierChoice(t)) {
    return "ready";
  }
  if (FR_REG_DONE.test(t)) {
    return "positive";
  }
  if (FR_REG_PENDING.test(t)) {
    return "ready";
  }
  if (wantsRegistrationLink(t)) {
    return "ready";
  }
  if (!t && (options?.messageReaction || options?.hasImage)) {
    if (step < 5) {
      return "positive";
    }
    return "image_only";
  }
  if (!t && POSITIVE_EMOJI.test(options?.messageReaction ?? "")) {
    return step < 5 ? "positive" : "image_only";
  }
  if (POSITIVE_EMOJI.test(t) && t.length <= 4) {
    return "positive";
  }
  if (FR_INTERESTED.test(t)) {
    return "interested";
  }
  if (/\boui\b/i.test(t) && step < 4) {
    return "positive";
  }
  if (FR_POSITIVE.test(t) && t.split(/\s+/).length <= 8) {
    return "positive";
  }
  if (/\?/.test(t) || /\b(comment|pourquoi|combien|quoi|what|how)\b/i.test(t)) {
    return "question";
  }
  if (options?.hasImage && !t) {
    return step < 5 ? "positive" : "image_only";
  }
  if (t) {
    return "unknown";
  }
  return "unknown";
}

export function isDepositTierChoice(text: string): boolean {
  const t = (text || "").trim();
  if (!t) {
    return false;
  }
  if (/^(1000|1500)\s*(?:cfa|fr|f)?\.?$/i.test(t)) {
    return true;
  }
  if (t.split(/\s+/).length <= 8 && /\b(1000|1500)\s*(?:cfa|fr|f)?\b/i.test(t)) {
    return true;
  }
  return false;
}

export function isAgeAnswer(text: string): boolean {
  const t = (text || "").trim();
  if (!t) {
    return false;
  }
  if (/^\d{1,2}$/.test(t)) {
    const age = Number(t);
    return age >= 15 && age <= 99;
  }
  if (/\b(j'ai|jai|ai)\s*\d{1,2}\s*ans\b/i.test(t)) {
    return true;
  }
  if (/\b(j'ai|jai|ai)\s*\d{1,2}\b/i.test(t)) {
    const match = t.match(/\b(?:j'ai|jai|ai)\s*(\d{1,2})\b/i);
    if (match) {
      const age = Number(match[1]);
      return age >= 15 && age <= 99;
    }
  }
  if (/\b\d{1,2}\s*ans\b/i.test(t)) {
    return true;
  }
  if (/\d{1,2}ans\b/i.test(t)) {
    const match = t.match(/(\d{1,2})ans/i);
    if (match) {
      const age = Number(match[1]);
      return age >= 15 && age <= 99;
    }
  }
  return false;
}

export function wantsRegistrationLink(text: string): boolean {
  const t = (text || "").trim().toLowerCase();
  if (!t) {
    return false;
  }
  return (
    /\b(lien|link|inscri|register|compte|account)\b/i.test(t) &&
    /\b(envoy|donn|send|veux|besoin|where|faut)\b/i.test(t)
  );
}

export function isRegistrationConfirmed(text: string): boolean {
  return FR_REG_DONE.test((text || "").trim());
}

export function isRegistrationPending(text: string): boolean {
  return FR_REG_PENDING.test((text || "").trim());
}

export function isFunnelPositiveReaction(text: string, funnelStep: number): boolean {
  if (funnelStep >= 5) {
    return false;
  }
  const t = (text || "").trim();
  if (!t) {
    return false;
  }
  if (POSITIVE_EMOJI.test(t)) {
    return true;
  }
  if (/^(oui|ok|yes|d'accord)\.?$/i.test(t)) {
    return true;
  }
  if (/\boui\b/i.test(t) && t.split(/\s+/).length <= 12) {
    return true;
  }
  return false;
}

export function wantsDetailsAfterIntro(text: string): boolean {
  const t = (text || "").trim();
  if (!t) {
    return false;
  }
  return /\b(detail|détail|explique|comment ça|comment ca|how)\b/i.test(t);
}

export function isReadyForRegistration(text: string): boolean {
  const t = (text || "").trim();
  if (!t) {
    return false;
  }
  if (isDepositTierChoice(t)) {
    return true;
  }
  if (/^(oui|ok|yes|d'accord)\.?$/i.test(t)) {
    return true;
  }
  if (FR_POSITIVE.test(t) && t.split(/\s+/).length <= 4) {
    return true;
  }
  return false;
}
