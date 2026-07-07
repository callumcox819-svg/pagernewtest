import { isPositiveMessageReaction } from "./message-attachments.js";

export type ZmIntent =
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

const INTERESTED =
  /\b(interested|i'?m interested|i am interested|tell me more|teach me|need help|go ahead|very interested|want to learn|i want to invest|would like to join|count me in)\b/i;
const POSITIVE = /\b(yes|yess?|ok|okay|sure|alright|got it|i am|how can i start|how do i start)\b/i;
const READY = /\b(i'?m ready|am ready|let'?s start|start today|ready to start|i'?m in)\b/i;
const JOINED = /\b(have joined|joined|i joined|registered already|done registering|account created)\b/i;
const DECLINED = /\b(not interested|no thanks|stop|scam|leave me alone)\b/i;
const GAME_ID = /\b(17\d{6,}|16\d{6,}|account\s*\d+)\b/i;
const POSITIVE_EMOJI = /^[\s👍👌✅🔥❤️🙏😊🙂]+$/u;
const EN_LINK_ASK =
  /\b(?:send|give|share|want|need|get|where|gimme).{0,28}\b(?:link|url)\b|\b(?:link|url)\b.{0,28}\b(?:please|pls|send|registration|register)\b|\bregistration\s+link\b|\bregister\s+link\b|\bneed\s+(?:the\s+)?link\b/i;

export function classifyZmIntent(
  text: string,
  options?: {
    hasImage?: boolean;
    funnelStep?: number;
    messageReaction?: string;
  },
): ZmIntent {
  const t = (text || "").trim();
  const step = options?.funnelStep ?? 0;

  if (DECLINED.test(t)) {
    return "declined";
  }
  if (GAME_ID.test(t)) {
    return "game_id_text";
  }
  if (isRegistrationConfirmed(t)) {
    return "joined";
  }
  if (isReadyForRegistration(t)) {
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
  if (INTERESTED.test(t)) {
    return "interested";
  }
  if (READY.test(t)) {
    return "ready";
  }
  if (POSITIVE.test(t) && t.split(/\s+/).length <= 8) {
    return "positive";
  }
  if (/\?/.test(t) || /\b(what|how|why|when|explain)\b/i.test(t)) {
    return "question";
  }
  if (options?.hasImage && !t) {
    return step < 5 ? "positive" : "image_only";
  }
  if (JOINED.test(t)) {
    return "joined";
  }
  return t ? "unknown" : "unknown";
}

export function isFunnelPositiveReaction(text: string, funnelStep = 0): boolean {
  const t = (text || "").trim();
  if (!t) {
    return false;
  }
  if (POSITIVE_EMOJI.test(t)) {
    return true;
  }
  if (funnelStep < 4 && /^(yes|ok|okay|sure|alright)\.?$/i.test(t)) {
    return true;
  }
  if (funnelStep < 4 && POSITIVE.test(t) && t.split(/\s+/).length <= 4) {
    return true;
  }
  return false;
}

export function wantsDetailsAfterIntro(text: string): boolean {
  const t = (text || "").trim();
  if (!t) {
    return false;
  }
  return (
    /^explain\??$/i.test(t) ||
    /\b(how it works|how does it work|tell me more|more details|explain)\b/i.test(t)
  );
}

export function wantsRegistrationLink(text: string): boolean {
  const t = (text || "").trim();
  if (!t) {
    return false;
  }
  if (isRegistrationConfirmed(t)) {
    return false;
  }
  if (isRegistrationHelpRequest(t)) {
    return true;
  }
  if (/^(?:the\s+)?(?:link|url)(?:\s+please)?\s*[.!?]*$/i.test(t)) {
    return true;
  }
  if (EN_LINK_ASK.test(t)) {
    return true;
  }
  return (
    /\b(send|give|share|want|need|where).{0,28}\b(link|url)\b/i.test(t) ||
    /\bregistration\s+link\b/i.test(t) ||
    /\bregister\s+link\b/i.test(t)
  );
}

export function isReadyForRegistration(text: string): boolean {
  const t = (text || "").trim();
  if (!t) {
    return false;
  }
  if (/^yes\.?$/i.test(t)) {
    return true;
  }
  if (READY.test(t)) {
    return true;
  }
  if (POSITIVE.test(t) && t.split(/\s+/).length <= 4) {
    return true;
  }
  if (/\b(let'?s go|let'?s do it|i'?m in|count me in)\b/i.test(t)) {
    return true;
  }
  return false;
}

export function isRegistrationConfirmed(text: string): boolean {
  const t = (text || "").trim();
  if (!t) {
    return false;
  }
  return (
    /\b(registered|registration done|account created|i registered|done registering)\b/i.test(t) ||
    /\b(waiting for the next step|next step)\b/i.test(t)
  );
}

export function isRegistrationPending(text: string): boolean {
  const t = (text || "").trim();
  return /\b(not yet|still registering|in progress|trying to register)\b/i.test(t);
}

export function isRegistrationHelpRequest(text: string): boolean {
  const t = (text || "").trim();
  return (
    /\b(problem|issue|error|help).{0,30}(registration|register|account)\b/i.test(t) ||
    /\bscreenshot.{0,20}problem\b/i.test(t)
  );
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
