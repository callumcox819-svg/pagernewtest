import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import type { AppEnv } from "./env.js";
import type { AppMetaStore } from "./app-meta-store.js";
import type { XPartnersCountry, XPartnersQuickStats } from "./xpartners-client.js";
import {
  loadGlobalPartnerStats,
  saveGlobalPartnerStats,
  type GlobalPartnerStatsState,
} from "./xpartners-stats-cache.js";

export const XPARTNERS_POSTBACK_META_KEY = "xpartners_postback_day";

const XP_REPORT_TIMEZONE = "Europe/Kyiv";
const MAX_DEDUPE_IDS = 500;

type PostbackEvent = "reg" | "ftd";

type PostbackDayState = {
  dayKey: string;
  byCountry: Partial<
    Record<
      XPartnersCountry,
      {
        registrations: number;
        ftd: number;
        seen: string[];
      }
    >
  >;
};

export function usesPostbackStats(env: AppEnv): boolean {
  return env.XPARTNERS_STATS_SOURCE === "postback";
}

function todayDayKey(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: XP_REPORT_TIMEZONE }).format(new Date());
}

function siteLabel(country: XPartnersCountry, env: AppEnv): string {
  if (country === "CM") {
    return env.XPARTNERS_SITE_CM;
  }
  if (country === "EG") {
    return env.XPARTNERS_SITE_EG;
  }
  if (country === "ZM") {
    return env.XPARTNERS_SITE_ZM;
  }
  return env.XPARTNERS_SITE_RW;
}

function parseCountry(raw: string | null): XPartnersCountry | null {
  const code = (raw || "").trim().toUpperCase();
  if (code === "CM" || code === "EG" || code === "ZM" || code === "RW") {
    return code;
  }
  return null;
}

function parseEvent(raw: string | null): PostbackEvent | null {
  const value = (raw || "").trim().toLowerCase();
  if (!value) {
    return null;
  }
  if (value === "reg" || value === "registration" || value === "registrations" || value === "signup") {
    return "reg";
  }
  if (
    value === "ftd" ||
    value === "deposit" ||
    value === "first_deposit" ||
    value === "firstdeposit" ||
    value === "new_deposit"
  ) {
    return "ftd";
  }
  return null;
}

function dedupeKey(params: URLSearchParams): string | null {
  for (const key of ["click_id", "clickid", "clickId", "player_id", "playerId", "subid", "sub_id"]) {
    const value = params.get(key)?.trim();
    if (value) {
      return `${key}:${value}`;
    }
  }
  return null;
}

async function loadPostbackDay(meta: AppMetaStore): Promise<PostbackDayState> {
  const dayKey = todayDayKey();
  const raw = (await meta.get(XPARTNERS_POSTBACK_META_KEY))?.trim();
  if (!raw) {
    return { dayKey, byCountry: {} };
  }
  try {
    const parsed = JSON.parse(raw) as PostbackDayState;
    if (parsed.dayKey !== dayKey) {
      return { dayKey, byCountry: {} };
    }
    return parsed;
  } catch {
    return { dayKey, byCountry: {} };
  }
}

async function savePostbackDay(meta: AppMetaStore, state: PostbackDayState): Promise<void> {
  await meta.set(XPARTNERS_POSTBACK_META_KEY, JSON.stringify(state));
}

async function syncGlobalStatsCache(meta: AppMetaStore, env: AppEnv, day: PostbackDayState): Promise<void> {
  const global = await loadGlobalPartnerStats(meta);
  const countries: XPartnersCountry[] = ["CM", "EG", "ZM", "RW"];
  const byCountry: GlobalPartnerStatsState["byCountry"] = { ...(global.byCountry ?? {}) };
  const fetchedAt = new Date().toISOString();
  for (const country of countries) {
    const bucket = day.byCountry[country];
    byCountry[country] = {
      registrations: bucket?.registrations ?? 0,
      newAccountsWithDeposits: bucket?.ftd ?? 0,
      fetchedAt,
      siteLabel: siteLabel(country, env),
    };
  }
  await saveGlobalPartnerStats(meta, {
    refreshIntervalHours: global.refreshIntervalHours,
    cachedAt: fetchedAt,
    byCountry,
  });
}

export async function loadPostbackCountryStats(
  meta: AppMetaStore,
  env: AppEnv,
  country: XPartnersCountry,
): Promise<XPartnersQuickStats> {
  const day = await loadPostbackDay(meta);
  const bucket = day.byCountry[country];
  return {
    registrations: bucket?.registrations ?? 0,
    newAccountsWithDeposits: bucket?.ftd ?? 0,
    fetchedAt: new Date().toISOString(),
    siteLabel: siteLabel(country, env),
  };
}

