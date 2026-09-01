import type { WorkerCountry } from "./rw-learn.js";
import type { ConversationRuntimeState } from "./state-store.js";
import type { PagerConversation, PagerMessage } from "./pager-client.js";
import { isAutomatedFunnelOutgoing } from "./funnel-outbound.js";
import {
  isIncomingDirection,
  isOperatorOutgoingMessage,
  isOutgoingDirection,
  parseMessageTimestamp,
} from "./conversation-reply.js";
import type { CountryCode } from "./config.js";

/** Markets that get delayed «в процессе» check-ins (each in its own language). */
export type InProgressFollowUpCountry = "ZM" | "CM" | "EG" | "RW" | "CL";

export const IN_PROGRESS_FOLLOWUP_MIN_MS = 20 * 60 * 1000;
export const IN_PROGRESS_FOLLOWUP_MAX_MS = 22 * 60 * 1000;
/** Only ping chats the bot moved to «в процессе» within this window. */
export const IN_PROGRESS_FOLLOWUP_MAX_AGE_MS = 48 * 60 * 60 * 1000;
export const IN_PROGRESS_FOLLOWUP_ATTEMPT_COOLDOWN_MS = 60 * 60 * 1000;

/** ZM/RW English, CM French, CL Spanish, EG Arabic — aligned with AI market languages. */
const FOLLOWUP_NEEDLES: Record<InProgressFollowUpCountry, string[]> = {
  ZM: ["have you already registered", "when will you complete registration"],
  RW: ["have you already registered", "when will you complete registration"],
  CM: ["déjà inscrit", "terminer l'inscription", "terminer votre inscription"],
  CL: ["ya te registraste", "terminarás el registro", "terminaras el registro"],
  EG: ["هل قمت بالتسجيل", "متى ستنهي التسجيل", "متى ستكمل التسجيل"],
};

const FOLLOWUP_MESSAGES: Record<InProgressFollowUpCountry, [string, string]> = {
  ZM: ["Have you already registered?", "When will you complete registration?"],
  RW: ["Have you already registered?", "When will you complete registration?"],
  CM: ["Vous êtes déjà inscrit(e) ?", "Quand allez-vous terminer l'inscription ?"],
  CL: ["¿Ya te registraste?", "¿Cuándo terminarás el registro?"],
  EG: ["هل قمت بالتسجيل بالفعل؟", "متى ستنهي التسجيل؟"],
};

const PLAN_ASK_MESSAGES: Record<InProgressFollowUpCountry, string> = {
  ZM: "When do you plan to register?",
  RW: "When do you plan to register?",
  CM: "Quand comptez-vous vous enregistrer ?",
  CL: "¿Cuándo planeas registrarte?",
  EG: "متى تخطط للتسجيل؟",
};

const PLAN_ASK_NEEDLES: Record<InProgressFollowUpCountry, string[]> = {
  ZM: ["when do you plan to register"],
  RW: ["when do you plan to register"],
  CM: ["comptez-vous vous enregistrer", "comptez-vous terminer votre inscription"],
  CL: ["cuándo planeas registrarte", "cuando planeas registrarte"],
  EG: ["متى تخطط للتسجيل"],
};

function stableHash(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}

export function computeInProgressFollowUpDueAt(
  convId: string,
  fromMs = Date.now(),
): string {
  const span = IN_PROGRESS_FOLLOWUP_MAX_MS - IN_PROGRESS_FOLLOWUP_MIN_MS;
  const offset = stableHash(convId) % (span + 1);
  return new Date(fromMs + IN_PROGRESS_FOLLOWUP_MIN_MS + offset).toISOString();
}

export function pickInProgressFollowUpVariant(convId: string): 0 | 1 {
  return (stableHash(`${convId}:variant`) % 2) as 0 | 1;
}

export function inProgressFollowUpMessage(
  country: InProgressFollowUpCountry,
  variant: 0 | 1,
): string {
  return FOLLOWUP_MESSAGES[country][variant];
}

export function inProgressPlanAskMessage(country: InProgressFollowUpCountry): string {
  return PLAN_ASK_MESSAGES[country];
}

export function inProgressFollowUpAlreadySent(
  country: InProgressFollowUpCountry,
  outgoingTexts: string[],
): boolean {
  const blob = outgoingTexts.join("\n");
  const needles = FOLLOWUP_NEEDLES[country];
  if (country === "EG") {
    return needles.some((needle) => blob.includes(needle));
  }
  const lower = blob.toLowerCase();
  return needles.some((needle) => lower.includes(needle.toLowerCase()));
}

