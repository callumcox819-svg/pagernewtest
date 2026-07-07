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

  async deleteWebhook(): Promise<void> {
    await this.request("deleteWebhook", { drop_pending_updates: false });
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
      ...channels.map((channel, index) => [
        {
          text: `${channel.enabled ? "🟢" : "🔴"} ${channel.name}`,
          callback_data: `channel_toggle:${index}`,
        },
        {
          text: COUNTRY_LABELS[channel.country] ?? channel.country,
          callback_data: `channel_country:${index}`,
        },
        {
          text: truncateLabel(channel.templateBank ?? "Шаблоны"),
          callback_data: `channel_bank:${index}`,
        },
      ]),
      [{ text: "🔄 Обновить каналы", callback_data: "channels:refresh" }],
    ],
  };
}

export function buildCountryKeyboard(channelIndex: number): ReplyMarkup {
  return {
    inline_keyboard: [
      [
        { text: "🇿🇲 Замбия", callback_data: `country_pick:${channelIndex}:ZM` },
        { text: "🇪🇬 Египет", callback_data: `country_pick:${channelIndex}:EG` },
      ],
      [
        { text: "🇨🇲 Камерун", callback_data: `country_pick:${channelIndex}:CM` },
        { text: "« Назад", callback_data: "channels:back" },
      ],
    ],
  };
}

export function buildTemplateKeyboard(
  channelIndex: number,
  templateBanks: Array<{ id: string; name: string }>,
): ReplyMarkup {
  const rows = templateBanks.map((bank, folderIndex) => [
    {
      text: bank.name,
      callback_data: `template_pick:${channelIndex}:${folderIndex}`,
    },
  ]);

  rows.push([{ text: "« Назад", callback_data: "channels:back" }]);

  return {
    inline_keyboard: rows,
  };
}

export function buildFoldersKeyboard(
  folders: Array<{ name: string; enabled: boolean }>,
): ReplyMarkup {
  const rows = folders.map((folder, index) => [
    {
      text: `${folder.enabled ? "✅" : "⬜"} ${folder.name}`,
      callback_data: `folder_toggle:${index}`,
    },
  ]);

  const allEnabled = folders.length > 0 && folders.every((folder) => folder.enabled);
  rows.push([
    {
      text: allEnabled ? "✅ Все вкл." : "📂 Включить все",
      callback_data: "folders:all_on",
    },
    { text: "⬜ Снять все", callback_data: "folders:all_off" },
  ]);
  rows.push([{ text: "🔄 Обновить папки", callback_data: "folders:refresh" }]);
  rows.push([{ text: "« Назад", callback_data: "menu:main" }]);

  return { inline_keyboard: rows };
}

export function buildFoldersRetryKeyboard(): ReplyMarkup {
  return {
    inline_keyboard: [
      [{ text: "🔄 Обновить папки", callback_data: "folders:refresh" }],
      [{ text: "« Назад", callback_data: "menu:main" }],
    ],
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
        { text: "Папки", callback_data: "menu:folders" },
        { text: "Статус", callback_data: "menu:status" },
      ],
      [{ text: "Сброс", callback_data: "menu:reset" }],
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
