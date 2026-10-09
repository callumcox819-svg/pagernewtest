import type { PagerMessage } from "./pager-client.js";
import type { ProofKind } from "./config.js";
import {
  isCustomerSaysNotRegisteredYet,
  recentTextsIndicateNotRegistered,
} from "./customer-clarity.js";
import {
  customerAgreedAfterOfferTable,
  registrationResendScriptKeys,
} from "./funnel-common.js";
import { isKeDepositAmountChoice } from "./ke-intent.js";
import { looksLikeZmDepositBalanceScreenshot } from "./zm-proof.js";
import {
  type KeIntent,
  classifyKeIntent,
  isFunnelPositiveReaction,
  isReadyForRegistration,
  isRegistrationConfirmed,
  isRegistrationHelpRequest,
  isKeRegistrationAccountQuestion,
  isBarePostLinkAcknowledgment,
  wantsDetailsAfterIntro,
  wantsRegistrationLink,
} from "./ke-intent.js";

const KE_GAME_ID_RE = /\b((?:15|16|17|18|19)\d{7,10})\b/;

export const KE_SCRIPT_SNIPPETS: Record<string, string> = {
  "01_intro": "Hi! I want to show you",
  "02_how_it_works": "How it works:",
  "03_kes_table": "30 KES - 300 KES",
  "04_registration": "promo code KEN577",
  "05_link": "tinyurl.com/ken577",
  "06_deposit": 'click "Deposit"',
  "07_game_id": "Account number",
  "08_tg_invite": "join our private channels",
  "09_tg_link": "t.me/+cxqeg5kratJkYTMy",
  "10_reg_screenshot": "registration already",
  "11_fb_link": "slotsofwin",
};

export const KE_SCRIPT_SEARCH_NEEDLES: Record<string, string[]> = {
  "01_intro": ["hi! i want to show you", "analytical systems", "artificial intelligence"],
  "02_how_it_works": [
    "how it works:",
    "first deposit up from",
    "first deposit up from k30",
    "first deposit up from 30 kes",
    "your own account",
  ],
  "03_kes_table": [
    "30 kes - 300 kes",
    "50 kes - 500 kes",
    "100 kes - 1000 kes",
    "200 kes - 2000 kes",
    "30 zmw - 300 zmw",
    "ready to start today",
    "here's what you can get",
  ],
  "04_registration": [
    "special registration link",
    "paste it into your google chrome",
    "promo code ken577",
    "registration by one click",
  ],
  "05_link": ["tinyurl.com/ken577"],
  "06_deposit": ['click "deposit"', "i'm waiting for you"],
  "07_game_id": ["account number", "begins with 17", "send me please your account"],
  "08_tg_invite": ["join our private channels", "grow together with us", "new strategies every day"],
  "09_tg_link": ["t.me/+cxqeg5kratjkytmy", "t.me/+", "cxqeg5kratjkytmy"],
};

export const KE_SCRIPT_EXCLUDE_SNIPPETS: Record<string, string[]> = {
  "04_registration": ["registration by e-mail", "make registration by e-mail", "by e-mail", "how it works:"],
  "05_link": ["promo code", "special registration", "how it works", "30 kes"],
  "02_how_it_works": ["promo code ken577", "tinyurl.com/ken577", "promo code zam777", "tinyurl.com/zambia777"],
  "03_kes_table": ["promo code ken577", "tinyurl.com/ken577", "promo code zam777", "tinyurl.com/zambia777"],
};

export const KE_FOLDER_NAME_HINTS = ["кени", "kenya", "kenia", "nairobi"];
export const KE_REG_SEND_KEYS = new Set(["04_registration", "05_link"]);
export const KE_STATUS_MOVE_KEYS = new Set(["04_registration", "05_link"]);
export const KE_EXPLAIN_SEND_KEYS = new Set(["02_how_it_works", "03_kes_table"]);

