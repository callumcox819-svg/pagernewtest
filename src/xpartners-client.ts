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
const GRAPHQL = `${BASE}/graphql/`;
const XP_FETCH_TIMEOUT_MS = 90_000;

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
            newDepositors
            countOfRegistrationsWithDeposits
            countOfAccountsWithDeposits
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

/** Same as 1xPartners UI: start/end of calendar day (UTC on server). */
function quickReportTodayPeriod(): { startPeriod: string; endPeriod: string } {
  const now = new Date();
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0),
  );
  const end = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999),
  );
  return { startPeriod: start.toISOString(), endPeriod: end.toISOString() };
}

function formatGraphqlErrors(errors: Array<{ message?: string; extensions?: unknown }>): string {
  const parts = errors.map((e) => {
    const msg = (e.message || "GraphQL error").trim();
    if (e.extensions && typeof e.extensions === "object") {
      const ext = e.extensions as Record<string, unknown>;
      const code = ext.code ?? ext.errorCode ?? ext.type;
      if (code != null) {
        return `${msg} [${String(code)}]`;
      }
    }
    return msg;
  });
  return [...new Set(parts)].join("; ");
}

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

const GET_PARTNERS_CAPTCHA_MODE = `
query PartnersCaptchaMode {
  partnersProgram {
    generalInformation {
      hasOwnCaptcha
    }
  }
}`;

export class XPartnersClient {
  private jar: CookieJar;
  private fetchWithCookies: typeof fetch;
  private loggedIn = false;
  private siteIdCache = new Map<XPartnersCountry, { id: number; label: string }>();
  private bootstrapped = false;
  private signInInFlight: Promise<void> | null = null;
  /** After captcha/login failure, do not hammer SignIn (e.g. «Обновить все» × 3 countries). */
  private signInBlockedUntilMs = 0;
  private lastSignInError = "";

