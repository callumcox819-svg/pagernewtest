import makeFetchCookie from "fetch-cookie";
import { CookieJar } from "tough-cookie";
import type { AppEnv } from "./env.js";
import type { AppMetaStore } from "./app-meta-store.js";

export const XPARTNERS_SESSION_META_KEY = "xpartners_session_cookie";

export type XPartnersCountry = "CM" | "EG" | "ZM";

export type XPartnersQuickStats = {
  registrations: number;
  newAccountsWithDeposits: number;
  fetchedAt: string;
  siteLabel: string;
};

type GraphQlBatchItem = {
  operationName: string;
  variables?: Record<string, unknown>;
  query: string;
};

const BASE = "https://1xpartners.com";
const GRAPHQL = `${BASE}/graphql`;

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept: "application/json",
  "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8",
};

const SIGN_IN_MUTATION = `
mutation SignIn($login: String!, $password: String!, $recaptcha: String!, $likePartner: Boolean, $isOwnCaptcha: Boolean) {
  authorization {
    signIn(login: $login, password: $password, recaptcha: $recaptcha, likePartner: $likePartner, isOwnCaptcha: $isOwnCaptcha) {
      user { id }
      twoFactorAuthNeeded
    }
  }
}`;

const GET_AUTH_STATE = `
query GetAuthState {
  authorized {
    partnerAccount {
      twoFA { state { enabled } }
    }
  }
}`;

const PARTNER_SITES = `
query PartnerSites($filter: SitesFilter!) {
  authorized {
    partnerAndManager {
      data {
        sites(filter: $filter) { id name hidden }
      }
    }
  }
}`;

const GET_QUICK_REPORT = `
query GetQuickReport($filter: QuickReportFilter!) {
  authorized {
    partner {
      reports {
        quickReport(filter: $filter) {
          status
          total {
            countOfRegistrations
            countOfNewAccountsWithDeposits
          }
        }
      }
    }
  }
}`;

const SITE_HINTS: Record<XPartnersCountry, string[]> = {
  CM: ["camerun", "cameroon"],
  EG: ["egypt", "egypt0011", "egypt"],
  ZM: ["zambia", "zam"],
};

const DEFAULT_SITE_URL: Record<XPartnersCountry, string> = {
  CM: "http://Camerun.com",
  EG: "http://Egypt.com",
  ZM: "http://Zambia.com",
};

function siteUrlForCountry(env: AppEnv, country: XPartnersCountry): string {
  const key =
    country === "CM"
      ? env.XPARTNERS_SITE_CM
      : country === "EG"
        ? env.XPARTNERS_SITE_EG
        : env.XPARTNERS_SITE_ZM;
  return (key || DEFAULT_SITE_URL[country]).trim();
}

function parseCredentials(env: AppEnv): { login: string; password: string } | null {
  const combined = (env.XPARTNERS_CREDENTIALS || "").trim();
  if (combined.includes(":")) {
    const idx = combined.indexOf(":");
    const login = combined.slice(0, idx).trim();
    const password = combined.slice(idx + 1).trim();
    if (login && password) {
      return { login, password };
    }
  }
  const login = (env.XPARTNERS_LOGIN || "").trim();
  const password = (env.XPARTNERS_PASSWORD || "").trim();
  if (login && password) {
    return { login, password };
  }
  return null;
}

function mapSignInError(raw: string): string {
  if (raw.includes("INVALID_CAPTCHA")) {
    return [
      "Логин и пароль в Railway заданы, но 1xPartners при входе через API всегда требует капчу — только пароль с сервера не проходит.",
      "",
      "Один раз добавьте XPARTNERS_COOKIE (тот же аккаунт, вход в Chrome → F12 → graphql → Cookie).",
      "Дальше бот сам держит сессию (keep-alive + сохранение в БД); логин/пароль в Variables можно оставить.",
      "",
      "Это ограничение партнёрки, не Telegram-бота.",
    ].join("\n");
  }
  return raw;
}

function cookiesFromEnv(env: AppEnv): string | null {
  const raw = (env.XPARTNERS_COOKIE || "").trim();
  return raw || null;
}

export class XPartnersClient {
  private readonly jar = new CookieJar();
  private readonly fetchWithCookies: typeof fetch;
  private loggedIn = false;
  private siteIdCache = new Map<XPartnersCountry, number>();
  private bootstrapped = false;

  constructor(
    private readonly env: AppEnv,
    private readonly meta?: AppMetaStore,
  ) {
    this.fetchWithCookies = makeFetchCookie(fetch, this.jar) as typeof fetch;
  }

