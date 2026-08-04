import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_BOT_NAME: z.string().default("Pager Test Bot"),
  PAGER_BASE_URL: z.string().url().default("https://www.pager.co.ua"),
  BOT_CONFIG_PATH: z.string().default("config/bot.config.yaml"),
  BOT_STATE_PATH: z.string().default("data/chat-state.json"),
  DATABASE_URL: z
    .preprocess((value) => (value === "" || value === undefined ? undefined : value), z.string().min(1))
    .optional(),
  OCR_LANG: z.string().default("eng"),
  OCR_ENABLED: z
    .string()
    .default("true")
    .transform((value) => value.toLowerCase() !== "false"),
  POLL_INTERVAL_MS: z.coerce.number().int().positive().default(2000),
  AI_ENABLED: z
    .string()
    .default("false")
    .transform((value) => value.toLowerCase() === "true"),
  AI_API_KEY: z
    .preprocess(
      (value) => {
        if (value === "" || value === undefined) {
          return undefined;
        }
        return String(value).replace(/\s+/g, "").trim();
      },
      z.string().min(1),
    )
    .optional(),
  AI_MODEL: z.string().default("gpt-4o-mini"),
  AI_VISION_MODEL: z.string().default("gpt-4o-mini"),
  /** OpenAI-compatible API base, e.g. OpenRouter: https://openrouter.ai/api/v1/chat/completions */
  AI_BASE_URL: z
    .string()
    .url()
    .default("https://api.openai.com/v1/chat/completions"),
  /** Optional — OpenRouter recommends HTTP-Referer */
  AI_HTTP_REFERER: z
    .preprocess((value) => (value === "" || value === undefined ? undefined : value), z.string().url())
    .optional(),
  AI_APP_TITLE: z.string().default("Pager Inbox Bot"),

  XPARTNERS_ENABLED: z
    .string()
    .default("false")
    .transform((value) => value.toLowerCase() === "true"),
  XPARTNERS_CREDENTIALS: z
    .preprocess((value) => (value === "" || value === undefined ? undefined : String(value)), z.string())
    .optional(),
  XPARTNERS_LOGIN: z
    .preprocess((value) => (value === "" || value === undefined ? undefined : String(value)), z.string())
    .optional(),
  XPARTNERS_PASSWORD: z
    .preprocess((value) => (value === "" || value === undefined ? undefined : String(value)), z.string())
    .optional(),
  XPARTNERS_COOKIE: z
    .preprocess((value) => (value === "" || value === undefined ? undefined : String(value)), z.string())
    .optional(),
  XPARTNERS_KEEPALIVE_MINUTES: z.coerce.number().int().positive().default(3),
  XPARTNERS_CURRENCY_ID: z.coerce.number().int().positive().default(1),
  XPARTNERS_SITE_CM: z.string().default("http://Camerun.com"),
  XPARTNERS_SITE_EG: z.string().default("http://Egypt.com"),
  XPARTNERS_SITE_ZM: z.string().default("http://Zambia.com"),
});

export type AppEnv = z.infer<typeof envSchema>;

export function loadEnv(): AppEnv {
  return envSchema.parse(process.env);
}
