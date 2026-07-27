import type { CountryCode } from "./config.js";
import type { AppEnv } from "./env.js";

export type AiAssistContext = {
  country: CountryCode;
  customerText: string;
  recentCustomerTexts: string[];
  recentOutgoingTexts: string[];
  funnelStep: number;
  intent: string;
  scriptKeys?: string[];
};

export type AiVisionContext = {
  country: CountryCode;
  caption: string;
  funnelStep: number;
  outgoingTexts: string[];
  proofKind: string;
  imageBase64: string;
  mimeType: string;
};

const SERVICE_FRAMING = [
  "Business context: we OFFER A LEGITIMATE SERVICE — personal step-by-step guidance on using the platform (registration, deposit, gameplay). You are a service assistant, not a random spammer.",
  "If they ask «is this a scam?» / fraud / trust: answer calmly and realistically — this is a real service, you walk them through official steps on the platform, you are here to help them succeed with clear instructions. Do not dodge the question.",
  "Never ask them to send money to a personal wallet or unknown account in chat. Deposits happen only on the official platform as explained in scripts.",
  "Do not guarantee specific profits or «100% win». Say results depend on following the steps; your role is to guide.",
].join(" ");

const COUNTRY_RULES: Record<CountryCode, string> = {
  EG: [
    "Reply ONLY in Arabic (Egyptian dialect is fine).",
    SERVICE_FRAMING,
    "On doubt or «هل ده نصب»: explain it is a real support service, you guide them on the platform step by step, many clients work this way with help — invite them to continue calmly.",
    "Never send registration URLs — automated scripts send the official link and steps right after.",
    "Do not invent new profit numbers; stay aligned with what was already explained in the thread.",
    "End by inviting them to reply when ready for the next official step.",
  ].join(" "),
  CM: [
    "Reply ONLY in French.",
    SERVICE_FRAMING,
    "On «arnaque» / trust: same calm, realistic reassurance — real service, official platform steps, you help them follow the process.",
    "Never send registration URLs — scripts send the official steps next.",
    "Stay concise and professional.",
  ].join(" "),
  ZM: [
    "Reply ONLY in English.",
    SERVICE_FRAMING,
    "On «scam» / trust: calm, realistic reassurance — legitimate guidance service, official platform, you help step by step.",
    "Never send registration URLs — scripts send the official steps next.",
    "Stay concise and friendly.",
  ].join(" "),
};

function buildSystemPrompt(country: CountryCode): string {
  return [
    "You are the AI AGENT layer on a Pager inbox bot.",
    "Preset SCRIPTS (not you) send: intro, how-it-works, registration text, links, deposit steps, game ID requests.",
    "Your job ONLY when routed to you: vague, complex, skeptical, or trust/scam questions.",
    "Scripts handle mechanical funnel messages; you handle everything that needs a human, reassuring explanation.",
    COUNTRY_RULES[country],
    "Max 5 short sentences. No markdown. No JSON. No URLs.",
  ].join(" ");
}

function buildUserPrompt(ctx: AiAssistContext): string {
  const parts = [
    `Country: ${ctx.country}`,
    `Funnel step: ${ctx.funnelStep}`,
    `Classifier intent: ${ctx.intent}`,
    `Planned script keys (do not duplicate verbatim): ${ctx.scriptKeys?.join(", ") || "none"}`,
    `Latest customer message: ${ctx.customerText}`,
  ];
  if (ctx.recentCustomerTexts.length > 1) {
    parts.push(`Recent customer lines:\n${ctx.recentCustomerTexts.slice(0, 5).join("\n")}`);
  }
  if (ctx.recentOutgoingTexts.length) {
    parts.push(
      `Recent operator/bot outgoings:\n${ctx.recentOutgoingTexts.slice(-4).join("\n---\n")}`,
    );
  }
  return parts.join("\n\n");
}

function buildVisionSystemPrompt(country: CountryCode): string {
  return [
    "You see a customer screenshot from a messenger funnel (registration / casino app / deposit proof).",
    buildSystemPrompt(country),
    "Describe briefly what you see if relevant, then reply to the customer.",
    "If the image is unrelated or too blurry, ask politely for the screenshot they were asked for (registration done, balance, or account id).",
    "Plain text reply only. No URLs.",
  ].join(" ");
}

async function openAiChatCompletion(
  apiKey: string,
  model: string,
  system: string,
  user: string | Array<{ type: string; text?: string; image_url?: { url: string } }>,
): Promise<string | undefined> {
  const userContent =
    typeof user === "string"
      ? user
      : user.map((part) => {
          if (part.type === "text") {
            return { type: "text" as const, text: part.text ?? "" };
          }
          return {
            type: "image_url" as const,
            image_url: { url: part.image_url?.url ?? "", detail: "low" as const },
          };
        });

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.35,
      max_tokens: 500,
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: userContent,
        },
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

function sanitizeAiReply(reply: string | undefined): string | undefined {
  if (!reply?.trim()) {
    return undefined;
  }
  if (/https?:\/\/\S+/i.test(reply)) {
    console.warn("AI assist rejected reply containing URL");
    return undefined;
  }
  return reply.trim();
}

/** OpenAI call — invoked only via ai-agent routing. */
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

  try {
    const reply = await openAiChatCompletion(
      env.AI_API_KEY.trim(),
      env.AI_MODEL,
      buildSystemPrompt(ctx.country),
      buildUserPrompt(ctx),
    );
    return sanitizeAiReply(reply);
  } catch (error) {
    console.warn("AI assist failed:", error instanceof Error ? error.message : error);
    return undefined;
  }
}

export async function maybeAiAssistVision(
  env: AppEnv,
  ctx: AiVisionContext,
): Promise<string | undefined> {
  if (!env.AI_ENABLED || !env.AI_API_KEY?.trim()) {
    return undefined;
  }
  const model = env.AI_VISION_MODEL?.trim() || env.AI_MODEL;
  const dataUrl = `data:${ctx.mimeType};base64,${ctx.imageBase64}`;
  const userParts = [
    {
      type: "text",
      text: [
        `Country: ${ctx.country}`,
        `Funnel step: ${ctx.funnelStep}`,
        `OCR/proof classifier: ${ctx.proofKind}`,
        `Caption: ${ctx.caption || "(none)"}`,
      ].join("\n"),
    },
    { type: "image_url", image_url: { url: dataUrl } },
  ];

  try {
    const reply = await openAiChatCompletion(
      env.AI_API_KEY.trim(),
      model,
      buildVisionSystemPrompt(ctx.country),
      userParts,
    );
    return sanitizeAiReply(reply);
  } catch (error) {
    console.warn("AI vision failed:", error instanceof Error ? error.message : error);
    return undefined;
  }
}

export function detectImageMimeType(image: Buffer): string {
  if (image[0] === 0xff && image[1] === 0xd8) {
    return "image/jpeg";
  }
  if (image[0] === 0x89 && image[1] === 0x50) {
    return "image/png";
  }
  if (image[0] === 0x47 && image[1] === 0x49) {
    return "image/gif";
  }
  if (image[0] === 0x52 && image[1] === 0x49) {
    return "image/webp";
  }
  return "image/jpeg";
}
