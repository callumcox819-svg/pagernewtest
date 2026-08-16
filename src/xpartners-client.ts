import makeFetchCookie from "fetch-cookie";
import { CookieJar } from "tough-cookie";
import type { AppEnv } from "./env.js";
import type { AppMetaStore } from "./app-meta-store.js";

export const XPARTNERS_SESSION_META_KEY = "xpartners_session_cookie";
export const XPARTNERS_LOGIN_META_KEY = "xpartners_login";
export const XPARTNERS_PASSWORD_META_KEY = "xpartners_password";

export type XPartnersSessionStatus = {
  connected: boolean;
  source: "cookie" | "credentials" | "env" | "none";
  loginHint?: string;
  hasStoredCookie: boolean;
  hasStoredCredentials: boolean;
  hasEnvCookie: boolean;
  hasEnvCredentials: boolean;
  captchaBlockedUntil?: string;
  message: string;
};

export type XPartnersCountry = "CM" | "EG" | "ZM" | "RW";

export type XPartnersQuickStats = {
  registrations: number;
  newAccountsWithDeposits: number;
  fetchedAt: string;
  siteLabel: string;
};

export type XPartnersPlayersToday = {
  country: XPartnersCountry;
  dayKey: string;
  siteLabel: string;
  playerIds: string[];
  registrationsExpected: number;
  fetchedAt: string;
};

