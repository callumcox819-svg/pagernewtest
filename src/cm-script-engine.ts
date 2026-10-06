import type { PagerMessage } from "./pager-client.js";
import {
  isCustomerSaysNotRegisteredYet,
  isLinkAccessProblemMessage,
  looksLikeBrokenLinkScreenshot,
  recentTextsIndicateNotRegistered,
} from "./customer-clarity.js";
import { registrationResendScriptKeys, customerAgreedAfterOfferTable } from "./funnel-common.js";
import {
  type CmIntent,
  classifyCmIntent,
  isAgeAnswer,
  isRegistrationBlocked,
  isClientReadyPhrase,
  isDepositTierChoice,
  isFunnelPositiveReaction,
  isCmProfitFigure,
  isCmRegistrationHelpRequest,
  isReadyForRegistration,
  isRegistrationAccountQuestion,
  isRegistrationConfirmed,
  isRegistrationPending,
  wantsDetailsAfterIntro,
  wantsRegistrationLink,
} from "./cm-intent.js";

/** Resend link + Chrome + Wi‑Fi tip when the short link will not load. */
export function cmLinkTroubleHelpScripts(includeLinkResend = true): string[] {
  return includeLinkResend
    ? ["06_link", "07_chrome", "07_mtn_tip"]
    : ["07_chrome", "07_mtn_tip"];
}

function cmNeedsLinkTroubleHelp(
  text: string,
  options?: { hasImage?: boolean },
): boolean {
  const t = (text || "").trim();
  if (isLinkAccessProblemMessage(t) || isRegistrationBlocked(t) || looksLikeBrokenLinkScreenshot(t)) {
    return true;
  }
  // Caption «envoie encore le lien» + screenshot of the failed load.
  if (options?.hasImage && wantsRegistrationLink(t)) {
    return true;
  }
  return false;
}

export const CM_SCRIPT_SNIPPETS: Record<string, string> = {
  "01_intro": "Tu es du Cameroun",
  "01_intro_2": "L'IA analyse",
  "01_intro_3": "Mon équipe cumule",
  "02_age": "Quel âge avez-vous",
  "03_steps": "voici comment ça fonctionne",
  "04_tier": "140 000 CFA",
  "05_registration": "Je vais vous envoyer un lien d'inscription spécial",
  "06_link": "tinyurl.com/CMR056",
  "07_chrome": "Copiez ce lien",
  "07_mtn_tip": "ne s'ouvre pas sur MTN",
  "08_game_id": "commence par +",
  "09_deposit": "bouton vert",
  "10_tg_invite": "canal Telegram privé",
  "11_tg_link": "XtIY04zvcVw2YzZi",
};

export const CM_SCRIPT_SEARCH_NEEDLES: Record<string, string[]> = {
  "01_intro": ["tu es du cameroun", "bonjour ! tu es du cameroun", "bonjour !tu es du cameroun"],
  "01_intro_2": [
    "l'ia analyse de grands volumes",
    "l ia analyse de grands volumes",
  ],
  "01_intro_3": [
    "mon équipe cumule",
    "mon equipe cumule",
    "ans d'expérience sur le terrain",
    "ans d'experience sur le terrain",
  ],
  "02_age": ["quel âge", "quel age", "age avez-vous", "age as-tu"],
  "03_steps": [
    "voici comment ça fonctionne",
    "d'accord, voici comment",
    "crée ton compte casino",
    "cree ton compte casino",
    "dépôt minimum de 1 000",
  ],
  "04_tier": [
    "140 000 cfa",
    "190 000 cfa",
    "240 000 cfa",
    "290 000 cfa",
    "340 000 cfa",
    "1000 cfa - 140 000",
    "1500 cfa - 190 000",
    "2000 cfa - 240 000",
    "2500 cfa - 290 000",
    "3000 cfa - 340 000",
    "1 000 cfa — 140 000",
    "1 000 cfa - 140 000",
    "que vas-tu choisir",
    "tu choisis quoi",
    "voici ce que tu peux obtenir",
    "investissement → gain",
    "bénéfice",
  ],
  "05_registration": [
    "je vais vous envoyer un lien d'inscription",
    "lien d'inscription spécial",
    "lien d'inscription special",
    "utilisez le code promotionnel",
    "une fois inscrit, envoyez-moi",
  ],
  "06_link": ["tinyurl.com/cmr056", "https://tinyurl.com/cmr056", "cmr056"],
  "07_chrome": ["copiez ce lien et collez-le", "navigateur google chrome"],
  "07_mtn_tip": ["ne s'ouvre pas sur mtn", "essayez le wi-fi", "autre opérateur mobile"],
  "08_game_id": [
    "commence par +",
    "commence par 17",
    "commence par 18",
    "numéro de joueur",
    "numero de joueur",
    "identifiant de jeu",
  ],
  "09_deposit": ["bouton vert", "déposer", "deposer", "mtn", "orange"],
  "10_tg_invite": ["canal telegram privé", "canal telegram prive"],
  "11_tg_link": ["xtiy04zvcvw", "t.me/"],
};