export function inProgressPlanAskAlreadySent(
  country: InProgressFollowUpCountry,
  outgoingTexts: string[],
): boolean {
  const blob = outgoingTexts.join("\n");
  const needles = PLAN_ASK_NEEDLES[country];
  if (country === "EG") {
    return needles.some((needle) => blob.includes(needle));
  }
  const lower = blob.toLowerCase();
  return needles.some((needle) => lower.includes(needle.toLowerCase()));
}

export function isInProgressBotAutomatedText(
  country: InProgressFollowUpCountry,
  text: string,
): boolean {
  const t = (text || "").trim();
  if (!t) {
    return false;
  }
  if (isAutomatedFunnelOutgoing(t, country as CountryCode)) {
    return true;
  }
  const lower = t.toLowerCase();
  const needles = [...FOLLOWUP_NEEDLES[country], ...PLAN_ASK_NEEDLES[country]];
  if (country === "EG") {
    return needles.some((needle) => t.includes(needle));
  }
  return needles.some((needle) => lower.includes(needle.toLowerCase()));
}

/** Operator typed in the thread after bot moved chat to «в процессе» — cancel automation. */
export function hasManualOperatorReplyAfterInProgress(
  messages: PagerMessage[],
  enteredAtIso: string,
  country: InProgressFollowUpCountry,
  conv?: PagerConversation,
  operatorUserId?: string,
): boolean {
  const enteredMs = Date.parse(enteredAtIso);
  if (!Number.isFinite(enteredMs)) {
    return false;
  }
  for (const message of messages) {
    if (!isOperatorOutgoingMessage(message, conv, operatorUserId, country as CountryCode)) {
      continue;
    }
    if (
      !isOutgoingDirection(message.messageDirection) &&
      !(message.isDelivered || message.facebookMessageId)
    ) {
      continue;
    }
    const ts = Date.parse(parseMessageTimestamp(message.createdAt));
    if (!Number.isFinite(ts) || ts <= enteredMs) {
      continue;
    }
    const text = (message.text || "").trim();
    if (isInProgressBotAutomatedText(country, text)) {
      continue;
    }
    return true;
  }
  return false;
}

export function shouldSendInProgressFollowUp(
  convState: ConversationRuntimeState,
  nowMs = Date.now(),
): boolean {
  if (convState.inProgressMutedAt?.trim()) {
    return false;
  }
  if (!convState.inProgressEnteredAt?.trim()) {
    return false;
  }
  if (convState.inProgressFollowUpSentAt?.trim()) {
    return false;
  }
  const dueAt = convState.inProgressFollowUpDueAt?.trim();
  if (!dueAt) {
    return false;
  }
  const dueMs = Date.parse(dueAt);
  return Number.isFinite(dueMs) && dueMs <= nowMs;
}

/** Queue in-progress chats only when the bot scheduled a recent follow-up. */
export function shouldQueueInProgressFollowUp(
  convState: ConversationRuntimeState | undefined,
  nowMs = Date.now(),
): boolean {
  if (!convState?.inProgressEnteredAt?.trim()) {
    return false;
  }
  if (isInProgressBotMuted(convState)) {
    return false;
  }
  if (convState.inProgressFollowUpSentAt?.trim()) {
    return false;
  }
  if (isInProgressFollowUpExpired(convState, nowMs)) {
    return false;
  }
  if (!convState.inProgressFollowUpDueAt?.trim()) {
    return false;
  }
  return shouldSendInProgressFollowUp(convState, nowMs);
}

export function isInProgressFollowUpExpired(
  convState: ConversationRuntimeState,
  nowMs = Date.now(),
): boolean {
  const enteredMs = Date.parse(convState.inProgressEnteredAt ?? "");
  if (!Number.isFinite(enteredMs)) {
    return true;
  }
  return nowMs - enteredMs > IN_PROGRESS_FOLLOWUP_MAX_AGE_MS;
}

export function isInProgressFollowUpAttemptCoolingDown(
  convState: ConversationRuntimeState,
  nowMs = Date.now(),
): boolean {
  if (convState.inProgressFollowUpSentAt?.trim()) {
    return false;
  }
  const attemptMs = Date.parse(convState.inProgressFollowUpLastAttemptAt ?? "");
  if (!Number.isFinite(attemptMs)) {
    return false;
  }
  return nowMs - attemptMs < IN_PROGRESS_FOLLOWUP_ATTEMPT_COOLDOWN_MS;
}

