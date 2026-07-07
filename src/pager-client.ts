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
  templateBanks: PagerTemplateBank[];
};

export type PagerTemplateBank = {
  id: string;
  name: string;
  replyCount: number;
};

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export class PagerClient {
  private orgId = "";
  private orgSlug = "";

  constructor(
    private readonly options: {
      baseUrl: string;
      cookieHeader: string;
      orgId?: string;
      orgSlug?: string;
      locale?: string;
    },
  ) {
    this.orgId = options.orgId ?? "";
    this.orgSlug = options.orgSlug ?? "";
  }

  async getChannels(): Promise<PagerChannel[]> {
    const orgId = await this.ensureOrgId();
    const params = orgId ? { orgId } : undefined;
    const payload = await this.request<PagerChannel[]>("/api/channel", params);
    return Array.isArray(payload) ? payload : [];
  }

  async getOrganization(): Promise<{ id?: string; name?: string; slug?: string } | undefined> {
    try {
      const payload = await this.request<{ id?: string; name?: string; slug?: string }>(
        "/api/organization",
      );
      if (payload?.id) {
        this.orgId = payload.id;
      }
      if (payload?.slug) {
        this.orgSlug = payload.slug;
      }
      return payload;
    } catch {
      return undefined;
    }
  }

  async getTemplateBanks(): Promise<PagerTemplateBank[]> {
    const orgId = await this.ensureOrgId();
    if (!orgId) {
      return [];
    }

    const foldersPayload = await this.request<unknown>("/api/reply/folder", { orgId });
    const folders = normalizeReplyFolders(foldersPayload);
    if (!folders.length) {
      return [];
    }

    const withCounts = await Promise.all(
      folders.map(async (folder) => {
        try {
          const repliesPayload = await this.request<unknown>("/api/reply", {
            folderId: folder.id,
          });
          const replies = Array.isArray(repliesPayload) ? repliesPayload : [];
          return {
            ...folder,
            replyCount: replies.length,
          };
        } catch {
          return folder;
        }
      }),
    );

    return withCounts.sort((left, right) => left.name.localeCompare(right.name));
  }

  async validateSession(): Promise<PagerSessionSummary> {
    await this.warmSession();
    const organization = await this.getOrganization();
    const channels = await this.getChannels();
    const templateBanks = await this.getTemplateBanks().catch(() => []);

    if (!channels.length) {
      throw new Error("Pager session is not authorized or returned no channels.");
    }

    if (!this.orgId) {
      const fromChannel = channels.find((channel) => channel.organizationId)?.organizationId;
      if (fromChannel) {
        this.orgId = fromChannel;
      }
    }

    return {
      organizationId: organization?.id ?? this.orgId,
      organizationName: organization?.name,
      channelCount: channels.length,
      channels,
      templateBanks,
    };
  }

  private async warmSession(): Promise<void> {
    const locale = this.options.locale ?? "uk";
    const paths = [
      this.orgSlug ? `/${locale}/${this.orgSlug}/chats` : "",
      `/${locale}/chats`,
      "/chats",
    ].filter(Boolean);

    for (const path of paths) {
      try {
        const response = await fetch(new URL(path, this.options.baseUrl), {
          method: "GET",
          headers: this.buildHeaders("text/html"),
          redirect: "follow",
        });
        const finalUrl = response.url;
        const match = finalUrl.match(/\/(?:uk|en)\/([^/]+)\/chats/i);
        if (match && !this.orgSlug) {
          const slug = match[1].toLowerCase();
          if (!["chats", "sign-in", "en", "uk", "api"].includes(slug)) {
            this.orgSlug = slug;
          }
        }
        if (response.ok) {
          return;
        }
      } catch {
        continue;
      }
    }
  }

  private async ensureOrgId(): Promise<string> {
    if (this.orgId) {
      return this.orgId;
    }

    const organization = await this.getOrganization();
    if (organization?.id) {
      this.orgId = organization.id;
      return organization.id;
    }

    try {
      const channels = await this.request<PagerChannel[]>("/api/channel");
      const orgId = channels.find((channel) => channel.organizationId)?.organizationId ?? "";
      if (orgId) {
        this.orgId = orgId;
        return orgId;
      }
    } catch {
      // fall through
    }

    return "";
  }

  private buildHeaders(accept = "application/json, text/plain, */*"): Record<string, string> {
    const locale = this.options.locale ?? "uk";
    const referer = this.orgSlug
      ? `${this.options.baseUrl}/${locale}/${this.orgSlug}/chats`
      : `${this.options.baseUrl}/`;

    return {
      Cookie: this.options.cookieHeader,
      Accept: accept,
      "User-Agent": BROWSER_UA,
      Origin: this.options.baseUrl,
      Referer: referer,
    };
  }

  private async request<T>(
    path: string,
    params?: Record<string, string>,
  ): Promise<T> {
    const url = new URL(path, this.options.baseUrl);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value) {
          url.searchParams.set(key, value);
        }
      }
    }

    const response = await fetch(url, {
      method: "GET",
      headers: this.buildHeaders(),
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

function normalizeReplyFolders(payload: unknown): PagerTemplateBank[] {
  const items = Array.isArray(payload) ? payload : [];
  const folders: PagerTemplateBank[] = [];

  for (const item of items) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const record = item as Record<string, unknown>;
    const id = firstString(record.id, record._id, record.folderId, record.uuid);
    const name = firstString(record.name, record.title, record.folderName, record.label);
    if (!id || !name) {
      continue;
    }

    folders.push({
      id,
      name,
      replyCount: 0,
    });
  }

  return folders;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}
