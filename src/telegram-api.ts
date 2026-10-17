type ButtonStyle = "primary" | "success" | "danger";

type InlineKeyboardButton = {
  text: string;
  callback_data: string;
  icon_custom_emoji_id?: string;
  style?: ButtonStyle;
};

type ReplyKeyboardButton = {
  text: string;
  icon_custom_emoji_id?: string;
  style?: ButtonStyle;
};

type ReplyMarkup = {
  inline_keyboard?: InlineKeyboardButton[][];
  keyboard?: ReplyKeyboardButton[][];
  resize_keyboard?: boolean;
  is_persistent?: boolean;
  remove_keyboard?: boolean;
};

/** RestrictedEmoji pack IDs — animated icons (bot owner Telegram Premium, Bot API 9.4+). */
export const PREMIUM_EMOJI = {
  lock: "5472308992514464048",
  channels: "5373330964372004748",
  folder: "5433653135799228968",
  openFolder: "5431721976769027887",
  status: "5431577498364158238",
  reset: "5264727218734524899",
  robot: "5372981976804366741",
  email: "5406631276042002796",
  link: "5375129357373165375",
  back: "5264727218734524899",
  refresh: "5264727218734524899",
  check: "5427009714745517609",
  cross: "5465665476971471368",
  flagEg: "5226476858471626962",
  flagZm: "5339279432857171449",
  flagCm: "5474681124426884947",
  globe: "5399898266265475100",
  chart: "5431577498364158238",
  left: "5264727218734524899",
  right: "5264727218734524899",
} as const;

const FLAG_EMOJI: Record<string, string> = {
  EG: PREMIUM_EMOJI.flagEg,
  ZM: PREMIUM_EMOJI.flagZm,
  CM: PREMIUM_EMOJI.flagCm,
};

function inlineBtn(
  text: string,
  callbackData: string,
  options?: { emojiId?: string; style?: ButtonStyle },
): InlineKeyboardButton {
  return {
    text,
    callback_data: callbackData,
    ...(options?.emojiId ? { icon_custom_emoji_id: options.emojiId } : {}),
    ...(options?.style ? { style: options.style } : {}),
  };
}

