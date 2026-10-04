import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EcReplyLanguage } from "./ec-language.js";

const SCRIPTS_ROOT = join(process.cwd(), "scripts", "ec");
const cache = new Map<string, string>();

export function loadLocalEcScript(
  scriptKey: string,
  lang: EcReplyLanguage,
): string | undefined {
  const cacheKey = `${lang}:${scriptKey}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const path = join(SCRIPTS_ROOT, lang, `${scriptKey}.txt`);
  if (!existsSync(path)) {
    return undefined;
  }

  const text = readFileSync(path, "utf8").trim();
  if (!text) {
    return undefined;
  }

  cache.set(cacheKey, text);
  return text;
}