  constructor(
    private readonly env: AppEnv,
    private readonly meta?: AppMetaStore,
  ) {
    this.jar = new CookieJar();
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
    const response = await this.fetchTimed(GRAPHQL, {
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

  private async clearStaleSessionForLogin(): Promise<void> {
    if (this.meta) {
      await this.meta.set(XPARTNERS_SESSION_META_KEY, "");
    }
    this.bootstrapped = false;
    this.jar = new CookieJar();
    this.fetchWithCookies = makeFetchCookie(fetch, this.jar) as typeof fetch;
  }

  private async fetchTimed(url: string, init: RequestInit): Promise<Response> {
    return this.fetchWithCookies(url, {
      ...init,
      signal: AbortSignal.timeout(XP_FETCH_TIMEOUT_MS),
    });
  }

  private async reloadEnvCookieSession(): Promise<boolean> {
    const envCookie = cookiesFromEnv(this.env);
    if (!envCookie) {
      return false;
    }
    await this.clearStaleSessionForLogin();
    await this.seedCookies(envCookie);
    this.bootstrapped = true;
    return this.pingAuthorized();
  }

  async ensureSession(): Promise<void> {
    await this.bootstrapCookiesIfNeeded();
    if (await this.pingAuthorized()) {
      this.loggedIn = true;
      return;
    }
    this.loggedIn = false;

    if (cookiesFromEnv(this.env)) {
      if (await this.reloadEnvCookieSession()) {
        this.loggedIn = true;
        return;
      }
      throw new Error(
        "XPARTNERS_COOKIE не принят (истёк или обрезан при вставке). Скопируйте Cookie из graphql заново — одной строкой, с connect.sid.",
      );
    }

    const cookieHeader = (await this.meta?.get(XPARTNERS_SESSION_META_KEY))?.trim();
    if (cookieHeader) {
      await this.seedCookies(cookieHeader);
      if (await this.pingAuthorized()) {
        this.loggedIn = true;
        return;
      }
    }

    const creds = parseCredentials(this.env);
    if (creds) {
      await this.clearStaleSessionForLogin();
      await this.loginWithPasswordOnce(creds.login, creds.password);
      this.loggedIn = true;
      return;
    }

    throw new Error(
      "1xPartners: задайте XPARTNERS_COOKIE или XPARTNERS_CREDENTIALS в Railway.",
    );
  }

  async keepAlive(): Promise<void> {
    try {
      await this.bootstrapCookiesIfNeeded();
      if (await this.pingAuthorized()) {
        this.loggedIn = true;
        return;
      }
      this.loggedIn = false;
    } catch (error) {
      console.warn("1xPartners keep-alive:", error instanceof Error ? error.message : error);
    }
  }

  private async fetchUsesOwnCaptcha(): Promise<boolean> {
    try {
      const batch = await this.graphql<
        Array<{
          data?: { partnersProgram?: { generalInformation?: { hasOwnCaptcha?: boolean } } };
        }>
      >([{ operationName: "PartnersCaptchaMode", query: GET_PARTNERS_CAPTCHA_MODE }]);
      return Boolean(batch?.[0]?.data?.partnersProgram?.generalInformation?.hasOwnCaptcha);
    } catch {
      return false;
    }
  }

  private async loginWithPasswordOnce(login: string, password: string): Promise<void> {
    if (Date.now() < this.signInBlockedUntilMs) {
      throw new Error(this.lastSignInError || mapSignInError("INVALID_CAPTCHA"));
    }
    if (this.signInInFlight) {
      await this.signInInFlight;
      if (this.loggedIn) {
        return;
      }
      if (Date.now() < this.signInBlockedUntilMs) {
        throw new Error(this.lastSignInError || mapSignInError("INVALID_CAPTCHA"));
      }
    }
    this.signInInFlight = this.loginWithPassword(login, password).finally(() => {
      this.signInInFlight = null;
    });
    await this.signInInFlight;
  }

  private async pingAuthorized(): Promise<boolean> {
    try {
      const data = await this.graphql<
        Array<{
          data?: {
            authorized?: {
              partnerAndManager?: { data?: { sites?: unknown[] } };
            };
          };
          errors?: Array<{ message?: string }>;
        }>
      >([
        {
          operationName: "PartnerSites",
          variables: { filter: { hidden: false, partnerId: null } },
          query: PARTNER_SITES,
        },
      ]);
      const first = data?.[0];
      if (first?.errors?.length) {
        return false;
      }
      const sites = first?.data?.authorized?.partnerAndManager?.data?.sites;
      return Array.isArray(sites);
    } catch {
      return false;
    }
  }

  private async loginWithPassword(login: string, password: string): Promise<void> {
    await this.fetchTimed(`${BASE}/ru/sign-in`, {
      method: "GET",
      headers: this.requestHeaders({ Accept: "text/html" }),
    });
    const isOwnCaptcha = await this.fetchUsesOwnCaptcha();
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
          isOwnCaptcha,
        },
        query: SIGN_IN_MUTATION,
      },
    ]);
    const first = batch?.[0];
    const errors = first?.errors;
    if (errors?.length) {
      const msg = errors.map((e) => e.message).filter(Boolean).join("; ") || "SignIn failed";
      const mapped = mapSignInError(msg);
      if (msg.includes("INVALID_CAPTCHA") || msg.includes("CAPTCHA")) {
        this.signInBlockedUntilMs = Date.now() + 30 * 60_000;
        this.lastSignInError = mapped;
      }
      throw new Error(mapped);
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

  private async resolveSite(country: XPartnersCountry): Promise<{ id: number; label: string }> {
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
    const resolved = { id: hit.id, label: hit.name };
    this.siteIdCache.set(country, resolved);
    return resolved;
  }

  async fetchQuickStatsToday(country: XPartnersCountry): Promise<XPartnersQuickStats> {
    await this.ensureSession();
    const site = await this.resolveSite(country);
    const { startPeriod, endPeriod } = quickReportTodayPeriod();
    const filter = {
      currencyId: Number(this.env.XPARTNERS_CURRENCY_ID || 1),
      siteId: site.id,
      startPeriod,
      endPeriod,
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
                    newDepositors?: number;
                    countOfRegistrationsWithDeposits?: number;
                    countOfAccountsWithDeposits?: number;
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
      console.warn("1xPartners GetQuickReport errors:", JSON.stringify(first.errors).slice(0, 2000));
      throw new Error(formatGraphqlErrors(first.errors));
    }
    const total = first?.data?.authorized?.partner?.reports?.quickReport?.total;
    const siteLabel = site.label;
    const ftd =
      total?.newDepositors ??
      total?.countOfRegistrationsWithDeposits ??
      total?.countOfAccountsWithDeposits ??
      0;
    return {
      registrations: Number(total?.countOfRegistrations ?? 0),
      newAccountsWithDeposits: Number(ftd),
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
  console.log(`1xPartners: session ping every ${minutes} min (no password retries on ping)`);
}
