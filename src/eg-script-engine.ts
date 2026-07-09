import type { PagerMessage } from "./pager-client.js";
import {
  type EgIntent,
  classifyEgIntent,
  isEgDepositTierChoice,
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
  "01_intro": ["إنت من مصر", "انت من مصر", "أهلاً", "اهلا"],
  "02_how_it_works": ["تمام كده", "الشغل بيمشي", "كود eg011"],
  "03_egp_table": ["55 جنيه", "110 جنيه", "إيه اللي يناسبك"],
  "04_registration": ["eg011", "هبعتلك اللينك", "google chrome", "اختار مصر"],
  "05_link": ["tinyurl.com", "egypt0011"],
  "06_deposit": ["إيداع", "الزر الأخضر", "الأخضر"],
  "07_game_id": ["يبدأ ب 17", "رقم العميل", "17"],
  "09_tg_invite": ["تليجرام", "telegram", "قناتنا"],
  "10_tg_link": ["t.me/+", "t7iys46b2ls2ywrd"],
};

export const EG_SCRIPT_EXCLUDE_SNIPPETS: Record<string, string[]> = {
  "04_registration": ["تمام كده", "55 جنيه", "110 جنيه"],
  "05_link": ["eg011", "هبعتلك اللينك", "55 جنيه"],
  "02_how_it_works": ["eg011", "tinyurl.com"],
  "03_egp_table": ["eg011", "tinyurl.com", "هبعتلك اللينك"],
};

export const EG_FOLDER_NAME_HINTS = ["егип", "egypt", "hapka", "mahmoud", "مصر"];
export const EG_REG_SEND_KEYS = new Set(["04_registration", "05_link"]);

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
    egScriptSentInHistory(outgoingTexts, "02_how_it_works") &&
    egScriptSentInHistory(outgoingTexts, "03_egp_table")
  );
}

export function regLinkSentInHistory(outgoingTexts: string[]): boolean {
  if (egScriptSentInHistory(outgoingTexts, "05_link")) {
    return true;
  }
  const blob = outgoingTexts.join("\n").toLowerCase();
  return blob.includes("tinyurl.com") || blob.includes("eg011") || blob.includes("egypt0011");
}

export function depositSentInHistory(outgoingTexts: string[]): boolean {
  if (egScriptSentInHistory(outgoingTexts, "06_deposit")) {
    return true;
  }
  const blob = outgoingTexts.join("\n").toLowerCase();
  return blob.includes("إيداع") || blob.includes("الأخضر") || blob.includes("ايداع");
}

function stepForOutgoingText(text: string): number {
  const t = text.toLowerCase();
  if (t.includes("t.me/+") || t.includes("t7iys46b2ls2ywrd")) {
    return 9;
  }
  if (t.includes("تليجرام") || t.includes("telegram")) {
    return 8;
  }
  if (t.includes("إيداع") || t.includes("الأخضر") || t.includes("ايداع")) {
    return 7;
  }
  if (t.includes("يبدأ ب 17") || t.includes("رقم العميل")) {
    return 6;
  }
  if (t.includes("tinyurl.com") || t.includes("eg011") || t.includes("egypt0011")) {
    return 4;
  }
  if (t.includes("55 جنيه") || t.includes("110 جنيه") || t.includes("إيه اللي يناسبك")) {
    return 3;
  }
  if (t.includes("تمام كده") || t.includes("الشغل بيمشي")) {
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
    return Math.min(step, 2);
  }
  step = Math.max(step, 3);
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

function shouldSendDepositScript(
  text: string,
  effectiveStep: number,
  outgoingTexts: string[],
): boolean {
  if (!regLinkSentInHistory(outgoingTexts)) {
    return false;
  }
  if (isRegistrationConfirmed(text) || isRegistrationPending(text)) {
    return true;
  }
  return effectiveStep >= 4 && !depositSentInHistory(outgoingTexts);
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
    ["interested", "positive", "ready", "question"].includes(intent) ||
    positiveSignal(text, intent, effectiveStep) ||
    isReadyForRegistration(text)
  );
}

function wantsRegistrationNow(text: string, intent: EgIntent, effectiveStep: number): boolean {
  return (
    wantsRegistrationLink(text) ||
    isReadyForRegistration(text) ||
    isRegistrationPending(text) ||
    isEgDepositTierChoice(text) ||
    ["ready", "interested", "positive", "question"].includes(intent) ||
    positiveSignal(text, intent, effectiveStep)
  );
}