export const CM_SCRIPT_EXCLUDE_SNIPPETS: Record<string, string[]> = {
  // Script 1 and script 2 share the closing paragraph. Match each preset by its own opening.
  "01_intro": ["mon équipe cumule", "mon equipe cumule"],
  "01_intro_2": ["mon équipe cumule", "mon equipe cumule", "tu es du cameroun"],
  "01_intro_3": ["tu es du cameroun", "je souhaite te montrer"],
  // Never pick the short promo-only scrap as the full registration preset.
  "05_registration": [
    "voici comment ça fonctionne",
    "d'accord, voici comment",
    "crée ton compte casino",
    "indiquez le code promotionnel",
  ],
  "06_link": [
    "voici comment ça fonctionne",
    "d'accord, voici comment",
    "je vais vous envoyer",
    "code promotionnel",
    "cash056",
  ],
  "07_chrome": [
    "voici comment ça fonctionne",
    "que vas-tu choisir",
    "je vais vous envoyer",
    "cash056",
    "code promotionnel",
  ],
  "03_steps": [
    "cash056",
    "cmr056",
    "camerun01",
    "google chrome",
    "140 000 cfa",
    "que vas-tu choisir",
    "voici ce que tu peux obtenir",
  ],
  "04_tier": [
    "cash056",
    "cmr056",
    "camerun01",
    "google chrome",
    "voici comment ça fonctionne",
    "voici comment ca fonctionne",
    "d'accord, voici comment",
  ],
};

export const CM_FOLDER_NAME_HINTS = [
  "камерун",
  "cameroon",
  "cameroun",
  "cm",
  "cash056",
  "cmr056",
];

/** Initial reg send: full instructions + link + Chrome tip (as in Pager saved presets). */
export const CM_REG_SEND_KEYS = new Set(["05_registration", "06_link", "07_chrome", "07_mtn_tip"]);
export const CM_INTRO_SEND_KEYS = new Set(["01_intro", "01_intro_3"]);

const CM_INTRO_BUNDLE = ["01_intro", "01_intro_3"] as const;
/** Must match the 3-bubble Pager preset: reg text → URL → Chrome. */
const CM_REG_BUNDLE = ["05_registration", "06_link", "07_chrome"] as const;

/** Full registration instructions preset — not a one-line CASH056 reminder. */
export function isFullCmRegistrationPreset(text: string): boolean {
  const body = (text || "").trim().toLowerCase();
  if (body.length < 120) {
    return false;
  }
  const hasIntro =
    body.includes("je vais vous envoyer") ||
    body.includes("lien d'inscription spécial") ||
    body.includes("lien d'inscription special");
  const hasPromo = body.includes("cash056") || body.includes("code promotionnel");
  const hasChromeHint = body.includes("google chrome") || body.includes("inscription");
  // Reject short promo-only scraps.
  if (/indiquez le code promotionnel/i.test(body) && body.length < 160) {
    return false;
  }
  return hasIntro && hasPromo && hasChromeHint;
}

/** Next unfinished intro bubble — one per customer turn. */
function nextCmIntroScript(outgoingTexts: string[]): string[] {
  const remaining = CM_INTRO_BUNDLE.filter((key) => !cmScriptSentInHistory(outgoingTexts, key));
  return remaining.length ? [remaining[0]!] : [];
}

export function scriptSnippet(key: string): string {
  return CM_SCRIPT_SNIPPETS[key] ?? "";
}

export function scriptSearchNeedles(key: string): string[] {
  return CM_SCRIPT_SEARCH_NEEDLES[key] ?? [scriptSnippet(key)].filter(Boolean);
}

