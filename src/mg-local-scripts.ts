import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_MG_LINK = "https://tinyurl.com/MDG56";

const EMBEDDED_MG_SCRIPTS: Record<string, string> = {
  "05_link": DEFAULT_MG_LINK,
};

const cache = new Map<string, string>();

function resolveMgScriptsDir(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(moduleDir, "..", "scripts", "mg"),
    join(process.cwd(), "scripts", "mg"),
    join(process.cwd(), "dist", "scripts", "mg"),
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, "01_intro.txt"))) {
      return dir;
    }
  }
  return candidates[0]!;
}

export function loadLocalMgScript(scriptKey: string): string | undefined {
  const cached = cache.get(scriptKey);
  if (cached) {
    return cached;
  }

  const path = join(resolveMgScriptsDir(), `${scriptKey}.txt`);
  if (existsSync(path)) {
    const text = readFileSync(path, "utf8").trim();
    if (text) {
      cache.set(scriptKey, text);
      return text;
    }
  }

  const embedded = EMBEDDED_MG_SCRIPTS[scriptKey]?.trim();
  if (embedded) {
    cache.set(scriptKey, embedded);
    return embedded;
  }

  return undefined;
}

export function mgDefaultRegistrationLink(): string {
  return loadLocalMgScript("05_link")?.trim() || DEFAULT_MG_LINK;
}
