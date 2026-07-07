import type { CountryCode, PlaybookConfig, TemplateRole } from "./config.js";

export type SpecialCustomerIntent =
  | "no_money"
  | "deferral"
  | "declined"
  | "money_request"
  | "scam_accusation"
  | "none";

const FR_NO_MONEY =
  /\b(pas d['']?argent|pas de argent|pas d argent|j['']?ai pas d['']?argent|je n['']?ai pas d['']?argent|je n ai pas d argent|sans argent|manque d['']?argent|pas les moyens|pas de sous|pas de fric|no money)\b/i;
const FR_DEFERRAL =
  /\b(plus tard|pas maintenant|pas maintenant|demain|une autre fois|quand j['']?aurai|quand j aurai|je suis occupe|je suis occupé|trop occupe|trop occupé|pas le temps|je reviens)\b/i;
const FR_DECLINED =
  /\b(pas intéressé|pas interesse|je ne suis pas intéressé|non merci|laisse moi|arrête|arrete|stop)\b/i;
const FR_SCAM = /\b(arnaque|escroc|scam|voleur|nigerian|nigérian)\b/i;

const EN_NO_MONEY =
  /\b(no money|don't have money|do not have money|not enough money|broke|can't afford|cannot afford|no funds|no cash)\b/i;
const EN_DEFERRAL =
  /\b(later|not now|tomorrow|another time|when i have|too busy|no time|come back|not ready yet)\b/i;
const EN_DECLINED = /\b(not interested|no thanks|leave me|stop texting|go away)\b/i;

const AR_NO_MONEY =
  /(مش معايه فلوس|مش معاي فلوس|معنديش فلوس|مفيش فلوس|لا فلوس|بدون فلوس|مصاري|مش معايا فلوس|ما عندي فلوس)/i;
const AR_DEFERRAL = /(بعدين|مش دلوقتي|مش الآن|لاحقا|لاحقاً|مشغول|مش فاضي|ارجع|ارجعلك)/i;
const AR_DECLINED = /(مش مهتم|مش مهتمة|مش عايز|مش عاوز|سيبني|بطل|لا شكرا)/i;
const AR_SCAM = /(نصب|نصاب|احتيال|سكام|حرامي)/i;

const FR_MONEY_REQUEST =
  /\b(prête[- ]moi|pret[- ]moi|donne[- ](moi )?(de l')?argent|envoy\w*[- ](moi )?(de l')?argent|besoin d['']?argent|besoin d argent)\b/i;
const EN_MONEY_REQUEST =
  /\b(send(ing)?\s+me\s+(money|cash|funds)|give\s+me\s+(money|cash|funds)|lend\s+me|loan\s+me|need\s+money|want\s+money)\b/i;
const AR_MONEY_REQUEST =
  /(فلوس|محتاج\s*فلوس|عايز\s*فلوس|عاوز\s*فلوس|ابعت(لي|ولي)\s*فلوس|ارسل(لي|ني)\s*فلوس|اديني\s*فلوس)/i;

export function normalizeCustomerText(value?: string): string {
  return (value || "")
    .trim()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/['’]/g, "'")
    .replace(/\s+/g, " ");
}

export function classifySpecialCustomerIntent(
  playbook: PlaybookConfig,
  text: string,
): SpecialCustomerIntent {
  const t = normalizeCustomerText(text);
  if (!t) {
    return "none";
  }

  if (matchesPlaybookKeywords(playbook.noMoneyKeywords, t)) {
    return "no_money";
  }
  if (matchesPlaybookKeywords(playbook.notReadyKeywords ?? [], t)) {
    return "deferral";
  }

  if (FR_SCAM.test(t) || EN_DECLINED.test(t) && /scam|fraud/i.test(t) || AR_SCAM.test(t)) {
    return "scam_accusation";
  }
  if (FR_DECLINED.test(t) || EN_DECLINED.test(t) || AR_DECLINED.test(t)) {
    return "declined";
  }
  if (FR_MONEY_REQUEST.test(t) || EN_MONEY_REQUEST.test(t) || AR_MONEY_REQUEST.test(t)) {
    return "money_request";
  }
  if (FR_NO_MONEY.test(t) || EN_NO_MONEY.test(t) || AR_NO_MONEY.test(t)) {
    return "no_money";
  }
  if (FR_DEFERRAL.test(t) || EN_DEFERRAL.test(t) || AR_DEFERRAL.test(t)) {
    return "deferral";
  }

  return "none";
}

export function specialIntentTemplateRole(intent: SpecialCustomerIntent): TemplateRole | undefined {
  switch (intent) {
    case "no_money":
    case "deferral":
      return "no_money";
    default:
      return undefined;
  }
}

export function moneyRefusalText(country: CountryCode): string {
  switch (country) {
    case "CM":
      return "Nous ne donnons pas d'argent — nous vous aidons seulement à gagner avec nos tactiques. Quand vous serez prêt à investir, écrivez-moi.";
    case "EG":
      return "نحن لا نُعطي أموالاً، بل نساعدك فقط على الكسب بالتكتيكات. عندما تكون جاهزاً للاستثمار، راسلني.";
    default:
      return "We don't give money — we only help you earn with our tactics. Message me when you're ready to invest.";
  }
}

export function matchesPlaybookKeywords(keywords: string[], text: string): boolean {
  const normalized = normalizeCustomerText(text);
  if (!normalized) {
    return false;
  }
  return keywords.some((keyword) => normalized.includes(normalizeCustomerText(keyword)));
}