export function cmScriptSentInHistory(outgoingTexts: string[], scriptKey: string): boolean {
  if (scriptKey === "01_intro_2") {
    const blob = outgoingTexts.join("\n").toLowerCase();
    if (blob.includes("l'ia analyse") || blob.includes("l ia analyse")) {
      return true;
    }
  }
  if (scriptKey === "01_intro_3") {
    const blob = outgoingTexts.join("\n").toLowerCase();
    // Script 1 ends with the same «gagner ensemble» paragraph. Only the team opening counts.
    return (
      blob.includes("mon équipe cumule") ||
      blob.includes("mon equipe cumule") ||
      blob.includes("ans d'expérience sur le terrain") ||
      blob.includes("ans d'experience sur le terrain")
    );
  }
  if (scriptKey === "04_tier") {
    return tierSentInHistory(outgoingTexts);
  }
  if (scriptKey === "05_registration") {
    return cmRegistrationInstructionsSentInHistory(outgoingTexts);
  }
  return scriptSearchNeedles(scriptKey).some((needle) => scriptSentInHistory(outgoingTexts, needle));
}

export function tierSentInHistory(outgoingTexts: string[]): boolean {
  const blob = outgoingTexts.join("\n").toLowerCase();
  return (
    blob.includes("140 000 cfa") ||
    blob.includes("190 000 cfa") ||
    blob.includes("240 000 cfa") ||
    blob.includes("290 000 cfa") ||
    blob.includes("340 000 cfa") ||
    blob.includes("1000 cfa - 140") ||
    blob.includes("1500 cfa - 190") ||
    blob.includes("2000 cfa - 240") ||
    blob.includes("2500 cfa - 290") ||
    blob.includes("3000 cfa - 340") ||
    blob.includes("que vas-tu choisir") ||
    blob.includes("tu choisis quoi") ||
    blob.includes("voici ce que tu peux obtenir") ||
    blob.includes("investissement → gain") ||
    blob.includes("investissement -> gain") ||
    blob.includes("obtenir avec mon aide")
  );
}

export function stepsSentInHistory(outgoingTexts: string[]): boolean {
  const blob = outgoingTexts.join("\n").toLowerCase();
  return (
    blob.includes("voici comment ça fonctionne") ||
    blob.includes("voici comment ca fonctionne") ||
    blob.includes("d'accord, voici comment") ||
    blob.includes("d accord, voici comment") ||
    ((blob.includes("crée ton compte casino") || blob.includes("cree ton compte casino")) &&
      blob.includes("dépôt minimum"))
  );
}

function ageQuestionSentInHistory(outgoingTexts: string[]): boolean {
  const blob = outgoingTexts.join("\n").toLowerCase();
  return (
    blob.includes("quel âge") ||
    blob.includes("quel age") ||
    blob.includes("age avez-vous") ||
    blob.includes("age as-tu") ||
    blob.includes("âge avez") ||
    blob.includes("age as tu")
  );
}

export function cmAgeQuestionSentInHistory(outgoingTexts: string[]): boolean {
  return ageQuestionSentInHistory(outgoingTexts);
}

export function scriptSentInHistory(outgoingTexts: string[], snippet: string): boolean {
  const needle = snippet.trim().toLowerCase();
  if (!needle) {
    return false;
  }
  return outgoingTexts.some((text) => {
    const body = text.toLowerCase();
    return body.includes(needle) || needle.includes(body.slice(0, 80));
  });
}

export function regLinkSentInHistory(outgoingTexts: string[]): boolean {
  if (cmScriptSentInHistory(outgoingTexts, "06_link")) {
    return true;
  }
  const blob = outgoingTexts.join("\n").toLowerCase();
  return (
    blob.includes("cmr056") ||
    blob.includes("camerun01") ||
    blob.includes("tinyurl.com/cmr") ||
    blob.includes("tinyurl.com/camerun")
  );
}

export function cmRegistrationInstructionsSentInHistory(outgoingTexts: string[]): boolean {
  const blob = outgoingTexts.join("\n").toLowerCase();
  if (!blob.includes("cash056")) {
    return false;
  }
  return (
    blob.includes("je vais vous envoyer") ||
    blob.includes("je vais vous envoyer") ||
    blob.includes("je vous envoie le lien") ||
    blob.includes("je t'envoie le lien") ||
    blob.includes("lien d'inscription spécial") ||
    blob.includes("lien d'inscription special") ||
    blob.includes("telecharger l'application") ||
    blob.includes("télécharger l'application") ||
    blob.includes("telecharger l'app") ||
    blob.includes("télécharger l'app")
  );
}

