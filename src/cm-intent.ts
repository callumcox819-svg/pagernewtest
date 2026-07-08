import { isPositiveMessageReaction } from "./message-attachments.js";

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
  /\b(oui|ok|okay|d'accord|dac|dacc|bien|super|parfait|merci|yes|yeah|yep)\b/i;
const FR_GREETING =
  /^(bonjour|bonsoir|salut|saluu+t|bjr|slt|hello|hi)([\s,!.]|$)/i;
const FR_INTERESTED =
  /\b(je veux|interesse|interesse|interessee|interessee|m'interesse|ca m'interesse|comment|explique|details|details|investir|gagner|j[' ]?ai vu votre publication|jai vu votre publication|j[' ]?ai vu votre pub|jai vu votre pub|publication|je suis interesse|suis interesse|commen[cç]ons)\b/i;
const FR_DECLINED =
  /\b(pas intéressé|pas interesse|je ne suis pas intéressé|non merci|stop|arrête|arnaque|escroc|nigerian)\b/i;
const FR_REG_DONE =
  /(déjà|deja).{0,32}(connect|inscription|inscrit|enregistr|1xbet)|je me suis deja connecte|compte.{0,16}(ouvert|créé|cree)|j[' ]?ai (fini|créé|cree).{0,16}(inscription|compte)/i;
const FR_REG_PENDING =
  /\b(pas encore|pas fini|je m'inscris|j['']?inscris|en cours)\b/i;
const POSITIVE_EMOJI = /[👍👌✅🔥❤️🙏😊🙂]/;
const FR_LINK_BROKEN =
  /\b(sa marche pas|ca marche pas|ne marche pas|marche pas|ne fonctionne pas|fonctionne pas|pas pu telecharger|pas pui telecharger|probleme de lien|lien.*pas|telecharg\w*.*pas)\b/i;
const FR_HAS_ACCOUNT_OR_APP =
  /\b(j'ai l'application|jai l'application|j'ai un compte|jai un compte|avec un compte|application deja|deja un compte|compte deja cree)\b/i;

export function classifyCmIntent(
  text: string,
  options?: {
    hasImage?: boolean;
    funnelStep?: number;
    messageReaction?: string;
  },
): CmIntent {
  const t = (text || "").trim();
  const normalized = normalizeFrText(text);
  const step = options?.funnelStep ?? 0;

  if (FR_DECLINED.test(t) || /nigerian|scam|arnaque|escroc/i.test(t)) {
    return "declined";
  }
  if (isClientReadyPhrase(t)) {
    return "ready";
  }
  if (isAgeAnswer(t) && step >= 1 && step < 5) {
    return "positive";
  }
  if (isDepositTierChoice(t)) {
    return "ready";
  }
  if (FR_REG_DONE.test(t) || FR_REG_DONE.test(normalized)) {
    return "positive";
  }
  if (FR_REG_PENDING.test(t) || FR_REG_PENDING.test(normalized)) {
    return "ready";
  }
  if (wantsRegistrationLink(t)) {
    return "ready";
  }
  if (!t && isPositiveMessageReaction(options?.messageReaction)) {
    return "positive";
  }
  if (!t && options?.hasImage) {
    return step < 5 ? "positive" : "image_only";
  }
  if (POSITIVE_EMOJI.test(t) && t.length <= 4) {
    return "positive";
  }
  if (FR_INTERESTED.test(t) || FR_INTERESTED.test(normalized)) {
    return "interested";
  }
  if (FR_GREETING.test(t) || FR_GREETING.test(normalized)) {
    return step < 2 ? "interested" : "positive";
  }
  if (
    /\b(je suis a l'ecoute|je suis a l ecoute|a l'ecoute|je vous ecoute|je t'ecoute)\b/i.test(
      normalized,
    )
  ) {
    return "positive";
  }
  if (/\bje suis (au|du) cameroun\b|\b(au|du) cameroun\b/i.test(normalized)) {
    return "positive";
  }
  if (isProfitFigure(normalized)) {
    return step >= 3 ? "positive" : "interested";
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
  const t = normalizeFrText(text);
  if (!t) {
    return false;
  }
  if (/^(1|2)\.?$/.test(t)) {
    return true;
  }
  if (/^(1000|1500|1\s?000|1\s?500)\s*(?:cfa|frs?|f)?\.?$/i.test(t)) {
    return true;
  }
  if (
    t.split(/\s+/).length <= 12 &&
    /\b(1000|1500|1\s?000|1\s?500)\s*(?:cfa|frs?|f)?\b/i.test(t)
  ) {
    return true;
  }
  if (/\b(1000|1500)\s*f(?:rs?)?\b/i.test(t) || /\b(1000f(?:rs?)?|1500f(?:rs?)?)\b/i.test(t)) {
    return true;
  }
  return isCmTier1000Choice(t) || isCmTier1500Choice(t);
}

export function isClientReadyPhrase(text: string): boolean {
  const t = normalizeFrText(text);
  if (!t) {
    return false;
  }
  return (
    /\b(je suis pret|je suis prete|pret a commencer|pret a continuer|je suis partant|je suis partante)\b/i.test(
      t,
    ) ||
    /\b(j'attends|j attends|jattends|vas y|allons y|on y va|je suis d'accord)\b/i.test(t) ||
    /\bje veux commencer|je veux continuer\b/i.test(t)
  );
}

function normalizeFrText(text: string): string {
  return (text || "")
    .trim()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/['’]/g, "'");
}

function isProfitFigure(text: string): boolean {
  const t = (text || "").trim();
  if (!t) {
    return false;
  }
  return (
    /^\d{1,3}(?:[\s.,]\d{3})+(?:\s*(?:cfa|frs?|f))?\.?$/i.test(t) ||
    /^(?:10000|15000|19000|20000|25000|30000)\s*(?:cfa|frs?|f)?\.?$/i.test(t)
  );
}

export function isCmProfitFigure(text: string): boolean {
  return isProfitFigure(normalizeFrText(text)) || isProfitFigure(text);
}

function isCmTier1000Choice(t: string): boolean {
  if (/^(1er|1ere|premier|premiere)\.?$/i.test(t)) {
    return true;
  }
  if (
    /\b(je choisis|je prends|je veux|je prend|choisis|prends|prenez|je prendrai)\s+(le\s+)?(1er|premier|premiere|1ere)\b/i.test(
      t,
    )
  ) {
    return true;
  }
  if (/\b(le|la)\s+(1er|premier|premiere|1ere)\b/i.test(t)) {
    return true;
  }
  if (/\b(1er|premier|premiere)\s+(option|choix|montant|variante)\b/i.test(t)) {
    return true;
  }
  if (/\boption\s+1\b/i.test(t)) {
    return true;
  }
  if (/\b(premier|1er)\s+montant\b/i.test(t)) {
    return true;
  }
  if (/\bfirst(\s+one|\s+option)?\b/i.test(t)) {
    return true;
  }
  return false;
}

function isCmTier1500Choice(t: string): boolean {
  if (/^(2eme|2e|deuxieme|second)\.?$/i.test(t)) {
    return true;
  }
  if (
    /\b(je choisis|je prends|je veux|choisis|prends)\s+(le\s+)?(2eme|deuxieme|second)\b/i.test(
      t,
    )
  ) {
    return true;
  }
  if (/\b(le|la)\s+(2eme|deuxieme|second)\b/i.test(t)) {
    return true;
  }
  if (/\b(2eme|deuxieme|second)\s+(option|choix|montant)\b/i.test(t)) {
    return true;
  }
  if (/\boption\s+2\b/i.test(t)) {
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
  const t = (text || "").trim();
  const normalized = normalizeFrText(text);
  if (!t) {
    return false;
  }
  if (isRegistrationConfirmed(t)) {
    return false;
  }
  if (/^(?:le\s+)?(?:lien|link)(?:\s+please)?\s*[.!?]*$/i.test(t)) {
    return true;
  }
  if (/\b(dacor|daccor|daccord|dacor)\b.*\b(lien|link)\b/i.test(normalized)) {
    return true;
  }
  if (/\benvoy\w*.*\blien\b|\blien\b.*\benvoy\w*\b/i.test(t)) {
    return true;
  }
  return (
    /\b(lien|link|inscri|register|compte|account)\b/i.test(t) &&
    /\b(envoy|donn|send|veux|besoin|where|faut)\b/i.test(t)
  );
}

export function isRegistrationConfirmed(text: string): boolean {
  const t = normalizeFrText(text);
  return FR_REG_DONE.test(t) || FR_HAS_ACCOUNT_OR_APP.test(t);
}

export function isRegistrationPending(text: string): boolean {
  return FR_REG_PENDING.test(normalizeFrText(text));
}

export function isRegistrationBlocked(text: string): boolean {
  return FR_LINK_BROKEN.test(normalizeFrText(text));
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
  if (isProfitFigure(t)) {
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
