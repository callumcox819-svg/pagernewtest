/**
 * Screenshot scene hints for the funnel (OCR / caption text).
 * Used so AI + scripts advance correctly: stuck reg, ID, SMS ≠ deposit, balance OK.
 */

export type FunnelScreenshotScene =
  | "wrong_betting_brand"
  | "site_loading_stuck"
  | "registration_form"
  | "deposit_form"
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
  /** Foreign brand label when scene is wrong_betting_brand (e.g. 256bet, Bet261). */
  foreignBrand?: string;
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

/** Rival bookmakers / wrong casino — NOT a «page won't load» issue for our 1xBET funnel. */
const FOREIGN_BRAND_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\b256\s*bet\b|256bet\.com/i, label: "256bet" },
  { re: /\bbet\s*261\b|bet261\.|bet261\.mg/i, label: "Bet261" },
  { re: /\bmel\s*bet\b|melbet\.|мелбет/i, label: "Melbet" },
  { re: /\bline\s*bet\b|linebet\./i, label: "Linebet" },
  { re: /\bmost\s*bet\b|mostbet\./i, label: "Mostbet" },
  { re: /\b22\s*bet\b|22bet\./i, label: "22bet" },
  { re: /\bmegapari\b|megapari\./i, label: "Megapari" },
  { re: /\bparipesa\b|paripesa\./i, label: "Paripesa" },
  { re: /\b888starz\b|888starz\./i, label: "888starz" },
  { re: /\bbetway\b|betway\./i, label: "Betway" },
];

const OWN_1XBET_RE = /\b1x\s*bet\b|\b1хбет\b|\b1xbet\b|1xbet\./i;

export function extractWrongBettingBrandLabel(text: string): string | undefined {
  const raw = text || "";
  for (const item of FOREIGN_BRAND_PATTERNS) {
    if (item.re.test(raw)) {
      return item.label;
    }
  }
  return undefined;
}

/**
 * Customer opened a competitor site (256bet, Bet261, Melbet…) instead of our 1xBET link.
 * Must win over «site loading» heuristics — sports UI is not a Chrome/refresh problem.
 */
export function looksLikeWrongBettingBrand(text: string): boolean {
  const raw = text || "";
  if (!raw.trim()) {
    return false;
  }
  const foreign = extractWrongBettingBrandLabel(raw);
  if (!foreign) {
    return false;
  }
  // Explicit foreign host in URL bar always wins.
  if (/256bet\.|bet261\.|melbet\.|linebet\.|mostbet\.|22bet\./i.test(raw)) {
    return true;
  }
  // Brand name visible without our 1xBET brand → wrong site.
  if (!OWN_1XBET_RE.test(raw)) {
    return true;
  }
  // Both brands mentioned — still treat as wrong if foreign label is primary brand chrome.
  return /logo|sports|top match|top jeux|aviator|casino/i.test(raw);
}

/** Localized coach text: use OUR 1xBET link + promo, not the foreign brand. */
export function wrongBettingBrandCoachReply(
  country: string,
  brandLabel?: string,
): string {
  const brand = (brandLabel || "ce site").trim();
  const code = (country || "").trim().toUpperCase();
  if (code === "EG" || code === "JO" || code === "PK") {
    return `هذا ليس الموقع الصحيح — أنت على ${brand}. لازم تفتح رابط تسجيل 1xBET اللي بعتُه لك مع كود البرومو بتاعنا. مش ${brand}. افتح الرابط من الشات في Chrome وكمل التسجيل هناك.`;
  }
  if (
    code === "CL" ||
    code === "GT" ||
    code === "EC" ||
    code === "CR" ||
    code === "PE"
  ) {
    return `Esa no es la plataforma correcta — estás en ${brand}. Tienes que abrir el enlace de registro 1xBET que ya te envié con nuestro código promo. No ${brand}. Abre mi enlace del chat en Chrome y regístrate ahí.`;
  }
  if (code === "ZM" || code === "KE" || code === "RW") {
    return `That's the wrong site — you're on ${brand}. You need to open the 1xBET registration link I already sent you with our promo code — not ${brand}. Open my link from this chat in Chrome and register there.`;
  }
  // CM / MG / DJ / MA / FR markets
  return `Ce n'est pas la bonne plateforme — tu es sur ${brand}. Il faut ouvrir le lien d'inscription 1xBET que je t'ai déjà envoyé avec notre code promo, pas ${brand}. Rouvre mon lien depuis ce chat dans Chrome et inscris-toi là.`;
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

/**
 * Deposit UI open (Dépôt / Confirmer / MVola…) — in progress, NOT a balance proof.
 * Must win over generic «deposit» keyword → deposit_balance mis-class.
 */
export function looksLikeDepositFormInProgress(text: string): boolean {
  const t = fold(text);
  if (!t || looksLikeMobileMoneySms(text)) {
    return false;
  }
  // Funded wallet screen: Solde/Balance without Confirmer + wallet picker.
  if (/\b(solde|balance)\b/i.test(t) && !/\bconfirmer\b/i.test(t)) {
    return false;
  }
  const depositUi =
    /\b(d[eé]p[oô]t|depot|deposit|faire un d[eé]p[oô]t)\b/i.test(t) ||
    /\b(confirmer|confirm)\b/i.test(t);
  const walletUi =
    /\b(mvola|orange\s*money|airtel(\s*money)?|mobile\s*money|mtn\s*momo)\b/i.test(t) ||
    /\b(choisir|methode|m[eé]thode|paiement|payment)\b/i.test(t);
  const phoneField = /\b(0\d{8,10}|\+261\d{8,9}|num[eé]ro|telephone|t[eé]l[eé]phone)\b/i.test(
    t,
  );
  return depositUi && (walletUi || (phoneField && /\bconfirmer\b/i.test(t)));
}

export function looksLikePlatformBalance(text: string): boolean {
  const t = fold(text);
  if (!t || looksLikeMobileMoneySms(text)) {
    return false;
  }
  // Open deposit form ≠ funded balance.
  if (looksLikeDepositFormInProgress(text)) {
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

  // Before «loading stuck» — sports UI of 256bet/Bet261 is not a Chrome/refresh issue.
  if (looksLikeWrongBettingBrand(raw)) {
    const foreignBrand = extractWrongBettingBrandLabel(raw);
    return {
      scene: "wrong_betting_brand",
      reason: `wrong bookmaker UI (${foreignBrand ?? "foreign"}) — need our 1xBET link`,
      foreignBrand,
    };
  }

  if (looksLikeSiteLoadingStuck(raw)) {
    return { scene: "site_loading_stuck", reason: "registration UI stuck/loading" };
  }

  if (looksLikeDepositFormInProgress(raw)) {
    return {
      scene: "deposit_form",
      reason: "deposit form open (Dépôt/Confirmer) — not balance proof yet",
    };
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
