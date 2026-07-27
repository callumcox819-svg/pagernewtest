/** Doubt, confusion, skepticism — customer needs a human-like reply before the next script step. */

const CLARITY_PATTERNS = [
  // Arabic
  /مش\s*فاهم|مش\s*عارف|مش\s*مقتنع|هل\s*ده\s*حق|هل\s*هذا\s*حق|ممكن\s*تشرح|اشرح\s*لي|ازاي\s*بالظبط|إزاي\s*بالظبط|مش\s*واضح|مش\s*متاك|متأكد|مضمون|نصب|احتيال|حقيق|واثق/i,
  // French
  /pas\s*compris|je\s*ne\s*comprends|vraiment\s*vrai|est-ce\s*(que\s*)?(vrai|s[eé]rieux|sûr|sur)|arnaque|escroc|comment\s*faire|explique|pas\s*clair/i,
  // English
  /don'?t\s*understand|do\s*not\s*understand|not\s*clear|is\s*this\s*(real|true|legit|a\s*scam|scam)|are\s*you\s*sure|how\s*exactly|what\s*do\s*i\s*need|confus|scam|trust|fraud|fake|legit/i,
  // Russian / Ukrainian (common in operator chats)
  /не\s*понима|не\s*понят|точно\s*ли|правда\s*ли|это\s*правда|как\s*именно|как\s*надо|обман|развод|не\s*верю|это\s*скам|скам\??|мошен/i,
  /\?/,
];

const SHORT_REG_TECH_HELP =
  /(sms|код|code|otp|chrome|линк|link|url|tinyurl|eg011|cash056|zam577|promo)/i;

/** True when the customer needs reassurance or explanation, not the next funnel preset yet. */
export function isCustomerClarificationMessage(text: string): boolean {
  const t = (text || "").trim();
  if (!t || t.length < 3) {
    return false;
  }
  if (t.length > 400) {
    return false;
  }
  if (!CLARITY_PATTERNS.some((pattern) => pattern.test(t))) {
    return false;
  }
  // Pure "send link / promo code" tech requests stay on script path.
  if (SHORT_REG_TECH_HELP.test(t) && !/(مش|pas|don'?t|не\s*пон)/i.test(t)) {
    return false;
  }
  return true;
}

/** «Это скам?» / arnaque / احتيال — always agent, never a bare script skip. */
export function isScamOrTrustQuestion(text: string): boolean {
  const t = (text || "").trim();
  if (!t) {
    return false;
  }
  return /(scam|скам|мошен|развод|обман|arnaque|escroc|fraude|fake|n'?est\s*pas\s*vrai|احتيال|نصب|نصبة|هل\s*.*نصب|حقيق)/i.test(t);
}