  private requestHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return {
      ...BROWSER_HEADERS,
      ...extra,
    };
  }

  private async bootstrapCookiesIfNeeded(): Promise<void> {
    if (this.bootstrapped) {
      return;
    }
    this.bootstrapped = true;
    const existing = await this.jar.getCookieString(BASE);
    if (existing) {
      return;
    }
    let raw = (await this.meta?.get(XPARTNERS_SESSION_META_KEY))?.trim() || null;
    if (!raw) {
      raw = cookiesFromEnv(this.env);
    }
    if (raw) {
      await this.seedCookies(raw);
    }
  }

  private async persistSessionCookies(): Promise<void> {
    const serialized = await this.jar.getCookieString(BASE);
    if (!serialized?.trim() || !this.meta) {
      return;
    }
    await this.meta.set(XPARTNERS_SESSION_META_KEY, serialized);
  }

  private async seedCookies(cookieHeader: string): Promise<void> {
    for (const part of cookieHeader.split(";")) {
      const trimmed = part.trim();
      if (!trimmed) {
        continue;
      }
      try {
        await this.jar.setCookie(trimmed, BASE);
      } catch {
        // ignore malformed fragments
      }
    }
  }

  private async graphql<T>(items: GraphQlBatchItem[]): Promise<T> {
    const response = await this.fetchWithCookies(GRAPHQL, {
      method: "POST",
      headers: this.requestHeaders({
        "Content-Type": "application/json",
        Origin: BASE,
        Referer: `${BASE}/ru/partner`,
      }),
      body: JSON.stringify(items),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`1xPartners HTTP ${response.status}: ${text.slice(0, 300)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`1xPartners invalid JSON: ${text.slice(0, 200)}`);
    }
    await this.persistSessionCookies();
    return parsed as T;
  }

  async ensureSession(): Promise<void> {
    await this.bootstrapCookiesIfNeeded();
    if (this.loggedIn) {
      const ok = await this.pingAuthorized();
      if (ok) {
        return;
      }
      this.loggedIn = false;
    }
    const cookieHeader =
      (await this.meta?.get(XPARTNERS_SESSION_META_KEY))?.trim() ||
      cookiesFromEnv(this.env);
    if (cookieHeader) {
      await this.seedCookies(cookieHeader);
      if (await this.pingAuthorized()) {
        this.loggedIn = true;
        return;
      }
      throw new Error(
        "Сессия 1xPartners истекла. Один раз обновите XPARTNERS_COOKIE в Railway (вход в браузере → Cookie из graphql).",
      );
    }
    const creds = parseCredentials(this.env);
    if (!creds) {
      throw new Error(
        "1xPartners: задайте XPARTNERS_COOKIE в Railway Variables (рекомендуется).",
      );
    }
    await this.loginWithPassword(creds.login, creds.password);
    this.loggedIn = true;
  }

  async keepAlive(): Promise<void> {
    try {
      await this.ensureSession();
    } catch (error) {
      console.warn("1xPartners keep-alive:", error instanceof Error ? error.message : error);
    }
  }

  private async pingAuthorized(): Promise<boolean> {
    try {
      const data = await this.graphql<Array<{ data?: { authorized?: unknown } }>>([
        { operationName: "GetAuthState", query: GET_AUTH_STATE },
      ]);
      return Boolean(data?.[0]?.data?.authorized);
    } catch {
      return false;
    }
  }

  private async loginWithPassword(login: string, password: string): Promise<void> {
    await this.fetchWithCookies(`${BASE}/ru/sign-in`, {
      method: "GET",
      headers: this.requestHeaders({ Accept: "text/html" }),
    });
    const batch = await this.graphql<
      Array<{
        data?: {
          authorization?: {
            signIn?: { twoFactorAuthNeeded?: boolean; user?: { id?: string } };
          };
        };
        errors?: Array<{ message?: string }>;
      }>
    >([
      {
        operationName: "SignIn",
        variables: {
          login,
          password,
          recaptcha: "",
          likePartner: false,
          isOwnCaptcha: false,
        },
        query: SIGN_IN_MUTATION,
      },
    ]);
    const first = batch?.[0];
    const errors = first?.errors;
    if (errors?.length) {
      const msg = errors.map((e) => e.message).filter(Boolean).join("; ") || "SignIn failed";
      throw new Error(mapSignInError(msg));
    }
    if (first?.data?.authorization?.signIn?.twoFactorAuthNeeded) {
      throw new Error("1xPartners: включена 2FA — отключите или задайте cookie через Railway Variables.");
    }
    if (!first?.data?.authorization?.signIn?.user?.id) {
      throw new Error("1xPartners: вход не удался (проверьте логин/пароль).");
    }
  }

  private async listSites(): Promise<Array<{ id: number; name: string }>> {
    await this.ensureSession();
    const batch = await this.graphql<
      Array<{
        data?: {
          authorized?: {
            partnerAndManager?: {
              data?: { sites?: Array<{ id: string | number; name: string; hidden?: boolean }> };
            };
          };
        };
      }>
    >([
      {
        operationName: "PartnerSites",
        variables: { filter: { hidden: false, partnerId: null } },
        query: PARTNER_SITES,
      },
    ]);
    const sites = batch?.[0]?.data?.authorized?.partnerAndManager?.data?.sites ?? [];
    return sites
      .filter((s) => !s.hidden)
      .map((s) => ({ id: Number(s.id), name: (s.name || "").trim() }))
      .filter((s) => s.id > 0 && s.name);
  }

  private async resolveWebsiteId(country: XPartnersCountry): Promise<number> {
    const cached = this.siteIdCache.get(country);
    if (cached) {
      return cached;
    }
    const wantUrl = siteUrlForCountry(this.env, country).toLowerCase();
    const hints = SITE_HINTS[country];
    const sites = await this.listSites();
    let hit = sites.find((s) => s.name.toLowerCase() === wantUrl);
    if (!hit) {
      hit = sites.find((s) => {
        const n = s.name.toLowerCase();
        return hints.some((h) => n.includes(h));
      });
    }
    if (!hit) {
      throw new Error(
        `1xPartners: не найден сайт для ${country} (ожидали ${wantUrl}). Проверьте XPARTNERS_SITE_${country}.`,
      );
    }
    this.siteIdCache.set(country, hit.id);
    return hit.id;
  }

  async fetchQuickStatsToday(country: XPartnersCountry): Promise<XPartnersQuickStats> {
    await this.ensureSession();
    const websiteId = await this.resolveWebsiteId(country);
    const filter = {
      currencyId: Number(this.env.XPARTNERS_CURRENCY_ID || 1),
      websiteId,
      marketingToolId: null,
      period: {
        interval: "TODAY",
      },
    };
    const batch = await this.graphql<
      Array<{
        data?: {
          authorized?: {
            partner?: {
              reports?: {
                quickReport?: {
                  status?: string;
                  total?: {
                    countOfRegistrations?: number;
                    countOfNewAccountsWithDeposits?: number;
                  };
                };
              };
            };
          };
        };
        errors?: Array<{ message?: string }>;
      }>
    >([
      {
        operationName: "GetQuickReport",
        variables: { filter },
        query: GET_QUICK_REPORT,
      },
    ]);
    const first = batch?.[0];
    if (first?.errors?.length) {
      throw new Error(first.errors.map((e) => e.message).join("; "));
    }
    const total = first?.data?.authorized?.partner?.reports?.quickReport?.total;
    const sites = await this.listSites();
    const siteLabel = sites.find((s) => s.id === websiteId)?.name ?? siteUrlForCountry(this.env, country);
    return {
      registrations: Number(total?.countOfRegistrations ?? 0),
      newAccountsWithDeposits: Number(total?.countOfNewAccountsWithDeposits ?? 0),
      fetchedAt: new Date().toISOString(),
      siteLabel,
    };
  }
}

let sharedClient: XPartnersClient | null = null;
let sharedMeta: AppMetaStore | undefined;

export function configureXPartnersSessionStore(meta: AppMetaStore): void {
  sharedMeta = meta;
}

export function getXPartnersClient(env: AppEnv): XPartnersClient | null {
  if (!env.XPARTNERS_ENABLED) {
    return null;
  }
  if (!sharedClient) {
    sharedClient = new XPartnersClient(env, sharedMeta);
  }
  return sharedClient;
}

export function startXPartnersKeepAlive(env: AppEnv): void {
  const client = getXPartnersClient(env);
  if (!client) {
    return;
  }
  const minutes = Math.max(1, env.XPARTNERS_KEEPALIVE_MINUTES);
  const ms = minutes * 60_000;
  void client.keepAlive();
  setInterval(() => {
    void client.keepAlive();
  }, ms);
  console.log(`1xPartners: keep-alive every ${minutes} min`);
}
