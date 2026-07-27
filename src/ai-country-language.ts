import type { CountryCode } from "./config.js";
import { containsArabicScript } from "./eg-script-engine.js";

/** Customer-facing language per market — extend when adding countries. */
export const AI_MARKET_LANGUAGE: Record<
  CountryCode,
  { label: string; neverUse: string }
> = {
  EG: {
    label: "Arabic (Egyptian dialect is fine)",
    neverUse: "English, French, or Russian",
  },
  CM: {
    label: "French",
    neverUse: "English, Arabic, or Russian",
  },
  ZM: {
    label: "English",
    neverUse: "French, Arabic, or Russian",
  },
};

export function buildAiLanguageLockRule(country: CountryCode): string {
  const { label, neverUse } = AI_MARKET_LANGUAGE[country];
  return [
    `CRITICAL LANGUAGE: The customer is in market ${country}.`,
    `Write your ENTIRE reply ONLY in ${label}.`,
    `Do NOT use ${neverUse} in the reply (except brand names like 1xBET or MTN).`,
    "Mirror the customer's tone but stay in that language.",
  ].join(" ");
}

/** Soft check — used to trigger one regeneration if the model replied in the wrong language. */
export function aiReplyLooksWrongLanguage(country: CountryCode, reply: string): boolean {
  const text = reply.trim();
  if (!text || text.length < 8) {
    return false;
  }
  if (country === "EG") {
    return !containsArabicScript(text);
  }
  if (country === "CM") {
    if (containsArabicScript(text)) {
      return true;
    }
    const latinOnly = /^[\s\d\p{L}.,!?;:'"()\-+$/€£%@#&*[\]]+$/u.test(text);
    const hasFrenchHint =
      /\b(je|tu|vous|merci|bonjour|d'accord|dépôt|depot|lien|capture|écran|ecran|patience|boss|inscription|c'est|n'|qu'|pas|pour|avec|une|des|le|la|les)\b/i.test(
        text,
      );
    return latinOnly && !hasFrenchHint && text.length > 25;
  }
  if (country === "ZM") {
    if (containsArabicScript(text)) {
      return true;
    }
    const hasFrenchHint =
      /\b(je|vous|merci|bonjour|d'accord|dépôt|inscription|c'est)\b/i.test(text);
    return hasFrenchHint;
  }
  return false;
}

export function describeAiMarketLanguage(country: CountryCode): string {
  return AI_MARKET_LANGUAGE[country].label;
}
