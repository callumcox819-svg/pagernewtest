import {
  type BotConfig,
  type ChannelConfig,
  type PlaybookConfig,
  type ProofKind,
  type Stage,
  type TemplateRole,
  getPlaybook,
  getTemplateBank,
} from "./config.js";
import {
  classifySpecialCustomerIntent,
  matchesPlaybookKeywords,
  normalizeCustomerText,
  specialIntentTemplateRole,
} from "./customer-intent.js";

export type ConversationEvent = {
  channelId: string;
  currentStage: Stage;
  latestCustomerText?: string;
  proofKind?: ProofKind;
};

export type DecisionResult = {
  nextStage: Stage;
  templateRole?: TemplateRole;
  templateToSend?: string;
  reason: string;
};

export function decideNextAction(
  config: BotConfig,
  channel: ChannelConfig,
  event: ConversationEvent,
): DecisionResult | undefined {
  if (!channel.enabled) {
    return undefined;
  }

  const playbook = getPlaybook(config, channel.country);
  const templateBank = getTemplateBank(config, channel.templateBank);

  if (event.proofKind) {
    const proofRule = playbook.proofRules.find((rule) => rule.kind === event.proofKind);
    if (proofRule) {
      return {
        nextStage: proofRule.nextStage,
        templateRole: proofRule.nextTemplateRole,
        templateToSend: proofRule.nextTemplateRole
          ? templateBank.roles[proofRule.nextTemplateRole]
          : undefined,
        reason: `Matched proof rule ${proofRule.kind}`,
      };
    }
    if (event.proofKind === "unclear_screenshot") {
      return {
        nextStage: "waiting_id",
        templateRole: "ask_clear_screenshot",
        templateToSend: templateBank.roles.ask_clear_screenshot,
        reason: "Unclear screenshot",
      };
    }
  }

  const text = event.latestCustomerText ?? "";
  const special = classifySpecialCustomerIntent(playbook, text);
  const specialRole = specialIntentTemplateRole(special);
  if (specialRole) {
    return {
      nextStage: special === "deferral" ? "not_ready" : "no_money",
      templateRole: specialRole,
      templateToSend: templateBank.roles[specialRole],
      reason: `Special intent ${special}`,
    };
  }

  const normalizedText = normalizeCustomerText(text);
  if (!normalizedText) {
    return undefined;
  }

  for (const rule of playbook.textRules) {
    const matched = rule.matchAny.some((keyword) =>
      matchesPlaybookKeywords([keyword], normalizedText),
    );
    if (matched) {
      return {
        nextStage: rule.nextStage,
        templateRole: rule.nextTemplateRole,
        templateToSend: rule.nextTemplateRole
          ? templateBank.roles[rule.nextTemplateRole]
          : undefined,
        reason: `Matched text rule ${rule.name}`,
      };
    }
  }

  if (event.currentStage === "registered") {
    return {
      nextStage: "deposit_pending",
      templateRole: "deposit",
      templateToSend: templateBank.roles.deposit,
      reason: "Registered stage defaulted to deposit instructions",
    };
  }

  if (event.currentStage === "new_lead") {
    return {
      nextStage: "engaged",
      templateRole: "intro",
      templateToSend: templateBank.roles.intro,
      reason: "New lead — send intro preset",
    };
  }

  return undefined;
}

export function inferProofKindFromCaption(
  playbook: PlaybookConfig,
  captionOrMessage?: string,
): ProofKind | undefined {
  const normalizedText = normalizeCustomerText(captionOrMessage);
  if (!normalizedText) {
    return undefined;
  }

  if (matchesPlaybookKeywords(playbook.depositKeywords, normalizedText)) {
    return "deposit_balance_screenshot";
  }

  if (matchesPlaybookKeywords(playbook.registrationKeywords, normalizedText)) {
    return "registration_screenshot";
  }

  return undefined;
}
