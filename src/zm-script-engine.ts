import type { PagerMessage } from "./pager-client.js";
import {
  type ZmIntent,
  classifyZmIntent,
  isFunnelPositiveReaction,
  isReadyForRegistration,
  isRegistrationConfirmed,
  isRegistrationHelpRequest,
  isRegistrationPending,
  wantsDetailsAfterIntro,
  wantsRegistrationLink,
} from "./zm-intent.js";
import { registrationHelpScriptKeys, registrationLinkScriptKeys } from "./funnel-common.js";

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
export const ZM_EXPLAIN_SEND_KEYS = new Set(["02_how_it_works", "03_zmw_table"]);

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
  return blob.includes("tinyurl.com/zam577") || blob.includes("zam577");
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
  return scriptKeys.some((key) => ZM_REG_SEND_KEYS.has(key));
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
    positiveSignal(text, intent, effectiveStep) ||
    isReadyForRegistration(text)
  );
}

function wantsRegistrationNow(
  text: string,
  intent: ZmIntent,
  effectiveStep: number,
): boolean {
  return (
    wantsRegistrationLink(text) ||
    isReadyForRegistration(text) ||
    isRegistrationPending(text) ||
    ["ready", "interested", "positive", "question"].includes(intent) ||
    positiveSignal(text, intent, effectiveStep)
  );
}

export function resolveZmFunnelScripts(
  effectiveStep: number,
  text: string,
  intent: ZmIntent,
  outgoingTexts: string[],
  options?: { hasImage?: boolean; messageReaction?: string },
): string[] {
  const t = (text || "").trim();
  const out = outgoingTexts;

  if (intent === "declined") {
    return [];
  }

  if (isRegistrationHelpRequest(t)) {
    return [...registrationHelpScriptKeys("ZM")];
  }

  if (wantsRegistrationLink(t)) {
    return registrationLinkScriptKeys("ZM", regLinkSentInHistory(out));
  }

  const introSent = zmScriptSentInHistory(out, "01_intro");
  const explainSent = explainScriptsSentInHistory(out);
  const linkSent = regLinkSentInHistory(out);
  const signal = positiveSignal(t, intent, effectiveStep);

  if (effectiveStep < 1) {
    if (introSent) {
      if (!explainSent && wantsExplain(t, intent, effectiveStep)) {
        return ["02_how_it_works", "03_zmw_table"];
      }
      if (explainSent && wantsRegistrationNow(t, intent, effectiveStep) && !linkSent) {
        return ["04_registration", "05_link"];
      }
      return [];
    }
    if (intent === "interested" || signal || intent === "question") {
      return ["01_intro"];
    }
    return [];
  }

  if (effectiveStep < 3) {
    if (!explainSent && wantsExplain(t, intent, effectiveStep)) {
      return ["02_how_it_works", "03_zmw_table"];
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
      return ["02_how_it_works", "03_zmw_table"];
    }

    if (explainSent && wantsRegistrationNow(t, intent, effectiveStep)) {
      if (linkSent && isRegistrationConfirmed(t)) {
        return shouldSendDepositScript(t, effectiveStep, out) ? ["06_deposit"] : [];
      }
      if (linkSent) {
        return [];
      }
      return ["04_registration", "05_link"];
    }
    return [];
  }

  if (isRegistrationHelpRequest(t)) {
    return [...registrationHelpScriptKeys("ZM")];
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
    return [];
  }

  if (effectiveStep < 8 && intent === "game_id_text") {
    if (!zmScriptSentInHistory(out, "07_game_id")) {
      return ["07_game_id"];
    }
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
