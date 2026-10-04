export type EcReplyLanguage = "es" | "en" | "fr";

const FR_MARKERS =
  /\b(je suis|cela m'int|j'ai besoin|vous faites|intéressé|interesse|bonjour|merci|quoi|français|d'accord|âge|age avez)\b/i;
const ES_MARKERS =
  /\b(hola|me interesa|estoy interesad|buenos|buenas|qué|que tal|español|spanish|te hablo|gracias|cuántos|cuantos)\b/i;
const EN_MARKERS =
  /\b(good (morning|afternoon|evening)|i'm interested|i am interested|hello|hi there|need help|how old|what do you)\b/i;

/** Pick script language for Ecuador from the customer thread (default Spanish). */
export function detectEcCustomerLanguage(
  text: string,
  recentTexts: string[] = [],
): EcReplyLanguage {
  const blob = [text, ...recentTexts].filter(Boolean).join("\n");
  const lower = blob.toLowerCase();
  if (/[ñ¿¡]/.test(blob) || ES_MARKERS.test(lower)) {
    return "es";
  }
  if (EN_MARKERS.test(lower) && !FR_MARKERS.test(lower)) {
    return "en";
  }
  if (FR_MARKERS.test(lower) || /[àâçéèêëïîôùûü]/.test(lower)) {
    return "fr";
  }
  return "es";
}

export function resolveEcReplyLanguage(
  customerText: string,
  recentTexts: string[],
  stored?: EcReplyLanguage,
): EcReplyLanguage {
  const detected = detectEcCustomerLanguage(customerText, recentTexts);
  if (!stored) {
    return detected;
  }
  // Keep first locked language unless customer clearly switched (strong markers).
  if (stored === detected) {
    return stored;
  }
  const strongSwitch =
    (stored === "es" && (EN_MARKERS.test(customerText) || FR_MARKERS.test(customerText))) ||
    (stored === "en" && ES_MARKERS.test(customerText)) ||
    (stored === "fr" && ES_MARKERS.test(customerText));
  return strongSwitch ? detected : stored;
}

export function describeEcLanguage(lang: EcReplyLanguage): string {
  if (lang === "en") {
    return "English";
  }
  if (lang === "fr") {
    return "French";
  }
  return "Spanish";
}
