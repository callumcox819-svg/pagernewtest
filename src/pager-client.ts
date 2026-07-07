import { randomUUID } from "node:crypto";

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

export type PagerConversation = {
  id: string;
  channelId?: string;
  statusId?: string | null;
  lastMessageDirection?: string;
  lastMessageAt?: string;
  clientPSID?: string;
  responsibleUserId?: string;
  responsibleuserId?: string;
  channel?: { id?: string; name?: string };
  status?: { id?: string; name?: string };
  client?: { psid?: string; PSID?: string };
};

export type PagerMessage = {
  id: string;
  text?: string;
  messageDirection?: string;
  authorId?: string;
  createdAt?: string;
  isDelivered?: boolean;
  facebookMessageId?: string;
  attachments?: Array<{ type?: string; payload?: { url?: string } }>;
};

export type PagerSavedReply = {
  id: string;
  text: string;
  name?: string;
};

export class PagerApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`Pager API ${status}: ${body.slice(0, 200)}`);
  }
}

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export class PagerClient {
  private orgId = "";
  private orgSlug = "";
  private sessionUserId = "";

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
    const payload = await this.request<PagerChannel[]>("/api/channel", { method: "GET", params });
    return Array.isArray(payload) ? payload : [];
  }

  async getOrganization(): Promise<{ id?: string; name?: string; slug?: string } | undefined> {
    try {
      const payload = await this.request<{ id?: string; name?: string; slug?: string }>(
        "/api/organization",
        { method: "GET" },
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

    const foldersPayload = await this.request<unknown>("/api/reply/folder", {
      method: "GET",
      params: { orgId },
    });
    const folders = normalizeReplyFolders(foldersPayload);
    if (!folders.length) {
      return [];
    }

    const withCounts = await Promise.all(
      folders.map(async (folder) => {
        try {
          const replies = await this.getSavedReplies(folder.id);
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

  async getSavedReplies(folderId: string): Promise<PagerSavedReply[]> {
    const payload = await this.request<unknown>("/api/reply", {
      method: "GET",
      params: { folderId },
    });
    if (!Array.isArray(payload)) {
      return [];
    }

    const replies: PagerSavedReply[] = [];
    for (const item of payload) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const record = item as Record<string, unknown>;
      const id = firstString(record.id, record._id, record.replyId);
      const text = firstString(record.text, record.body, record.message);
      if (!id || !text) {
        continue;
      }
      replies.push({
        id,
        text,
        name: firstString(record.name, record.title),
      });
    }
    return replies;
  }

  async listConversations(options?: {
    page?: number;
    pageSize?: number;
    channelId?: string;
    statusId?: string;
  }): Promise<PagerConversation[]> {
    const orgId = await this.ensureOrgId();
    const params: Record<string, string> = {
      orgId,
      page: String(options?.page ?? 1),
      pageSize: String(options?.pageSize ?? 50),
    };
    if (options?.channelId) {
      params.channelId = options.channelId;
    }
    if (options?.statusId !== undefined) {
      params.statusId = options.statusId;
    }

    const payload = await this.request<unknown>("/api/conversation", { method: "GET", params });
    const conversations = Array.isArray(payload) ? (payload as PagerConversation[]) : [];
    if (options?.channelId) {
      return conversations.filter((conv) => conv.channelId === options.channelId);
    }
    return conversations;
  }

  async collectConversationsForChannels(
    channelIds: string[],
    maxPages = 3,
  ): Promise<PagerConversation[]> {
    const seen = new Map<string, PagerConversation>();
    for (const channelId of channelIds) {
      for (let page = 1; page <= maxPages; page += 1) {
        const batch = await this.listConversations({ channelId, page, pageSize: 50 });
        if (!batch.length) {
          break;
        }
        for (const conv of batch) {
          seen.set(conv.id, conv);
        }
        if (batch.length < 50) {
          break;
        }
      }
    }
    return [...seen.values()];
  }

  async openConversation(convId: string): Promise<PagerConversation | undefined> {
    const orgId = await this.ensureOrgId();
    try {
      const payload = await this.request<PagerConversation>(`/api/conversation/${convId}`, {
        method: "GET",
        params: { orgId },
        referer: this.chatReferer(convId),
      });
      return payload;
    } catch {
      return undefined;
    }
  }

  async listMessages(convId: string, page = 1, pageSize = 50): Promise<PagerMessage[]> {
    const orgId = await this.ensureOrgId();
    const payload = await this.request<unknown>("/api/message", {
      method: "GET",
      params: {
        orgId,
        convId,
        page: String(page),
        pageSize: String(pageSize),
      },
    });
    return Array.isArray(payload) ? (payload as PagerMessage[]) : [];
  }

  async resolveSessionUserId(): Promise<string> {
    if (this.sessionUserId) {
      return this.sessionUserId;
    }

    const orgId = await this.ensureOrgId();
    for (const path of ["/api/user/me", "/api/users/me", "/api/user"]) {
      try {
        const payload = await this.request<unknown>(path, {
          method: "GET",
          params: { orgId },
        });
        const userId = extractUserId(payload);
        if (userId) {
          this.sessionUserId = userId;
          return userId;
        }
      } catch {
        continue;
      }
    }
    return "";
  }

  async takeConversation(convId: string, userId: string): Promise<boolean> {
    const uid = userId.trim();
    if (!uid) {
      return false;
    }

    if ((await this.getResponsibleUserId(convId)) === uid) {
      return true;
    }

    const orgId = await this.ensureOrgId();
    const referer = this.chatReferer(convId);
    const attempts: Array<{ params: Record<string, string>; body: Record<string, unknown> }> = [
      {
        params: { userId: uid, orgId },
        body: { responsibleUserId: uid, conversationState: "read" },
      },
      { params: { userId: uid, orgId }, body: { responsibleUserId: uid } },
      {
        params: { userId: uid, orgId },
        body: { responsibleuserId: uid, conversationState: "read" },
      },
      { params: { userId: uid }, body: { responsibleUserId: uid } },
    ];

    for (const attempt of attempts) {
      try {
        await this.request(`/api/conversation/${convId}`, {
          method: "PATCH",
          params: attempt.params,
          body: attempt.body,
          referer,
        });
      } catch {
        continue;
      }
      if (await this.waitTakeConfirmed(convId, uid)) {
        return true;
      }
    }

    return (await this.getResponsibleUserId(convId)) === uid;
  }

  async prepareOutbound(
    convId: string,
    conv?: PagerConversation,
    authorId = "",
  ): Promise<{ userId: string; conv: PagerConversation }> {
    await this.warmSession();
    const userId = (authorId || (await this.resolveSessionUserId())).trim();
    let convData: PagerConversation = { ...(conv ?? { id: convId }) };
    const fresh = await this.openConversation(convId);
    if (fresh) {
      convData = { ...convData, ...fresh };
    }

    if (userId) {
      let taken = await this.takeConversation(convId, userId);
      if (!taken) {
        await sleep(800);
        const retryConv = await this.openConversation(convId);
        if (retryConv) {
          convData = { ...convData, ...retryConv };
        }
        taken = await this.takeConversation(convId, userId);
      }
      if (!taken) {
        throw new PagerApiError(
          502,
          JSON.stringify({
            error: "take chat failed — operator not assigned",
            conv: convId.slice(0, 8),
          }),
        );
      }
      try {
        await this.markConversationRead(convId, userId);
      } catch {
        // non-fatal
      }
      const afterTake = await this.openConversation(convId);
      if (afterTake) {
        convData = { ...convData, ...afterTake };
      }
    }

    await this.fetchConversationChatPage(convId);
    try {
      await this.listMessages(convId, 1, 1);
    } catch {
      // non-fatal
    }

    return { userId, conv: convData };
  }

  async sendMessageReliable(
    convId: string,
    text: string,
    options?: {
      userId?: string;
      channelId?: string;
      conv?: PagerConversation;
    },
  ): Promise<boolean> {
    const prepared = await this.prepareOutbound(convId, options?.conv, options?.userId);
    const userId = prepared.userId;
    const conv = prepared.conv;
    const channelId = (options?.channelId || conv.channelId || conv.channel?.id || "").trim();

    const attempts: Array<() => Promise<Record<string, unknown>>> = [
      () => this.sendMessageSpa(convId, text, { userId, channelId, conv }),
      () => this.postMessageMinimal(convId, text, userId),
    ];

    for (const attempt of attempts) {
      try {
        const result = await attempt();
        if (messageDelivered(result)) {
          return true;
        }
      } catch (error) {
        console.warn(`Pager send attempt failed for ${convId.slice(0, 8)}:`, formatError(error));
      }
    }

    return this.waitMessageDelivered(convId, text, userId);
  }

  async downloadAttachment(url: string): Promise<Buffer> {
    const response = await fetch(url, {
      headers: {
        Cookie: this.options.cookieHeader,
        "User-Agent": BROWSER_UA,
        Referer: this.options.baseUrl,
      },
    });
    if (!response.ok) {
      throw new Error(`Failed to download attachment: ${response.status}`);
    }
    return Buffer.from(await response.arrayBuffer());
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

  private async sendMessageSpa(
    convId: string,
    text: string,
    options: { userId: string; channelId: string; conv: PagerConversation },
  ): Promise<Record<string, unknown>> {
    const orgId = await this.ensureOrgId();
    const referer = this.chatReferer(convId);
    let convData = options.conv;
    if (!convData.channelId) {
      const opened = await this.openConversation(convId);
      if (opened) {
        convData = opened;
      }
    }

    const channelId = (options.channelId || convData.channelId || convData.channel?.id || "").trim();
    if (!channelId) {
      throw new PagerApiError(400, JSON.stringify({ error: "channelId missing", conv: convId.slice(0, 8) }));
    }

    const recipient = extractRecipientPsid(convData);
    const imageUrl = await this.getOperatorImageUrl(options.userId, convData);
    const now = new Date().toISOString();
    const payload: Record<string, unknown> = {
      id: randomUUID(),
      channelId,
      text,
      conversationId: convId,
      messageDirection: "outgoing",
      authorId: options.userId,
      author: { id: options.userId, imageUrl: imageUrl || "" },
      recipient,
      createdAt: now,
      updatedAt: now,
      lastMessageAt: now,
      optimistic: true,
      isDelivered: null,
      replyToMessageId: null,
    };

    const params: Record<string, string> = { orgId };
    if (options.userId) {
      params.userId = options.userId;
    }

    const result = await this.request<Record<string, unknown>>("/api/message", {
      method: "POST",
      params,
      body: payload,
      referer,
    });
    if (!result || typeof result !== "object") {
      throw new PagerApiError(502, '{"error":"empty message response"}');
    }
    return result;
  }

  private async postMessageMinimal(
    convId: string,
    text: string,
    userId: string,
  ): Promise<Record<string, unknown>> {
    const orgId = await this.ensureOrgId();
    const params: Record<string, string> = { orgId };
    if (userId) {
      params.userId = userId;
    }

    const result = await this.request<Record<string, unknown>>("/api/message", {
      method: "POST",
      params,
      body: { conversationId: convId, text },
      referer: this.chatReferer(convId),
    });
    if (!result || typeof result !== "object") {
      throw new PagerApiError(502, '{"error":"empty message response"}');
    }
    return result;
  }

  private async markConversationRead(convId: string, userId: string): Promise<void> {
    const orgId = await this.ensureOrgId();
    await this.request(`/api/conversation/${convId}`, {
      method: "PATCH",
      params: { userId, orgId },
      body: { conversationState: "read" },
      referer: this.chatReferer(convId),
    });
  }

  private async getResponsibleUserId(convId: string): Promise<string> {
    const conv = await this.openConversation(convId);
    if (!conv) {
      return "";
    }
    return (
      conv.responsibleUserId ||
      conv.responsibleuserId ||
      ""
    ).trim();
  }

  private async waitTakeConfirmed(convId: string, userId: string, attempts = 10): Promise<boolean> {
    for (let index = 0; index < attempts; index += 1) {
      if ((await this.getResponsibleUserId(convId)) === userId) {
        return true;
      }
      await sleep(500);
    }
    return false;
  }

  private async getOperatorImageUrl(userId: string, conv?: PagerConversation): Promise<string> {
    if (!userId) {
      return "";
    }

    const orgId = await this.ensureOrgId();
    try {
      const members = await this.request<unknown>("/api/organizationMember", {
        method: "GET",
        params: { orgId },
      });
      if (!Array.isArray(members)) {
        return "";
      }
      for (const member of members) {
        if (!member || typeof member !== "object") {
          continue;
        }
        const record = member as Record<string, unknown>;
        const user = record.user && typeof record.user === "object"
          ? (record.user as Record<string, unknown>)
          : {};
        const memberId = firstString(record.userId, record.pagerUserId, user.id, record.id);
        if (memberId === userId) {
          return firstString(record.imageUrl, user.imageUrl) ?? "";
        }
      }
    } catch {
      return "";
    }
    return "";
  }

  private async waitMessageDelivered(
    convId: string,
    text: string,
    userId: string,
    timeoutMs = 45_000,
  ): Promise<boolean> {
    const needle = text.trim().toLowerCase().slice(0, 72);
    if (!needle) {
      return false;
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const messages = await this.listMessages(convId, 1, 15);
        for (const message of messages) {
          const direction = (message.messageDirection || "").toLowerCase();
          if (direction !== "outgoing" && direction !== "out") {
            continue;
          }
          const author = (message.authorId || "").trim();
          if (userId && author && author !== userId) {
            continue;
          }
          const body = (message.text || "").trim().toLowerCase();
          if (!body.includes(needle.slice(0, 40)) && !needle.includes(body.slice(0, 40))) {
            continue;
          }
          if (message.isDelivered || message.facebookMessageId) {
            return true;
          }
        }
      } catch {
        // keep polling
      }
      await sleep(700);
    }
    return false;
  }

  private async fetchConversationChatPage(convId: string): Promise<void> {
    if (!this.orgSlug || !convId) {
      return;
    }
    const locale = this.options.locale ?? "uk";
    const path = `/${locale}/${this.orgSlug}/chats/${convId}`;
    try {
      await fetch(new URL(path, this.options.baseUrl), {
        method: "GET",
        headers: {
          Accept: "text/html",
          Cookie: this.options.cookieHeader,
          Referer: this.chatReferer(),
          "User-Agent": BROWSER_UA,
        },
        redirect: "follow",
      });
    } catch {
      // non-fatal
    }
  }

  async warmSession(): Promise<void> {
    const html = await this.fetchChatsHtml();
    if (!html) {
      return;
    }

    const orgFromHtml = extractOrgFromHtml(html);
    if (orgFromHtml) {
      this.orgId = orgFromHtml;
    }
    if (!this.orgSlug) {
      const slug = extractOrgSlugFromHtml(html);
      if (slug) {
        this.orgSlug = slug;
      }
    }
  }

  private async fetchChatsHtml(): Promise<string> {
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
          headers: {
            Cookie: this.options.cookieHeader,
            Accept: "text/html",
            Referer: `${this.options.baseUrl}/`,
            "User-Agent": BROWSER_UA,
          },
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
        const html = await response.text();
        if (html) {
          return html;
        }
      } catch {
        continue;
      }
    }
    return "";
  }

  private async discoverOrgId(): Promise<string> {
    if (this.orgId) {
      return this.orgId;
    }

    const cookieOrg = this.parseCookies()._pager_org_id?.trim();
    if (cookieOrg?.startsWith("org_")) {
      this.orgId = cookieOrg;
      return cookieOrg;
    }

    await this.warmSession();
    if (this.orgId) {
      return this.orgId;
    }

    const organization = await this.getOrganization();
    if (organization?.id) {
      this.orgId = organization.id;
      return organization.id;
    }

    const fromConversations = await this.tryOrgFromConversations();
    if (fromConversations) {
      return fromConversations;
    }

    const fromSlug = await this.tryOrgBySlug();
    if (fromSlug) {
      return fromSlug;
    }

    try {
      const channels = await this.request<PagerChannel[]>("/api/channel", { method: "GET" });
      const orgId = channels.find((channel) => channel.organizationId)?.organizationId ?? "";
      if (orgId) {
        this.orgId = orgId;
        return orgId;
      }
    } catch {
      // fall through
    }

    const html = await this.fetchChatsHtml();
    if (html) {
      const orgFromHtml = extractOrgFromHtml(html);
      if (orgFromHtml) {
        this.orgId = orgFromHtml;
        return orgFromHtml;
      }
    }

    return "";
  }

  private async tryOrgFromConversations(): Promise<string> {
    try {
      const payload = await this.request<unknown>("/api/conversation", {
        method: "GET",
        params: { pageSize: "1", page: "1" },
      });
      if (!Array.isArray(payload) || !payload.length) {
        return "";
      }
      const first = payload[0] as Record<string, unknown>;
      const orgId = String(first.organizationId || first.orgId || "").trim();
      if (orgId.startsWith("org_")) {
        this.orgId = orgId;
        return orgId;
      }
    } catch {
      return "";
    }
    return "";
  }

  private async tryOrgBySlug(): Promise<string> {
    if (!this.orgSlug) {
      return "";
    }
    for (const path of [`/api/organization/${this.orgSlug}`, `/api/organizations/${this.orgSlug}`]) {
      try {
        const payload = await this.request<unknown>(path, { method: "GET" });
        const orgId = extractOrgFromPayload(payload);
        if (orgId) {
          this.orgId = orgId;
          return orgId;
        }
      } catch {
        continue;
      }
    }
    return "";
  }

  private parseCookies(): Record<string, string> {
    const cookies: Record<string, string> = {};
    for (const part of this.options.cookieHeader.split(";")) {
      const piece = part.trim();
      if (!piece.includes("=")) {
        continue;
      }
      const [key, ...rest] = piece.split("=");
      cookies[key.trim()] = rest.join("=").trim();
    }
    return cookies;
  }

  private async ensureOrgId(): Promise<string> {
    const orgId = await this.discoverOrgId();
    if (!orgId) {
      throw new PagerApiError(
        400,
        '{"error":"Organization ID required — could not auto-detect orgId"}',
      );
    }
    return orgId;
  }

  private chatReferer(convId?: string): string {
    const locale = this.options.locale ?? "uk";
    const base = this.orgSlug
      ? `${this.options.baseUrl}/${locale}/${this.orgSlug}/chats`
      : `${this.options.baseUrl}/`;
    return convId ? `${base}/${convId}` : base;
  }

  private buildHeaders(accept = "application/json, text/plain, */*"): Record<string, string> {
    return {
      Cookie: this.options.cookieHeader,
      Accept: accept,
      "Content-Type": "application/json",
      "User-Agent": BROWSER_UA,
      Origin: this.options.baseUrl,
      Referer: this.chatReferer(),
    };
  }

  private async request<T>(
    path: string,
    options: {
      method: "GET" | "POST" | "PATCH";
      params?: Record<string, string>;
      body?: unknown;
      referer?: string;
    },
  ): Promise<T> {
    const url = new URL(path, this.options.baseUrl);
    if (options.params) {
      for (const [key, value] of Object.entries(options.params)) {
        if (value) {
          url.searchParams.set(key, value);
        }
      }
    }

    const headers = this.buildHeaders();
    if (options.referer) {
      headers.Referer = options.referer;
    }

    const response = await fetch(url, {
      method: options.method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    const text = await response.text();
    if (!response.ok) {
      throw new PagerApiError(response.status, text);
    }

    if (!text.trim()) {
      return {} as T;
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      throw new Error(`Pager request for ${path} did not return JSON: ${text.slice(0, 160)}`);
    }

    return JSON.parse(text) as T;
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

function extractUserId(data: unknown): string {
  if (!data || typeof data !== "object") {
    return "";
  }
  const record = data as Record<string, unknown>;
  for (const key of ["id", "userId", "pagerUserId"]) {
    const value = record[key];
    if (typeof value === "string" && value.startsWith("user_")) {
      return value;
    }
  }
  for (const key of ["user", "data"]) {
    const nested = record[key];
    const found = extractUserId(nested);
    if (found) {
      return found;
    }
  }
  return "";
}

function extractRecipientPsid(conv: PagerConversation): string {
  return (
    conv.clientPSID ||
    conv.client?.psid ||
    conv.client?.PSID ||
    ""
  ).trim();
}

function extractOrgFromPayload(data: unknown): string {
  if (!data || typeof data !== "object") {
    if (Array.isArray(data) && data.length) {
      return extractOrgFromPayload(data[0]);
    }
    return "";
  }

  const record = data as Record<string, unknown>;
  for (const key of ["id", "organizationId", "orgId"]) {
    const value = record[key];
    if (typeof value === "string" && value.startsWith("org_")) {
      return value;
    }
  }

  for (const key of ["organizations", "items", "data", "organization", "org"]) {
    const nested = record[key];
    const found = extractOrgFromPayload(nested);
    if (found) {
      return found;
    }
  }

  return "";
}

function extractOrgFromHtml(html: string): string {
  const nextData = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (nextData?.[1]) {
    try {
      const found = extractOrgFromPayload(JSON.parse(nextData[1]));
      if (found) {
        return found;
      }
    } catch {
      // ignore parse errors
    }
  }

  const patterns = [
    /"orgId"\s*:\s*"(org_[^"]+)"/,
    /"organizationId"\s*:\s*"(org_[^"]+)"/,
    /orgId=(org_[^&"'\s]+)/,
    /(org_[a-zA-Z0-9]{20,})/,
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }
  return "";
}

function extractOrgSlugFromHtml(html: string): string {
  const patterns = [
    /\/(?:uk|en)\/([a-z0-9_-]+)\/chats/i,
    /"slug"\s*:\s*"([a-z0-9_-]+)"/i,
    /"orgSlug"\s*:\s*"([a-z0-9_-]+)"/i,
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) {
      const slug = match[1].toLowerCase();
      if (!["chats", "sign-in", "en", "uk", "api"].includes(slug)) {
        return slug;
      }
    }
  }
  return "";
}

function messageDelivered(result: Record<string, unknown>): boolean {
  if (result.isDelivered === true) {
    return true;
  }
  const facebookMessageId = String(result.facebookMessageId || "").trim();
  if (facebookMessageId) {
    return true;
  }
  if (result.optimistic === true) {
    const messageId = String(result.id || result.messageId || "").trim();
    const authorId = String(result.authorId || "").trim();
    if (messageId || authorId) {
      return true;
    }
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function isIncomingDirection(direction?: string): boolean {
  const normalized = (direction || "").toLowerCase();
  return normalized === "incoming" || normalized === "in";
}

export function isOutgoingDirection(direction?: string): boolean {
  const normalized = (direction || "").toLowerCase();
  return normalized === "outgoing" || normalized === "out";
}
