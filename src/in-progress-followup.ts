import type { WorkerCountry } from "./rw-learn.js";
import type { ConversationRuntimeState } from "./state-store.js";

/** Markets that get delayed «в процессе» check-ins (each in its own language). */
export type InProgressFollowUpCountry = "ZM" | "CM" | "EG" | "RW" | "CL";

export const IN_PROGRESS_FOLLOWUP_MIN_MS = 10 * 60 * 1000;
export const IN_PROGRESS_FOLLOWUP_MAX_MS = 15 * 60 * 1000;

/** ZM/RW English, CM French, EG Arabic — aligned with AI market languages. */
const FOLLOWUP_NEEDLES: Record<InProgressFollowUpCountry, string[]> = {
  ZM: ["have you already registered", "what stage are you at"],
  RW: ["have you already registered", "what stage are you at"],
  CM: ["déjà inscrit", "quelle étape"],
  CL: ["ya te registraste", "en qué etapa"],
  EG: ["هل قمت بالتسجيل", "في أي مرحلة"],
};

const FOLLOWUP_MESSAGES: Record<InProgressFollowUpCountry, [string, string]> = {
  ZM: ["Have you already registered?", "What stage are you at now?"],
  RW: ["Have you already registered?", "What stage are you at now?"],
  CM: ["Vous êtes déjà inscrit(e) ?", "À quelle étape en êtes-vous ?"],
  CL: ["¿Ya te registraste?", "¿En qué etapa estás ahora?"],
  EG: ["هل قمت بالتسجيل بالفعل؟", "في أي مرحلة أنت الآن؟"],
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

export function shouldSendInProgressFollowUp(
  convState: ConversationRuntimeState,
  nowMs = Date.now(),
): boolean {
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
