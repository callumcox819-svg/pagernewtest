import type { PagerMessage } from "./pager-client.js";
import { isPositiveMessageReaction } from "./message-attachments.js";
import {
  type EgIntent,
  classifyEgIntent,
  isDepositConfirmed,
  isEgDepositTierChoice,
  isEgJoinOrRegistrationQuestion,
  isFunnelPositiveReaction,
  isReadyForRegistration,
  isRegistrationConfirmed,
  isRegistrationHelpRequest,
  isRegistrationPending,
  wantsDetailsAfterIntro,
  wantsRegistrationLink,
} from "./eg-intent.js";
import { registrationHelpScriptKeys, registrationLinkScriptKeys } from "./funnel-common.js";

export const EG_SCRIPT_SNIPPETS: Record<string, string> = {
  "01_intro": "إنت من مصر",
  "02_how_it_works": "تمام كده",
  "03_egp_table": "55 جنيه",
  "04_registration": "EG011",
  "05_link": "tinyurl.com",
  "06_deposit": "الأخضر",
  "07_game_id": "يبدأ ب 17",
  "09_tg_invite": "تليجرام",
  "10_tg_link": "t.me/+",
};

export const EG_SCRIPT_SEARCH_NEEDLES: Record<string, string[]> = {
  "01_intro": ["إنت من مصر", "انت من مصر", "دخل إضافي", "أنا بساعد الناس"],
  "02_how_it_works": ["الشغل بيمشي", "كود eg011", "من 365", "1100 جنيه"],
  "03_egp_table": ["55 جنيه", "110 جنيه", "إيه اللي يناسبك"],
  "04_registration": [
    "هبعتلك لينك",
    "لينك التسجيل",
    "اختار الدولة",
    "استخدم كود الترويج",
    "google chrome",
  ],
  "05_link": ["tinyurl.com/egypt0011", "tinyurl.com", "egypt0011"],
  "06_deposit": ["الزر الأخضر", "ابعتلي سكرين واضح يظهر الرصيد"],
  "07_game_id": ["يبدأ بـ 17", "يبدأ ب 17", "رقم العميل"],
  "09_tg_invite": ["انضم لقناتنا الخاصة على تليجرام", "قناتنا الخاصة على تليجرام"],
  "10_tg_link": ["t.me/+t7iys46b2ls2ywrk", "t7iys46b2ls2ywrk"],
};

export const EG_SCRIPT_EXCLUDE_SNIPPETS: Record<string, string[]> = {
  "04_registration": ["تمام كده", "55 جنيه", "110 جنيه"],
  "05_link": ["eg011", "هبعتلك اللينك", "55 جنيه"],
  "02_how_it_works": ["eg011", "tinyurl.com"],
  "03_egp_table": ["eg011", "tinyurl.com", "هبعتلك اللينك"],
};

export const EG_FOLDER_NAME_HINTS = ["егип", "egypt", "hapka", "mahmoud", "مصر"];
export const EG_REG_SEND_KEYS = new Set(["04_registration", "05_link"]);
export const EG_EXPLAIN_SEND_KEYS = new Set(["02_how_it_works", "03_egp_table"]);

export function scriptSnippet(key: string): string {
  return EG_SCRIPT_SNIPPETS[key] ?? "";
}