/** Customer wrote after entering «в процессе» — skip the silence follow-up. */
export function hasCustomerIncomingAfter(
  messages: PagerMessage[],
  afterMs: number,
): boolean {
  for (const message of messages) {
    if (!isIncomingDirection(message.messageDirection)) {
      continue;
    }
    const text = (message.text || "").trim();
    if (!text) {
      continue;
    }
    const ts = Date.parse(parseMessageTimestamp(message.createdAt));
    if (Number.isFinite(ts) && ts > afterMs) {
      return true;
    }
  }
  return false;
}

/** Customer answered the «already registered?» ping — may need «when do you plan?» or mute. */
export function shouldHandleInProgressFollowUpCustomerReply(
  convState: ConversationRuntimeState,
): boolean {
  if (convState.inProgressMutedAt?.trim()) {
    return false;
  }
  if (!convState.inProgressFollowUpSentAt?.trim()) {
    return false;
  }
  if (convState.inProgressPlanAskSentAt?.trim()) {
    return false;
  }
  return true;
}

export function isInProgressBotMuted(convState: ConversationRuntimeState): boolean {
  return Boolean(convState.inProgressMutedAt?.trim());
}

export type InProgressCustomerReplyKind = "yes" | "not_yet" | "other";

export function classifyInProgressRegistrationReply(
  country: InProgressFollowUpCountry,
  text: string,
): InProgressCustomerReplyKind {
  const t = (text || "").trim().toLowerCase();
  if (!t) {
    return "other";
  }

  if (country === "CM" || country === "CL") {
    if (
      /\b(pas encore|non|encore non|je (vais|m[' ]?occupe|m[' ]?en occupe|travaille|suis en train)|bientôt|bientot|en cours|plus tard|après|apres|je m[' ]?en occupe|j[' ]?y travaille|ocupo|todavía no|todavia no|aún no|aun no)\b/.test(
        t,
      ) ||
      /^(non|no)\s*[!.]*$/.test(t)
    ) {
      return "not_yet";
    }
    if (
      /^(oui|ouais|yes|si|sí|ok)\b/.test(t) ||
      /\b(déjà inscrit|deja inscrit|j[' ]?ai (fini|fait|inscrit|enregistr)|c[' ]?est (fait|bon)|je suis inscrit|me suis inscrit|terminé|termine)\b/.test(
        t,
      ) ||
      /^(oui|si|sí)\s*[!.]*$/.test(t)
    ) {
      return "yes";
    }
    return "other";
  }

  if (country === "EG") {
    if (/لسه|ليس بعد|بعدين|قريب|هسجل|أسجل/.test(text)) {
      return "not_yet";
    }
    if (/نعم|ايوه|أيوه|خلصت|سجلت|تم/.test(text)) {
      return "yes";
    }
    if (/^\s*لا\s*[!.]*$/.test(text)) {
      return "not_yet";
    }
    return "other";
  }

  if (/\b(not yet|still registering|working on it|i('m| am) (working|doing)|almost|later|soon|in progress|busy)\b/.test(t) || /^(no)\s*[!.]*$/.test(t)) {
    return "not_yet";
  }
  if (
    /^(yes|yeah|yep|done)\b/.test(t) ||
    /\b(already registered|i('ve| have) registered|i('m| am) registered|finished|done registering)\b/.test(t)
  ) {
    return "yes";
  }
  return "other";
}

export function buildInProgressFollowUpStatePatch(
  convId: string,
  nowMs = Date.now(),
): Pick<
  ConversationRuntimeState,
  "inProgressEnteredAt" | "inProgressFollowUpDueAt" | "inProgressFollowUpVariant"
> {
  return {
    inProgressEnteredAt: new Date(nowMs).toISOString(),
    inProgressFollowUpDueAt: computeInProgressFollowUpDueAt(convId, nowMs),
    inProgressFollowUpVariant: pickInProgressFollowUpVariant(convId),
  };
}

export function isInProgressFollowUpCountry(
  country: WorkerCountry,
): country is InProgressFollowUpCountry {
  return country === "ZM" || country === "CM" || country === "EG" || country === "RW" || country === "CL";
}

export function latestIncomingCustomerText(messages: PagerMessage[]): string {
  const chronological = [...messages].sort(
    (left, right) =>
      Date.parse(parseMessageTimestamp(right.createdAt)) -
      Date.parse(parseMessageTimestamp(left.createdAt)),
  );
  for (const message of chronological) {
    if (!isIncomingDirection(message.messageDirection)) {
      continue;
    }
    const text = (message.text || "").trim();
    if (text) {
      return text;
    }
  }
  return "";
}
