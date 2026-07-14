import type { PagerMessage } from "./pager-client.js";
import { isPositiveMessageReaction } from "./message-attachments.js";
import {
  type EgIntent,
  classifyEgIntent,
  isAppOrBrowserQuestion,
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

/** Matching pager-ai-bot EG snippets (no Telegram handoff auto-send). */
export const EG_SCRIPT_SNIPPETS: Record<string, string> = {
  "01_intro": "إنت من مصر",
  "02_how_it_works": "تمام كده",
  "04_registration": "هبعتلك اللينك دلوقتي",
  "05_link": "tinyurl.com/Egypt0011",
  "06_deposit": "+ الأخضر",
  "07_game_id": "يبدأ ب 17",
  "08_app_or_browser": "ينفع الاتنين",
};

export const EG_SCRIPT_SEARCH_NEEDLES: Record<string, string[]> = {
  "01_intro": ["إنت من مصر", "انت من مصر", "بساعد ناس يعملوا شوية دخل"],
  "02_how_it_works": ["تمام كده", "كود eg011", "365-550", "730-1100"],
  "04_registration": ["هبعتلك اللينك دلوقتي", "جنيه مصري", "كود eg011"],
  "05_link": ["tinyurl.com/egypt0011", "egypt0011"],
  "06_deposit": ["+ الأخضر", "ابعتلي سكرين لما يخلص"],
  "07_game_id": ["يبدأ ب 17", "رقم الحساب"],
  "08_app_or_browser": ["ينفع الاتنين", "تطبيق أو متصفح"],
};

export const EG_SCRIPT_EXCLUDE_SNIPPETS: Record<string, string[]> = {
  "04_registration": ["تمام كده", "هتعمل إيداع"],
  "05_link": ["هبعتلك اللينك", "تمام كده"],
  "02_how_it_works": ["tinyurl.com", "هبعتلك اللينك"],
};

export const EG_FOLDER_NAME_HINTS = [
  "егип",
  "egypt",
  "hapka",
  "hapkatest",
  "mahmoud",
  "مصر",
];
export const EG_REG_SEND_KEYS = new Set(["04_registration", "05_link"]);
export const EG_EXPLAIN_SEND_KEYS = new Set(["02_how_it_works"]);

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
  return egScriptSentInHistory(outgoingTexts, "02_how_it_works");
}

export function regLinkSentInHistory(outgoingTexts: string[]): boolean {
  if (egScriptSentInHistory(outgoingTexts, "05_link")) {
    return true;
  }
  const blob = outgoingTexts.join("\n").toLowerCase();
  return blob.includes("tinyurl.com/egypt0011") || blob.includes("egypt0011");
}

export function egRegistrationInstructionsSentInHistory(outgoingTexts: string[]): boolean {
  if (egScriptSentInHistory(outgoingTexts, "04_registration")) {
    return true;
  }
  const blob = outgoingTexts.join("\n").toLowerCase();
  return blob.includes("هبعتلك اللينك") || blob.includes("جنيه مصري");
}

export function depositSentInHistory(outgoingTexts: string[]): boolean {
  if (egScriptSentInHistory(outgoingTexts, "06_deposit")) {
    return true;
  }
  const blob = outgoingTexts.join("\n").toLowerCase();
  return blob.includes("+ الأخضر") || blob.includes("ابعتلي سكرين لما يخلص");
}

export function gameIdSentInHistory(outgoingTexts: string[]): boolean {
  return egScriptSentInHistory(outgoingTexts, "07_game_id");
}