function replyBtn(
  text: string,
  options?: { emojiId?: string; style?: ButtonStyle },
): ReplyKeyboardButton {
  return {
    text,
    ...(options?.emojiId ? { icon_custom_emoji_id: options.emojiId } : {}),
    ...(options?.style ? { style: options.style } : {}),
  };
}

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
    const result = await this.requestWithMarkupFallback<{ message_id: number }>("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      reply_markup: replyMarkup,
    });
    return result.message_id;
  }

  async sendDocument(
    chatId: number,
    filename: string,
    content: Buffer,
    options?: { caption?: string; replyMarkup?: ReplyMarkup },
  ): Promise<void> {
    const send = async (markup?: ReplyMarkup) => {
      const form = new FormData();
      form.append("chat_id", String(chatId));
      form.append("document", new Blob([new Uint8Array(content)]), filename);
      if (options?.caption) {
        form.append("caption", options.caption);
        form.append("parse_mode", "HTML");
      }
      if (markup) {
        form.append("reply_markup", JSON.stringify(markup));
      }
      const response = await fetch(`${this.baseUrl}/sendDocument`, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(120_000),
      });
      const payload = (await response.json()) as TelegramResponse<unknown>;
      if (!response.ok || !payload.ok) {
        throw new Error(payload.description ?? `Telegram sendDocument failed: ${response.status}`);
      }
    };

    try {
      await send(options?.replyMarkup);
    } catch (error) {
      if (!options?.replyMarkup || !isMarkupFeatureError(error)) {
        throw error;
      }
      await send(stripButtonStyles(stripCustomEmoji(options.replyMarkup)));
    }
  }

  /** Drop stale Telegram reply-keyboard menus from older bot builds. */
  async removeReplyKeyboard(chatId: number): Promise<void> {
    await this.request("sendMessage", {
      chat_id: chatId,
      text: "Меню обновлено — используй кнопки под сообщением.",
      reply_markup: { remove_keyboard: true },
    });
  }

  async editMessageReplyMarkup(
    chatId: number,
    messageId: number,
    replyMarkup: ReplyMarkup,
  ): Promise<void> {
    await this.requestWithMarkupFallback("editMessageReplyMarkup", {
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
    await this.requestWithMarkupFallback("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
      reply_markup: replyMarkup,
    });
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    await this.request("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text,
    });
  }

  async setMyCommands(
    commands: Array<{ command: string; description: string }>,
  ): Promise<void> {
    await this.request("setMyCommands", { commands });
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

  private async requestWithMarkupFallback<T>(
    method: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    const markup = body.reply_markup as ReplyMarkup | undefined;
    try {
      return await this.request<T>(method, body);
    } catch (error) {
      if (!markup || !isMarkupFeatureError(error)) {
        throw error;
      }
      console.warn(
        `Telegram ${method}: premium emoji rejected, retrying without custom emoji:`,
        formatTelegramError(error),
      );
      try {
        return await this.request<T>(method, {
          ...body,
          reply_markup: stripCustomEmoji(markup),
        });
      } catch (retryError) {
        if (!isMarkupFeatureError(retryError)) {
          throw retryError;
        }
        console.warn(
          `Telegram ${method}: styled buttons rejected, retrying plain markup:`,
          formatTelegramError(retryError),
        );
        return await this.request<T>(method, {
          ...body,
          reply_markup: stripButtonStyles(stripCustomEmoji(markup)),
        });
      }
    }
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

    const payload = (await response.json()) as TelegramResponse<T>;
    if (!response.ok || !payload.ok) {
      throw new Error(payload.description ?? `Telegram request failed: ${method} ${response.status}`);
    }

    return payload.result;
  }
}

function formatTelegramError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function isMarkupFeatureError(error: unknown): boolean {
  const message = formatTelegramError(error).toLowerCase();
  return (
    message.includes("icon_custom_emoji") ||
    message.includes("custom emoji") ||
    message.includes("button_type") ||
    message.includes("reply markup") ||
    message.includes("reply_markup") ||
    message.includes("style is invalid") ||
    message.includes("can't parse")
  );
}

function stripCustomEmoji(markup: ReplyMarkup): ReplyMarkup {
  const next: ReplyMarkup = { ...markup };
  if (markup.inline_keyboard) {
    next.inline_keyboard = markup.inline_keyboard.map((row) =>
      row.map(({ icon_custom_emoji_id: _icon, ...button }) => button),
    );
  }
  if (markup.keyboard) {
    next.keyboard = markup.keyboard.map((row) =>
      row.map(({ icon_custom_emoji_id: _icon, ...button }) => button),
    );
  }
  return next;
}

function stripButtonStyles(markup: ReplyMarkup): ReplyMarkup {
  const next: ReplyMarkup = { ...markup };
  if (markup.inline_keyboard) {
    next.inline_keyboard = markup.inline_keyboard.map((row) =>
      row.map(({ style: _style, ...button }) => button),
    );
  }
  if (markup.keyboard) {
    next.keyboard = markup.keyboard.map((row) =>
      row.map(({ style: _style, ...button }) => button),
    );
  }
  return next;
}

/** Short git sha for deploy verification in Telegram menus. */
export function getDeployLabel(): string {
  const sha =
    process.env.RAILWAY_GIT_COMMIT_SHA ||
    process.env.RAILWAY_GIT_COMMIT ||
    process.env.GIT_COMMIT ||
    "";
  return sha ? sha.slice(0, 7) : "local";
}

const COUNTRY_LABELS: Record<string, string> = {
  ZM: "ZM",
  EG: "EG",
  CM: "CM",
  RW: "RW",
  CL: "CL",
  MG: "MG",
  DJ: "DJ",
  JO: "JO",
  KE: "KE",
  GT: "GT",
  EC: "EC",
  MR: "MR",
  BF: "BF",
  BJ: "BJ",
  CR: "CR",
  SN: "SN",
};

