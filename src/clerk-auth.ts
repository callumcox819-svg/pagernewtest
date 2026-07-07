type ClerkClientContext = {
  authorizationToken: string;
  cookieHeader?: string;
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
    "__clerk_api_version=2025-04-10&_clerk_js_version=5.105.0";

  constructor(
    private readonly options: {
      frontendApi: string;
    },
  ) {}

  async signInWithPassword(email: string, password: string): Promise<string> {
    const client = await this.createClient();
    const signInAttempt = await this.createSignInAttempt(client, email);

    if (signInAttempt.response?.status !== "needs_first_factor") {
      throw new Error("Clerk did not enter password sign-in stage.");
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

    const sessionId =
      attempt.response?.created_session_id ?? attempt.client?.last_active_session_id;

    if (!sessionId) {
      const error = attempt.errors?.[0]?.long_message ?? attempt.errors?.[0]?.message;
      throw new Error(error ?? "Password sign-in did not create a Clerk session.");
    }

    return this.createSessionJwt(client, sessionId);
  }

  private async createClient(): Promise<ClerkClientContext> {
    const response = await fetch(
      `https://${this.options.frontendApi}/v1/client?${this.queryString}`,
    );
    return this.buildClientContext(response);
  }

  private async createSignInAttempt(
    client: ClerkClientContext,
    email: string,
  ): Promise<ClerkSignInResponse> {
    const response = await fetch(
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
    const response = await fetch(
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

  private async createSessionJwt(
    client: ClerkClientContext,
    sessionId: string,
  ): Promise<string> {
    const response = await fetch(
      `https://${this.options.frontendApi}/v1/client/sessions/${sessionId}/tokens?${this.queryString}`,
      {
        method: "POST",
        headers: this.buildHeaders(client),
        body: "",
      },
    );

    this.refreshClientContext(client, response);

    const payload = (await response.json()) as
      | {
          jwt?: string;
          object?: string;
        }
      | {
          object?: string;
          jwt?: {
            __raw?: string;
          };
        }
      | {
          errors?: Array<{
            long_message?: string;
            message?: string;
          }>;
        };

    if ("errors" in payload && payload.errors?.length) {
      throw new Error(
        payload.errors[0]?.long_message ?? payload.errors[0]?.message ?? "Failed to mint Clerk session token.",
      );
    }

    if ("jwt" in payload && typeof payload.jwt === "string") {
      return payload.jwt;
    }

    if ("jwt" in payload && payload.jwt && typeof payload.jwt === "object" && "__raw" in payload.jwt) {
      return payload.jwt.__raw ?? "";
    }

    throw new Error("Clerk session token response did not contain a JWT.");
  }

  private buildHeaders(client: ClerkClientContext): Record<string, string> {
    return {
      authorization: client.authorizationToken,
      "content-type": "application/x-www-form-urlencoded",
      ...(client.cookieHeader ? { cookie: client.cookieHeader } : {}),
    };
  }

  private buildClientContext(response: Response): ClerkClientContext {
    const authorizationToken = response.headers.get("authorization");
    if (!authorizationToken) {
      throw new Error("Clerk client authorization token was not returned.");
    }

    return {
      authorizationToken,
      cookieHeader: this.extractCookieHeader(response),
    };
  }

  private refreshClientContext(client: ClerkClientContext, response: Response) {
    const authorizationToken = response.headers.get("authorization");
    if (authorizationToken) {
      client.authorizationToken = authorizationToken;
    }

    const cookieHeader = this.extractCookieHeader(response);
    if (cookieHeader) {
      client.cookieHeader = client.cookieHeader
        ? `${client.cookieHeader}; ${cookieHeader}`
        : cookieHeader;
    }
  }

  private extractCookieHeader(response: Response): string | undefined {
    const setCookies = response.headers.getSetCookie?.() ?? [];
    const cookiePairs = setCookies
      .map((item) => item.split(";")[0]?.trim())
      .filter((item): item is string => Boolean(item));

    if (cookiePairs.length === 0) {
      return undefined;
    }

    return cookiePairs.join("; ");
  }
}
