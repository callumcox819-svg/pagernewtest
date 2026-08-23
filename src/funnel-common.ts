import type { CountryCode } from "./config.js";

/** Customer explicitly asks for registration link / instructions — scripts, not AI. */
export function customerRequestsRegistrationMaterials(text: string): boolean {
  const t = (text || "").trim();
  if (!t) {
    return false;
  }
  if (
    /\bhelp\b.{0,50}\b(instruction|instructions|steps|link|register|registration|account|sign[\s-]?up)\b/i.test(
      t,
    )
  ) {
    return true;
  }
  if (
    /\b(give|send|share|need|want|show|provide|help).{0,40}\b(instruction|instructions|steps|link|registration)\b/i.test(
      t,
    )
  ) {
    return true;
  }
  if (
    /\b(instruction|instructions|steps)\b.{0,40}\b(please|help|need|want|with|me)\b/i.test(t)
  ) {
    return true;
  }
  if (/\bhow\s+(do\s+i|to)\s+(register|sign[\s-]?up|start|begin|join)\b/i.test(t)) {
    return true;
  }
  if (/\b(donn|envoy|envoi|envoyer|envoyez).{0,30}\b(lien|link|instruction)\b/i.test(t)) {
    return true;
  }
  if (/\b(aide|help).{0,40}\b(lien|link|inscri|instruction|étape|etape|register)\b/i.test(t)) {
    return true;
  }
  return false;
}

/** «Yes» / «ready» after offer table — proceed to registration, not free-form AI chat. */
export function customerAgreedAfterOfferTable(text: string): boolean {
  const t = (text || "").trim();
  if (!t || /\b(not interested|no thanks|stop|scam|leave me alone)\b/i.test(t)) {
    return false;
  }
  if (/^(yes|yeah|yep|ok|okay|sure|alright|oui|d'accord|si|sí|listo|vale)[\s,!.]*$/i.test(t)) {
    return true;
  }
  return (
    /\b(yes|yeah|yep|ok|okay|sure|oui|d'accord|si|sí|listo|vale)\b/i.test(t) &&
    /\b(start|begin|ready|kwacha|zmw|deposit|register|instruction|instructions|link|lien|help|aide|inscri)\b/i.test(
      t,
    )
  );
}

export function registrationLinkScriptKeys(
  country: CountryCode,
  linkAlreadySent: boolean,
): string[] {
  if (country === "CM") {
    return linkAlreadySent
      ? ["06_link", "07_chrome", "07_mtn_tip"]
      : ["05_registration", "06_link", "07_chrome", "07_mtn_tip"];
  }
  if (country === "EG") {
    return linkAlreadySent ? ["05_link"] : ["04_registration", "05_link"];
  }
  return linkAlreadySent ? ["05_link"] : ["04_registration", "05_link"];
}

export function registrationHelpScriptKeys(country: CountryCode): string[] {
  if (country === "CM") {
    return ["05_registration", "06_link", "07_chrome", "07_mtn_tip"];
  }
  if (country === "EG") {
    return ["04_registration", "05_link"];
  }
  return ["04_registration", "05_link"];
}

/** Customer still not registered — resend link/scripts, never deposit / game ID. */
export function registrationResendScriptKeys(
  country: CountryCode,
  linkAlreadySent: boolean,
): string[] {
  if (linkAlreadySent) {
    if (country === "CM") {
      return ["06_link", "07_chrome", "07_mtn_tip"];
    }
    return ["05_link"];
  }
  return registrationHelpScriptKeys(country);
}
