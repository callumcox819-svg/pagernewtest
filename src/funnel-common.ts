import type { CountryCode } from "./config.js";

export function registrationLinkScriptKeys(
  country: CountryCode,
  linkAlreadySent: boolean,
): string[] {
  if (country === "CM") {
    return linkAlreadySent ? ["06_link"] : ["05_registration", "06_link", "07_chrome"];
  }
  if (country === "EG") {
    return linkAlreadySent ? ["05_link"] : ["04_registration", "05_link"];
  }
  return linkAlreadySent ? ["05_link"] : ["04_registration", "05_link"];
}

export function registrationHelpScriptKeys(country: CountryCode): string[] {
  if (country === "CM") {
    return ["05_registration", "06_link", "07_chrome"];
  }
  if (country === "EG") {
    return ["04_registration", "05_link"];
  }
  return ["04_registration", "05_link"];
}