const CM_REGISTRATION_LINK = "https://tinyurl.com/CMR056";

/** Short Chrome reminder only — not the long 05_registration text (also mentions Chrome). */
export function cmMtnTipSentInHistory(outgoingTexts: string[]): boolean {
  if (cmScriptSentInHistory(outgoingTexts, "07_mtn_tip")) {
    return true;
  }
  const blob = outgoingTexts.join("\n").toLowerCase();
  return blob.includes("ne s'ouvre pas sur mtn") || blob.includes("ne s ouvre pas sur mtn");
}

export function cmChromeReminderSentInHistory(outgoingTexts: string[]): boolean {
  return outgoingTexts.some((line) => {
    const lower = line.toLowerCase().trim();
    if (!lower.includes("google chrome")) {
      return false;
    }
    // Registration script embeds "Google Chrome" + "colle" — exclude it.
    if (
      lower.includes("cash056") ||
      lower.includes("code promotionnel") ||
      lower.includes("lien d'inscription") ||
      lower.includes("cmr056") ||
      lower.length > 160
    ) {
      return false;
    }
    return (
      lower.includes("copiez ce lien") ||
      (lower.includes("colle") && lower.includes("navigateur"))
    );
  });
}

function canSendCmRegistration(
  tierSent: boolean,
  tierChoice: boolean,
  linkSent: boolean,
  outgoingTexts: string[],
  customerText = "",
): boolean {
  if (linkSent) {
    return false;
  }
  if (cmRegistrationInstructionsSentInHistory(outgoingTexts) && !regLinkSentInHistory(outgoingTexts)) {
    return true;
  }
  // Steps («comment ça fonctionne») or the legacy money table both count as the offer.
  if (!tierSent && !stepsSentInHistory(outgoingTexts)) {
    return false;
  }
  if (tierChoice) {
    return true;
  }
  const t = customerText.trim();
  if (!t) {
    return false;
  }
  return (
    wantsRegistrationLink(t) ||
    isCmRegistrationHelpRequest(t) ||
    isRegistrationAccountQuestion(t) ||
    isReadyForRegistration(t) ||
    customerAgreedAfterOfferTable(t)
  );
}

/** After tier table: registration only once the client picked 1000 or 1500 CFA. */
function cmReadyForRegAfterTier(
  text: string,
  intent: CmIntent,
  tierSent: boolean,
  tierChoice: boolean,
  linkSent: boolean,
  _signal: boolean,
): boolean {
  if (!tierSent || linkSent) {
    return false;
  }
  if (tierChoice) {
    return true;
  }
  const t = text.trim();
  return (
    wantsRegistrationLink(t) ||
    isCmRegistrationHelpRequest(t) ||
    isRegistrationAccountQuestion(t) ||
    customerAgreedAfterOfferTable(t) ||
    intent === "ready"
  );
}

function cmRegBundleIfEligible(
  tierSent: boolean,
  tierChoice: boolean,
  linkSent: boolean,
  outgoingTexts: string[],
  customerText = "",
): string[] {
  return canSendCmRegistration(tierSent, tierChoice, linkSent, outgoingTexts, customerText)
    ? [...CM_REG_BUNDLE]
    : [];
}

function cmTierReminderIfNeeded(tierSent: boolean, tierChoice: boolean): string[] {
  if (tierSent && !tierChoice) {
    return ["04_tier"];
  }
  return [];
}

export function depositSentInHistory(outgoingTexts: string[]): boolean {
  if (cmScriptSentInHistory(outgoingTexts, "09_deposit")) {
    return true;
  }
  const blob = outgoingTexts.join("\n").toLowerCase();
  return blob.includes("bouton vert") || blob.includes("déposer");
}

export function gameIdSentInHistory(outgoingTexts: string[]): boolean {
  if (cmScriptSentInHistory(outgoingTexts, "08_game_id")) {
    return true;
  }
  const blob = outgoingTexts.join("\n").toLowerCase();
  return (
    blob.includes("commence par +") ||
    blob.includes("commence par 17") ||
    blob.includes("commence par 18") ||
    blob.includes("numéro de joueur") ||
    blob.includes("numero de joueur") ||
    blob.includes("identifiant de jeu")
  );
}