function isGreeting(text: string): boolean {
  return /^(اهلا|أهلا|اهلاً|أهلاً|مرحبا|مرحباً|السلام|سلام|هاي|هلو|hello|hi)([\s,!.]|$)/i.test(
    (text || "").trim(),
  );
}

export function resolveEgFunnelScripts(
  effectiveStep: number,
  text: string,
  intent: EgIntent,
  outgoingTexts: string[],
  options?: { hasImage?: boolean; messageReaction?: string },
): string[] {
  const t = (text || "").trim();
  const out = outgoingTexts;

  if (intent === "declined") {
    return [];
  }

  if (isRegistrationHelpRequest(t)) {
    return [...registrationHelpScriptKeys("EG")];
  }

  if (wantsRegistrationLink(t)) {
    return registrationLinkScriptKeys("EG", regLinkSentInHistory(out));
  }

  const introSent = egScriptSentInHistory(out, "01_intro");
  const explainSent = explainScriptsSentInHistory(out);
  const linkSent = regLinkSentInHistory(out);
  const signal = positiveSignal(t, intent, effectiveStep);

  if ((explainSent || effectiveStep >= 3) && isEgDepositTierChoice(t) && !linkSent) {
    return ["04_registration", "05_link"];
  }

  if (effectiveStep < 1) {
    if (introSent) {
      if (!explainSent && wantsExplain(t, intent, effectiveStep)) {
        return ["02_how_it_works", "03_egp_table"];
      }
      if (explainSent && wantsRegistrationNow(t, intent, effectiveStep) && !linkSent) {
        return ["04_registration", "05_link"];
      }
      return [];
    }
    if (intent === "interested" || signal || intent === "question" || isGreeting(t)) {
      return ["01_intro"];
    }
    return [];
  }

  if (effectiveStep < 3) {
    if (!explainSent && wantsExplain(t, intent, effectiveStep)) {
      return ["02_how_it_works", "03_egp_table"];
    }
    if (explainSent && wantsRegistrationNow(t, intent, effectiveStep) && !linkSent) {
      return ["04_registration", "05_link"];
    }
    return [];
  }

  if (effectiveStep < 4) {
    if (isRegistrationConfirmed(t) && linkSent) {
      return shouldSendDepositScript(t, effectiveStep, out) ? ["06_deposit"] : [];
    }

    if (!explainSent && wantsExplain(t, intent, effectiveStep)) {
      return ["02_how_it_works", "03_egp_table"];
    }

    if (explainSent && wantsRegistrationNow(t, intent, effectiveStep)) {
      if (linkSent) {
        if (shouldSendDepositScript(t, effectiveStep, out) || signal || intent === "ready") {
          return depositSentInHistory(out) ? [] : ["06_deposit"];
        }
        return [];
      }
      return ["04_registration", "05_link"];
    }
    if (linkSent && !depositSentInHistory(out) && (signal || intent === "joined")) {
      return ["06_deposit"];
    }
    return [];
  }

  if (isRegistrationPending(t) && !linkSent) {
    return ["04_registration", "05_link"];
  }

  if (effectiveStep < 7) {
    if (isRegistrationConfirmed(t) || intent === "joined" || options?.hasImage) {
      if (shouldSendDepositScript(t, effectiveStep, out)) {
        return ["06_deposit"];
      }
    }
    if (!linkSent && wantsRegistrationNow(t, intent, effectiveStep)) {
      return ["04_registration", "05_link"];
    }
    if (
      linkSent &&
      !depositSentInHistory(out) &&
      (signal ||
        intent === "ready" ||
        intent === "positive" ||
        intent === "interested" ||
        intent === "question" ||
        isReadyForRegistration(t))
    ) {
      return ["06_deposit"];
    }
    return [];
  }

  if (
    effectiveStep >= 7 &&
    !egScriptSentInHistory(out, "07_game_id") &&
    (intent === "ready" ||
      intent === "positive" ||
      intent === "interested" ||
      intent === "image_only" ||
      signal ||
      isReadyForRegistration(t) ||
      options?.hasImage)
  ) {
    return ["07_game_id"];
  }

  if (effectiveStep < 8 && intent === "game_id_text") {
    if (!egScriptSentInHistory(out, "07_game_id")) {
      return ["07_game_id"];
    }
  }

  return [];
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
