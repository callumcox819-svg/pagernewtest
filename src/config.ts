import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const proofKindSchema = z.enum([
  "registration_screenshot",
  "id_screenshot",
  "deposit_balance_screenshot",
  "unclear_screenshot",
]);

export type ProofKind = z.infer<typeof proofKindSchema>;

const countrySchema = z.enum(["ZM", "CM", "EG"]);

const stageSchema = z.enum([
  "new_lead",
  "engaged",
  "registered",
  "deposit_pending",
  "waiting_id",
  "post_deposit",
  "completed",
  "no_money",
  "dormant",
  "not_ready",
]);

export type Stage = z.infer<typeof stageSchema>;
export type CountryCode = z.infer<typeof countrySchema>;

const templateRoleSchema = z.enum([
  "intro",
  "details",
  "registration",
  "deposit",
  "ask_id",
  "ask_clear_screenshot",
  "telegram_handoff",
  "no_money",
  "reactivation",
]);

export type TemplateRole = z.infer<typeof templateRoleSchema>;

const templateBankSchema = z.object({
  name: z.string().min(1),
  roles: z.record(templateRoleSchema, z.string().min(1)),
});

const statusMapSchema = z.record(stageSchema, z.string().min(1));

const proofRuleSchema = z.object({
  kind: proofKindSchema,
  nextStage: stageSchema,
  nextTemplateRole: templateRoleSchema.optional(),
});

const textRuleSchema = z.object({
  name: z.string().min(1),
  matchAny: z.array(z.string().min(1)).min(1),
  nextStage: stageSchema,
  nextTemplateRole: templateRoleSchema.optional(),
});

const playbookSchema = z.object({
  country: countrySchema,
  language: z.string().min(1),
  promoCode: z.string().optional(),
  telegramLink: z.string().url(),
  registrationKeywords: z.array(z.string()).default([]),
  depositKeywords: z.array(z.string()).default([]),
  noMoneyKeywords: z.array(z.string()).default([]),
  proofRules: z.array(proofRuleSchema).min(1),
  textRules: z.array(textRuleSchema).min(1),
});

const channelSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  enabled: z.boolean(),
  country: countrySchema,
  templateBank: z.string().min(1),
  statusMap: statusMapSchema,
});

const botConfigSchema = z.object({
  bot: z.object({
    pollIntervalSeconds: z.number().int().positive(),
    preventDuplicateReplyWindowMinutes: z.number().int().positive(),
    requireCustomerLastMessage: z.boolean(),
    skipIfHumanRepliedRecentlyMinutes: z.number().int().nonnegative(),
  }),
  channels: z.array(channelSchema).min(1),
  templateBanks: z.array(templateBankSchema).min(1),
  playbooks: z.array(playbookSchema).min(1),
});

export type BotConfig = z.infer<typeof botConfigSchema>;
export type ChannelConfig = z.infer<typeof channelSchema>;
export type PlaybookConfig = z.infer<typeof playbookSchema>;
export type TemplateBankConfig = z.infer<typeof templateBankSchema>;

export function loadConfig(configPath: string): BotConfig {
  const raw = readFileSync(configPath, "utf8");
  const parsed = parseYaml(raw);
  return botConfigSchema.parse(parsed);
}

export function getChannelConfig(
  config: BotConfig,
  channelId: string,
): ChannelConfig | undefined {
  return config.channels.find((channel) => channel.id === channelId);
}

export function getPlaybook(
  config: BotConfig,
  country: CountryCode,
): PlaybookConfig {
  const playbook = config.playbooks.find((item) => item.country === country);
  if (!playbook) {
    throw new Error(`Missing playbook for country ${country}`);
  }
  return playbook;
}

export function getTemplateBank(
  config: BotConfig,
  templateBankName: string,
): TemplateBankConfig {
  const bank = config.templateBanks.find((item) => item.name === templateBankName);
  if (!bank) {
    throw new Error(`Missing template bank ${templateBankName}`);
  }
  return bank;
}