const COUNTRY_API_NAME: Record<XPartnersCountry, string> = {
  CM: "Cameroon",
  EG: "Egypt",
  ZM: "Zambia",
  RW: "Rwanda",
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
            countOfViews
            countOfClicks
            countOfDirectLinks
            countOfRegistrations
            countOfRegistrationsWithDeposits
            newDepositsSum
            newDepositors
            countOfAccountsWithDeposits
            depositAmount
            profit
            countOfDeposits
            countOfActivePlayers
          }
        }
      }
    }
  }
}`;

const GET_PLAYERS_REPORT = `
query GetPlayersReport($filter: PlayersReportFilter!) {
  authorized {
    partner {
      reports {
        playersReport(filter: $filter) {
          status
          hash
          pagesCount
          rows {
            playerId
            registrationDate
            depositAmount
            siteName
            siteId
          }
        }
      }
    }
  }
}`;

const SITE_HINTS: Record<XPartnersCountry, string[]> = {
  CM: ["camerun", "cameroon"],
  EG: ["egypt", "egypt0011", "eg011", "hapka"],
  ZM: ["zambia", "zam"],
  RW: ["rwanda", "ruanda", "rw"],
};

const DEFAULT_SITE_URL: Record<XPartnersCountry, string> = {
  CM: "http://Camerun.com",
  EG: "http://Egypt.com",
  ZM: "http://Zambia.com",
  RW: "http://Rwanda.com",
};

/** Same calendar day as 1xPartners UI (moment startOf/endOf day in partner TZ). */
const XP_REPORT_TIMEZONE = "Europe/Kyiv";

/** Partner UI normalizes start/end to the same UTC midnight for "today". */
function quickReportTodayPeriod(): { startPeriod: string; endPeriod: string } {
  const dayKey = new Intl.DateTimeFormat("en-CA", { timeZone: XP_REPORT_TIMEZONE }).format(new Date());
  const midnight = `${dayKey}T00:00:00.000Z`;
  return {
    startPeriod: midnight,
    endPeriod: midnight,
  };
}

function todayDayKey(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: XP_REPORT_TIMEZONE }).format(new Date());
}

/** Registration date column in partner UI (YYYY-MM-DD). */
function registrationDayKey(registrationDate: string | undefined): string | null {
  if (!registrationDate?.trim()) {
    return null;
  }
  const raw = registrationDate.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
    return raw.slice(0, 10);
  }
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) {
    return null;
  }
  return new Intl.DateTimeFormat("en-CA", { timeZone: XP_REPORT_TIMEZONE }).format(new Date(ms));
}

/** «Сегодня» в отчёте «По игрокам»: startOf/endOf day → ISO (как moment в кабинете). */
function playersReportTodayPeriodFullDay(): { startPeriod: string; endPeriod: string } {
  const dayKey = todayDayKey();
  const start = `${dayKey}T00:00:00.000Z`;
  return {
    startPeriod: start,
    endPeriod: `${dayKey}T23:59:59.999Z`,
  };
}

function todayReportPeriodVariants(): Array<{ startPeriod: string; endPeriod: string }> {
  const quick = quickReportTodayPeriod();
  return [quick, playersReportTodayPeriodFullDay()];
}

type PlayersReportRow = {
  playerId?: string | number;
  registrationDate?: string;
  depositAmount?: string | number | null;
  siteName?: string;
  siteId?: number | string;
};

function resolveCurrencyId(env: AppEnv): number {
  const raw = Number(env.XPARTNERS_CURRENCY_ID || 6);
  // Railway often kept legacy default 1; USD in partner UI is 6.
  if (raw === 1) {
    return 6;
  }
  return raw > 0 ? raw : 6;
}

function totalsLookEmpty(total: QuickReportTotals | undefined): boolean {
  if (!total) {
    return true;
  }
  const keys: (keyof QuickReportTotals)[] = [
    "countOfRegistrations",
    "newDepositors",
    "countOfRegistrationsWithDeposits",
    "countOfAccountsWithDeposits",
  ];
  return keys.every((k) => !Number(total[k] ?? 0));
}

type QuickReportTotals = {
  countOfRegistrations?: number;
  newDepositors?: number;
  countOfRegistrationsWithDeposits?: number;
  countOfAccountsWithDeposits?: number;
};

function sumQuickReportTotals(totals: QuickReportTotals[]): QuickReportTotals {
  const sum = (pick: (t: QuickReportTotals) => number | undefined) =>
    totals.reduce((acc, t) => acc + Number(pick(t) ?? 0), 0);
  return {
    countOfRegistrations: sum((t) => t.countOfRegistrations),
    newDepositors: sum((t) => t.newDepositors),
    countOfRegistrationsWithDeposits: sum((t) => t.countOfRegistrationsWithDeposits),
    countOfAccountsWithDeposits: sum((t) => t.countOfAccountsWithDeposits),
  };
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

function siteIdOverride(env: AppEnv, country: XPartnersCountry): number | undefined {
  const raw =
    country === "CM"
      ? env.XPARTNERS_SITE_ID_CM
      : country === "EG"
        ? env.XPARTNERS_SITE_ID_EG
        : country === "RW"
          ? env.XPARTNERS_SITE_ID_RW
          : env.XPARTNERS_SITE_ID_ZM;
  return raw && raw > 0 ? raw : undefined;
}

function siteUrlForCountry(env: AppEnv, country: XPartnersCountry): string {
  const key =
    country === "CM"
      ? env.XPARTNERS_SITE_CM
      : country === "EG"
        ? env.XPARTNERS_SITE_EG
        : country === "RW"
          ? env.XPARTNERS_SITE_RW
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
  if (raw.includes("INVALID_CAPTCHA") || raw.includes("CAPTCHA")) {
    return "1xPartners требует капчу: добавь XPARTNERS_COOKIE в Railway. F12 → Network → кликни GetQuickReport → Headers → cookie (вся строка).";
  }
  return raw;
}

function cookiesFromEnv(env: AppEnv): string | null {
  const raw = (env.XPARTNERS_COOKIE || "").trim();
  return raw || null;
}

function xsrfHeaderFromCookieHeader(cookieHeader: string | null | undefined): Record<string, string> {
  if (!cookieHeader?.trim()) {
    return {};
  }
  const match = cookieHeader.match(/(?:^|;\s*)XSRF-TOKEN=([^;]*)/i);
  if (!match?.[1]) {
    return {};
  }
  const raw = match[1].trim();
  try {
    return { "X-XSRF-TOKEN": decodeURIComponent(raw) };
  } catch {
    return { "X-XSRF-TOKEN": raw };
  }
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
  private siteBundleCache = new Map<
    XPartnersCountry,
    { sites: Array<{ id: number; label: string }>; label: string }
  >();
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

  private async requestHeaders(
    extra: Record<string, string> = {},
    cookieSource?: string | null,
  ): Promise<Record<string, string>> {
    let xsrfSource = cookieSource?.trim() || extra.Cookie?.trim() || null;
    if (!xsrfSource) {
      xsrfSource = (await this.jar.getCookieString(BASE)) || null;
    }
    return {
      ...BROWSER_HEADERS,
      ...xsrfHeaderFromCookieHeader(xsrfSource),
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
      headers: await this.requestHeaders({
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

  private reportsCookieFromEnv(): string | null {
    const raw = (this.env.XPARTNERS_REPORTS_COOKIE || "").trim();
    return raw || null;
  }

  private playersReportCookieHeader(): string | null {
    const reports = this.reportsCookieFromEnv();
    if (reports) {
      return reports;
    }
    return cookiesFromEnv(this.env);
  }

  /** GetPlayersReport: явный Cookie (reports или основной), иначе jar-сессия. */
  private async graphqlPlayersReport<T>(items: GraphQlBatchItem[]): Promise<T> {
    const cookie = this.playersReportCookieHeader();
    if (!cookie) {
      return this.graphql<T>(items);
    }
    const response = await fetch(GRAPHQL, {
      method: "POST",
      headers: await this.requestHeaders(
        {
          "Content-Type": "application/json",
          Origin: BASE,
          Referer: `${BASE}/ru/partner/reports/players`,
          Cookie: cookie,
        },
        cookie,
      ),
      body: JSON.stringify(items),
      signal: AbortSignal.timeout(XP_FETCH_TIMEOUT_MS),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`1xPartners HTTP ${response.status}: ${text.slice(0, 300)}`);
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`1xPartners invalid JSON: ${text.slice(0, 200)}`);
    }
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

  private async readAuthFlags(): Promise<{
    hasStoredCookie: boolean;
    hasStoredCredentials: boolean;
    hasEnvCookie: boolean;
    hasEnvCredentials: boolean;
  }> {
    const metaLogin = (await this.meta?.get(XPARTNERS_LOGIN_META_KEY))?.trim();
    const metaPassword = await this.meta?.get(XPARTNERS_PASSWORD_META_KEY);
    return {
      hasStoredCookie: Boolean((await this.meta?.get(XPARTNERS_SESSION_META_KEY))?.trim()),
      hasStoredCredentials: Boolean(metaLogin && metaPassword),
      hasEnvCookie: Boolean(cookiesFromEnv(this.env)),
      hasEnvCredentials: Boolean(parseCredentials(this.env)),
    };
  }

  private async getStoredCredentials(): Promise<{ login: string; password: string } | null> {
    const metaLogin = (await this.meta?.get(XPARTNERS_LOGIN_META_KEY))?.trim();
    const metaPassword = await this.meta?.get(XPARTNERS_PASSWORD_META_KEY);
    if (metaLogin && metaPassword) {
      return { login: metaLogin, password: metaPassword };
    }
    return parseCredentials(this.env);
  }

  private async reloadPersistedCookieSession(): Promise<boolean> {
    const cookieHeader = (await this.meta?.get(XPARTNERS_SESSION_META_KEY))?.trim();
    if (!cookieHeader) {
      return false;
    }
    await this.clearStaleSessionForLogin();
    await this.seedCookies(cookieHeader);
    this.bootstrapped = true;
    return this.pingAuthorized();
  }

  private async loginWithStoredCredentials(): Promise<boolean> {
    const creds = await this.getStoredCredentials();
    if (!creds) {
      return false;
    }
    if (Date.now() < this.signInBlockedUntilMs) {
      return false;
    }
    try {
      await this.clearStaleSessionForLogin();
      await this.loginWithPasswordOnce(creds.login, creds.password);
      return true;
    } catch {
      return false;
    }
  }

  async describeSessionStatus(metaOverride?: AppMetaStore): Promise<XPartnersSessionStatus> {
    const meta = metaOverride ?? this.meta;
    const hasStoredCookie = Boolean((await meta?.get(XPARTNERS_SESSION_META_KEY))?.trim());
    const metaLogin = (await meta?.get(XPARTNERS_LOGIN_META_KEY))?.trim();
    const metaPassword = await meta?.get(XPARTNERS_PASSWORD_META_KEY);
    const hasStoredCredentials = Boolean(metaLogin && metaPassword);
    const hasEnvCookie = Boolean(cookiesFromEnv(this.env));
    const hasEnvCredentials = Boolean(parseCredentials(this.env));

    await this.bootstrapCookiesIfNeeded();
    const connected = await this.pingAuthorized();
    if (connected) {
      const source = hasStoredCookie || hasEnvCookie ? "cookie" : hasStoredCredentials || hasEnvCredentials ? "credentials" : "env";
      return {
        connected: true,
        source,
        loginHint: metaLogin || parseCredentials(this.env)?.login,
        hasStoredCookie,
        hasStoredCredentials,
        hasEnvCookie,
        hasEnvCredentials,
        captchaBlockedUntil:
          Date.now() < this.signInBlockedUntilMs
            ? new Date(this.signInBlockedUntilMs).toISOString()
            : undefined,
        message: "Сессия активна.",
      };
    }

    const credsHint = metaLogin || parseCredentials(this.env)?.login;
    return {
      connected: false,
      source: "none",
      loginHint: credsHint,
      hasStoredCookie,
      hasStoredCredentials,
      hasEnvCookie,
      hasEnvCredentials,
      captchaBlockedUntil:
        Date.now() < this.signInBlockedUntilMs
          ? new Date(this.signInBlockedUntilMs).toISOString()
          : undefined,
      message: this.lastSignInError
        || (hasStoredCookie || hasEnvCookie || hasStoredCredentials || hasEnvCredentials
          ? "Сессия истекла — бот переподключится сам. Если не помогло: обнови XPARTNERS_COOKIE в Railway."
          : "Задай XPARTNERS_LOGIN/PASSWORD или XPARTNERS_COOKIE в Railway Variables."),
    };
  }

  async importCookieHeader(cookieHeader: string): Promise<void> {
    const trimmed = cookieHeader.trim();
    if (!trimmed) {
      throw new Error("Cookie пустой.");
    }
    await this.clearStaleSessionForLogin();
    await this.seedCookies(trimmed);
    this.bootstrapped = true;
    if (!(await this.pingAuthorized())) {
      throw new Error(
        "Cookie не принят. F12 → Network → GetQuickReport → Headers → cookie — скопируй всю строку в XPARTNERS_COOKIE.",
      );
    }
    this.loggedIn = true;
    await this.persistSessionCookies();
  }

  async persistCredentials(login: string, password: string): Promise<void> {
    if (!this.meta) {
      throw new Error("Хранилище сессии недоступно (нет DATABASE_URL).");
    }
    await this.meta.set(XPARTNERS_LOGIN_META_KEY, login.trim());
    await this.meta.set(XPARTNERS_PASSWORD_META_KEY, password);
  }

  async clearStoredAuth(): Promise<void> {
    if (this.meta) {
      await this.meta.set(XPARTNERS_SESSION_META_KEY, "");
      await this.meta.set(XPARTNERS_LOGIN_META_KEY, "");
      await this.meta.set(XPARTNERS_PASSWORD_META_KEY, "");
    }
    this.loggedIn = false;
    this.bootstrapped = false;
    this.signInBlockedUntilMs = 0;
    this.lastSignInError = "";
    this.jar = new CookieJar();
    this.fetchWithCookies = makeFetchCookie(fetch, this.jar) as typeof fetch;
  }

  async ensureSession(): Promise<void> {
    await this.bootstrapCookiesIfNeeded();
    if (await this.pingAuthorized()) {
      this.loggedIn = true;
      await this.persistSessionCookies();
      return;
    }
    this.loggedIn = false;

    if (await this.reloadPersistedCookieSession()) {
      this.loggedIn = true;
      await this.persistSessionCookies();
      return;
    }

    if (await this.reloadEnvCookieSession()) {
      this.loggedIn = true;
      await this.persistSessionCookies();
      return;
    }

    if (await this.loginWithStoredCredentials()) {
      this.loggedIn = true;
      await this.persistSessionCookies();
      return;
    }

    const creds = await this.getStoredCredentials();
    if (creds && Date.now() < this.signInBlockedUntilMs) {
      throw new Error(this.lastSignInError || mapSignInError("INVALID_CAPTCHA"));
    }

    if (hasStoredOrEnvAuth(this.env, await this.readAuthFlags())) {
      throw new Error(
        this.lastSignInError
          || "1xPartners: сессия истекла — бот переподключится сам. Если ошибка повторяется: обнови XPARTNERS_COOKIE в Railway.",
      );
    }

    throw new Error(
      "1xPartners: задай XPARTNERS_LOGIN/PASSWORD или XPARTNERS_COOKIE в Railway Variables.",
    );
  }

  async keepAlive(): Promise<void> {
    try {
      await this.bootstrapCookiesIfNeeded();
      if (await this.pingAuthorized()) {
        this.loggedIn = true;
        await this.persistSessionCookies();
        return;
      }
      this.loggedIn = false;
      await this.ensureSession();
    } catch (error) {
      this.loggedIn = false;
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
      headers: await this.requestHeaders({ Accept: "text/html" }),
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
    const run = async (hidden: boolean | undefined) => {
      const filter: { partnerId: null; hidden?: boolean } = { partnerId: null };
      if (hidden !== undefined) {
        filter.hidden = hidden;
      }
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
          variables: { filter },
          query: PARTNER_SITES,
        },
      ]);
      return batch?.[0]?.data?.authorized?.partnerAndManager?.data?.sites ?? [];
    };
    const merged = [...(await run(false)), ...(await run(true))];
    const byId = new Map<number, { id: number; name: string }>();
    for (const s of merged) {
      if (s.hidden) {
        continue;
      }
      const id = Number(s.id);
      const name = (s.name || "").trim();
      if (id > 0 && name) {
        byId.set(id, { id, name });
      }
    }
    return [...byId.values()];
  }

  private async resolveSitesForCountry(
    country: XPartnersCountry,
  ): Promise<{ sites: Array<{ id: number; label: string }>; label: string }> {
    const cached = this.siteBundleCache.get(country);
    if (cached) {
      return cached;
    }
    const allSites = await this.listSites();
    const overrideId = siteIdOverride(this.env, country);
    if (overrideId) {
      const hit = allSites.find((s) => s.id === overrideId);
      if (!hit) {
        throw new Error(`1xPartners: XPARTNERS_SITE_ID_${country}=${overrideId} не найден в списке сайтов.`);
      }
      const bundle = { sites: [{ id: hit.id, label: hit.name }], label: hit.name };
      this.siteBundleCache.set(country, bundle);
      return bundle;
    }

    const wantUrl = siteUrlForCountry(this.env, country).toLowerCase();
    const hints = SITE_HINTS[country];
    const exact = allSites.filter((s) => s.name.toLowerCase() === wantUrl);
    const byHints = allSites.filter((s) => {
      const n = s.name.toLowerCase();
      return hints.some((h) => n.includes(h));
    });
    const matched = [...new Map([...exact, ...byHints].map((s) => [Number(s.id), s])).values()];
    if (!matched.length) {
      throw new Error(
        `1xPartners: не найден сайт для ${country} (ожидали ${wantUrl} или подсказки ${hints.join(", ")}).`,
      );
    }

    const label =
      matched.length === 1
        ? matched[0]!.name
        : `${matched.length} сайта · ${country} (${matched.map((s) => s.name).slice(0, 2).join(", ")}${matched.length > 2 ? "…" : ""})`;
    const bundle = {
      sites: matched.map((s) => ({ id: Number(s.id), label: s.name })),
      label,
    };
    this.siteBundleCache.set(country, bundle);
    return bundle;
  }

  private async fetchQuickReportTotals(filter: {
    currencyId: number;
    siteId?: number;
    startPeriod: string;
    endPeriod: string;
  }): Promise<{ status?: string; total: QuickReportTotals }> {
    const deadline = Date.now() + 60_000;
    let lastStatus: string | undefined;
    let total: QuickReportTotals | undefined;
    let partnerMissing = false;

    for (;;) {
      const batch = await this.graphql<
        Array<{
          data?: {
            authorized?: {
              partner?: {
                reports?: {
                  quickReport?: {
                    status?: string;
                    total?: QuickReportTotals;
                  };
                };
              } | null;
            };
          };
          errors?: Array<{ message?: string; extensions?: unknown }>;
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
      const partner = first?.data?.authorized?.partner;
      if (!partner) {
        partnerMissing = true;
        break;
      }
      const quickReport = partner.reports?.quickReport;
      lastStatus = quickReport?.status;
      total = quickReport?.total;
      if (lastStatus !== "PENDING") {
        break;
      }
      if (Date.now() >= deadline) {
        throw new Error("1xPartners: отчёт ещё формируется (PENDING), попробуйте через минуту.");
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    if (partnerMissing) {
      throw new Error(
        "1xPartners: нет доступа к partner.reports (сессия не партнёрская или cookie устарел).",
      );
    }

    if (lastStatus === "ERROR") {
      throw new Error("1xPartners: ошибка формирования быстрого отчёта (status ERROR).");
    }

    if (lastStatus === "SUCCESS" && totalsLookEmpty(total)) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const retry = await this.graphql<
        Array<{
          data?: {
            authorized?: {
              partner?: {
                reports?: {
                  quickReport?: { status?: string; total?: QuickReportTotals };
                };
              } | null;
            };
          };
        }>
      >([
        {
          operationName: "GetQuickReport",
          variables: { filter },
          query: GET_QUICK_REPORT,
        },
      ]);
      const qr = retry?.[0]?.data?.authorized?.partner?.reports?.quickReport;
      if (qr?.total && !totalsLookEmpty(qr.total)) {
        return { status: qr.status, total: qr.total };
      }
    }

    return { status: lastStatus, total: total ?? {} };
  }

  async fetchQuickStatsToday(country: XPartnersCountry): Promise<XPartnersQuickStats> {
    await this.ensureSession();
    const { sites, label: siteLabel } = await this.resolveSitesForCountry(country);
    const { startPeriod, endPeriod } = quickReportTodayPeriod();
    const currencyId = resolveCurrencyId(this.env);
    const baseFilter = { currencyId, startPeriod, endPeriod };

    const perSite: QuickReportTotals[] = [];
    let usedFilter = baseFilter;

    const fetchAllSites = async (filter: typeof baseFilter & { siteId?: number }) => {
      const totals: QuickReportTotals[] = [];
      for (const site of sites) {
        const { status, total } = await this.fetchQuickReportTotals({ ...filter, siteId: site.id });
        totals.push(total);
        if (totalsLookEmpty(total)) {
          console.warn(
            `1xPartners ${country}: empty total · siteId=${site.id} name=${site.label} status=${status} filter=${JSON.stringify({ ...filter, siteId: site.id })}`,
          );
        }
      }
      return totals;
    };

    perSite.push(...(await fetchAllSites(baseFilter)));

    let total =
      sites.length === 1 ? (perSite[0] ?? {}) : sumQuickReportTotals(perSite);

    if (totalsLookEmpty(total)) {
      const dayKey = new Intl.DateTimeFormat("en-CA", { timeZone: XP_REPORT_TIMEZONE }).format(
        new Date(),
      );
      const altFilter = {
        ...baseFilter,
        startPeriod: `${dayKey}T00:00:00.000Z`,
        endPeriod: `${dayKey}T23:59:59.999Z`,
      };
      const altPerSite = await fetchAllSites(altFilter);
      const altTotal =
        sites.length === 1 ? (altPerSite[0] ?? {}) : sumQuickReportTotals(altPerSite);
      if (!totalsLookEmpty(altTotal)) {
        perSite.length = 0;
        perSite.push(...altPerSite);
        total = altTotal;
        usedFilter = altFilter;
      }
    }
    const ftd =
      total.newDepositors ??
      total.countOfRegistrationsWithDeposits ??
      total.countOfAccountsWithDeposits ??
      0;
    const registrations = Number(total.countOfRegistrations ?? 0);
    const ftdN = Number(ftd);

    if (registrations === 0 && ftdN === 0) {
      console.warn(
        `1xPartners ${country}: zero after fetch · sites=${sites.map((s) => `${s.id}:${s.label}`).join("|")} · currencyId=${currencyId} · period=${usedFilter.startPeriod}/${usedFilter.endPeriod}`,
      );
    }

    return {
      registrations,
      newAccountsWithDeposits: ftdN,
      fetchedAt: new Date().toISOString(),
      siteLabel,
    };
  }

  private playersReportBaseFilter(
    scope: { siteId: number } | { country: XPartnersCountry },
    options?: {
      onlyNewPlayers?: boolean;
      withoutDepositsOnly?: boolean;
      startPeriod?: string;
      endPeriod?: string;
    },
  ): Record<string, unknown> {
    const period = playersReportTodayPeriodFullDay();
    const filter: Record<string, unknown> = {
      currencyId: resolveCurrencyId(this.env),
      startPeriod: options?.startPeriod ?? period.startPeriod,
      endPeriod: options?.endPeriod ?? period.endPeriod,
      methood: "get",
      onlyNewPlayers: options?.onlyNewPlayers ?? false,
      withoutDepositsOnly: options?.withoutDepositsOnly ?? false,
      subId: "",
    };
    if ("siteId" in scope) {
      filter.siteId = scope.siteId;
    } else {
      filter.country = COUNTRY_API_NAME[scope.country];
    }
    return filter;
  }

  private async fetchPlayersReportOnce(filter: Record<string, unknown>): Promise<{
    status?: string;
    hash?: string;
    pagesCount?: number;
    rows: PlayersReportRow[];
  }> {
    const deadline = Date.now() + 90_000;
    let lastStatus: string | undefined;
    let payload:
      | {
          status?: string;
          hash?: string;
          pagesCount?: number;
          rows?: PlayersReportRow[];
        }
      | undefined;

    for (;;) {
      const batch = await this.graphqlPlayersReport<
        Array<{
          data?: {
            authorized?: {
              partner?: {
                reports?: {
                  playersReport?: {
                    status?: string;
                    hash?: string;
                    pagesCount?: number;
                    rows?: PlayersReportRow[];
                  };
                };
              } | null;
            };
          };
          errors?: Array<{ message?: string; extensions?: unknown }>;
        }>
      >([
        {
          operationName: "GetPlayersReport",
          variables: { filter },
          query: GET_PLAYERS_REPORT,
        },
      ]);
      const first = batch?.[0];
      if (first?.errors?.length) {
        console.warn("1xPartners GetPlayersReport errors:", JSON.stringify(first.errors).slice(0, 2000));
        throw new Error(formatGraphqlErrors(first.errors));
      }
      const partner = first?.data?.authorized?.partner;
      if (!partner) {
        throw new Error(
          "1xPartners: нет доступа к отчёту по игрокам (partner.reports).",
        );
      }
      payload = partner.reports?.playersReport;
      lastStatus = payload?.status;
      if (lastStatus !== "PENDING") {
        break;
      }
      if (Date.now() >= deadline) {
        throw new Error("1xPartners: отчёт по игрокам ещё формируется (PENDING).");
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    if (lastStatus === "ERROR") {
      throw new Error(
        `1xPartners: ошибка отчёта по игрокам (status ERROR) · filter=${JSON.stringify(filter).slice(0, 400)}`,
      );
    }

    return {
      status: lastStatus,
      hash: payload?.hash,
      pagesCount: payload?.pagesCount,
      rows: payload?.rows ?? [],
    };
  }

  private async fetchPlayersReportAllRows(
    scope: { siteId: number } | { country: XPartnersCountry },
    options?: {
      onlyNewPlayers?: boolean;
      withoutDepositsOnly?: boolean;
      startPeriod?: string;
      endPeriod?: string;
    },
  ): Promise<PlayersReportRow[]> {
    const base = this.playersReportBaseFilter(scope, options);
    const load = async (extra: Record<string, unknown>) => {
      const first = await this.fetchPlayersReportOnce({ ...base, ...extra });
      const acc = [...(first.rows ?? [])];
      const pagesCount = Math.max(1, Number(first.pagesCount ?? 1));
      let hash = first.hash;
      for (let page = 2; page <= pagesCount && page <= 100; page++) {
        const next = await this.fetchPlayersReportOnce({
          ...base,
          ...extra,
          pageNumber: page,
          countOnPage: 100,
          ...(hash ? { hash } : {}),
        });
        acc.push(...(next.rows ?? []));
        hash = next.hash ?? hash;
      }
      return acc;
    };

    let rows = await load({});
    if (rows.length <= 4) {
      const paged = await load({ pageNumber: 1, countOnPage: 100 });
      if (paged.length > rows.length) {
        rows = paged;
      }
    }
    return rows;
  }

  private ingestPlayerReportRows(
    idSet: Set<string>,
    rows: PlayersReportRow[],
    dayKey: string,
    mode: "all" | "registeredToday",
  ): void {
    for (const row of rows) {
      if (mode === "registeredToday" && registrationDayKey(row.registrationDate) !== dayKey) {
        continue;
      }
      const id = String(row.playerId ?? "").trim();
      if (id) {
        idSet.add(id);
      }
    }
  }

  private static readonly NEW_PLAYER_REPORT_VARIANTS = [
    { onlyNewPlayers: true, withoutDepositsOnly: true },
    { onlyNewPlayers: true, withoutDepositsOnly: false },
  ] as const;

  private async addPlayerIdsFromReports(
    idSet: Set<string>,
    scope: { siteId: number },
    dayKey: string,
    label: string,
    options: {
      variants: ReadonlyArray<{ onlyNewPlayers: boolean; withoutDepositsOnly: boolean }>;
      periods: Array<{ startPeriod: string; endPeriod: string }>;
      mode: "all" | "registeredToday";
    },
  ): Promise<void> {
    let first = true;
    for (const period of options.periods) {
      for (const variant of options.variants) {
        if (!first) {
          await new Promise((resolve) => setTimeout(resolve, 400));
        }
        first = false;
        try {
          const rows = await this.fetchPlayersReportAllRows(scope, {
            ...variant,
            ...period,
          });
          console.log(
            `1xPartners ${label}: playersReport onlyNew=${variant.onlyNewPlayers} noDep=${variant.withoutDepositsOnly} end=${period.endPeriod} mode=${options.mode} rows=${rows.length}`,
          );
          this.ingestPlayerReportRows(idSet, rows, dayKey, options.mode);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          console.warn(
            `1xPartners ${label}: skip playersReport variant onlyNew=${variant.onlyNewPlayers} noDep=${variant.withoutDepositsOnly} · ${msg}`,
          );
        }
      }
    }
  }

  async fetchPlayerIdsToday(country: XPartnersCountry): Promise<XPartnersPlayersToday> {
    await this.ensureSession();
    const dayKey = todayDayKey();
    const { sites, label: siteLabel } = await this.resolveSitesForCountry(country);
    const quick = await this.fetchQuickStatsToday(country);
    const idSet = new Set<string>();
    const quickPeriod = quickReportTodayPeriod();
    const newVariants = XPartnersClient.NEW_PLAYER_REPORT_VARIANTS;

    for (const site of sites) {
      await this.addPlayerIdsFromReports(idSet, { siteId: site.id }, dayKey, `${country}:site${site.id}`, {
        variants: newVariants,
        periods: [quickPeriod],
        mode: "all",
      });
    }

    if (idSet.size < quick.registrations) {
      for (const site of sites) {
        await this.addPlayerIdsFromReports(idSet, { siteId: site.id }, dayKey, `${country}:site${site.id}:fallback`, {
          variants: newVariants,
          periods: todayReportPeriodVariants(),
          mode: "all",
        });
        await this.addPlayerIdsFromReports(idSet, { siteId: site.id }, dayKey, `${country}:site${site.id}:fallback`, {
          variants: [{ onlyNewPlayers: false, withoutDepositsOnly: false }],
          periods: todayReportPeriodVariants(),
          mode: "registeredToday",
        });
      }
    }

    let playerIds = [...idSet].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    if (playerIds.length > quick.registrations && quick.registrations > 0) {
      const byRegDate = new Set<string>();
      for (const site of sites) {
        await this.addPlayerIdsFromReports(
          byRegDate,
          { siteId: site.id },
          dayKey,
          `${country}:site${site.id}:trim`,
          {
            variants: newVariants,
            periods: todayReportPeriodVariants(),
            mode: "registeredToday",
          },
        );
      }
      if (byRegDate.size > 0 && byRegDate.size <= playerIds.length) {
        console.log(
          `1xPartners ${country}: trim player IDs ${playerIds.length} → ${byRegDate.size} (registrationDate=${dayKey}, сводка рег=${quick.registrations})`,
        );
        playerIds = [...byRegDate].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      }
    }

    if (
      quick.registrations > 0 &&
      playerIds.length === quick.newAccountsWithDeposits &&
      playerIds.length < quick.registrations
    ) {
      console.warn(
        `1xPartners ${country}: ID count matches FTD (${playerIds.length}) but registrations=${quick.registrations} — need XPARTNERS_REPORTS_COOKIE from «Отчёт по игрокам»`,
      );
    }

    if (quick.registrations > 0 && playerIds.length !== quick.registrations) {
      const hint = this.playersReportCookieHeader()
        ? ""
        : " · задайте XPARTNERS_REPORTS_COOKIE со страницы «Отчёт по игрокам»";
      console.warn(
        `1xPartners ${country}: player IDs ${playerIds.length} vs registrations ${quick.registrations}${hint}`,
      );
    }

    return {
      country,
      dayKey,
      siteLabel,
      playerIds,
      registrationsExpected: quick.registrations,
      fetchedAt: new Date().toISOString(),
    };
  }
}

let sharedClient: XPartnersClient | null = null;
let sharedMeta: AppMetaStore | undefined;

function hasStoredOrEnvAuth(
  env: AppEnv,
  flags: {
    hasStoredCookie: boolean;
    hasStoredCredentials: boolean;
    hasEnvCookie: boolean;
    hasEnvCredentials: boolean;
  },
): boolean {
  return (
    flags.hasStoredCookie ||
    flags.hasStoredCredentials ||
    flags.hasEnvCookie ||
    flags.hasEnvCredentials ||
    Boolean(parseCredentials(env)) ||
    Boolean(cookiesFromEnv(env))
  );
}

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
  console.log(`1xPartners: session keep-alive every ${minutes} min (ping + auto-refresh on expiry)`);
}
