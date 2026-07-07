type InlineKeyboardButton = {
  text: string;
  callback_data: string;
};

type ReplyMarkup = {
  inline_keyboard: InlineKeyboardButton[][];
};

type TelegramResponse<T> = {
  ok: boolean;
  result: T;
  description?: string;
};

export type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
};

export type TelegramCallbackQuery = {
  id: string;
  data?: string;
  message?: TelegramMessage;
};

export type TelegramMessage = {
  message_id: number;
  chat: {
    id: number;
  };
  text?: string;
  caption?: string;
  photo?: Array<{
    file_id: string;
    width: number;
    height: number;
    file_size?: number;
  }>;
};

type TelegramFile = {
  file_id: string;
  file_unique_id: string;
  file_path?: string;
};

export class TelegramApi {
  private readonly baseUrl: string;

  constructor(token: string) {
    this.baseUrl = `https://api.telegram.org/bot${token}`;
  }

  async getUpdates(offset?: number, timeoutSeconds = 25): Promise<TelegramUpdate[]> {
    const result = await this.request<TelegramUpdate[]>("getUpdates", {
      offset,
      timeout: timeoutSeconds,
      allowed_updates: ["message", "callback_query"],
    });
    return result;
  }

  async sendMessage(
    chatId: number,
    text: string,
    replyMarkup?: ReplyMarkup,
  ): Promise<void> {
    await this.request("sendMessage", {
      chat_id: chatId,
      text,
      reply_markup: replyMarkup,
    });
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    await this.request("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text,
    });
  }

  async getFile(fileId: string): Promise<TelegramFile> {
    return this.request<TelegramFile>("getFile", { file_id: fileId });
  }

  async downloadFile(filePath: string, token: string): Promise<Buffer> {
    const response = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
    if (!response.ok) {
      throw new Error(`Failed to download Telegram file: ${response.status}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  private async request<T = unknown>(
    method: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const response = await fetch(`${this.baseUrl}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });

    if (!response.ok) {
      throw new Error(`Telegram request failed: ${method} ${response.status}`);
    }

    const payload = (await response.json()) as TelegramResponse<T>;
    if (!payload.ok) {
      throw new Error(payload.description ?? `Telegram API error on ${method}`);
    }

    return payload.result;
  }
}

export function buildChannelKeyboard(
  channels: Array<{
    id: string;
    name: string;
    country: string;
    enabled: boolean;
    templateBank?: string;
  }>,
): ReplyMarkup {
  return {
    inline_keyboard: channels.flatMap((channel) => [
      [
        {
          text: `${channel.enabled ? "ON" : "OFF"} | ${channel.name}`,
          callback_data: `channel_toggle:${channel.id}`,
        },
        {
          text: channel.country,
          callback_data: `channel_country:${channel.id}`,
        },
        {
          text: channel.templateBank ?? "Replies",
          callback_data: `channel_bank:${channel.id}`,
        },
      ],
    ]),
  };
}

export function buildTemplateKeyboard(
  channelId: string,
  templateNames: string[],
): ReplyMarkup {
  return {
    inline_keyboard: templateNames.map((name) => [
      { text: name, callback_data: `template:${channelId}:${name}` },
    ]),
  };
}

export function buildStageKeyboard(stages: string[]): ReplyMarkup {
  return {
    inline_keyboard: stages.map((stage) => [
      { text: stage, callback_data: `stage:${stage}` },
    ]),
  };
}

export function buildMainMenuKeyboard(): ReplyMarkup {
  return {
    inline_keyboard: [
      [
        { text: "Pager аккаунт", callback_data: "menu:pager_account" },
        { text: "Каналы", callback_data: "menu:channels" },
      ],
      [
        { text: "Статус", callback_data: "menu:status" },
        { text: "Сброс", callback_data: "menu:reset" },
      ],
    ],
  };
}

export function buildPagerAccountKeyboard(isConnected: boolean): ReplyMarkup {
  return {
    inline_keyboard: [
      [
        { text: "Email + пароль", callback_data: "pager:login_password" },
        { text: "Импорт cookies", callback_data: "pager:import_cookies" },
      ],
      [
        {
          text: isConnected ? "Отключить" : "Очистить",
          callback_data: "pager:disconnect",
        },
      ],
      [{ text: "Назад", callback_data: "menu:main" }],
    ],
  };
}