export async function handlePostbackRequest(
  meta: AppMetaStore,
  env: AppEnv,
  params: URLSearchParams,
): Promise<{ ok: true; country: XPartnersCountry; event: PostbackEvent } | { ok: false; status: number; message: string }> {
  const token = env.XPARTNERS_POSTBACK_TOKEN?.trim();
  if (token) {
    const got = params.get("token")?.trim();
    if (got !== token) {
      return { ok: false, status: 403, message: "invalid token" };
    }
  }

  const country = parseCountry(params.get("country") ?? params.get("geo") ?? params.get("c"));
  if (!country) {
    return { ok: false, status: 400, message: "missing country=CM|EG|ZM|RW" };
  }

  const event = parseEvent(params.get("event") ?? params.get("type") ?? params.get("postback_type"));
  if (!event) {
    return { ok: false, status: 400, message: "missing event=reg|ftd" };
  }

  const day = await loadPostbackDay(meta);
  const bucket = day.byCountry[country] ?? { registrations: 0, ftd: 0, seen: [] as string[] };
  const idKey = dedupeKey(params);
  if (idKey && bucket.seen.includes(idKey)) {
    await syncGlobalStatsCache(meta, env, day);
    return { ok: true, country, event };
  }

  if (event === "reg") {
    bucket.registrations += 1;
  } else {
    bucket.ftd += 1;
  }
  if (idKey) {
    bucket.seen = [...bucket.seen, idKey].slice(-MAX_DEDUPE_IDS);
  }
  day.byCountry[country] = bucket;
  await savePostbackDay(meta, day);
  await syncGlobalStatsCache(meta, env, day);
  console.log(`1xPartners postback: ${country} ${event}${idKey ? ` · ${idKey}` : ""}`);
  return { ok: true, country, event };
}

function writeText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(body);
}

async function readUrl(req: IncomingMessage): Promise<URL> {
  const host = req.headers.host || "localhost";
  return new URL(req.url || "/", `http://${host}`);
}

export function startXPartnersPostbackServer(env: AppEnv, meta: AppMetaStore): void {
  if (!usesPostbackStats(env)) {
    return;
  }
  const port = Number(process.env.PORT || 3000);
  const publicBase = (env.XPARTNERS_POSTBACK_PUBLIC_URL || "").replace(/\/$/, "");

  const server = createServer((req, res) => {
    void (async () => {
      try {
        if (req.method !== "GET" && req.method !== "HEAD") {
          writeText(res, 405, "method not allowed");
          return;
        }
        const url = await readUrl(req);
        if (url.pathname === "/health" || url.pathname === "/") {
          writeText(res, 200, "ok");
          return;
        }
        if (url.pathname !== "/xpartners/postback") {
          writeText(res, 404, "not found");
          return;
        }
        const result = await handlePostbackRequest(meta, env, url.searchParams);
        if (!result.ok) {
          writeText(res, result.status, result.message);
          return;
        }
        if (req.method === "HEAD") {
          res.writeHead(204);
          res.end();
          return;
        }
        writeText(res, 200, "ok");
      } catch (error) {
        console.warn("1xPartners postback error:", error instanceof Error ? error.message : error);
        writeText(res, 500, "error");
      }
    })();
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(`1xPartners postback server on :${port} · path /xpartners/postback`);
    if (publicBase) {
      console.log(`1xPartners postback URL example: ${publicBase}/xpartners/postback?token=***&country=CM&event=reg&click_id={click_id}`);
    } else {
      console.warn("1xPartners: set XPARTNERS_POSTBACK_PUBLIC_URL to your Railway public domain for postback setup.");
    }
  });
}

export function postbackSetupHint(env: AppEnv): string {
  const base = (env.XPARTNERS_POSTBACK_PUBLIC_URL || "https://YOUR-RAILWAY-DOMAIN").replace(/\/$/, "");
  const token = env.XPARTNERS_POSTBACK_TOKEN?.trim();
  const tokenPart = token ? `token=${encodeURIComponent(token)}&` : "";
  return [
    `${base}/xpartners/postback?${tokenPart}country=CM&event=reg&click_id={click_id}`,
    `${base}/xpartners/postback?${tokenPart}country=CM&event=ftd&click_id={click_id}`,
  ].join("\n");
}