const KE_REG_BUNDLE = ["04_registration", "05_link"] as const;
const KE_REGISTRATION_LINK = "https://tinyurl.com/KEN577";

export function scriptSnippet(key: string): string {
  return KE_SCRIPT_SNIPPETS[key] ?? "";
}

export function scriptSearchNeedles(key: string): string[] {
  return KE_SCRIPT_SEARCH_NEEDLES[key] ?? [scriptSnippet(key)].filter(Boolean);
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

export function keScriptSentInHistory(outgoingTexts: string[], scriptKey: string): boolean {
  if (scriptKey === "04_registration") {
    return keRegistrationInstructionsSentInHistory(outgoingTexts);
  }
  return scriptSearchNeedles(scriptKey).some((needle) => scriptSentInHistory(outgoingTexts, needle));
}

export function explainScriptsSentInHistory(outgoingTexts: string[]): boolean {
  return (
    keScriptSentInHistory(outgoingTexts, "02_how_it_works") &&
    keScriptSentInHistory(outgoingTexts, "03_kes_table")
  );
}

export function regLinkSentInHistory(outgoingTexts: string[]): boolean {
  if (keScriptSentInHistory(outgoingTexts, "05_link")) {
    return true;
  }
  const blob = outgoingTexts.join("\n").toLowerCase();
  return (
    blob.includes("tinyurl.com/ken577") ||
    blob.includes("tinyurl.com/zambia777")
  );
}

export function keRegistrationInstructionsSentInHistory(outgoingTexts: string[]): boolean {
  const blob = outgoingTexts.join("\n").toLowerCase();
  if (!blob.includes("ken577") && !blob.includes("zam777")) {
    return false;
  }
  return (
    blob.includes("special registration link") ||
    (blob.includes("paste it into your google chrome") && blob.includes("promo code")) ||
    (blob.includes("registration by") && blob.includes("one click"))
  );
}

export function tgLinkSentInHistory(outgoingTexts: string[]): boolean {
  if (keScriptSentInHistory(outgoingTexts, "09_tg_link")) {
    return true;
  }
  const blob = outgoingTexts.join("\n").toLowerCase();
  return blob.includes("t.me/+");
}

export function keTgInviteSentInHistory(outgoingTexts: string[]): boolean {
  return keScriptSentInHistory(outgoingTexts, "08_tg_invite");
}

export function gameIdSentInHistory(outgoingTexts: string[]): boolean {
  return keScriptSentInHistory(outgoingTexts, "07_game_id");
}

export function gameIdReceivedInText(text: string): boolean {
  return KE_GAME_ID_RE.test((text || "").trim());
}

export function gameIdReceivedFromProof(proofKind: ProofKind | undefined, proofText: string): boolean {
  if (!proofKind || !proofText.trim()) {
    return false;
  }
  if (proofKind === "id_screenshot") {
    return true;
  }
  if (gameIdReceivedInText(proofText)) {
    return true;
  }
  if (
    (proofKind === "registration_screenshot" || proofKind === "deposit_balance_screenshot") &&
    gameIdReceivedInText(proofText)
  ) {
    return true;
  }
  return false;
}

function customerIdReceived(
  text: string,
  recentTexts: string[],
  proofKind?: ProofKind,
  proofText?: string,
): boolean {
  const blob = [text, proofText ?? "", ...recentTexts].filter(Boolean).join("\n");
  return gameIdReceivedInText(blob) || gameIdReceivedFromProof(proofKind, blob);
}

export function depositSentInHistory(outgoingTexts: string[]): boolean {
  if (keScriptSentInHistory(outgoingTexts, "06_deposit")) {
    return true;
  }
  const blob = outgoingTexts.join("\n").toLowerCase();
  return blob.includes('click "deposit"') || blob.includes("minimum deposit");
}

function stepForOutgoingText(text: string): number {
  const t = text.toLowerCase();
  if (t.includes("t.me/+") || t.includes("cxqeg5kratjkytmy") || t.includes("vhfjlofy")) {
    return 9;
  }
  if (t.includes("join our private channel") || t.includes("grow together with us")) {
    return 8;
  }
  if (t.includes('click "deposit"') || t.includes("i'm waiting for you")) {
    return 7;
  }
  if (t.includes("account number") || t.includes("begins with 17") || t.includes("game id")) {
    return 6;
  }
  if (
    t.includes("tinyurl.com/ken577") ||
    t.includes("tinyurl.com/zambia777") ||
    t.includes("promo code ken577") ||
    t.includes("promo code zam777")
  ) {
    return 4;
  }
  if (
    t.includes("30 kes - 300 kes") ||
    t.includes("50 kes - 500 kes") ||
    t.includes("100 kes - 1000 kes") ||
    t.includes("200 kes - 2000 kes") ||
    t.includes("are you ready to start today")
  ) {
    return 3;
  }
  if (t.includes("how it works:") && (t.includes("1.") || t.includes("1)"))) {
    return 2;
  }
  if (t.includes("hi! i want to show you") || t.includes("analytical systems")) {
    return 1;
  }
  return 0;
}

function isOutgoingDelivered(message: PagerMessage): boolean {
  const direction = (message.messageDirection ?? "").toLowerCase();
  if (direction !== "outgoing" && direction !== "out") {
    return false;
  }
  const text = (message.text || "").trim();
  if (text) {
    return true;
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
  if (!keScriptSentInHistory(outgoingTexts, "01_intro")) {
    return 0;
  }
  step = Math.max(step, 1);
  if (!explainScriptsSentInHistory(outgoingTexts)) {
    return Math.min(step, 2);
  }
  step = Math.max(step, 3);
  if (!regLinkSentInHistory(outgoingTexts)) {
    return Math.min(step, 3);
  }
  step = Math.max(step, 4);
  if (!gameIdSentInHistory(outgoingTexts)) {
    return Math.min(step, 4);
  }
  step = Math.max(step, 5);
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
  return scriptKeys.includes("05_link");
}

export function limitKeScriptsForCustomerTurn(
  scriptKeys: string[],
  outgoingTexts: string[],
): string[] {
  if (!scriptKeys.length) {
    return scriptKeys;
  }
  if (
    scriptKeys.includes("01_intro") &&
    !keScriptSentInHistory(outgoingTexts, "01_intro")
  ) {
    return ["01_intro"];
  }
  if (
    scriptKeys.some((key) => KE_EXPLAIN_SEND_KEYS.has(key)) &&
    !explainScriptsSentInHistory(outgoingTexts)
  ) {
    return ["02_how_it_works", "03_kes_table"];
  }
  if (scriptKeys.some((key) => KE_REG_SEND_KEYS.has(key))) {
    const instructionsSent = keRegistrationInstructionsSentInHistory(outgoingTexts);
    const linkSent = regLinkSentInHistory(outgoingTexts);
    if (!linkSent) {
      if (!instructionsSent) {
        return [...KE_REG_BUNDLE];
      }
      return ["05_link"];
    }
    return [];
  }
  return [scriptKeys[0]!];
}

export function keAllowsMultiSend(scriptKeys: string[]): boolean {
  if (scriptKeys.includes("01_intro")) {
    return true;
  }
  if (scriptKeys.some((key) => KE_EXPLAIN_SEND_KEYS.has(key))) {
    return true;
  }
  return scriptKeys.some((key) => KE_REG_SEND_KEYS.has(key));
}

export type KeStatusMoveTarget = "in_progress_registration" | "registration_complete";

export function keStatusMoveTarget(sentScriptKeys: string[]): KeStatusMoveTarget | null {
  if (sentScriptKeys.includes("06_deposit")) {
    return "registration_complete";
  }
  if (sentScriptKeys.includes("05_link")) {
    return "in_progress_registration";
  }
  return null;
}

export function keStatusMoveAfterSend(sentScriptKeys: string[]): boolean {
  return keStatusMoveTarget(sentScriptKeys) !== null;
}

export function statusMoveTriggersInProgress(scriptKeys: string[]): boolean {
  return scriptKeys.includes("05_link") || scriptKeys.includes("06_deposit");
}

export { KE_REGISTRATION_LINK };

function positiveSignal(text: string, intent: KeIntent, effectiveStep: number): boolean {
  return (
    isFunnelPositiveReaction(text, effectiveStep) ||
    intent === "positive" ||
    intent === "ready" ||
    intent === "interested"
  );
}

function wantsExplain(
  text: string,
  intent: KeIntent,
  effectiveStep: number,
): boolean {
  return (
    wantsDetailsAfterIntro(text) ||
    ["interested", "positive", "ready", "question"].includes(intent) ||
    positiveSignal(text, intent, effectiveStep)
  );
}

function isGreeting(text: string): boolean {
  return /^(hi|hello|hey|morning|good morning|good evening|yo)([\s,!.]|$)/i.test(
    (text || "").trim(),
  );
}

function hasUsableFollowUp(text: string): boolean {
  const t = (text || "").trim();
  if (!t) {
    return false;
  }
  return !/\b(fuck|scam|leave me alone|stop texting|not interested|no thanks|get out)\b/i.test(t);
}

function wantsDepositNow(text: string, intent: KeIntent): boolean {
  const t = (text || "").trim();
  if (!t) {
    return false;
  }
  return (
    intent === "ready" ||
    /\b(make a deposit|ready to deposit|let me deposit|want to deposit|do the deposit|deposit now|ready.*deposit)\b/i.test(
      t,
    )
  );
}

function wantsRegistrationBundle(
  text: string,
  intent: KeIntent,
  effectiveStep: number,
): boolean {
  return (
    isReadyForRegistration(text) ||
    wantsRegistrationLink(text) ||
    isRegistrationHelpRequest(text) ||
    customerAgreedAfterOfferTable(text) ||
    isKeDepositAmountChoice(text) ||
    intent === "ready" ||
    (positiveSignal(text, intent, effectiveStep) && effectiveStep >= 2)
  );
}

export function resolveKeFunnelScripts(
  effectiveStep: number,
  text: string,
  intent: KeIntent,
  outgoingTexts: string[],
  options?: {
    hasImage?: boolean;
    messageReaction?: string;
    recentCustomerTexts?: string[];
    proofKind?: ProofKind;
    proofText?: string;
  },
): string[] {
  const t = (text || "").trim();
  const out = outgoingTexts;
  const recentTexts = options?.recentCustomerTexts ?? [];

  if (intent === "declined") {
    return [];
  }

  const notRegisteredYet =
    isCustomerSaysNotRegisteredYet(t) || recentTextsIndicateNotRegistered(recentTexts);

  const introSent = keScriptSentInHistory(out, "01_intro");
  const explainSent = explainScriptsSentInHistory(out);
  const linkSent = regLinkSentInHistory(out);
  const gameIdAskSent = gameIdSentInHistory(out);
  const depositSent = depositSentInHistory(out);
  const signal = positiveSignal(t, intent, effectiveStep);
  const idReceived = customerIdReceived(t, recentTexts, options?.proofKind, options?.proofText);

  if (notRegisteredYet) {
    if (!introSent) {
      return ["01_intro"];
    }
    if (!explainSent) {
      return ["02_how_it_works", "03_kes_table"];
    }
    if (
      linkSent &&
      !wantsRegistrationLink(t) &&
      !isRegistrationHelpRequest(t) &&
      !isKeRegistrationAccountQuestion(t)
    ) {
      if (
        !gameIdAskSent &&
        !depositSent &&
        (isRegistrationConfirmed(t) || intent === "joined" || idReceived)
      ) {
        return ["07_game_id"];
      }
      return [];
    }
    return registrationResendScriptKeys("ZM", linkSent);
  }

  if (isRegistrationHelpRequest(t) || isKeRegistrationAccountQuestion(t)) {
    if (!introSent) {
      return ["01_intro"];
    }
    if (!explainSent) {
      return ["02_how_it_works", "03_kes_table"];
    }
    if (!linkSent) {
      return ["04_registration", "05_link"];
    }
    if (
      !gameIdAskSent &&
      !depositSent &&
      (isRegistrationConfirmed(t) || intent === "joined" || idReceived)
    ) {
      return ["07_game_id"];
    }
    if (!depositSent && (idReceived || signal || options?.hasImage)) {
      return ["06_deposit"];
    }
    return [];
  }

  if (!introSent) {
    // First SMS: always script 1 — any text/image (money ask, hello, etc.).
    if (t || options?.hasImage || options?.messageReaction) {
      return ["01_intro"];
    }
    return [];
  }

  if (!explainSent) {
    if (wantsExplain(t, intent, effectiveStep) || signal || intent === "interested") {
      return ["02_how_it_works", "03_kes_table"];
    }
    return [];
  }

  if (!linkSent) {
    if (wantsRegistrationBundle(t, intent, effectiveStep)) {
      return ["04_registration", "05_link"];
    }
    return [];
  }

  if (!depositSent && idReceived) {
    return ["06_deposit"];
  }

  if (!gameIdAskSent && !depositSent) {
    if (!t && !options?.hasImage) {
      return [];
    }
    if (isBarePostLinkAcknowledgment(t, intent)) {
      return [];
    }
    if (
      isRegistrationConfirmed(t) ||
      intent === "joined" ||
      intent === "game_id_text" ||
      idReceived
    ) {
      return ["07_game_id"];
    }
    return [];
  }

  if (depositSent && !gameIdAskSent) {
    const depositProof =
      options?.proofKind === "deposit_balance_screenshot" ||
      intent === "deposit_done" ||
      (options?.hasImage &&
        looksLikeZmDepositBalanceScreenshot(
          [t, options?.proofText ?? ""].filter(Boolean).join("\n"),
        ));
    if (
      depositProof ||
      isRegistrationConfirmed(t) ||
      intent === "joined" ||
      idReceived ||
      intent === "game_id_text"
    ) {
      return ["07_game_id"];
    }
    return [];
  }

  if (gameIdAskSent && !depositSent) {
    if (
      idReceived ||
      options?.hasImage ||
      intent === "game_id_text" ||
      intent === "image_only" ||
      isRegistrationConfirmed(t) ||
      intent === "joined" ||
      wantsDepositNow(t, intent) ||
      (signal && !isBarePostLinkAcknowledgment(t, intent))
    ) {
      return ["06_deposit"];
    }
    return [];
  }

  return [];
}

export function classifyKeMessage(
  text: string,
  options?: {
    hasImage?: boolean;
    funnelStep?: number;
    messageReaction?: string;
  },
): KeIntent {
  return classifyKeIntent(text, options);
}

/** Re-open mid-funnel KE chats when the customer gave a clear next-step signal. */
export function keFunnelNeedsContinuation(
  customerText: string,
  outgoingTexts: string[],
  options?: { hasImage?: boolean },
): boolean {
  const text = (customerText || "").trim();
  if (!text && !options?.hasImage) {
    return false;
  }
  const intent = classifyKeMessage(text, {
    hasImage: options?.hasImage,
    funnelStep: funnelStepFromScriptGaps(outgoingTexts, 0),
  });
  const keys = resolveKeFunnelScripts(
    funnelStepFromScriptGaps(outgoingTexts, 0),
    text,
    intent,
    outgoingTexts,
    { hasImage: options?.hasImage },
  );
  return keys.length > 0;
}