function stepForOutgoingText(text: string): number {
  const t = text.toLowerCase();
  if (t.includes("xtiy04zvcvw") || t.includes("t.me/+")) {
    return 9;
  }
  if (t.includes("canal telegram") && (t.includes("privé") || t.includes("prive"))) {
    return 8;
  }
  if (t.includes("bouton vert") || (t.includes("déposer") && t.includes("mtn"))) {
    return 7;
  }
  if (
    t.includes("commence par +") ||
    t.includes("commence par 17") ||
    t.includes("commence par 18") ||
    t.includes("identifiant de jeu")
  ) {
    return 6;
  }
  if (
    t.includes("cmr056") ||
    t.includes("camerun01") ||
    (t.includes("google chrome") && t.includes("colle"))
  ) {
    return 5;
  }
  if (t.includes("cash056")) {
    return 5;
  }
  if (t.includes("140 000 cfa") || t.includes("190 000 cfa") || t.includes("que vas-tu choisir")) {
    return 4;
  }
  if (
    t.includes("voici comment ça fonctionne") ||
    t.includes("voici comment ca fonctionne") ||
    t.includes("crée ton compte casino") ||
    t.includes("cree ton compte casino")
  ) {
    return 3;
  }
  if (t.includes("quel âge") || t.includes("quel age") || t.includes("age avez-vous")) {
    return 2;
  }
  if (t.includes("mon équipe cumule") || t.includes("mon equipe cumule")) {
    return 1;
  }
  if (t.includes("tu es du cameroun") || t.includes("cameroun")) {
    return 1;
  }
  return 0;
}

export function inferStepFromThread(messages: PagerMessage[]): number {
  let step = 0;
  for (const message of messages) {
    if (!isOutgoingDelivered(message)) {
      continue;
    }
    const text = (message.text || "").trim();
    if (!text) {
      continue;
    }
    step = Math.max(step, stepForOutgoingText(text));
  }
  return step;
}

export function funnelStepFromScriptGaps(
  outgoingTexts: string[],
  storedStep = 0,
): number {
  let step = Math.max(storedStep, 0);
  if (!scriptSentInHistory(outgoingTexts, scriptSnippet("01_intro"))) {
    return 0;
  }
  step = Math.max(step, 1);
  if (!cmScriptSentInHistory(outgoingTexts, "01_intro_3")) {
    return Math.min(step, 1);
  }
  if (!cmScriptSentInHistory(outgoingTexts, "02_age") && !ageQuestionSentInHistory(outgoingTexts)) {
    return Math.min(step, 1);
  }
  step = Math.max(step, 2);
  // Age answer → money table, then wait for a sum or an agreement.
  if (!tierSentInHistory(outgoingTexts)) {
    return Math.min(step, 2);
  }
  step = Math.max(step, 4);
  if (!regLinkSentInHistory(outgoingTexts)) {
    return Math.min(step, 4);
  }
  if (!depositSentInHistory(outgoingTexts)) {
    return Math.min(step, 5);
  }
  return Math.max(step, 6);
}

export function collectOutgoingTexts(messages: PagerMessage[]): string[] {
  const chronological = [...messages].sort(
    (left, right) => Date.parse(left.createdAt ?? "") - Date.parse(right.createdAt ?? ""),
  );
  const texts: string[] = [];
  for (const message of chronological) {
    if (!isOutgoingDelivered(message)) {
      continue;
    }
    const text = (message.text || "").trim();
    if (text) {
      texts.push(text);
    }
  }
  return texts;
}

function positiveSignal(
  text: string,
  intent: CmIntent,
  effectiveStep: number,
): boolean {
  return (
    isFunnelPositiveReaction(text, effectiveStep) ||
    intent === "positive" ||
    intent === "ready" ||
    intent === "interested"
  );
}

/** Positive advance for CM early funnel (2nd intro / age) — not bare noise. */
function cmPositiveAdvance(
  text: string,
  intent: CmIntent,
  effectiveStep: number,
): boolean {
  if (isClientReadyPhrase(text) || wantsDetailsAfterIntro(text)) {
    return true;
  }
  return positiveSignal(text, intent, effectiveStep);
}

function cmAgeJustGiven(text: string): boolean {
  const t = (text || "").trim();
  return isAgeAnswer(t) || /^\d{1,2}\s*ans?\b/i.test(t);
}

