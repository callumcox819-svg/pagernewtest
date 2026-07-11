import type { PagerMessage } from "./pager-client.js";
import type { ProofKind } from "./config.js";
import {
  type ZmIntent,
  classifyZmIntent,
  isFunnelPositiveReaction,
  isReadyForRegistration,
  isRegistrationConfirmed,
  isRegistrationHelpRequest,
  isZmRegistrationAccountQuestion,
  wantsDetailsAfterIntro,
  wantsRegistrationLink,
} from "./zm-intent.js";

const ZM_GAME_ID_RE = /\b(17\d{6,}|16\d{6,})\b/;

export const ZM_SCRIPT_SNIPPETS: Record<string, string> = {
  "01_intro": "Hi! I want to show you",
  "02_how_it_works": "How it works:",
  "03_zmw_table": "30 ZMW - 300 ZMW",
  "04_registration": "promo code ZAM577",
  "05_link": "tinyurl.com/ZAM577",
  "06_deposit": 'click "Deposit"',
  "07_game_id": "begins with 17",
  "08_tg_invite": "Join our private Telegram",
  "09_tg_link": "t.me/+",
  "10_reg_screenshot": "screenshot",
  "11_fb_link": "facebook",
};

export const ZM_SCRIPT_SEARCH_NEEDLES: Record<string, string[]> = {
  "01_intro": ["hi! i want to show you", "analytical systems", "artificial intelligence"],
  "02_how_it_works": ["how it works:", "1) you create"],
  "03_zmw_table": ["30 zmw - 300 zmw", "are you ready to start today", "here's what you can get"],
  "04_registration": ["promo code zam577", "special registration link", "paste it into your google chrome"],
  "05_link": ["tinyurl.com/zam577"],
  "06_deposit": ['click "deposit"', "minimum deposit amount"],
  "07_game_id": ["begins with 17", "send me your game id", "game id"],
  "08_tg_invite": ["join our private telegram", "private telegram channel"],
  "09_tg_link": ["t.me/+", "vhfjiofy"],
};

export const ZM_SCRIPT_EXCLUDE_SNIPPETS: Record<string, string[]> = {
  "04_registration": ["registration by e-mail", "make registration by e-mail", "by e-mail", "how it works:"],
  "05_link": ["promo code", "special registration", "how it works", "30 zmw"],
  "02_how_it_works": ["promo code zam577", "tinyurl.com/zam577"],
  "03_zmw_table": ["promo code zam577", "tinyurl.com/zam577"],
};

export const ZM_FOLDER_NAME_HINTS = ["замб", "zamb", "zambia"];
export const ZM_REG_SEND_KEYS = new Set(["04_registration", "05_link"]);
export const ZM_STATUS_MOVE_KEYS = new Set(["04_registration", "05_link"]);
export const ZM_EXPLAIN_SEND_KEYS = new Set(["02_how_it_works", "03_zmw_table"]);

const ZM_REG_BUNDLE = ["04_registration", "05_link"] as const;
const ZM_REGISTRATION_LINK = "https://tinyurl.com/ZAM577";

export function scriptSnippet(key: string): string {
  return ZM_SCRIPT_SNIPPETS[key] ?? "";
}

