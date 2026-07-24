import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SCRIPTS_DIR = join(process.cwd(), "scripts", "eg");
const cache = new Map<string, string>();

export function loadLocalEgScript(scriptKey: string): string | undefined {
  const cached = cache.get(scriptKey);
  if (cached) {
    return cached;
  }

  const path = join(SCRIPTS_DIR, `${scriptKey}.txt`);
  if (!existsSync(path)) {
    return undefined;
  }

  const text = readFileSync(path, "utf8").trim();
  if (!text) {
    return undefined;
  }

  cache.set(scriptKey, text);
  return text;
}

const DEFAULT_EG_LINK = "https://tinyurl.com/Egypt0011";

/** Arabic registration instructions + link in one Pager message (EG funnel). */
export function buildEgRegistrationWithLinkMessage(): string | undefined {
  const reg = loadLocalEgScript("04_registration")?.trim();
  if (!reg) {
    return undefined;
  }
  const link = loadLocalEgScript("05_link")?.trim() || DEFAULT_EG_LINK;
  return `${reg}\n\n${link}`;
}

export function buildEgLinkOnlyMessage(): string {
  return loadLocalEgScript("05_link")?.trim() || DEFAULT_EG_LINK;
}