/** «19» + «Ans» in separate bubbles still counts as an age answer. */
export function cmAgeGivenFromThread(
  text: string,
  recentCustomerTexts: string[] = [],
): boolean {
  if (cmAgeJustGiven(text)) {
    return true;
  }
  const recent = [...recentCustomerTexts.slice(-5), text]
    .map((line) => (line || "").trim())
    .filter(Boolean);
  const joined = recent.join(" ");
  if (cmAgeJustGiven(joined)) {
    return true;
  }
  if (recent.some((line) => isAgeAnswer(line))) {
    return true;
  }
  const hasAgeNumber = recent.some(
    (line) => /^\d{1,2}$/.test(line) && isAgeAnswer(line),
  );
  const hasAnsWord = recent.some((line) => /^ans?\.?$/i.test(line));
  if (hasAgeNumber && hasAnsWord) {
    return true;
  }
  // Latest is «Ans», a recent bubble was bare «19» / «20».
  if (/^ans?\.?$/i.test((text || "").trim())) {
    return recentCustomerTexts.some((line) => {
      const t = (line || "").trim();
      return /^\d{1,2}$/.test(t) && isAgeAnswer(t);
    });
  }
  return false;
}

export function cmAgeQuestionSent(outgoingTexts: string[]): boolean {
  return (
    cmScriptSentInHistory(outgoingTexts, "02_age") || ageQuestionSentInHistory(outgoingTexts)
  );
}

/** After script 4: a deposit amount or a plain agreement, in any common wording. */
export function cmCustomerAcceptedOffer(text: string): boolean {
  const t = (text || "").trim();
  if (!t || isAgeAnswer(t)) {
    return false;
  }
  return (
    isDepositTierChoice(t) ||
    customerAgreedAfterOfferTable(t) ||
    isClientReadyPhrase(t) ||
    isReadyForRegistration(t)
  );
}

