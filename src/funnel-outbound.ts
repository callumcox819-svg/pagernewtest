import type { CountryCode } from "./config.js";
import { CM_SCRIPT_SEARCH_NEEDLES } from "./cm-script-engine.js";
import { EG_SCRIPT_SEARCH_NEEDLES } from "./eg-script-engine.js";
import { ZM_SCRIPT_SEARCH_NEEDLES } from "./zm-script-engine.js";

const EXTRA_EG_OUTBOUND =
  /(أهلاً، إذا كنت مهتمًا|اهلا، اذا كنت مهتم|هتعمل حساب من اللينك|السكرين مش واضح|مرحبًا\. تحقق استراتيجياتنا)/i;

function needlesForCountry(country: CountryCode): string[] {
  const map =
    country === "EG"
      ? EG_SCRIPT_SEARCH_NEEDLES
      : country === "CM"
        ? CM_SCRIPT_SEARCH_NEEDLES
        : ZM_SCRIPT_SEARCH_NEEDLES;
  return Object.values(map).flat();
}

export function isAutomatedFunnelOutgoing(text: string, country: CountryCode): boolean {
  const t = (text || "").trim();
  if (!t) {
    return false;
  }
  if (country === "EG" && EXTRA_EG_OUTBOUND.test(t)) {
    return true;
  }
  const lower = t.toLowerCase();
  for (const needle of needlesForCountry(country)) {
    const normalized = needle.trim().toLowerCase();
    if (!normalized) {
      continue;
    }
    if (normalized.length >= 10 && lower.includes(normalized)) {
      return true;
    }
    if (normalized.length >= 4 && lower.includes(normalized) && t.length <= 240) {
      return true;
    }
  }
  return false;
}