export function scriptSearchNeedles(key: string): string[] {
  return EG_SCRIPT_SEARCH_NEEDLES[key] ?? [scriptSnippet(key)].filter(Boolean);
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

export function egScriptSentInHistory(outgoingTexts: string[], scriptKey: string): boolean {
  return scriptSearchNeedles(scriptKey).some((needle) => scriptSentInHistory(outgoingTexts, needle));
}

export function explainScriptsSentInHistory(outgoingTexts: string[]): boolean {
  return (
    egScriptSentInHistory(outgoingTexts, "02_how_it_works") ||
    egScriptSentInHistory(outgoingTexts, "03_egp_table")
  );
}

function explainScriptKeys(): string[] {
  return ["02_how_it_works", "03_egp_table"];
}

export function regLinkSentInHistory(outgoingTexts: string[]): boolean {
  if (egScriptSentInHistory(outgoingTexts, "05_link")) {
    return true;
  }
  const blob = outgoingTexts.join("\n").toLowerCase();
  // Do NOT treat bare EG011 as the link — it appears in 02_how_it_works and 04_registration.
  return blob.includes("tinyurl.com") || blob.includes("egypt0011");
}

export function egRegistrationInstructionsSentInHistory(outgoingTexts: string[]): boolean {
  if (egScriptSentInHistory(outgoingTexts, "04_registration")) {
    return true;
  }
  const blob = outgoingTexts.join("\n").toLowerCase();
  return (
    blob.includes("هبعتلك لينك") ||
    blob.includes("لينك التسجيل") ||
    blob.includes("اختار الدولة")
  );
}

export function depositSentInHistory(outgoingTexts: string[]): boolean {
  if (egScriptSentInHistory(outgoingTexts, "06_deposit")) {
    return true;
  }
  const blob = outgoingTexts.join("\n").toLowerCase();
  return blob.includes("الزر الأخضر") || blob.includes("يظهر الرصيد للتأكيد");
}

export function gameIdSentInHistory(outgoingTexts: string[]): boolean {
  return egScriptSentInHistory(outgoingTexts, "07_game_id");
}

export function tgInviteSentInHistory(outgoingTexts: string[]): boolean {
  if (egScriptSentInHistory(outgoingTexts, "09_tg_invite")) {
    return true;
  }
  if (egScriptSentInHistory(outgoingTexts, "10_tg_link")) {
    return true;
  }
  const blob = outgoingTexts.join("\n").toLowerCase();
  return blob.includes("t.me/+t7iys46b2ls2ywrk") || blob.includes("قناتنا الخاصة على تليجرام");
}

function tgScriptKeys(): string[] {
  return ["09_tg_invite", "10_tg_link"];
}

function stepForOutgoingText(text: string): number {
  const t = text.toLowerCase();
  if (t.includes("t.me/+t7iys46b2ls2ywrk") || t.includes("t.me/+")) {
    return 9;
  }
  if (t.includes("قناتنا الخاصة على تليجرام") || t.includes("انضم لقناتنا")) {
    return 8;
  }
  if (t.includes("الزر الأخضر") || t.includes("يظهر الرصيد للتأكيد")) {
    return 7;
  }
  if (t.includes("يبدأ بـ 17") || t.includes("يبدأ ب 17") || t.includes("رقم العميل")) {
    return 6;
  }
  if (t.includes("tinyurl.com") || t.includes("egypt0011")) {
    return 4;
  }
  if (
    t.includes("هبعتلك لينك") ||
    t.includes("لينك التسجيل") ||
    t.includes("اختار الدولة") ||
    t.includes("استخدم كود الترويج")
  ) {
    return 3;
  }
  if (t.includes("الشغل بيمشي") || t.includes("365") || t.includes("1100")) {
    return 2;
  }
  if (t.includes("إنت من مصر") || t.includes("انت من مصر") || t.includes("أهلاً") || t.includes("اهلا")) {
    return 1;
  }
  return 0;
}

function isOutgoingDelivered(message: PagerMessage): boolean {
  if (!message.text?.trim()) {
    return false;
  }
  const direction = (message.messageDirection ?? "").toLowerCase();
  if (direction !== "outgoing" && direction !== "out") {
    return false;
  }
  return Boolean(message.isDelivered || message.facebookMessageId);
}

export function inferStepFromThread(messages: PagerMessage[]): number {
  let step = 0;
  for (const message of messages) {
    if (!isOutgoingDelivered(message)) {
      continue;
    }
    step = Math.max(step, stepForOutgoingText((message.text || "").trim()));
  }
  return step;
}

export function funnelStepFromScriptGaps(outgoingTexts: string[], storedStep = 0): number {
  let step = Math.max(storedStep, 0);
  if (!egScriptSentInHistory(outgoingTexts, "01_intro")) {
    return 0;
  }
  step = Math.max(step, 1);
  if (!explainScriptsSentInHistory(outgoingTexts)) {
    return Math.min(step, 1);
  }
  step = Math.max(step, 2);
  if (!regLinkSentInHistory(outgoingTexts)) {
    return Math.min(step, 2);
  }
  step = Math.max(step, 3);
  if (!depositSentInHistory(outgoingTexts)) {
    return Math.min(step, 5);
  }
  step = Math.max(step, 6);
  if (!gameIdSentInHistory(outgoingTexts)) {
    return Math.min(step, 6);
  }
  step = Math.max(step, 7);
  if (!tgInviteSentInHistory(outgoingTexts)) {
    return Math.min(step, 7);
  }
  return Math.max(step, 9);
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

export function regSendTriggersInProgress(scriptKeys: string[]): boolean {
  return scriptKeys.some((key) => EG_REG_SEND_KEYS.has(key));
}

export function egFunnelNeedsContinuation(customerText: string, outgoingTexts: string[]): boolean {
  const introSent = egScriptSentInHistory(outgoingTexts, "01_intro");
  const explainSent = explainScriptsSentInHistory(outgoingTexts);
  const linkSent = regLinkSentInHistory(outgoingTexts);
  const depositSent = depositSentInHistory(outgoingTexts);
  const gameIdSent = gameIdSentInHistory(outgoingTexts);
  const tgSent = tgInviteSentInHistory(outgoingTexts);
  const t = (customerText || "").trim();

  if (!introSent) {
    return Boolean(t);
  }
  if (!explainSent) {
    return (
      Boolean(t) ||
      wantsDetailsAfterIntro(customerText) ||
      isReadyForRegistration(customerText) ||
      isEgJoinOrRegistrationQuestion(customerText)
    );
  }
  if (!linkSent) {
    return (
      Boolean(t) ||
      isEgJoinOrRegistrationQuestion(customerText) ||
      isEgDepositTierChoice(customerText) ||
      isReadyForRegistration(customerText) ||
      isRegistrationHelpRequest(customerText) ||
      wantsRegistrationLink(customerText)
    );
  }
  if (!depositSent) {
    return (
      isRegistrationConfirmed(customerText) ||
      isRegistrationPending(customerText) ||
      isRegistrationHelpRequest(customerText) ||
      Boolean(t)
    );
  }
  if (!gameIdSent) {
    return (
      isDepositConfirmed(customerText) ||
      /\b(17\d{6,}|16\d{6,})\b/.test(customerText) ||
      isEgJoinOrRegistrationQuestion(customerText) ||
      isRegistrationHelpRequest(customerText) ||
      wantsRegistrationLink(customerText) ||
      isReadyForRegistration(customerText) ||
      Boolean(t)
    );
  }
  if (!tgSent) {
    return (
      isDepositConfirmed(customerText) ||
      /\b(17\d{6,}|16\d{6,})\b/.test(customerText) ||
      isReadyForRegistration(customerText) ||
      Boolean(t)
    );
  }
  return false;
}

function shouldSendDepositScript(
  text: string,
  effectiveStep: number,
  outgoingTexts: string[],
  options?: { hasImage?: boolean },
): boolean {
  if (!regLinkSentInHistory(outgoingTexts)) {
    return false;
  }
  if (isRegistrationConfirmed(text) || isRegistrationPending(text) || options?.hasImage) {
    return true;
  }
  return effectiveStep >= 3 && !depositSentInHistory(outgoingTexts);
}

function positiveSignal(text: string, intent: EgIntent, effectiveStep: number): boolean {
  return (
    isFunnelPositiveReaction(text, effectiveStep) ||
    intent === "positive" ||
    intent === "ready" ||
    intent === "interested"
  );
}

function wantsExplain(text: string, intent: EgIntent, effectiveStep: number): boolean {
  return (
    wantsDetailsAfterIntro(text) ||
    intent === "question" ||
    (intent === "interested" && effectiveStep >= 1) ||
    positiveSignal(text, intent, effectiveStep)
  );
}

function wantsRegistrationNow(text: string, intent: EgIntent, effectiveStep: number): boolean {
  return (
    wantsRegistrationLink(text) ||
    isReadyForRegistration(text) ||
    isRegistrationPending(text) ||
    isEgDepositTierChoice(text) ||
    intent === "ready" ||
    intent === "positive" ||
    positiveSignal(text, intent, effectiveStep)
  );
}

function isGreeting(text: string): boolean {
  return /^(اهلا|أهلا|اهلاً|أهلاً|مرحبا|مرحباً|السلام|سلام|هاي|هلو|hello|hi)([\s,!.]|$)/i.test(
    (text || "").trim(),
  );
}

function hasUsableFollowUp(text: string): boolean {
  const t = (text || "").trim();
  if (!t) {
    return false;
  }
  return !/(مش مهتم|مش مهتمة|مش عايز|مش عاوز|لا شكرا|لا شكراً|سيبني|بطل|stop|scam)/i.test(t);
}

export function resolveEgFunnelScripts(
  effectiveStep: number,
  text: string,
  intent: EgIntent,
  outgoingTexts: string[],
  options?: { hasImage?: boolean; messageReaction?: string; recentCustomerTexts?: string[] },
): string[] {
  const t = (text || "").trim();
  const out = outgoingTexts;
  const recentTexts = options?.recentCustomerTexts ?? [];
  const introSent = egScriptSentInHistory(out, "01_intro");
  const explainSent = explainScriptsSentInHistory(out);
  const linkSent = regLinkSentInHistory(out);
  const tierChoice =
    isEgDepositTierChoice(t) || recentTexts.some((line) => isEgDepositTierChoice(line));
  const signal = positiveSignal(t, intent, effectiveStep);
  const wantsReg =
    wantsRegistrationNow(t, intent, effectiveStep) ||
    isEgJoinOrRegistrationQuestion(t) ||
    isRegistrationHelpRequest(t);

  if (intent === "declined") {
    return [];
  }

  if (isRegistrationHelpRequest(t) || isEgJoinOrRegistrationQuestion(t)) {
    if (!linkSent && effectiveStep < 3) {
      if (!introSent) {
        return ["01_intro"];
      }
      if (!explainSent) {
        return explainScriptKeys();
      }
      return ["04_registration", "05_link"];
    }
    if (!linkSent) {
      return ["04_registration", "05_link"];
    }
    return [...registrationHelpScriptKeys("EG")];
  }

  if (wantsRegistrationLink(t)) {
    return registrationLinkScriptKeys("EG", regLinkSentInHistory(out));
  }

  if ((explainSent || effectiveStep >= 2) && tierChoice && !linkSent) {
    return ["04_registration", "05_link"];
  }

  if (explainSent && !linkSent && wantsReg) {
    return ["04_registration", "05_link"];
  }

  if (effectiveStep < 1) {
    if (introSent) {
      if (!explainSent && (wantsExplain(t, intent, effectiveStep) || t.length > 0)) {
        return explainScriptKeys();
      }
      if (explainSent && wantsRegistrationNow(t, intent, effectiveStep) && !linkSent) {
        return ["04_registration", "05_link"];
      }
      return [];
    }
    if (
      ["interested", "positive", "ready", "question", "unknown"].includes(intent) ||
      signal ||
      isGreeting(t) ||
      hasUsableFollowUp(t) ||
      t.length > 0
    ) {
      return ["01_intro"];
    }
    return [];
  }

  if (effectiveStep < 3) {
    if (!explainSent && (wantsExplain(t, intent, effectiveStep) || t.length > 0)) {
      return explainScriptKeys();
    }
    if (explainSent && wantsRegistrationNow(t, intent, effectiveStep) && !linkSent) {
      return ["04_registration", "05_link"];
    }
    return [];
  }

  if (effectiveStep < 4) {
    if (isRegistrationConfirmed(t) && linkSent) {
      return shouldSendDepositScript(t, effectiveStep, out, options) ? ["06_deposit"] : [];
    }

    if (!explainSent && wantsExplain(t, intent, effectiveStep)) {
      return explainScriptKeys();
    }

    if (explainSent && wantsRegistrationNow(t, intent, effectiveStep)) {
      if (linkSent) {
        if (shouldSendDepositScript(t, effectiveStep, out, options) || signal || intent === "ready") {
          return depositSentInHistory(out) ? [] : ["06_deposit"];
        }
        return [];
      }
      return ["04_registration", "05_link"];
    }
    if (linkSent && !depositSentInHistory(out) && (signal || intent === "joined" || options?.hasImage)) {
      return ["06_deposit"];
    }
    return [];
  }

  if (isRegistrationPending(t) && !linkSent) {
    return ["04_registration", "05_link"];
  }

  if (effectiveStep < 7) {
    if (
      linkSent &&
      !depositSentInHistory(out) &&
      (isRegistrationConfirmed(t) ||
        isRegistrationPending(t) ||
        intent === "joined" ||
        options?.hasImage ||
        signal ||
        intent === "ready" ||
        intent === "positive")
    ) {
      return ["06_deposit"];
    }
    if (!linkSent && wantsRegistrationNow(t, intent, effectiveStep)) {
      return ["04_registration", "05_link"];
    }
    return [];
  }

  if (
    depositSentInHistory(out) &&
    !gameIdSentInHistory(out) &&
    (isDepositConfirmed(t) ||
      intent === "deposit_done" ||
      intent === "image_only" ||
      intent === "game_id_text" ||
      intent === "positive" ||
      intent === "ready" ||
      options?.hasImage ||
      isPositiveMessageReaction(options?.messageReaction))
  ) {
    return ["07_game_id"];
  }

  if (effectiveStep < 8 && intent === "game_id_text") {
    if (!gameIdSentInHistory(out)) {
      return ["07_game_id"];
    }
  }

  if (
    gameIdSentInHistory(out) &&
    !tgInviteSentInHistory(out) &&
    (intent === "game_id_text" ||
      intent === "positive" ||
      intent === "ready" ||
      intent === "deposit_done" ||
      intent === "image_only" ||
      intent === "joined" ||
      isDepositConfirmed(t) ||
      isPositiveMessageReaction(options?.messageReaction) ||
      options?.hasImage ||
      /\b(17\d{6,}|16\d{6,})\b/.test(t))
  ) {
    return tgScriptKeys();
  }

  if (!linkSent && explainSent && wantsReg) {
    return ["04_registration", "05_link"];
  }

  if (!introSent && !linkSent && (intent === "interested" || signal || isGreeting(t) || hasUsableFollowUp(t))) {
    return ["01_intro"];
  }

  if (introSent && !explainSent && !linkSent && t.length > 0) {
    return explainScriptKeys();
  }

  if (
    effectiveStep >= 6 &&
    depositSentInHistory(out) &&
    !gameIdSentInHistory(out) &&
    !t &&
    (options?.hasImage ||
      isPositiveMessageReaction(options?.messageReaction) ||
      intent === "positive" ||
      intent === "ready")
  ) {
    return ["07_game_id"];
  }

  if (
    effectiveStep >= 2 &&
    !linkSent &&
    (isRegistrationHelpRequest(t) ||
      isEgJoinOrRegistrationQuestion(t) ||
      wantsRegistrationLink(t) ||
      wantsReg ||
      signal)
  ) {
    return ["04_registration", "05_link"];
  }

  if (
    linkSent &&
    (isRegistrationHelpRequest(t) || isEgJoinOrRegistrationQuestion(t) || wantsRegistrationLink(t))
  ) {
    return [...registrationHelpScriptKeys("EG")];
  }

  if (
    introSent &&
    !explainSent &&
    !linkSent &&
    (intent === "interested" || intent === "ready" || signal || isGreeting(t) || t.length > 0)
  ) {
    return explainScriptKeys();
  }

  return [];
}

const EG_REG_BUNDLE = ["04_registration", "05_link"] as const;
const EG_TG_BUNDLE = ["09_tg_invite", "10_tg_link"] as const;
const EG_TG_SEND_KEYS = new Set(["09_tg_invite", "10_tg_link"]);

/** One funnel stage per customer message — explain + registration text/link go together. */
export function limitEgScriptsForCustomerTurn(
  scriptKeys: string[],
  outgoingTexts: string[],
): string[] {
  if (!scriptKeys.length) {
    return scriptKeys;
  }
  if (
    scriptKeys.includes("01_intro") &&
    !egScriptSentInHistory(outgoingTexts, "01_intro")
  ) {
    return ["01_intro"];
  }
  if (
    scriptKeys.some((key) => EG_EXPLAIN_SEND_KEYS.has(key)) &&
    !explainScriptsSentInHistory(outgoingTexts)
  ) {
    return ["02_how_it_works", "03_egp_table"];
  }
  if (scriptKeys.some((key) => EG_REG_SEND_KEYS.has(key))) {
    const instructionsSent = egRegistrationInstructionsSentInHistory(outgoingTexts);
    const linkSent = regLinkSentInHistory(outgoingTexts);
    if (!instructionsSent) {
      return [...EG_REG_BUNDLE];
    }
    if (!linkSent) {
      return ["05_link"];
    }
    return [];
  }
  if (scriptKeys.some((key) => EG_TG_SEND_KEYS.has(key))) {
    if (!tgInviteSentInHistory(outgoingTexts)) {
      return [...EG_TG_BUNDLE];
    }
    return [];
  }
  return [scriptKeys[0]!];
}

export function egAllowsMultiSend(scriptKeys: string[]): boolean {
  if (scriptKeys.includes("01_intro")) {
    return true;
  }
  if (scriptKeys.some((key) => EG_EXPLAIN_SEND_KEYS.has(key))) {
    return true;
  }
  if (scriptKeys.some((key) => EG_TG_SEND_KEYS.has(key))) {
    return true;
  }
  return scriptKeys.some((key) => EG_REG_SEND_KEYS.has(key));
}

export function classifyEgMessage(
  text: string,
  options?: {
    hasImage?: boolean;
    funnelStep?: number;
    messageReaction?: string;
  },
): EgIntent {
  return classifyEgIntent(text, options);
}