export function resolveCmFunnelScripts(
  effectiveStep: number,
  text: string,
  intent: CmIntent,
  outgoingTexts: string[],
  options?: { hasImage?: boolean; messageReaction?: string; recentCustomerTexts?: string[] },
): string[] {
  const out = outgoingTexts;
  const t = (text || "").trim();
  const recentTexts = options?.recentCustomerTexts ?? [];
  const registrationHelp =
    isCmRegistrationHelpRequest(t) || isRegistrationAccountQuestion(t);

  if (intent === "declined") {
    return [];
  }

  const notRegisteredYet =
    isCustomerSaysNotRegisteredYet(t) || recentTextsIndicateNotRegistered(recentTexts);

  const introSent = cmScriptSentInHistory(out, "01_intro");
  const intro3Sent = cmScriptSentInHistory(out, "01_intro_3");
  const ageSent = cmScriptSentInHistory(out, "02_age") || ageQuestionSentInHistory(out);
  const stepsSent = stepsSentInHistory(out);
  const tierSent = tierSentInHistory(out);
  const linkSent = regLinkSentInHistory(out);
  const tierChoice =
    isDepositTierChoice(t) || recentTexts.some((line) => isDepositTierChoice(line));
  const signal = positiveSignal(t, intent, effectiveStep);
  const positive = cmPositiveAdvance(t, intent, effectiveStep);

  // ── Early funnel (strict one script / customer turn) ─────────────────
  // 1) Any first reply → 01_intro only
  // 2) Positive reply → 01_intro_3 only («Mon équipe»)
  // 3) Positive reply → 02_age
  // 4) Age answer → 04_tier (money table), nothing else in that turn
  // 5) Sum or agreement → registration + link
  if (!introSent) {
    if (t.length > 0 || options?.hasImage || options?.messageReaction) {
      return ["01_intro"];
    }
    return [];
  }
  if (!intro3Sent) {
    if (positive) {
      return ["01_intro_3"];
    }
    return [];
  }
  if (!ageSent) {
    if (positive) {
      return ["02_age"];
    }
    return [];
  }
  if (!tierSent) {
    if (cmAgeGivenFromThread(t, recentTexts)) {
      return ["04_tier"];
    }
    return [];
  }
  if (!linkSent && cmCustomerAcceptedOffer(t)) {
    return [...CM_REG_BUNDLE];
  }

  // Broken short-link / black screen / «envoie encore le lien» + screenshot →
  // Chrome + Wi‑Fi help, never player ID.
  if (linkSent && cmNeedsLinkTroubleHelp(t, options)) {
    return cmLinkTroubleHelpScripts(true);
  }

  if (notRegisteredYet) {
    if (!linkSent) {
      return [...CM_REG_BUNDLE];
    }
    return registrationResendScriptKeys("CM", true);
  }

  if (registrationHelp) {
    if (regLinkSentInHistory(out)) {
      return cmLinkTroubleHelpScripts(true);
    }
    const reg = cmRegBundleIfEligible(tierSent, tierChoice, linkSent, out, t);
    if (reg.length) {
      return reg;
    }
    const tierReminder = cmTierReminderIfNeeded(tierSent, tierChoice);
    if (tierReminder.length) {
      return tierReminder;
    }
    return [];
  }

  if (wantsRegistrationLink(t)) {
    if (linkSent) {
      return cmLinkTroubleHelpScripts(true);
    }
    const reg = cmRegBundleIfEligible(tierSent, tierChoice, linkSent, out, t);
    if (reg.length) {
      return reg;
    }
    const tierReminder = cmTierReminderIfNeeded(tierSent, tierChoice);
    if (tierReminder.length) {
      return tierReminder;
    }
    return [];
  }

  if (intent === "game_id_text") {
    if (depositSentInHistory(out) && !gameIdSentInHistory(out)) {
      return ["08_game_id"];
    }
    return [];
  }

  if (tierSent && tierChoice && !linkSent) {
    return [...CM_REG_BUNDLE];
  }

  if (cmReadyForRegAfterTier(t, intent, tierSent, tierChoice, linkSent, signal)) {
    return [...CM_REG_BUNDLE];
  }

  if (tierSent && tierChoice && !linkSent && isRegistrationAccountQuestion(t)) {
    return [...CM_REG_BUNDLE];
  }

  if (linkSent) {
    if (registrationHelp || isRegistrationBlocked(t) || isLinkAccessProblemMessage(t)) {
      return cmLinkTroubleHelpScripts(true);
    }
    if (
      (options?.hasImage || isRegistrationConfirmed(t) || intent === "image_only") &&
      !depositSentInHistory(out) &&
      !cmNeedsLinkTroubleHelp(t, options)
    ) {
      return ["09_deposit"];
    }
    if (isRegistrationConfirmed(t) && !depositSentInHistory(out)) {
      return ["09_deposit"];
    }
    if (
      !depositSentInHistory(out) &&
      (intent === "positive" ||
        intent === "ready" ||
        intent === "interested" ||
        isReadyForRegistration(t) ||
        isClientReadyPhrase(t))
    ) {
      return ["09_deposit"];
    }
    // Game ID only after clear deposit proof — never on link-fail / INSCRIPTION form shots.
    // Bare image_only is handled in tryHandleCustomerImage (OCR); do not auto-ask ID here.
    if (
      depositSentInHistory(out) &&
      !gameIdSentInHistory(out) &&
      !cmNeedsLinkTroubleHelp(t, options) &&
      !wantsRegistrationLink(t) &&
      (intent === "deposit_done" || isRegistrationConfirmed(t))
    ) {
      return ["08_game_id"];
    }
    return [];
  }

  if (effectiveStep >= 4 && tierSent && !linkSent) {
    if (tierChoice || isDepositTierChoice(t)) {
      return [...CM_REG_BUNDLE];
    }
    if (
      wantsRegistrationLink(t) ||
      registrationHelp ||
      isReadyForRegistration(t) ||
      customerAgreedAfterOfferTable(t)
    ) {
      return [...CM_REG_BUNDLE];
    }
  }

  if (effectiveStep < 4) {
    if (tierChoice && tierSent && !linkSent) {
      return [...CM_REG_BUNDLE];
    }
    if (isCmProfitFigure(t) && !linkSent) {
      if (stepsSent) {
        return [];
      }
      if (!tierSent) {
        return ["04_tier"];
      }
      if (!tierChoice) {
        return ["04_tier"];
      }
      return [...CM_REG_BUNDLE];
    }
    if (tierSent && tierChoice && !linkSent) {
      return [...CM_REG_BUNDLE];
    }
    if (tierSent && !stepsSent && !linkSent && t.length > 0 && t.length <= 24) {
      return ["04_tier"];
    }
    return [];
  }

  if (isRegistrationConfirmed(t) && linkSent) {
    if (!depositSentInHistory(out)) {
      return ["09_deposit"];
    }
    return [];
  }

  if (isRegistrationPending(t) && tierSent && tierChoice && !linkSent) {
    return [...CM_REG_BUNDLE];
  }

  if (
    depositSentInHistory(out) &&
    !gameIdSentInHistory(out) &&
    (intent === "deposit_done" ||
      intent === "image_only" ||
      options?.hasImage ||
      isRegistrationConfirmed(t))
  ) {
    return ["08_game_id"];
  }

  if (cmReadyForRegAfterTier(t, intent, tierSent, tierChoice, linkSent, signal)) {
    return [...CM_REG_BUNDLE];
  }

  return [];
}

