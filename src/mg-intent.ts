import { isPositiveMessageReaction } from "./message-attachments.js";
import { isCustomerSaysNotRegisteredYet } from "./customer-clarity.js";
import {
  customerAgreedAfterOfferTable,
  customerRequestsRegistrationMaterials,
} from "./funnel-common.js";
import {
  isCustomMarketDepositAmount,
  normalizeDepositText,
  type CustomDepositRules,
} from "./market-deposit-choice.js";

export type MgIntent =
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

export const MG_CUSTOM_DEPOSIT_RULES: CustomDepositRules = {
  min: 500,
  max: 500_000,
  bareMin: 800,
  currencyPattern: /\b(mga|ariary|ar)\b/i,
  depositIntentPattern:
    /\b(deposit|depot|dépôt|start with|begin with|invest|put in|with|can i start|want to start|ready to start|mets|mettre|investir|avec|pour|commencer)\b/i,
};

const INTERESTED =
  /\b(intéressé|interesse|interessé|ça m'intéresse|ca m'interesse|dis[- ]moi|explique|je veux|interested|tell me more)\b/i;
const POSITIVE =
  /\b(oui|ouais|ok|okay|okey|d'accord|daccord|dac|bien|super|parfait|merci|yes|yeah|yep|sure|continue|vas[- ]y)\b/i;
const READY =
  /\b(je suis prêt|je suis prete|prêt|prete|ready|on commence|allons[- ]y|je suis partant|c'est bon)\b/i;
const GREETING = /^(salut|bonjour|bonsoir|hey|hello|hi|yo)([\s,!.]|$)/i;
const JOINED =
  /\b(je me suis inscrit|inscrit|inscription (faite|terminée|termine)|j'ai créé|j ai cree|account created|registered)\b/i;
const DECLINED = /\b(pas intéressé|pas interesse|non merci|stop|arnaque|scam|laisse[- ]moi)\b/i;
const BARE_DECLINED = /^(non|nah|nope|jamais|rien|non merci)\.?!*$/i;
const DEPOSIT_DONE =
  /\b(j'ai (fait|déposé|depose)|dépôt (fait|terminé|termine)|deposit done|deposited|après (le )?dépôt)\b/i;
const GAME_ID = /\b(17\d{6,}|16\d{6,}|identifiant\s*\d+|id\s*\d+)\b/i;
const POSITIVE_EMOJI = /^[\s👍👌✅🔥❤️🙏😊🙂]+$/u;
const FR_LINK_ASK =
  /\b(?:envoie|envoyer|envoyez|donne|donner|besoin|veux|veut|où|ou).{0,28}\b(?:lien|link)\b|\b(?:lien|link)\b.{0,28}\b(?:svp|s'il|sil|please|inscription|register)\b|\blien\s+d['']inscription\b/i;
const REGISTRATION_HELP =
  /\b(code promo|quel code|quel promo|créer (le )?compte|creer (le )?compte|comment (m')?inscri|comment s'inscri|prochaine étape|prochaine etape|quoi faire)\b/i;

export function classifyMgIntent(
  text: string,
  options?: {
    hasImage?: boolean;
    funnelStep?: number;
    messageReaction?: string;
  },
): MgIntent {
  const t = (text || "").trim();
  if (!t && options?.hasImage) {
    return "image_only";
  }
  if (!t) {
    if (isPositiveMessageReaction(options?.messageReaction)) {
      return "positive";
    }
    return "unknown";
  }
  if (BARE_DECLINED.test(t) || DECLINED.test(t)) {
    return "declined";
  }
  if (GAME_ID.test(t)) {
    return "game_id_text";
  }
  if (DEPOSIT_DONE.test(t)) {
    return "deposit_done";
  }
  if (JOINED.test(t)) {
    return "joined";
  }
  if (READY.test(t)) {
    return "ready";
  }
  if (INTERESTED.test(t)) {
    return "interested";
  }
  if (POSITIVE.test(t) || POSITIVE_EMOJI.test(t) || isPositiveMessageReaction(options?.messageReaction)) {
    return "positive";
  }
  if (/\?/.test(t) || /^(comment|pourquoi|c'est quoi|cest quoi|quoi)/i.test(t)) {
    return "question";
  }
  if (GREETING.test(t)) {
    return "interested";
  }
  return "unknown";
}

export function isFunnelPositiveReaction(text: string, _effectiveStep: number): boolean {
  const t = (text || "").trim();
  return POSITIVE.test(t) || READY.test(t) || POSITIVE_EMOJI.test(t) || INTERESTED.test(t);
}

export function isReadyForRegistration(text: string): boolean {
  const t = (text || "").trim();
  return (
    READY.test(t) ||
    customerAgreedAfterOfferTable(t) ||
    isMgDepositAmountChoice(t) ||
    /\b(prêt|prete|ready|commencer|on y va|c'est parti)\b/i.test(t)
  );
}

export function isRegistrationConfirmed(text: string): boolean {
  const t = (text || "").trim().toLowerCase();
  return (
    JOINED.test(t) ||
    /\b(déjà inscrit|deja inscrit|j'ai (fini|fait|inscrit|enregistr)|c'est (fait|bon)|je suis inscrit|terminé|termine)\b/i.test(
      t,
    )
  );
}

export function isRegistrationHelpRequest(text: string): boolean {
  const t = (text || "").trim();
  return REGISTRATION_HELP.test(t) || customerRequestsRegistrationMaterials(t);
}

export function isMgRegistrationAccountQuestion(text: string): boolean {
  const t = (text || "").trim().toLowerCase();
  return (
    /\b(compte|account|inscription|register|email|e-mail|chrome|navigateur|code promo|mad778)\b/i.test(t) &&
    (/\?/.test(t) || /\b(comment|aide|help|problème|probleme)\b/i.test(t))
  );
}

export function isBarePostLinkAcknowledgment(text: string, intent: MgIntent): boolean {
  const t = (text || "").trim();
  if (!t) {
    return false;
  }
  if (intent === "declined" || intent === "joined" || intent === "deposit_done" || intent === "game_id_text") {
    return false;
  }
  return /^(ok|okay|okey|oui|d'accord|daccord|merci|thanks|thank you|super|parfait|hum+|hm+|mhm+)[.!\s]*$/i.test(
    t,
  );
}

export function wantsDetailsAfterIntro(text: string): boolean {
  const t = (text || "").trim();
  return (
    INTERESTED.test(t) ||
    POSITIVE.test(t) ||
    READY.test(t) ||
    /\b(détail|detail|explique|comment|plus|suite|continue)\b/i.test(t)
  );
}

export function wantsRegistrationLink(text: string): boolean {
  const t = (text || "").trim();
  return FR_LINK_ASK.test(t) || customerRequestsRegistrationMaterials(t);
}

export function isMgDepositAmountChoice(text: string): boolean {
  const t = normalizeDepositText(text);
  if (!t) {
    return false;
  }
  if (
    /\b(4000|8000|15000|30000)\b/.test(t) &&
    (/\bmga\b/.test(t) || /\b(deposit|depot|dépôt|choisir|préfère|prefere|celui|celui[- ]là)\b/i.test(t) || t.length < 40)
  ) {
    return true;
  }
  return isCustomMarketDepositAmount(text, MG_CUSTOM_DEPOSIT_RULES);
}

export { isCustomerSaysNotRegisteredYet };
