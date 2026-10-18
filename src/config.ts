import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const PROOF_KINDS = [
  "registration_screenshot",
  "id_screenshot",
  "deposit_balance_screenshot",
  "unclear_screenshot",
 ] as const;

export const proofKindSchema = z.enum(PROOF_KINDS);

export type ProofKind = z.infer<typeof proofKindSchema>;

export const COUNTRIES = ["ZM", "CM", "EG"] as const;

const countrySchema = z.enum(COUNTRIES);

export const STAGES = [
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
 ] as const;

const stageSchema = z.enum(STAGES);

export type Stage = z.infer<typeof stageSchema>;
export type CountryCode = z.infer<typeof countrySchema>;

export const TEMPLATE_ROLES = [
  "intro",
  "details",
  "registration",
  "deposit",
  "ask_id",
  "ask_clear_screenshot",
  "telegram_handoff",
  "no_money",
  "reactivation",
 ] as const;

const templateRoleSchema = z.enum(TEMPLATE_ROLES);

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
  notReadyKeywords: z.array(z.string()).default([]),
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

/**
 * Map any worker/operator geo onto a YAML playbook country (ZM|CM|EG).
 * Extended markets reuse a sibling playbook for OCR / proof / special templates.
 */
export function resolvePlaybookCountry(country: string | undefined): CountryCode {
  const code = (country || "").trim().toUpperCase();
  if (code === "EG" || code === "JO") {
    return "EG";
  }
  if (code === "ZM" || code === "KE" || code === "RW") {
    return "ZM";
  }
  if (
    code === "CM" ||
    code === "CL" ||
    code === "MG" ||
    code === "DJ" ||
    code === "GT" ||
    code === "EC" ||
    code === "MA" ||
    code === "MR" ||
    code === "BF" ||
    code === "BJ" ||
    code === "CR" ||
    code === "SN" ||
    code === "PE"
  ) {
    return "CM";
  }
  // Pakistan Urdu — Arabic-script OCR/playbook sibling (EG).
  if (code === "PK") {
    return "EG";
  }
  // Unknown / future geos — English playbook is the safest default.
  return "ZM";
}

export function getPlaybook(
  config: BotConfig,
  country: CountryCode | string,
): PlaybookConfig {
  const mapped = resolvePlaybookCountry(String(country));
  const playbook =
    config.playbooks.find((item) => item.country === mapped) ??
    config.playbooks.find((item) => item.country === "ZM") ??
    config.playbooks.find((item) => item.country === "CM") ??
    config.playbooks[0];
  if (!playbook) {
    // Should be unreachable — config always ships at least one playbook.
    throw new Error(`Missing playbook for country ${country} (mapped=${mapped})`);
  }
  if (playbook.country !== mapped) {
    console.warn(
      `Playbook fallback: requested=${country} mapped=${mapped} using=${playbook.country}`,
    );
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

export function resolveYamlTemplateBankName(
  config: BotConfig,
  country:
    | CountryCode
    | "RW"
    | "CL"
    | "MG"
    | "DJ"
    | "JO"
    | "KE"
    | "GT"
    | "EC"
    | "MA"
    | "MR"
    | "BF"
    | "BJ"
    | "CR"
    | "SN"
    | "PK"
    | "PE",
  channelId?: string,
): string {
  if (country === "RW") {
    if (channelId) {
      const channel = getChannelConfig(config, channelId);
      if (channel?.templateBank) {
        return channel.templateBank;
      }
    }
    return "rw-observe";
  }
  if (country === "CL") {
    if (channelId) {
      const channel = getChannelConfig(config, channelId);
      if (channel?.templateBank) {
        return channel.templateBank;
      }
    }
    return "cl-default";
  }
  if (country === "MG") {
    if (channelId) {
      const channel = getChannelConfig(config, channelId);
      if (channel?.templateBank) {
        return channel.templateBank;
      }
    }
    return "mg-default";
  }
  if (country === "DJ") {
    if (channelId) {
      const channel = getChannelConfig(config, channelId);
      if (channel?.templateBank) {
        return channel.templateBank;
      }
    }
    return "dj-default";
  }
  if (country === "JO") {
    if (channelId) {
      const channel = getChannelConfig(config, channelId);
      if (channel?.templateBank) {
        return channel.templateBank;
      }
    }
    return "jo-default";
  }
  if (country === "KE") {
    return "ke-default";
  }
  if (country === "GT") {
    return "gt-default";
  }
  if (country === "EC") {
    return "ec-default";
  }
  if (
    country === "MA" ||
    country === "MR" ||
    country === "BF" ||
    country === "BJ" ||
    country === "CR" ||
    country === "SN" ||
    country === "PK" ||
    country === "PE"
  ) {
    return `${country.toLowerCase()}-folder`;
  }
  if (channelId) {
    const channel = getChannelConfig(config, channelId);
    if (channel?.templateBank) {
      return channel.templateBank;
    }
  }
  return `${country.toLowerCase()}-default`;
}

export function getConfigEnabledChannelIds(config: BotConfig): string[] {
  return config.channels.filter((channel) => channel.enabled).map((channel) => channel.id);
}

export function isChannelConfigured(config: BotConfig, channelId: string): boolean {
  return Boolean(getChannelConfig(config, channelId));
}

export function statusMapForCountry(
  config: BotConfig,
  country:
    | CountryCode
    | "RW"
    | "CL"
    | "MG"
    | "DJ"
    | "JO"
    | "KE"
    | "GT"
    | "EC"
    | "MA"
    | "MR"
    | "BF"
    | "BJ"
    | "CR"
    | "SN"
    | "PK"
    | "PE",
): ChannelConfig["statusMap"] {
  if (
    country === "RW" ||
    country === "CL" ||
    country === "MG" ||
    country === "DJ" ||
    country === "GT" ||
    country === "EC" ||
    country === "MA" ||
    country === "MR" ||
    country === "BF" ||
    country === "BJ" ||
    country === "CR" ||
    country === "SN" ||
    country === "PE"
  ) {
    return statusMapForCountry(config, "CM");
  }
  if (country === "JO" || country === "PK") {
    return statusMapForCountry(config, "EG");
  }
  if (country === "KE") {
    return statusMapForCountry(config, "ZM");
  }
  const channel = config.channels.find((item) => item.country === country);
  if (channel) {
    return channel.statusMap;
  }
  const fallback = config.channels[0];
  if (!fallback) {
    throw new Error("No channels found in config");
  }
  return fallback.statusMap;
}

export function getDefaultEnabledChannel(config: BotConfig): ChannelConfig {
  const channel = config.channels.find((item) => item.enabled) ?? config.channels[0];
  if (!channel) {
    throw new Error("No channels found in config");
  }
  return channel;
}
