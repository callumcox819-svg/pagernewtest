/**
 * Screenshot scene hints for the funnel (OCR / caption text).
 * Used so AI + scripts advance correctly: stuck reg, ID, SMS ≠ deposit, balance OK.
 */

export type FunnelScreenshotScene =
  | "site_loading_stuck"
  | "registration_form"
  | "account_id_ready"
  | "mobile_money_sms"
  | "platform_balance"
  | "unclear";

export type FunnelScreenshotRead = {
  scene: FunnelScreenshotScene;
  reason: string;
  /** Game / account id if visible (15–19…). */
  accountId?: string;
  /** Parsed balance amount if visible on platform UI. */
  balanceAmount?: number;
};

const ACCOUNT_ID_RE = /\b((?:15|16|17|18|19)\d{7,10})\b/;

export function extractFunnelAccountId(text: string): string | undefined {
  const match = (text || "").match(ACCOUNT_ID_RE);
  return match?.[1];
}

function fold(value: string): string {
  return (value || "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** SMS / mobile-money receipt — not proof of 1xBET balance. */
export function looksLikeMobileMoneySms(text: string): boolean {
  const t = fold(text);
  if (!t) {
    return false;
  }
  const hasSmsTransfer =
    /\b(envoye a|envoy[eé] a|transfere? a|transfert|frais:?\s*\d|ref:?\s*\d|solde\.|raison:)\b/i.test(
      text,
    ) || /\b(ar|mga|fcfa|xof)\b.{0,40}\b(envoye|envoy[eé]|frais|ref)\b/i.test(t);
  const hasPlatformUi =
    /\b(1xbet|xbet|faire un d[eé]p[oô]t|nom d'utilisateur|vos coordonn[eé]es|office\/menu)\b/i.test(
      t,
    );
  return hasSmsTransfer && !hasPlatformUi;
}

/** Registration form still open / button spinning — help load, don't treat as done. */
export function looksLikeSiteLoadingStuck(text: string): boolean {
  const t = fold(text);
  if (!t) {
    return false;
  }
  if (extractFunnelAccountId(text) && /nom d'utilisateur|login\s*:|inscription r[eé]ussie/i.test(t)) {
    return false;
  }
  const formish =
    /\binscription\b/.test(t) &&
    (/\bcode promo\b/.test(t) ||
      /\ben un clic\b/.test(t) ||
      /\bpar (e-?mail|telephone)\b/.test(t) ||
      /\bmadagascar\b|\bcameroun\b|\bmga\b|\bfcfa\b/.test(t));
  const stuck =
    /\b(chargement|loading|veuillez patienter|please wait|\.{3}|…)\b/i.test(text) ||
    /\b(ne charge|page blanche|ecran noir|about:blank|err_)\b/i.test(t);
  return (formish && stuck) || (formish && !extractFunnelAccountId(text) && stuck);
}

export function looksLikePlatformBalance(text: string): boolean {
  const t = fold(text);
  if (!t || looksLikeMobileMoneySms(text)) {
    return false;
  }
  const hasPlatform =
    /\b(1xbet|xbet|1x\s*bet|faire un d[eé]p[oô]t|mes paris|office)\b/i.test(t);
  const hasBalance =
    /\b(solde|balance|wallet)\b/i.test(t) ||
    /\b\d{3,7}\s*(mga|ar|fcfa|xof|djf|kes|egp|zmw|jod|gtq)\b/i.test(t) ||
    /\b\d{3,7}\s*F\b/i.test(text);
  return hasPlatform && hasBalance;
}

export function looksLikeAccountIdReady(text: string): boolean {
  const id = extractFunnelAccountId(text);
  if (!id) {
    return false;
  }
  if (looksLikeMobileMoneySms(text) || looksLikeSiteLoadingStuck(text)) {
    return false;
  }
  const t = fold(text);
  return (
    /\b(nom d'utilisateur|login\s*:|d[eé]p[oô]t\s*\d{8,}|id joueur|numero de joueur|compte|profil|inscription r[eé]ussie)\b/i.test(
      t,
    ) ||
    /\bvos coordonnees de compte\b/i.test(t) ||
    /\bfaire un d[eé]p[oô]t\b/i.test(t)
  );
}

function parseBalanceAmount(text: string): number | undefined {
  const match = text.match(
    /\b(\d{3,7}(?:[.,]\d{1,2})?)\s*(mga|ar|fcfa|xof|djf|kes|egp|zmw|jod|gtq|F)\b/i,
  );
  if (!match?.[1]) {
    return undefined;
  }
  const n = Number(match[1].replace(",", "."));
  return Number.isFinite(n) ? n : undefined;
}

/** Classify OCR/caption of a customer screenshot for funnel routing. */
export function readFunnelScreenshot(text: string): FunnelScreenshotRead {
  const raw = (text || "").trim();
  if (!raw) {
    return { scene: "unclear", reason: "empty" };
  }

  if (looksLikeMobileMoneySms(raw)) {
    return {
      scene: "mobile_money_sms",
      reason: "mobile-money SMS receipt, not 1xBET balance",
      balanceAmount: parseBalanceAmount(raw),
    };
  }

  if (looksLikeSiteLoadingStuck(raw)) {
    return { scene: "site_loading_stuck", reason: "registration UI stuck/loading" };
  }

  if (looksLikePlatformBalance(raw)) {
    return {
      scene: "platform_balance",
      reason: "1xBET balance / wallet visible",
      accountId: extractFunnelAccountId(raw),
      balanceAmount: parseBalanceAmount(raw),
    };
  }

  if (looksLikeAccountIdReady(raw)) {
    return {
      scene: "account_id_ready",
      reason: "account/ID screen ready for deposit step",
      accountId: extractFunnelAccountId(raw),
    };
  }

  const t = fold(raw);
  if (
    /\binscription\b/.test(t) &&
    (/\bcode promo\b/.test(t) || /\ben un clic\b/.test(t)) &&
    !extractFunnelAccountId(raw)
  ) {
    return { scene: "registration_form", reason: "inscription form without finished id" };
  }

  return { scene: "unclear", reason: "unclassified screenshot text" };
}
