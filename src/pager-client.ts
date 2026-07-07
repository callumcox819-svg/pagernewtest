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

  async getTemplateBanks(): Promise<PagerTemplateBank[]> {
    const folderCandidates = [
      "/api/savedReplyFolder",
      "/api/saved-reply-folder",
      "/api/savedRepliesFolder",
      "/api/saved-replies-folder",
      "/api/savedReply/folder",
      "/api/saved-reply/folder",
    ];
    const replyCandidates = [
      "/api/savedReply",
      "/api/saved-reply",
      "/api/savedReplies",
      "/api/saved-replies",
      "/api/replyTemplate",
      "/api/reply-template",
    ];

    const foldersPayload = await this.requestFirstSuccessful<unknown>(folderCandidates);
    const repliesPayload = await this.requestFirstSuccessful<unknown>(replyCandidates);
    return normalizeTemplateBanks(foldersPayload, repliesPayload);
  }

  async validateSession(): Promise<PagerSessionSummary> {
    const [channels, organization, templateBanks] = await Promise.all([
      this.getChannels(),
      this.getOrganization(),
      this.getTemplateBanks().catch(() => []),
    ]);

    if (!channels.length) {
      throw new Error("Pager session is not authorized or returned no channels.");
    }

    return {
      organizationId: organization?.id,
      organizationName: organization?.name,
      channelCount: channels.length,
      channels,
      templateBanks,
    };
  }

  private async requestFirstSuccessful<T>(paths: string[]): Promise<T | undefined> {
    for (const path of paths) {
      try {
        return await this.request<T>(path);
      } catch {
        continue;
      }
    }

    return undefined;
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

function normalizeTemplateBanks(
  foldersPayload: unknown,
  repliesPayload: unknown,
): PagerTemplateBank[] {
  const folderItems = Array.isArray(foldersPayload) ? foldersPayload : [];
  const replyItems = Array.isArray(repliesPayload) ? repliesPayload : [];

  const folderMap = new Map<string, PagerTemplateBank>();

  for (const item of folderItems) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const record = item as Record<string, unknown>;
    const id = firstString(record.id, record._id, record.folderId, record.uuid);
    const name = firstString(record.name, record.title, record.folderName, record.label);
    if (!id || !name) {
      continue;
    }

    folderMap.set(id, {
      id,
      name,
      replyCount: 0,
    });
  }

  for (const item of replyItems) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const record = item as Record<string, unknown>;
    const folderId = firstString(
      record.folderId,
      record.savedReplyFolderId,
      record.saved_reply_folder_id,
    );
    const folderName = firstString(record.folderName, record.folder, record.categoryName);

    if (folderId && folderMap.has(folderId)) {
      const current = folderMap.get(folderId);
      if (current) {
        current.replyCount += 1;
      }
      continue;
    }

    if (folderName) {
      const syntheticId = `name:${folderName}`;
      const current = folderMap.get(syntheticId) ?? {
        id: syntheticId,
        name: folderName,
        replyCount: 0,
      };
      current.replyCount += 1;
      folderMap.set(syntheticId, current);
    }
  }

  return [...folderMap.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}
