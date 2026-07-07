import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_BOT_NAME: z.string().default("Pager Test Bot"),
  BOT_CONFIG_PATH: z.string().default("config/bot.config.yaml"),
  BOT_STATE_PATH: z.string().default("data/chat-state.json"),
  OCR_LANG: z.string().default("eng"),
  OCR_ENABLED: z
    .string()
    .default("true")
    .transform((value) => value.toLowerCase() !== "false"),
  POLL_INTERVAL_MS: z.coerce.number().int().positive().default(2000),
});

export type AppEnv = z.infer<typeof envSchema>;

export function loadEnv(): AppEnv {
  return envSchema.parse(process.env);
}
