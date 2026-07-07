export type PagerChannel = {
  id: string;
  name: string;
  channelSource?: string | null;
  organizationId?: string | null;
};

export type PagerSessionSummary = {
  organizationId?: string;
  organizationName?: string;
  channelCount: number;
  channels: PagerChannel[];
};

export class PagerClient {
  constructor(
    private readonly options: {
      baseUrl: string;
      cookieHeader: string;
    },
  ) {}

  async getChannels(): Promise<PagerChannel[]> {
    const payload = await this.request<PagerChannel[]>("/api/channel");
    return Array.isArray(payload) ? payload : [];
  }

  async getOrganization(): Promise<{ id?: string; name?: string } | undefined> {
    try {
      const payload = await this.request<{ id?: string; name?: string }>("/api/organization");
      return payload;
    } catch {
      return undefined;
    }
  }

  async validateSession(): Promise<PagerSessionSummary> {
    const [channels, organization] = await Promise.all([
      this.getChannels(),
      this.getOrganization(),
    ]);

    if (!channels.length) {
      throw new Error("Pager session is not authorized or returned no channels.");
    }

    return {
      organizationId: organization?.id,
      organizationName: organization?.name,
      channelCount: channels.length,
      channels,
    };
  }

  private async request<T>(path: string): Promise<T> {
    const response = await fetch(new URL(path, this.options.baseUrl), {
      method: "GET",
      headers: {
        Cookie: this.options.cookieHeader,
        Accept: "application/json, text/plain, */*",
        "User-Agent": "pagernewtest-bot/1.0",
      },
    });

    if (!response.ok) {
      throw new Error(`Pager request failed for ${path}: ${response.status}`);
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      const text = await response.text();
      throw new Error(`Pager request for ${path} did not return JSON: ${text.slice(0, 160)}`);
    }

    return (await response.json()) as T;
  }
}
