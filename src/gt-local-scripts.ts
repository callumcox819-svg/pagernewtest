import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { GtReplyLanguage } from "./gt-language.js";

const SCRIPTS_ROOT = join(process.cwd(), "scripts", "gt");
const cache = new Map<string, string>();

export function loadLocalGtScript(
  scriptKey: string,
  lang: GtReplyLanguage,
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
