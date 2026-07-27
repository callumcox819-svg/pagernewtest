import type { CountryCode } from "./config.js";
import type { AppEnv } from "./env.js";

export type AiAssistContext = {
  country: CountryCode;
  customerText: string;
  recentCustomerTexts: string[];
  recentOutgoingTexts: string[];
  funnelStep: number;
  intent: string;
};

const COUNTRY_RULES: Record<CountryCode, string> = {
  EG: [
    "Reply ONLY in Arabic (Egyptian dialect is fine).",
    "Never send registration URLs — the scripted funnel sends links.",
    "Do not promise exact profits; stay aligned with operator scripts.",
    "If the customer asks how to register or for a link, tell them you will send step-by-step instructions next (do not paste a URL).",
  ].join(" "),
  CM: [
    "Reply ONLY in French.",
    "Never send registration URLs — the scripted funnel sends links.",
    "Stay concise and professional.",
  ].join(" "),
  ZM: [
    "Reply ONLY in English.",
    "Never send registration URLs — the scripted funnel sends links.",
    "Stay concise and friendly.",
  ].join(" "),
};

function buildSystemPrompt(country: CountryCode): string {
  return [
    "You assist a human operator on Pager (Messenger inbox).",
    "You answer ONE customer message when rule-based scripts did not match.",
    COUNTRY_RULES[country],
    "Max 4 short sentences. No markdown. No JSON.",
  ].join(" ");
}

function buildUserPrompt(ctx: AiAssistContext): string {
  const parts = [
    `Country: ${ctx.country}`,
    `Funnel step: ${ctx.funnelStep}`,
    `Classifier intent: ${ctx.intent}`,
    `Latest customer message: ${ctx.customerText}`,
  ];
  if (ctx.recentCustomerTexts.length > 1) {
    parts.push(`Recent customer lines:\n${ctx.recentCustomerTexts.slice(0, 5).join("\n")}`);
  }
  if (ctx.recentOutgoingTexts.length) {
    parts.push(
      `Recent operator/bot outgoings (do not repeat verbatim):\n${ctx.recentOutgoingTexts.slice(-4).join("\n---\n")}`,
    );
  }
  return parts.join("\n\n");
}

async function openAiChatCompletion(
  apiKey: string,
  model: string,
  system: string,
  user: string,
): Promise<string | undefined> {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.35,
      max_tokens: 450,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    console.warn(`AI assist HTTP ${response.status}: ${body.slice(0, 200)}`);
    return undefined;
  }
  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = payload.choices?.[0]?.message?.content?.trim();
  return text || undefined;
}

/** Optional LLM reply when scripts miss — disabled unless AI_ENABLED and AI_API_KEY are set. */
export async function maybeAiAssistReply(
  env: AppEnv,
  ctx: AiAssistContext,
): Promise<string | undefined> {
  if (!env.AI_ENABLED || !env.AI_API_KEY?.trim()) {
    return undefined;
  }
  if (!ctx.customerText.trim()) {
    return undefined;
  }
  if (/https?:\/\/\S+/i.test(ctx.customerText) && ctx.customerText.length < 80) {
    return undefined;
  }

  try {
    const reply = await openAiChatCompletion(
      env.AI_API_KEY.trim(),
      env.AI_MODEL,
      buildSystemPrompt(ctx.country),
      buildUserPrompt(ctx),
    );
    if (!reply?.trim()) {
      return undefined;
    }
    if (/https?:\/\/\S+/i.test(reply)) {
      console.warn("AI assist rejected reply containing URL");
      return undefined;
    }
    return reply.trim();
  } catch (error) {
    console.warn("AI assist failed:", error instanceof Error ? error.message : error);
    return undefined;
  }
}
