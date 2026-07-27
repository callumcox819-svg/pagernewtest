import type { CountryCode } from "./config.js";
import type { AppEnv } from "./env.js";
import {
  getSupportFunnelConfig,
  type SupportSnapshot,
} from "./ai-support-phase.js";
import { isCustomerClarificationMessage, isLinkAccessProblemMessage, isScamOrTrustQuestion } from "./customer-clarity.js";
import {
  type AiAssistContext,
  type AiVisionContext,
  detectImageMimeType,
  maybeAiAssistReply,
  maybeAiAssistVision,
} from "./ai-assist.js";

export type AiAgentContext = AiAssistContext;

export { detectImageMimeType, maybeAiAssistVision, type AiVisionContext };

/** Short «continue funnel» replies — scripts handle these, not the agent (pre-support only). */
const FUNNEL_ACK =
  /^(ok|okay|yes|oui|d'accord|نعم|اه|آه|تمام|طيب|حاضر|mashi|mashy|👍|👌|✅|🔥)[.!\s]*$/iu;

/** Complex thread: agent helps; mechanical steps stay on scripts. */
export function isComplexCustomerMessage(text: string): boolean {
  const t = (text || "").trim();
  if (t.length >= 100) {
    return true;
  }
  if ((t.match(/\?/g)?.length ?? 0) >= 2) {
    return true;
  }
  if (
    t.length > 25 &&
    /(why|how come|pourquoi|comment ça|لماذا|ليه|ازاي|إزاي|but |لكن |mais |pero |не пон|не ясн)/i.test(t)
  ) {
    return true;
  }
  return false;
}

export function isSimpleFunnelAcknowledgment(text: string): boolean {
  const t = (text || "").trim();
  if (!t || t.length > 40) {
    return false;
  }
  return FUNNEL_ACK.test(t) || /^[\s👍👌✅🔥🙏😊🙂]+$/u.test(t);
}

/**
 * AI Agent vs Scripts routing.
 * - Scripts: preset funnel (reg, link, deposit, ID, intro, steps).
 * - Support agent (post «в процессе»): handles coaching and complex messages for all countries.
 */
export function shouldUseAiAgent(ctx: AiAgentContext): boolean {
  if (ctx.forceSupportAgent || ctx.agentTrigger) {
    return true;
  }

  const text = ctx.customerText.trim();
  if (ctx.support?.active) {
    if (ctx.intent === "declined") {
      return false;
    }
    if (!text) {
      return false;
    }
    return true;
  }

  if (!text) {
    return false;
  }
  if (ctx.intent === "declined") {
    return false;
  }
  if (isSimpleFunnelAcknowledgment(text) && ctx.scriptKeys?.length) {
    return false;
  }
  if (isScamOrTrustQuestion(text)) {
    return true;
  }
  if (isLinkAccessProblemMessage(text)) {
    return true;
  }
  if (isCustomerClarificationMessage(text)) {
    return true;
  }
  if (isComplexCustomerMessage(text)) {
    return true;
  }
  if (
    (ctx.intent === "question" || ctx.intent === "unknown") &&
    !isSimpleFunnelAcknowledgment(text)
  ) {
    return true;
  }
  if (!ctx.scriptKeys?.length && text.length >= 4) {
    return true;
  }
  return false;
}

export async function runAiAgentTextTurn(
  env: AppEnv,
  ctx: AiAgentContext,
): Promise<string | undefined> {
  if (!env.AI_ENABLED || !env.AI_API_KEY?.trim()) {
    return undefined;
  }
  if (!shouldUseAiAgent(ctx)) {
    return undefined;
  }
  return maybeAiAssistReply(env, ctx);
}

export function shouldUseAiAgentForImage(options: {
  proofKind: string;
  caption: string;
  support?: SupportSnapshot;
}): boolean {
  if (options.support?.active) {
    if (
      options.proofKind === "registration_screenshot" ||
      options.proofKind === "id_screenshot" ||
      options.proofKind === "deposit_balance_screenshot" ||
      options.proofKind === "unclear_screenshot"
    ) {
      return true;
    }
    if (!options.caption.trim()) {
      return true;
    }
    if (isCustomerClarificationMessage(options.caption)) {
      return true;
    }
    return false;
  }
  if (options.proofKind === "unclear_screenshot") {
    return true;
  }
  if (options.proofKind === "registration_screenshot") {
    return true;
  }
  if (!options.caption.trim()) {
    return true;
  }
  if (isCustomerClarificationMessage(options.caption)) {
    return true;
  }
  return false;
}

export async function runAiAgentVisionTurn(
  env: AppEnv,
  ctx: AiVisionContext,
): Promise<string | undefined> {
  if (!env.AI_ENABLED || !env.AI_API_KEY?.trim()) {
    return undefined;
  }
  if (!shouldUseAiAgentForImage({ proofKind: ctx.proofKind, caption: ctx.caption, support: ctx.support })) {
    return undefined;
  }
  return maybeAiAssistVision(env, ctx);
}

export function supportSignalsFromOutgoing(
  country: CountryCode,
  outgoingTexts: string[],
): { regLinkSent: boolean; depositScriptSent: boolean } {
  const cfg = getSupportFunnelConfig(country);
  return {
    regLinkSent: cfg.regLinkSent(outgoingTexts),
    depositScriptSent: cfg.depositSent(outgoingTexts),
  };
}
