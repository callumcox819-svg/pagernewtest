import type { AppEnv } from "./env.js";
import type { FunnelScreenshotScene } from "./funnel-screenshot.js";

export type FunnelAdvanceVerdict =
  | "advance"
  | "hold_help"
  | "decline"
  | "need_balance_shot"
  | "unknown";

/**
 * Cheap YES/NO: is this customer message a positive funnel signal
 * (agree / interested / ready / picked amount / done) so scripts should advance?
 */
export async function aiLooksLikeFunnelAdvance(
  env: AppEnv,
  customerText: string,
  options?: {
    recentCustomerTexts?: string[];
    lastBotText?: string;
    languageHint?: string;
  },
): Promise<boolean> {
  if (!env.AI_ENABLED || !env.AI_API_KEY?.trim()) {
    return false;
  }
  const t = (customerText || "").trim();
  if (!t || t.length > 220) {
    return false;
  }
  if (/^(non|nan|nope|stop|spam|scam|arnaque)\b/i.test(t) && t.length < 40) {
    return false;
  }

  const recent = (options?.recentCustomerTexts ?? [])
    .slice(-3)
    .map((line) => (line || "").trim())
    .filter(Boolean)
    .join(" | ");
  const system = [
    "You classify if a customer message is a POSITIVE funnel signal for a betting-registration assistant.",
    "Reply YES if they agree, show interest, pick a table amount, say ready, say done/registered, send ID-like digits, want to continue (any language incl. Darija/French/Arabic/English/Spanish).",
    "Reply NO if decline, insult, off-topic spam, pure confusion question with no go-ahead, or unrelated.",
    "Reply with exactly YES or NO.",
  ].join(" ");
  const user = [
    options?.languageHint ? `Market language hint: ${options.languageHint}` : "",
    options?.lastBotText ? `Last bot message (context): ${options.lastBotText.slice(0, 240)}` : "",
    recent ? `Recent customer: ${recent}` : "",
    `Latest customer: ${t}`,
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const raw = await openAiYesNo(env, system, user);
    return raw === "YES";
  } catch (error) {
    console.warn(
      "AI funnel-advance classify failed:",
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}

/** Map screenshot scene → funnel action for scripts/AI coach. */
export function verdictFromScreenshotScene(scene: FunnelScreenshotScene): FunnelAdvanceVerdict {
  switch (scene) {
    case "account_id_ready":
    case "platform_balance":
      return "advance";
    case "mobile_money_sms":
      return "need_balance_shot";
    case "site_loading_stuck":
    case "registration_form":
      return "hold_help";
    default:
      return "unknown";
  }
}

async function openAiYesNo(env: AppEnv, system: string, user: string): Promise<"YES" | "NO" | ""> {
  const response = await fetch(env.AI_BASE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.AI_API_KEY!.trim()}`,
      "Content-Type": "application/json",
      ...(env.AI_HTTP_REFERER?.trim() ? { "HTTP-Referer": env.AI_HTTP_REFERER.trim() } : {}),
      ...(env.AI_APP_TITLE?.trim() ? { "X-Title": env.AI_APP_TITLE.trim() } : {}),
    },
    body: JSON.stringify({
      model: env.AI_MODEL,
      temperature: 0,
      max_tokens: 8,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!response.ok) {
    return "";
  }
  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const verdict = (payload.choices?.[0]?.message?.content || "").trim().toUpperCase();
  if (verdict.startsWith("YES")) {
    return "YES";
  }
  if (verdict.startsWith("NO")) {
    return "NO";
  }
  return /\bYES\b/.test(verdict) ? "YES" : /\bNO\b/.test(verdict) ? "NO" : "";
}
