import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Stage } from "./config.js";

export type PendingAction =
  | "await_pager_email"
  | "await_pager_password"
  | "await_pager_cookies";

export type PagerAccountState = {
  authMode: "credentials" | "cookies";
  email?: string;
  password?: string;
  cookies?: string;
  organizationId?: string;
  organizationName?: string;
  liveChannels?: Array<{
    id: string;
    name: string;
    channelSource?: string | null;
  }>;
  liveTemplateBanks?: Array<{
    id: string;
    name: string;
    replyCount?: number;
  }>;
  connectedAt: string;
};

export type ChannelRuntimeState = {
  enabled: boolean;
  country: "ZM" | "CM" | "EG";
  templateBank?: string;
};

export type ChatState = {
  chatId: number;
  channelId: string;
  currentStage: Stage;
  templateBankOverride?: string;
  pendingAction?: PendingAction;
  draftPagerEmail?: string;
  pagerAccount?: PagerAccountState;
  channels?: Record<string, ChannelRuntimeState>;
  updatedAt: string;
};

type StatePayload = {
  chats: Record<string, ChatState>;
};

export class StateStore {
  constructor(private readonly filePath: string) {}

  get(chatId: number): ChatState | undefined {
    const data = this.read();
    return data.chats[String(chatId)];
  }

  upsert(nextState: ChatState): ChatState {
    const data = this.read();
    data.chats[String(nextState.chatId)] = nextState;
    this.write(data);
    return nextState;
  }

  patch(chatId: number, patch: Partial<Omit<ChatState, "chatId">>): ChatState | undefined {
    const current = this.get(chatId);
    if (!current) {
      return undefined;
    }

    const nextState: ChatState = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    return this.upsert(nextState);
  }

  delete(chatId: number): void {
    const data = this.read();
    delete data.chats[String(chatId)];
    this.write(data);
  }

  private read(): StatePayload {
    try {
      const raw = readFileSync(this.filePath, "utf8");
      return JSON.parse(raw) as StatePayload;
    } catch {
      return { chats: {} };
    }
  }

  private write(payload: StatePayload): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(payload, null, 2));
  }
}
