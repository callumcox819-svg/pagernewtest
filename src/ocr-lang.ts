import { resolvePlaybookCountry, type CountryCode } from "./config.js";

export function ocrLangForCountry(country: CountryCode | string): string {
  switch (resolvePlaybookCountry(country)) {
    case "CM":
      return "fra+eng";
    case "EG":
      return "ara+eng";
    default:
      return "eng";
  }
}
