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
  ): Promise<number | undefined> {
    const result = await this.request<{ message_id: number }>("sendMessage", {
      chat_id: chatId,
      text,
      reply_markup: replyMarkup,
    });
    return result.message_id;
  }

  async editMessageReplyMarkup(
    chatId: number,
    messageId: number,
    replyMarkup: ReplyMarkup,
  ): Promise<void> {
    await this.request("editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: replyMarkup,
    });
  }

  async editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    replyMarkup?: ReplyMarkup,
  ): Promise<void> {
    await this.request("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
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

const COUNTRY_LABELS: Record<string, string> = {
  ZM: "🇿🇲 ZM",
  EG: "🇪🇬 EG",
  CM: "🇨🇲 CM",
};

function truncateLabel(value: string, max = 14): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max - 1)}…`;
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
    inline_keyboard: [
      ...channels.map((channel) => [
        {
          text: `${channel.enabled ? "🟢" : "🔴"} ${channel.name}`,
          callback_data: `channel_toggle:${channel.id}`,
        },
        {
          text: COUNTRY_LABELS[channel.country] ?? channel.country,
          callback_data: `channel_country:${channel.id}`,
        },
        {
          text: truncateLabel(channel.templateBank ?? "Шаблоны"),
          callback_data: `channel_bank:${channel.id}`,
        },
      ]),
      [{ text: "🔄 Обновить каналы", callback_data: "channels:refresh" }],
    ],
  };
}

export function buildCountryKeyboard(channelId: string): ReplyMarkup {
  return {
    inline_keyboard: [
      [
        { text: "🇿🇲 Замбия", callback_data: `country_pick:${channelId}:ZM` },
        { text: "🇪🇬 Египет", callback_data: `country_pick:${channelId}:EG` },
      ],
      [
        { text: "🇨🇲 Камерун", callback_data: `country_pick:${channelId}:CM` },
        { text: "« Назад", callback_data: "channels:back" },
      ],
    ],
  };
}

export function buildTemplateKeyboard(
  channelId: string,
  templateBanks: Array<{ id: string; name: string }>,
): ReplyMarkup {
  const rows = templateBanks.map((bank) => [
    {
      text: bank.name,
      callback_data: `template_pick:${channelId}:${bank.id}`,
    },
  ]);

  rows.push([{ text: "« Назад", callback_data: "channels:back" }]);

  return {
    inline_keyboard: rows,
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