export function scriptSearchNeedles(key: string): string[] {
  return ZM_SCRIPT_SEARCH_NEEDLES[key] ?? [scriptSnippet(key)].filter(Boolean);
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

export function zmScriptSentInHistory(outgoingTexts: string[], scriptKey: string): boolean {
  return scriptSearchNeedles(scriptKey).some((needle) => scriptSentInHistory(outgoingTexts, needle));
}

export function explainScriptsSentInHistory(outgoingTexts: string[]): boolean {
  return (
    zmScriptSentInHistory(outgoingTexts, "02_how_it_works") &&
    zmScriptSentInHistory(outgoingTexts, "03_zmw_table")
  );
}

export function regLinkSentInHistory(outgoingTexts: string[]): boolean {
  if (zmScriptSentInHistory(outgoingTexts, "05_link")) {
    return true;
  }
  const blob = outgoingTexts.join("\n").toLowerCase();
  return blob.includes("tinyurl.com/zam577");
}

export function zmRegistrationInstructionsSentInHistory(outgoingTexts: string[]): boolean {
  const blob = outgoingTexts.join("\n").toLowerCase();
  return (
    (blob.includes("special registration link") ||
      blob.includes("here is the link") ||
      blob.includes("paste it into your google chrome")) &&
    blob.includes("zam577")
  );
}

export function tgLinkSentInHistory(outgoingTexts: string[]): boolean {
  if (zmScriptSentInHistory(outgoingTexts, "09_tg_link")) {
    return true;
  }
  const blob = outgoingTexts.join("\n").toLowerCase();
  return blob.includes("t.me/+");
}

export function zmTgInviteSentInHistory(outgoingTexts: string[]): boolean {
  return zmScriptSentInHistory(outgoingTexts, "08_tg_invite");
}

export function gameIdSentInHistory(outgoingTexts: string[]): boolean {
  return zmScriptSentInHistory(outgoingTexts, "07_game_id");
}

export function gameIdReceivedInText(text: string): boolean {
  return ZM_GAME_ID_RE.test((text || "").trim());
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
  if (zmScriptSentInHistory(outgoingTexts, "06_deposit")) {
    return true;
  }
  const blob = outgoingTexts.join("\n").toLowerCase();
  return blob.includes('click "deposit"') || blob.includes("minimum deposit");
}

function stepForOutgoingText(text: string): number {
  const t = text.toLowerCase();
  if (t.includes("t.me/+") || t.includes("vhfjiofy")) {
    return 9;
  }
  if (t.includes("join our private telegram")) {
    return 8;
  }
  if (t.includes('click "deposit"') || t.includes("minimum deposit amount")) {
    return 7;
  }
  if (t.includes("begins with 17") || t.includes("game id")) {
    return 6;
  }
  if (t.includes("tinyurl.com/zam577") || t.includes("promo code zam577")) {
    return 4;
  }
  if (t.includes("30 zmw - 300 zmw") || t.includes("are you ready to start today")) {
    return 3;
  }
  if (t.includes("how it works:") && t.includes("1)")) {
    return 2;
  }
  if (t.includes("hi! i want to show you") || t.includes("analytical systems")) {
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
  if (!zmScriptSentInHistory(outgoingTexts, "01_intro")) {
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

export function limitZmScriptsForCustomerTurn(
  scriptKeys: string[],
  outgoingTexts: string[],
): string[] {
  if (!scriptKeys.length) {
    return scriptKeys;
  }
  if (
    scriptKeys.includes("01_intro") &&
    !zmScriptSentInHistory(outgoingTexts, "01_intro")
  ) {
    return ["01_intro"];
  }
  if (
    scriptKeys.some((key) => ZM_EXPLAIN_SEND_KEYS.has(key)) &&
    !explainScriptsSentInHistory(outgoingTexts)
  ) {
    return ["02_how_it_works", "03_zmw_table"];
  }
  if (scriptKeys.some((key) => ZM_REG_SEND_KEYS.has(key))) {
    const instructionsSent = zmRegistrationInstructionsSentInHistory(outgoingTexts);
    const linkSent = regLinkSentInHistory(outgoingTexts);
    if (!instructionsSent) {
      return [...ZM_REG_BUNDLE];
    }
    if (!linkSent) {
      return ["05_link"];
    }
    return [];
  }
  return [scriptKeys[0]!];
}

export function zmAllowsMultiSend(scriptKeys: string[]): boolean {
  if (scriptKeys.includes("01_intro")) {
    return true;
  }
  if (scriptKeys.some((key) => ZM_EXPLAIN_SEND_KEYS.has(key))) {
    return true;
  }
  return scriptKeys.some((key) => ZM_REG_SEND_KEYS.has(key));
}

export type ZmStatusMoveTarget = "in_progress_registration" | "registration_complete";

export function zmStatusMoveTarget(sentScriptKeys: string[]): ZmStatusMoveTarget | null {
  if (sentScriptKeys.includes("06_deposit")) {
    return "registration_complete";
  }
  if (sentScriptKeys.includes("05_link")) {
    return "in_progress_registration";
  }
  return null;
}

export function zmStatusMoveAfterSend(sentScriptKeys: string[]): boolean {
  return zmStatusMoveTarget(sentScriptKeys) !== null;
}

export function statusMoveTriggersInProgress(scriptKeys: string[]): boolean {
  return scriptKeys.includes("05_link") || scriptKeys.includes("06_deposit");
}

export { ZM_REGISTRATION_LINK };

function positiveSignal(text: string, intent: ZmIntent, effectiveStep: number): boolean {
  return (
    isFunnelPositiveReaction(text, effectiveStep) ||
    intent === "positive" ||
    intent === "ready" ||
    intent === "interested"
  );
}

function wantsExplain(
  text: string,
  intent: ZmIntent,
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

function wantsDepositNow(text: string, intent: ZmIntent): boolean {
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
  intent: ZmIntent,
  effectiveStep: number,
): boolean {
  return (
    isReadyForRegistration(text) ||
    wantsRegistrationLink(text) ||
    intent === "ready" ||
    (positiveSignal(text, intent, effectiveStep) && effectiveStep >= 2)
  );
}

export function resolveZmFunnelScripts(
  effectiveStep: number,
  text: string,
  intent: ZmIntent,
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

  const introSent = zmScriptSentInHistory(out, "01_intro");
  const explainSent = explainScriptsSentInHistory(out);
  const linkSent = regLinkSentInHistory(out);
  const gameIdAskSent = gameIdSentInHistory(out);
  const depositSent = depositSentInHistory(out);
  const signal = positiveSignal(t, intent, effectiveStep);
  const idReceived = customerIdReceived(t, recentTexts, options?.proofKind, options?.proofText);

  if (isRegistrationHelpRequest(t) || isZmRegistrationAccountQuestion(t)) {
    if (!introSent) {
      return ["01_intro"];
    }
    if (!explainSent) {
      return ["02_how_it_works", "03_zmw_table"];
    }
    if (!linkSent) {
      return ["04_registration", "05_link"];
    }
    if (!depositSent && idReceived) {
      return ["06_deposit"];
    }
    if (!gameIdAskSent && !depositSent) {
      return ["07_game_id"];
    }
    return [];
  }

  if (!introSent) {
    if (
      intent === "interested" ||
      signal ||
      intent === "question" ||
      isGreeting(t) ||
      hasUsableFollowUp(t)
    ) {
      return ["01_intro"];
    }
    return [];
  }

  if (!explainSent) {
    if (wantsExplain(t, intent, effectiveStep) || signal || intent === "interested") {
      return ["02_how_it_works", "03_zmw_table"];
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
    if (
      signal ||
      intent === "positive" ||
      intent === "ready" ||
      intent === "joined" ||
      isRegistrationConfirmed(t) ||
      options?.hasImage ||
      t.length > 0
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
      signal
    ) {
      return ["06_deposit"];
    }
    return [];
  }

  return [];
}

export function classifyZmMessage(
  text: string,
  options?: {
    hasImage?: boolean;
    funnelStep?: number;
    messageReaction?: string;
  },
): ZmIntent {
  return classifyZmIntent(text, options);
}