function truncateLabel(value: string, max = 14): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max - 1)}…`;
}

/**
 * List: [channel name → settings] [toggle].
 * Settings (country / templates / folders / info) live in a separate screen.
 * ~100 inline-button limit → 10 channels × 2 + footer ≈ safe.
 */
export const CHANNELS_PAGE_SIZE = 10;

export function buildChannelKeyboard(
  channels: Array<{
    id: string;
    name: string;
    country: string;
    enabled: boolean;
    templateBank?: string;
    foldersEnabledCount?: number;
  }>,
  page = 0,
): ReplyMarkup {
  const totalPages = Math.max(1, Math.ceil(channels.length / CHANNELS_PAGE_SIZE));
  const safePage = Math.min(Math.max(page, 0), totalPages - 1);
  const start = safePage * CHANNELS_PAGE_SIZE;
  const slice = channels.slice(start, start + CHANNELS_PAGE_SIZE);

  const rows: InlineKeyboardButton[][] = [];
  for (const [offset, channel] of slice.entries()) {
    const index = start + offset;
    rows.push([
      inlineBtn(
        truncateLabel(`${index + 1}. ${channel.name}`, 28),
        `channel_open|${channel.id}|${safePage}`,
        { emojiId: PREMIUM_EMOJI.openFolder },
      ),
      inlineBtn(channel.enabled ? "✅" : "❌❌", `channel_toggle|${channel.id}|${safePage}`, {
        emojiId: channel.enabled ? PREMIUM_EMOJI.check : PREMIUM_EMOJI.cross,
        style: channel.enabled ? "success" : "danger",
      }),
    ]);
  }

  if (totalPages > 1) {
    const nav: InlineKeyboardButton[] = [];
    if (safePage > 0) {
      nav.push(inlineBtn("◀ Назад", `channels:page:${safePage - 1}`, { emojiId: PREMIUM_EMOJI.left }));
    }
    nav.push(inlineBtn(`${safePage + 1}/${totalPages}`, "channels:noop", { emojiId: PREMIUM_EMOJI.chart }));
    if (safePage < totalPages - 1) {
      nav.push(inlineBtn("Далее ▶", `channels:page:${safePage + 1}`, { emojiId: PREMIUM_EMOJI.right }));
    }
    rows.push(nav);
  }

  rows.push([
    inlineBtn("Обновить", "channels:refresh", { emojiId: PREMIUM_EMOJI.refresh }),
    inlineBtn("Догнать чаты", "channels:catchup", {
      emojiId: PREMIUM_EMOJI.robot,
      style: "primary",
    }),
  ]);
  rows.push([
    inlineBtn("Включить все", "channels:all_on", {
      emojiId: PREMIUM_EMOJI.check,
      style: "success",
    }),
    inlineBtn("Снять все", "channels:all_off", {
      emojiId: PREMIUM_EMOJI.cross,
      style: "danger",
    }),
  ]);

  return { inline_keyboard: rows };
}

/** Per-channel settings hub opened from the channel name button. */
export function buildChannelSettingsKeyboard(channel: {
  id: string;
  name: string;
  country: string;
  enabled: boolean;
  templateBank?: string;
  foldersEnabledCount?: number;
  aiFoldersEnabledCount?: number;
}): ReplyMarkup {
  const foldersCount = channel.foldersEnabledCount ?? 0;
  const aiFoldersCount = channel.aiFoldersEnabledCount ?? 0;
  const foldersLabel = foldersCount > 0 ? `Папки · ${foldersCount}` : "Папки";
  const aiFoldersLabel = aiFoldersCount > 0 ? `Папки AI · ${aiFoldersCount}` : "Папки AI";
  const countryLabel = COUNTRY_LABELS[channel.country] ?? channel.country;
  const bankLabel = truncateLabel(channel.templateBank ?? "Шаблоны", 18);
  const powerStyle: ButtonStyle | undefined = channel.enabled ? "success" : "danger";

  return {
    inline_keyboard: [
      [
        inlineBtn(channel.enabled ? "✅ Канал включён" : "❌ Канал выключен", `channel_toggle|${channel.id}|settings`, {
          emojiId: channel.enabled ? PREMIUM_EMOJI.check : PREMIUM_EMOJI.cross,
          style: powerStyle,
        }),
      ],
      [
        inlineBtn("ℹ️ Инфо / последний чат", `channel_info|${channel.id}`, {
          emojiId: PREMIUM_EMOJI.chart,
        }),
      ],
      [
        inlineBtn(`Страна · ${countryLabel}`, `channel_country|${channel.id}`, {
          emojiId: FLAG_EMOJI[channel.country] ?? PREMIUM_EMOJI.globe,
          style: "primary",
        }),
      ],
      [
        inlineBtn(`Шаблоны · ${bankLabel}`, `channel_bank|${channel.id}`, {
          emojiId: PREMIUM_EMOJI.openFolder,
        }),
      ],
      [
        inlineBtn(foldersLabel, `ch_folders|${channel.id}`, {
          emojiId: PREMIUM_EMOJI.folder,
          style: foldersCount > 0 ? "success" : undefined,
        }),
      ],
      [
        inlineBtn(aiFoldersLabel, `ch_ai_folders|${channel.id}`, {
          emojiId: PREMIUM_EMOJI.robot,
          style: aiFoldersCount > 0 ? "primary" : undefined,
        }),
      ],
      [inlineBtn("◀️ К списку каналов", "channels:back", { emojiId: PREMIUM_EMOJI.back })],
    ],
  };
}

export function buildCountryKeyboard(channelId: string): ReplyMarkup {
  return {
    inline_keyboard: [
      [
        inlineBtn("Замбия", `country_pick|${channelId}|ZM`, { emojiId: PREMIUM_EMOJI.flagZm }),
        inlineBtn("Египет", `country_pick|${channelId}|EG`, { emojiId: PREMIUM_EMOJI.flagEg }),
      ],
      [
        inlineBtn("Камерун", `country_pick|${channelId}|CM`, { emojiId: PREMIUM_EMOJI.flagCm }),
        inlineBtn("Руанда", `country_pick|${channelId}|RW`, {
          emojiId: PREMIUM_EMOJI.globe,
          style: "primary",
        }),
      ],
      [
        inlineBtn("Чили", `country_pick|${channelId}|CL`, {
          emojiId: PREMIUM_EMOJI.globe,
          style: "primary",
        }),
        inlineBtn("Мадагаскар", `country_pick|${channelId}|MG`, {
          emojiId: PREMIUM_EMOJI.globe,
          style: "primary",
        }),
      ],
      [
        inlineBtn("Джибути", `country_pick|${channelId}|DJ`, {
          emojiId: PREMIUM_EMOJI.globe,
          style: "primary",
        }),
        inlineBtn("Йордания", `country_pick|${channelId}|JO`, {
          emojiId: PREMIUM_EMOJI.globe,
          style: "primary",
        }),
      ],
      [
        inlineBtn("Кения", `country_pick|${channelId}|KE`, {
          emojiId: PREMIUM_EMOJI.globe,
          style: "primary",
        }),
        inlineBtn("Гватемала", `country_pick|${channelId}|GT`, {
          emojiId: PREMIUM_EMOJI.globe,
          style: "primary",
        }),
      ],
      [
        inlineBtn("Эквадор", `country_pick|${channelId}|EC`, {
          emojiId: PREMIUM_EMOJI.globe,
          style: "primary",
        }),
      ],
      [inlineBtn("◀️ Назад", `channel_open|${channelId}`, { emojiId: PREMIUM_EMOJI.back })],
    ],
  };
}

export function buildTemplateKeyboard(
  channelId: string,
  templateBanks: Array<{ id: string; name: string }>,
): ReplyMarkup {
  const rows = templateBanks.map((bank, folderIndex) => [
    inlineBtn(bank.name, `template_pick|${channelId}|${folderIndex}`, {
      emojiId: PREMIUM_EMOJI.openFolder,
    }),
  ]);

  rows.push([inlineBtn("◀️ Назад", `channel_open|${channelId}`, { emojiId: PREMIUM_EMOJI.back })]);

  return {
    inline_keyboard: rows,
  };
}

export const FOLDERS_PAGE_SIZE = 12;

export function buildFoldersKeyboard(
  folders: Array<{ name: string; enabled: boolean }>,
  page = 0,
  channelId?: string,
): ReplyMarkup {
  const totalPages = Math.max(1, Math.ceil(folders.length / FOLDERS_PAGE_SIZE));
  const safePage = Math.min(Math.max(page, 0), totalPages - 1);
  const start = safePage * FOLDERS_PAGE_SIZE;
  const slice = folders.slice(start, start + FOLDERS_PAGE_SIZE);
  const scoped = Boolean(channelId);

  const rows = slice.map((folder, offset) => [
    inlineBtn(
      truncateLabel(folder.name, 28),
      scoped
        ? `ch_folder_toggle|${channelId}|${start + offset}`
        : `folder_toggle:${start + offset}`,
      {
        emojiId: folder.enabled ? PREMIUM_EMOJI.check : PREMIUM_EMOJI.cross,
        style: folder.enabled ? "success" : undefined,
      },
    ),
  ]);

  if (totalPages > 1) {
    const nav: InlineKeyboardButton[] = [];
    if (safePage > 0) {
      nav.push(
        inlineBtn(
          "◀",
          scoped ? `ch_folders_page|${channelId}|${safePage - 1}` : `folders:page:${safePage - 1}`,
          { emojiId: PREMIUM_EMOJI.left },
        ),
      );
    }
    nav.push(
      inlineBtn(
        `${safePage + 1}/${totalPages}`,
        scoped ? `ch_folders_noop|${channelId}` : "folders:noop",
        { emojiId: PREMIUM_EMOJI.chart },
      ),
    );
    if (safePage < totalPages - 1) {
      nav.push(
        inlineBtn(
          "▶",
          scoped ? `ch_folders_page|${channelId}|${safePage + 1}` : `folders:page:${safePage + 1}`,
          { emojiId: PREMIUM_EMOJI.right },
        ),
      );
    }
    rows.push(nav);
  }

  const allEnabled = folders.length > 0 && folders.every((folder) => folder.enabled);
  rows.push([
    inlineBtn(
      allEnabled ? "Все вкл." : "Включить все",
      scoped ? `ch_folders_all|${channelId}|on` : "folders:all_on",
      {
        emojiId: PREMIUM_EMOJI.check,
        style: "success",
      },
    ),
    inlineBtn(
      "Снять все",
      scoped ? `ch_folders_all|${channelId}|off` : "folders:all_off",
      {
        emojiId: PREMIUM_EMOJI.cross,
        style: "danger",
      },
    ),
  ]);
  rows.push([
    inlineBtn(
      "Обновить папки",
      scoped ? `ch_folders_refresh|${channelId}` : "folders:refresh",
      { emojiId: PREMIUM_EMOJI.refresh },
    ),
  ]);
  if (scoped) {
    rows.push([
      inlineBtn("Папки AI", `ch_ai_folders|${channelId}`, {
        emojiId: PREMIUM_EMOJI.robot,
        style: "primary",
      }),
    ]);
  }
  rows.push([
    inlineBtn("◀️ Назад", scoped ? `channel_open|${channelId}` : "menu:main", {
      emojiId: PREMIUM_EMOJI.back,
    }),
  ]);

  return { inline_keyboard: rows };
}

export function buildAiFoldersKeyboard(
  folders: Array<{ name: string; enabled: boolean; aiEnabled?: boolean }>,
  page = 0,
  channelId?: string,
): ReplyMarkup {
  const totalPages = Math.max(1, Math.ceil(folders.length / FOLDERS_PAGE_SIZE));
  const safePage = Math.min(Math.max(page, 0), totalPages - 1);
  const start = safePage * FOLDERS_PAGE_SIZE;
  const slice = folders.slice(start, start + FOLDERS_PAGE_SIZE);
  const scoped = Boolean(channelId);

  const rows = slice.map((folder, offset) => {
    const aiOn = folder.aiEnabled ?? folder.enabled;
    return [
      inlineBtn(
        truncateLabel(folder.name, 28),
        scoped
          ? `ch_ai_folder_toggle|${channelId}|${start + offset}`
          : `ai_folder_toggle:${start + offset}`,
        {
          emojiId: aiOn ? PREMIUM_EMOJI.robot : PREMIUM_EMOJI.cross,
          style: aiOn ? "primary" : undefined,
        },
      ),
    ];
  });

  if (totalPages > 1) {
    const nav: InlineKeyboardButton[] = [];
    if (safePage > 0) {
      nav.push(
        inlineBtn(
          "◀",
          scoped
            ? `ch_ai_folders_page|${channelId}|${safePage - 1}`
            : `ai_folders:page:${safePage - 1}`,
          { emojiId: PREMIUM_EMOJI.left },
        ),
      );
    }
    nav.push(
      inlineBtn(
        `${safePage + 1}/${totalPages}`,
        scoped ? `ch_ai_folders_noop|${channelId}` : "ai_folders:noop",
        { emojiId: PREMIUM_EMOJI.chart },
      ),
    );
    if (safePage < totalPages - 1) {
      nav.push(
        inlineBtn(
          "▶",
          scoped
            ? `ch_ai_folders_page|${channelId}|${safePage + 1}`
            : `ai_folders:page:${safePage + 1}`,
          { emojiId: PREMIUM_EMOJI.right },
        ),
      );
    }
    rows.push(nav);
  }

  const allAiOn = folders.length > 0 && folders.every((folder) => folder.aiEnabled ?? folder.enabled);
  rows.push([
    inlineBtn(
      allAiOn ? "AI везде" : "AI во все",
      scoped ? `ch_ai_folders_all|${channelId}|on` : "ai_folders:all_on",
      {
        emojiId: PREMIUM_EMOJI.robot,
        style: "primary",
      },
    ),
    inlineBtn(
      "AI выкл.",
      scoped ? `ch_ai_folders_all|${channelId}|off` : "ai_folders:all_off",
      {
        emojiId: PREMIUM_EMOJI.cross,
        style: "danger",
      },
    ),
  ]);
  if (scoped) {
    rows.push([
      inlineBtn("Папки бота", `ch_folders|${channelId}`, { emojiId: PREMIUM_EMOJI.folder }),
    ]);
    rows.push([
      inlineBtn("◀️ Назад", `channel_open|${channelId}`, { emojiId: PREMIUM_EMOJI.back }),
    ]);
  } else {
    rows.push([
      inlineBtn("◀️ В каналы", "menu:channels", { emojiId: PREMIUM_EMOJI.back }),
    ]);
  }

  return { inline_keyboard: rows };
}

export function buildFoldersRetryKeyboard(): ReplyMarkup {
  return {
    inline_keyboard: [
      [inlineBtn("Обновить папки", "folders:refresh", { emojiId: PREMIUM_EMOJI.refresh })],
      [inlineBtn("Назад", "menu:main", { emojiId: PREMIUM_EMOJI.back })],
    ],
  };
}

export function buildMainMenuKeyboard(options?: { isAdmin?: boolean }): ReplyMarkup {
  const rows: InlineKeyboardButton[][] = [
    [
      inlineBtn("Pager аккаунт", "menu:pager_account", {
        emojiId: PREMIUM_EMOJI.lock,
        style: "primary",
      }),
      inlineBtn("Каналы", "menu:channels", {
        emojiId: PREMIUM_EMOJI.channels,
        style: "primary",
      }),
    ],
    [
      inlineBtn("Статус", "menu:status", {
        emojiId: PREMIUM_EMOJI.status,
        style: "success",
      }),
      inlineBtn("Статистика", "menu:stats", {
        emojiId: PREMIUM_EMOJI.chart,
        style: "primary",
      }),
    ],
    [
      inlineBtn("Сброс", "menu:reset", {
        emojiId: PREMIUM_EMOJI.reset,
        style: "danger",
      }),
    ],
  ];
  if (options?.isAdmin) {
    rows.push([
      inlineBtn("Админ-панель", "menu:admin", {
        emojiId: PREMIUM_EMOJI.lock,
        style: "primary",
      }),
    ]);
  }
  return { inline_keyboard: rows };
}

export function buildAdminPanelKeyboard(): ReplyMarkup {
  return {
    inline_keyboard: [
      [
        inlineBtn("Статистика пользователей", "admin:stats", {
          emojiId: PREMIUM_EMOJI.chart,
          style: "primary",
        }),
      ],
      [
        inlineBtn("Доступ к боту", "admin:grant_access", {
          emojiId: PREMIUM_EMOJI.check,
          style: "success",
        }),
      ],
      [
        inlineBtn("Забрать доступ", "admin:revoke_access", {
          emojiId: PREMIUM_EMOJI.cross,
          style: "danger",
        }),
      ],
      [
        inlineBtn("Админ-права (панель)", "admin:rights", {
          emojiId: PREMIUM_EMOJI.lock,
          style: "primary",
        }),
      ],
      [inlineBtn("◀️ В меню", "menu:main", { emojiId: PREMIUM_EMOJI.back })],
    ],
  };
}

export function buildAdminRightsKeyboard(): ReplyMarkup {
  return {
    inline_keyboard: [
      [
        inlineBtn("Выдать админку", "admin:grant_admin", {
          emojiId: PREMIUM_EMOJI.check,
          style: "success",
        }),
      ],
      [
        inlineBtn("Снять админку", "admin:revoke_admin", {
          emojiId: PREMIUM_EMOJI.cross,
          style: "danger",
        }),
      ],
      [
        inlineBtn("Список админов", "admin:list_admins", {
          emojiId: PREMIUM_EMOJI.chart,
          style: "primary",
        }),
      ],
      [inlineBtn("◀️ Админ-панель", "admin:panel", { emojiId: PREMIUM_EMOJI.back })],
    ],
  };
}

export function buildAdminUserStatsKeyboard(userId: number): ReplyMarkup {
  return {
    inline_keyboard: [
      [
        inlineBtn("Показать каналы пользователя", `admin:user_channels|${userId}`, {
          emojiId: PREMIUM_EMOJI.channels,
          style: "primary",
        }),
      ],
      [
        inlineBtn("Забрать доступ", `admin:revoke_user|${userId}`, {
          emojiId: PREMIUM_EMOJI.cross,
          style: "danger",
        }),
      ],
      [inlineBtn("◀️ Админ-панель", "admin:panel", { emojiId: PREMIUM_EMOJI.back })],
    ],
  };
}

export function buildStatsCountryKeyboard(): ReplyMarkup {
  return {
    inline_keyboard: [
      [
        inlineBtn("Камерун", "stats:country:CM", {
          emojiId: PREMIUM_EMOJI.flagCm,
          style: "primary",
        }),
        inlineBtn("Египет", "stats:country:EG", {
          emojiId: PREMIUM_EMOJI.flagEg,
          style: "primary",
        }),
      ],
      [
        inlineBtn("Замбия", "stats:country:ZM", {
          emojiId: PREMIUM_EMOJI.flagZm,
          style: "primary",
        }),
        inlineBtn("Руанда", "stats:country:RW", {
          emojiId: PREMIUM_EMOJI.globe,
          style: "primary",
        }),
      ],
      [
        inlineBtn("Обновить все", "stats:refresh:all", {
          emojiId: PREMIUM_EMOJI.refresh,
          style: "success",
        }),
        inlineBtn("Интервал кэша", "stats:interval:menu", {
          emojiId: PREMIUM_EMOJI.chart,
          style: "primary",
        }),
      ],
      [
        inlineBtn("По ID (игроки)", "stats:players:menu", {
          emojiId: PREMIUM_EMOJI.email,
          style: "primary",
        }),
      ],
      [inlineBtn("Назад", "menu:main", { emojiId: PREMIUM_EMOJI.back })],
    ],
  };
}

export function buildStatsPlayersKeyboard(): ReplyMarkup {
  return {
    inline_keyboard: [
      [
        inlineBtn("Камерун", "stats:players:CM", { emojiId: PREMIUM_EMOJI.flagCm, style: "primary" }),
        inlineBtn("Египет", "stats:players:EG", { emojiId: PREMIUM_EMOJI.flagEg, style: "primary" }),
      ],
      [
        inlineBtn("Замбия", "stats:players:ZM", { emojiId: PREMIUM_EMOJI.flagZm, style: "primary" }),
        inlineBtn("Руанда", "stats:players:RW", { emojiId: PREMIUM_EMOJI.globe, style: "primary" }),
      ],
      [
        inlineBtn("Все 4", "stats:players:ALL", { emojiId: PREMIUM_EMOJI.globe, style: "success" }),
      ],
      [inlineBtn("Назад", "menu:stats", { emojiId: PREMIUM_EMOJI.back })],
    ],
  };
}

export function buildStatsIntervalKeyboard(currentHours: number): ReplyMarkup {
  const mark = (h: number) => (currentHours === h ? " ✓" : "");
  return {
    inline_keyboard: [
      [
        inlineBtn(`1 ч${mark(1)}`, "stats:interval:1", { emojiId: PREMIUM_EMOJI.chart, style: "primary" }),
        inlineBtn(`3 ч${mark(3)}`, "stats:interval:3", { emojiId: PREMIUM_EMOJI.chart, style: "primary" }),
        inlineBtn(`5 ч${mark(5)}`, "stats:interval:5", { emojiId: PREMIUM_EMOJI.chart, style: "primary" }),
      ],
      [inlineBtn("Назад", "menu:stats", { emojiId: PREMIUM_EMOJI.back })],
    ],
  };
}

/** Нижняя reply-клавиатура с premium emoji (Bot API 9.4+). */
export function buildOperatorReplyKeyboard(options?: { isAdmin?: boolean }): ReplyMarkup {
  const rows: ReplyKeyboardButton[][] = [
    [
      replyBtn("Pager аккаунт", { emojiId: PREMIUM_EMOJI.lock, style: "primary" }),
      replyBtn("Каналы", { emojiId: PREMIUM_EMOJI.channels, style: "primary" }),
    ],
    [
      replyBtn("Статус", { emojiId: PREMIUM_EMOJI.status, style: "success" }),
      replyBtn("Статистика", { emojiId: PREMIUM_EMOJI.chart, style: "primary" }),
    ],
  ];
  if (options?.isAdmin) {
    rows.push([replyBtn("Админ-панель", { emojiId: PREMIUM_EMOJI.lock, style: "primary" })]);
  }
  return {
    keyboard: rows,
    resize_keyboard: true,
    is_persistent: true,
  };
}

export function buildPagerAccountKeyboard(isConnected: boolean): ReplyMarkup {
  return {
    inline_keyboard: [
      [
        inlineBtn("Email + пароль", "pager:login_password", { emojiId: PREMIUM_EMOJI.email }),
        inlineBtn("Импорт cookies", "pager:import_cookies", { emojiId: PREMIUM_EMOJI.link }),
      ],
      [
        inlineBtn(isConnected ? "Отключить" : "Очистить", "pager:disconnect", {
          emojiId: PREMIUM_EMOJI.cross,
        }),
      ],
      [inlineBtn("Назад", "menu:main", { emojiId: PREMIUM_EMOJI.back })],
    ],
  };
}
