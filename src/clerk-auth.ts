import makeFetchCookie from "fetch-cookie";
import { CookieJar } from "tough-cookie";

type ClerkClientContext = {
  authorizationToken: string;
  fetchWithCookies: typeof fetch;
  jar: CookieJar;
};

type ClerkClientPayload = {
  response?: {
    sessions?: Array<{
      status?: string;
      last_active_token?: {
        jwt?: string;
      };
      last_active_organization_id?: string | null;
      active_organization_id?: string | null;
      user?: {
        id?: string;
      };
    }>;
    last_active_organization_id?: string | null;
    active_organization_id?: string | null;
  };
};

type ClerkSignInResponse = {
  response?: {
    id?: string;
    status?: string;
    created_session_id?: string | null;
    supported_first_factors?: Array<{
      strategy?: string;
    }>;
  };
  client?: {
    last_active_session_id?: string | null;
  };
  errors?: Array<{
    message?: string;
    long_message?: string;
    code?: string;
  }>;
};

export class ClerkPasswordAuthClient {
  private readonly queryString =
    "__clerk_api_version=2024-10-01&_clerk_js_version=5.68.0";
  private readonly pagerBaseUrl = "https://www.pager.co.ua";
  private readonly userAgent =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

  constructor(
    private readonly options: {
      frontendApi: string;
    },
  ) {}

  async signInWithPassword(email: string, password: string): Promise<string> {
    const client = await this.createClient();

    const signInAttempt = await this.createSignInAttempt(client, email);
    if (signInAttempt.response?.status !== "needs_first_factor") {
      const error =
        signInAttempt.errors?.[0]?.long_message ??
        signInAttempt.errors?.[0]?.message;
      throw new Error(error ?? "Clerk did not enter password sign-in stage.");
    }

    const supportsPassword = signInAttempt.response?.supported_first_factors?.some(
      (factor) => factor.strategy === "password",
    );
    if (!supportsPassword) {
      throw new Error("This account does not offer password sign-in.");
    }

    const attempt = await this.attemptPasswordFactor(
      client,
      signInAttempt.response.id ?? "",
      password,
    );
    const error = attempt.errors?.[0]?.long_message ?? attempt.errors?.[0]?.message;
    if (error) {
      throw new Error(error);
    }

    const clerkClient = await this.fetchClientState(client);
    const jwt = this.extractSessionJwt(clerkClient);
    if (!jwt) {
      throw new Error("Clerk session JWT was not found after login.");
    }

    return jwt;
  }

  private async createClient(): Promise<ClerkClientContext> {
    const headers = this.baseHeaders();
    const jar = new CookieJar();
    const fetchWithCookies = makeFetchCookie(fetch, jar);

    await fetchWithCookies(`${this.pagerBaseUrl}/sign-in`, {
      method: "GET",
      headers,
    });

    const response = await fetchWithCookies(`https://${this.options.frontendApi}/v1/client?${this.queryString}`, {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    return this.buildClientContext(response, fetchWithCookies, jar);
  }

  private async createSignInAttempt(
    client: ClerkClientContext,
    email: string,
  ): Promise<ClerkSignInResponse> {
    const response = await client.fetchWithCookies(
      `https://${this.options.frontendApi}/v1/client/sign_ins?${this.queryString}`,
      {
        method: "POST",
        headers: this.buildHeaders(client),
        body: new URLSearchParams({
          identifier: email,
        }),
      },
    );

    this.refreshClientContext(client, response);

    return (await response.json()) as ClerkSignInResponse;
  }

  private async attemptPasswordFactor(
    client: ClerkClientContext,
    signInId: string,
    password: string,
  ): Promise<ClerkSignInResponse> {
    const response = await client.fetchWithCookies(
      `https://${this.options.frontendApi}/v1/client/sign_ins/${signInId}/attempt_first_factor?${this.queryString}`,
      {
        method: "POST",
        headers: this.buildHeaders(client),
        body: new URLSearchParams({
          strategy: "password",
          password,
        }),
      },
    );

    this.refreshClientContext(client, response);

    return (await response.json()) as ClerkSignInResponse;
  }

  private async fetchClientState(
    client: ClerkClientContext,
  ): Promise<ClerkClientPayload> {
    const response = await client.fetchWithCookies(
      `https://${this.options.frontendApi}/v1/client?${this.queryString}`,
      {
        method: "GET",
        headers: this.buildHeaders(client),
      },
    );

    this.refreshClientContext(client, response);
    return (await response.json()) as ClerkClientPayload;
  }

  private buildHeaders(client: ClerkClientContext): Record<string, string> {
    return {
      ...this.baseHeaders(),
      authorization: client.authorizationToken,
      "content-type": "application/x-www-form-urlencoded",
    };
  }

  private buildClientContext(
    response: Response,
    fetchWithCookies: typeof fetch,
    jar: CookieJar,
  ): ClerkClientContext {
    const authorizationToken = response.headers.get("authorization");
    if (!authorizationToken) {
      throw new Error("Clerk client authorization token was not returned.");
    }

    return {
      authorizationToken,
      fetchWithCookies,
      jar,
    };
  }

  private refreshClientContext(client: ClerkClientContext, response: Response) {
    const authorizationToken = response.headers.get("authorization");
    if (authorizationToken) {
      client.authorizationToken = authorizationToken;
    }
  }

  private extractSessionJwt(payload: ClerkClientPayload): string {
    const sessions = payload.response?.sessions ?? [];
    for (const session of sessions) {
      const status = String(session.status ?? "").toLowerCase();
      if (status && status !== "active" && status !== "pending") {
        continue;
      }
      const jwt = session.last_active_token?.jwt?.trim();
      if (jwt) {
        return jwt;
      }
    }
    return "";
  }

  private baseHeaders(): Record<string, string> {
    return {
      "user-agent": this.userAgent,
      origin: this.pagerBaseUrl,
      referer: `${this.pagerBaseUrl}/sign-in`,
    };
  }
}