export function classifyCmMessage(
  text: string,
  options?: {
    hasImage?: boolean;
    funnelStep?: number;
    messageReaction?: string;
  },
): CmIntent {
  return classifyCmIntent(text, options);
}

export function regSendTriggersInProgress(scriptKeys: string[]): boolean {
  return scriptKeys.includes("06_link") || scriptKeys.includes("07_chrome");
}

/** Move to «в процессе» once the registration link (or chrome reminder) went out. */
export function cmStatusMoveAfterSend(sentScriptKeys: string[]): boolean {
  return sentScriptKeys.includes("06_link") || sentScriptKeys.includes("07_chrome");
}

/** Registration link pair can multi-send; intro is one script per customer turn. */
export function limitCmScriptsForCustomerTurn(
  scriptKeys: string[],
  outgoingTexts: string[],
): string[] {
  if (!scriptKeys.length) {
    return scriptKeys;
  }
  const tierPending = scriptKeys.includes("04_tier");
  const regPending = scriptKeys.some((key) => CM_REG_SEND_KEYS.has(key));
  if (tierPending && regPending) {
    return tierSentInHistory(outgoingTexts) ? limitCmScriptsForCustomerTurn(
      scriptKeys.filter((key) => CM_REG_SEND_KEYS.has(key)),
      outgoingTexts,
    ) : ["04_tier"];
  }
  if (scriptKeys.some((key) => CM_INTRO_SEND_KEYS.has(key))) {
    const remaining = CM_INTRO_BUNDLE.filter((key) => !cmScriptSentInHistory(outgoingTexts, key));
    if (remaining.length) {
      // Wait for the next customer reply before 01_intro_3.
      return [remaining[0]!];
    }
  }
  if (scriptKeys.some((key) => CM_REG_SEND_KEYS.has(key))) {
    const instructionsSent = cmRegistrationInstructionsSentInHistory(outgoingTexts);
    const linkSent = regLinkSentInHistory(outgoingTexts);

    // First reg turn: full preset = instructions + link + Chrome tip.
    const isInitialReg =
      scriptKeys.includes("05_registration") ||
      scriptKeys.includes("06_link") ||
      (!linkSent && scriptKeys.every((key) => CM_REG_SEND_KEYS.has(key)));
    if (!linkSent && isInitialReg) {
      if (!instructionsSent) {
        return [...CM_REG_BUNDLE];
      }
      // Instructions already out — finish link + Chrome.
      return ["06_link", "07_chrome"].filter((key) => !cmScriptSentInHistory(outgoingTexts, key));
    }

    // Help / resend: keep Wi‑Fi tip only when the funnel explicitly requested it
    // (broken link / black-screen). Allow resend even if tips were sent earlier.
    const allowMtnTip = scriptKeys.includes("07_mtn_tip");
    if (allowMtnTip) {
      return scriptKeys.filter((key) => CM_REG_SEND_KEYS.has(key));
    }
    const remaining = scriptKeys.filter(
      (key) =>
        CM_REG_SEND_KEYS.has(key) &&
        key !== "07_mtn_tip" &&
        !cmScriptSentInHistory(outgoingTexts, key),
    );
    return remaining.length ? remaining : [];
  }
  return [scriptKeys[0]!];
}

export function cmAllowsMultiSend(scriptKeys: string[]): boolean {
  // Intro is one bubble per turn; only registration instructions+link stay paired.
  return scriptKeys.some((key) => CM_REG_SEND_KEYS.has(key));
}

export { CM_REGISTRATION_LINK };

function isOutgoingDelivered(message: PagerMessage): boolean {
  const direction = (message.messageDirection || "").toLowerCase();
  if (direction !== "outgoing" && direction !== "out") {
    return false;
  }
  return Boolean(message.isDelivered || message.facebookMessageId);
}