function stepForOutgoingText(text: string): number {
  const t = text.toLowerCase();
  if (t.includes("يبدأ ب 17") || t.includes("رقم الحساب")) {
    return 7;
  }
  if (t.includes("+ الأخضر") || t.includes("ابعتلي سكرين لما يخلص")) {
    return 6;
  }
  if (t.includes("tinyurl.com/egypt0011") || t.includes("egypt0011")) {
    return 4;
  }
  if (t.includes("هبعتلك اللينك") || t.includes("جنيه مصري")) {
    return 3;
  }
  if (t.includes("تمام كده") || t.includes("365-550") || t.includes("730-1100")) {
    return 2;
  }
  if (t.includes("إنت من مصر") || t.includes("انت من مصر") || t.includes("بساعد ناس")) {
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

/** Matches pager-ai-bot funnel_step_from_script_gaps for geo=eg. */
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
    return Math.min(step, 3);
  }
  step = Math.max(step, 4);
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

export function regSendTriggersInProgress(scriptKeys: string[]): boolean {
  return scriptKeys.some((key) => EG_REG_SEND_KEYS.has(key));
}

export function egFunnelNeedsContinuation(customerText: string, outgoingTexts: string[]): boolean {
  const introSent = egScriptSentInHistory(outgoingTexts, "01_intro");
  const explainSent = explainScriptsSentInHistory(outgoingTexts);
  const linkSent = regLinkSentInHistory(outgoingTexts);
  const depositSent = depositSentInHistory(outgoingTexts);
  const gameIdSent = gameIdSentInHistory(outgoingTexts);
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
      isAppOrBrowserQuestion(customerText) ||
      Boolean(t)
    );
  }
  if (!gameIdSent) {
    return (
      isDepositConfirmed(customerText) ||
      /\b(17\d{6,}|16\d{6,}|10\d{8,})\b/.test(customerText) ||
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
  if (depositSentInHistory(outgoingTexts)) {
    return false;
  }
  if (isRegistrationConfirmed(text) || isRegistrationPending(text) || options?.hasImage) {
    return true;
  }
  return effectiveStep >= 4;
}

function positiveSignal(text: string, intent: EgIntent, effectiveStep: number): boolean {
  return (
    isFunnelPositiveReaction(text, effectiveStep) ||
    intent === "positive" ||
    intent === "ready" ||
    intent === "interested"
  );
}

function egRegScripts(linkSent: boolean, force = false): string[] {
  if (linkSent && !force) {
    return [];
  }
  return ["04_registration", "05_link"];
}

/**
 * Egypt funnel from pager-ai-bot:
 * 01_intro → 02_how_it_works → 04+05 reg → (08_app_or_browser) → 06_deposit → 07_game_id
 * Telegram handoff is NOT auto-sent.
 */
export function resolveEgFunnelScripts(
  effectiveStep: number,
  text: string,
  intent: EgIntent,
  outgoingTexts: string[],
  options?: { hasImage?: boolean; messageReaction?: string; recentCustomerTexts?: string[] },
): string[] {
  const t = (text || "").trim();
  const out = outgoingTexts;
  const howSent = explainScriptsSentInHistory(out);
  const linkSent = regLinkSentInHistory(out);
  const signal = positiveSignal(t, intent, effectiveStep);

  if (intent === "declined") {
    return [];
  }

  if (isRegistrationHelpRequest(t) || isEgJoinOrRegistrationQuestion(t)) {
    if (!egScriptSentInHistory(out, "01_intro")) {
      return ["01_intro"];
    }
    if (!howSent) {
      return ["02_how_it_works"];
    }
    return egRegScripts(linkSent, true);
  }

  if (wantsRegistrationLink(t)) {
    return registrationLinkScriptKeys("EG", linkSent);
  }

  if (howSent && !linkSent) {
    if (
      wantsRegistrationLink(t) ||
      isReadyForRegistration(t) ||
      isRegistrationPending(t) ||
      signal ||
      intent === "ready" ||
      intent === "positive" ||
      intent === "question" ||
      intent === "interested" ||
      isEgDepositTierChoice(t) ||
      effectiveStep >= 2 ||
      /استثمر|أريد|اريد|ايو|نجرب|مهتم|تمام/i.test(t)
    ) {
      return egRegScripts(linkSent);
    }
  }

  if (
    isAppOrBrowserQuestion(t) &&
    effectiveStep >= 2 &&
    effectiveStep < 6 &&
    !egScriptSentInHistory(out, "08_app_or_browser")
  ) {
    return ["08_app_or_browser"];
  }

  if (effectiveStep < 1) {
    if (egScriptSentInHistory(out, "01_intro")) {
      if (signal || intent === "question" || wantsDetailsAfterIntro(t) || t.length > 0) {
        return howSent ? egRegScripts(linkSent) : ["02_how_it_works"];
      }
      return [];
    }
    if (
      ["interested", "positive", "ready", "question", "unknown"].includes(intent) ||
      signal ||
      t.length > 0
    ) {
      return ["01_intro"];
    }
    return [];
  }

  if (effectiveStep < 2) {
    if (howSent) {
      if (
        isReadyForRegistration(t) ||
        wantsRegistrationLink(t) ||
        signal ||
        intent === "ready" ||
        intent === "positive" ||
        intent === "question" ||
        intent === "interested" ||
        /استثمر|أريد|اريد|ايو|نجرب|مهتم|تمام/i.test(t)
      ) {
        return egRegScripts(linkSent);
      }
      return [];
    }
    if (
      intent === "interested" ||
      intent === "positive" ||
      intent === "ready" ||
      intent === "question" ||
      wantsDetailsAfterIntro(t) ||
      isReadyForRegistration(t) ||
      signal ||
      /استثمر|أريد أن|اريد ان|أنا مهتم|موضوع|شغل|ازاي|إزاي/i.test(t) ||
      t.length > 0
    ) {
      return ["02_how_it_works"];
    }
    return [];
  }

  if (effectiveStep < 4) {
    if (
      isReadyForRegistration(t) ||
      wantsRegistrationLink(t) ||
      intent === "ready" ||
      intent === "positive" ||
      intent === "question" ||
      signal ||
      isEgDepositTierChoice(t)
    ) {
      return egRegScripts(linkSent);
    }
    return [];
  }

  if (isRegistrationPending(t)) {
    return egRegScripts(linkSent);
  }

  if (effectiveStep < 7) {
    if (intent === "game_id_text") {
      return [];
    }
    if (isRegistrationConfirmed(t) || intent === "joined") {
      return shouldSendDepositScript(t, effectiveStep, out, options) ? ["06_deposit"] : [];
    }
    if (
      linkSent &&
      !depositSentInHistory(out) &&
      (options?.hasImage || signal || intent === "positive" || intent === "ready")
    ) {
      return ["06_deposit"];
    }
    if (
      !linkSent &&
      (intent === "interested" ||
        intent === "positive" ||
        intent === "ready" ||
        intent === "question" ||
        signal)
    ) {
      return egRegScripts(linkSent);
    }
    return [];
  }

  if (effectiveStep < 8 && intent === "game_id_text") {
    if (gameIdSentInHistory(out)) {
      return [];
    }
    if (depositSentInHistory(out) || effectiveStep >= 7) {
      return ["07_game_id"];
    }
    return [];
  }

  if (
    depositSentInHistory(out) &&
    !gameIdSentInHistory(out) &&
    (isDepositConfirmed(t) ||
      intent === "deposit_done" ||
      intent === "image_only" ||
      intent === "positive" ||
      intent === "ready" ||
      options?.hasImage ||
      isPositiveMessageReaction(options?.messageReaction))
  ) {
    return ["07_game_id"];
  }

  if (effectiveStep < 4 && (intent === "positive" || intent === "interested" || intent === "ready" || signal)) {
    if (!howSent) {
      return ["02_how_it_works"];
    }
    if (!linkSent) {
      return egRegScripts(linkSent);
    }
  }

  if (linkSent && (isRegistrationHelpRequest(t) || isEgJoinOrRegistrationQuestion(t) || wantsRegistrationLink(t))) {
    return [...registrationHelpScriptKeys("EG")];
  }

  return [];
}

const EG_REG_BUNDLE = ["04_registration", "05_link"] as const;

/** One funnel stage per customer message — reg text+link go together. */
export function limitEgScriptsForCustomerTurn(
  scriptKeys: string[],
  outgoingTexts: string[],
): string[] {
  if (!scriptKeys.length) {
    return scriptKeys;
  }
  if (scriptKeys.includes("01_intro") && !egScriptSentInHistory(outgoingTexts, "01_intro")) {
    return ["01_intro"];
  }
  if (
    scriptKeys.some((key) => EG_EXPLAIN_SEND_KEYS.has(key)) &&
    !explainScriptsSentInHistory(outgoingTexts)
  ) {
    return ["02_how_it_works"];
  }
  if (scriptKeys.includes("08_app_or_browser")) {
    return ["08_app_or_browser"];
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
  return [scriptKeys[0]!];
}

export function egAllowsMultiSend(scriptKeys: string[]): boolean {
  if (scriptKeys.includes("01_intro")) {
    return true;
  }
  if (scriptKeys.some((key) => EG_EXPLAIN_SEND_KEYS.has(key))) {
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
