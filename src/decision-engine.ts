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
  }

  const normalizedText = normalizeText(event.latestCustomerText);
  if (!normalizedText) {
    return undefined;
  }

  const noMoneyHit = playbook.noMoneyKeywords.some((keyword) =>
    normalizedText.includes(normalizeText(keyword)),
  );
  if (noMoneyHit) {
    return {
      nextStage: "no_money",
      templateRole: "no_money",
      templateToSend: templateBank.roles.no_money,
      reason: "Detected no-money objection",
    };
  }

  for (const rule of playbook.textRules) {
    const matched = rule.matchAny.some((keyword) =>
      normalizedText.includes(normalizeText(keyword)),
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
  const normalizedText = normalizeText(captionOrMessage);
  if (!normalizedText) {
    return undefined;
  }

  if (playbook.depositKeywords.some((keyword) => normalizedText.includes(normalizeText(keyword)))) {
    return "deposit_balance_screenshot";
  }

  if (playbook.registrationKeywords.some((keyword) =>
    normalizedText.includes(normalizeText(keyword)),
  )) {
    return "registration_screenshot";
  }

  return undefined;
}

function normalizeText(value?: string): string {
  return value?.toLowerCase().trim() ?? "";
}
