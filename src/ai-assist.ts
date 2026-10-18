import type { CountryCode } from "./config.js";
import type { AppEnv } from "./env.js";
import type { SupportCountry, SupportSnapshot } from "./ai-support-phase.js";
import { describeSupportPhase } from "./ai-support-phase.js";
import {
  aiReplyLooksWrongLanguage,
  buildAiLanguageLockRule,
  describeAiMarketLanguage,
} from "./ai-country-language.js";

export type AiAgentTrigger =
  | "deposit_script_just_sent"
  | "registration_proof_ack";

export type AiAssistContext = {
  country: CountryCode;
  customerText: string;
  recentCustomerTexts: string[];
  recentOutgoingTexts: string[];
  funnelStep: number;
  intent: string;
  scriptKeys?: string[];
  support?: SupportSnapshot;
  agentTrigger?: AiAgentTrigger;
  /** Bypass routing — support agent must reply (post «в процессе»). */
  forceSupportAgent?: boolean;
};

export type AiVisionContext = {
  country: CountryCode;
  caption: string;
  funnelStep: number;
  outgoingTexts: string[];
  proofKind: string;
  imageBase64: string;
  mimeType: string;
  support?: SupportSnapshot;
  ocrCombinedText?: string;
};

const SERVICE_FRAMING = [
  "Business context: we OFFER A LEGITIMATE SERVICE — personal step-by-step guidance on using the platform (registration, deposit, gameplay). You are a service assistant, not a random spammer.",
  "If they ask «is this a scam?» / fraud / trust: answer calmly and realistically — this is a real service, you walk them through official steps on the platform, you are here to help them succeed with clear instructions. Do not dodge the question.",
  "Never ask them to send money to a personal wallet or unknown account in chat. Deposits happen only on the official platform as explained in scripts.",
  "Do not guarantee specific profits or «100% win». Say results depend on following the steps; your role is to guide.",
].join(" ");

const COUNTRY_RULES: Record<CountryCode, string> = {
  EG: [
    buildAiLanguageLockRule("EG"),
    SERVICE_FRAMING,
    "SUPPORT AGENT mode after scripts: warm, patient, like a real operator.",
    "Guide first deposit (green + / deposit), mobile wallet if discussed in thread — do not invent new amounts.",
    "Registration proof: congratulate, ask for deposit then balance screenshot.",
    "Link will not open: Wi‑Fi, different network, open in browser — calm steps, NEVER paste a new URL.",
    "On «هل ده نصب»: calm reassurance, official platform, step-by-step help.",
    "Do not repeat deposit script bullets verbatim — human follow-up only.",
    "If they say NOT registered yet / no account / «لا» to finishing registration — do NOT ask for ID or deposit; registration link scripts handle that.",
    "Max 4 short sentences. No markdown. No URLs.",
    buildAiLanguageLockRule("EG"),
  ].join(" "),
  CM: [
    buildAiLanguageLockRule("CM"),
    SERVICE_FRAMING,
    "SUPPORT AGENT mode after scripts: warm, patient, like a real operator in Telegram.",
    "Guide first deposit on 1xBET (green $ / Déposer, MTN or Orange). Minimum in thread is often 1 000 CFA — do not invent promos unless the customer said them.",
    "Registration proof: congratulate, ask for balance screenshot after top-up.",
    "Acknowledge «Ok boss», «j'ai déjà fait», waiting for screenshot — brief and friendly.",
    "Link/MTN/Orange issues: Wi‑Fi, other operator, Google Chrome — no new URL.",
    "Screenshot of INSCRIPTION / Étape X sur Y / code promo form = still registering — tell them to finish signup with promo CASH056; NEVER ask for player ID yet.",
    "Player ID (when truly registered): say it starts with + (not 17 or 18).",
    "On «arnaque»: calm reassurance.",
    "Do not repeat deposit script verbatim.",
    "If they say NOT registered yet / no account / «Non» or «No» to finishing registration — do NOT ask for ID or deposit; registration link scripts handle that.",
    "Max 4 short sentences. No markdown. No URLs.",
    buildAiLanguageLockRule("CM"),
  ].join(" "),
  ZM: [
    buildAiLanguageLockRule("ZM"),
    SERVICE_FRAMING,
    "SUPPORT AGENT mode after scripts: warm, patient, like a real operator.",
    "Guide first deposit (Deposit button / green +), mobile money as in thread — do not invent amounts.",
    "Registration proof: congratulate, ask for deposit screenshot when ready.",
    "If they say NOT registered yet / no account — do NOT ask for ID or deposit; registration link scripts handle that.",
    "If they say they are NOT registered yet or have no account: do NOT coach deposit or ask for ID — registration link scripts handle that.",
    "Link or network issues: Wi‑Fi, try again in Chrome, different network — no new URL.",
    "On «scam»: calm reassurance.",
    "Do not repeat deposit script verbatim.",
    "Max 4 short sentences. No markdown. No URLs.",
    buildAiLanguageLockRule("ZM"),
  ].join(" "),
};

/** MG/DJ/JO reuse CM/EG language routing in the worker — currency rules must follow the real market. */
const MARKET_RULES: Partial<Record<SupportCountry, string>> = {
  MG: [
    buildAiLanguageLockRule("CM"),
    SERVICE_FRAMING,
    "Market: Madagascar (MG). Currency is MGA (Ariary) ONLY.",
    "NEVER write CFA, FCFA, francs CFA, or Cameroon deposit amounts (1 000 / 1 500 CFA).",
    "Use amounts from the MGA table already in the thread (e.g. 5000 / 8000 / 15000 / 30000 MGA). Typical minimum deposit is 5000 MGA.",
    "Promo in scripts is MAD778 — do not invent other promo codes.",
    "Guide deposit on the platform (Déposer / green $). Ask for a screenshot after top-up.",
    "Link issues: Wi‑Fi, Google Chrome — never paste a new URL.",
    "If they say NOT registered yet / no account — do NOT ask for ID or deposit; registration scripts handle that.",
    "On «arnaque»: calm reassurance.",
    "Max 4 short sentences. No markdown. No URLs.",
    buildAiLanguageLockRule("CM"),
  ].join(" "),
  DJ: [
    buildAiLanguageLockRule("CM"),
    SERVICE_FRAMING,
    "Market: Djibouti (DJ). Currency is DJF ONLY.",
    "NEVER write CFA, FCFA, MGA, or Cameroon/Madagascar amounts.",
    "Use amounts from the DJF table already in the thread (e.g. 100 / 200 / 500 / 1000 DJF). Typical starter amounts are around 40–300 DJF as in scripts.",
    "Promo in scripts is BJI777 — do not invent other promo codes.",
    "Guide deposit on the platform. Ask for a screenshot after top-up.",
    "Link issues: Wi‑Fi, Google Chrome — never paste a new URL.",
    "If they say NOT registered yet / no account — do NOT ask for ID or deposit; registration scripts handle that.",
    "On «arnaque»: calm reassurance.",
    "Max 4 short sentences. No markdown. No URLs.",
    buildAiLanguageLockRule("CM"),
  ].join(" "),
  JO: [
    buildAiLanguageLockRule("EG"),
    SERVICE_FRAMING,
    "Market: Jordan (JO). Currency is JOD ONLY.",
    "NEVER write CFA, MGA, DJF, or invent foreign currency amounts.",
    "Use deposit amounts from the JOD table already in the thread — do not invent new amounts.",
    "Link issues: Wi‑Fi, browser — never paste a new URL.",
    "If they say NOT registered yet / no account — do NOT ask for ID or deposit; registration scripts handle that.",
    "Max 4 short sentences. No markdown. No URLs.",
    buildAiLanguageLockRule("EG"),
  ].join(" "),
  PK: [
    "CRITICAL LANGUAGE: Write your ENTIRE reply ONLY in Urdu (Pakistan), Arabic-script Urdu.",
    "Do NOT use English, French, Russian, or Egyptian dialect (except brand names like 1xBET).",
    SERVICE_FRAMING,
    "Market: Pakistan (PK). Use PKR amounts from the saved-reply table already in the thread — do not invent amounts or promo codes.",
    "Guide registration → ID screenshot → deposit → balance screenshot. Never invent URLs — only the link already sent in chat.",
    "If site stuck/loading: refresh, Chrome, same link, remind promo from our script.",
    "If mobile-money SMS only: ask for 1xBET balance screenshot.",
    "Max 4 short sentences. No markdown. No URLs.",
  ].join(" "),
};

function resolveAiMarket(country: CountryCode, ctx?: AiAssistContext): SupportCountry {
  return ctx?.support?.country ?? country;
}

function resolveAiLanguageCountry(market: SupportCountry): CountryCode {
  if (market === "MG" || market === "DJ") {
    return "CM";
  }
  if (market === "JO" || market === "PK") {
    return "EG";
  }
  return market;
}

function resolveAiMarketRules(country: CountryCode, ctx?: AiAssistContext): string {
  const market = resolveAiMarket(country, ctx);
  return MARKET_RULES[market] ?? COUNTRY_RULES[country] ?? COUNTRY_RULES.CM;
}

function buildSystemPrompt(country: CountryCode, ctx?: AiAssistContext): string {
  const market = resolveAiMarket(country, ctx);
  const supportMode =
    ctx?.support?.active ||
    ctx?.agentTrigger === "deposit_script_just_sent" ||
    ctx?.agentTrigger === "registration_proof_ack";

  const supportBlock =
    supportMode && ctx?.support
      ? [
          `MODE: SUPPORT AGENT (${market}, post-scripts, «в процессе регистрации»).`,
          describeSupportPhase(ctx.support),
          "Automated scripts sent mechanical steps; YOU coach deposit, handle doubts, operator/network issues, waiting for screenshots.",
        ].join(" ")
      : supportMode
        ? `MODE: SUPPORT AGENT (${market}) — short human follow-up after an automated script.`
        : "";

  const baseRole = supportMode
    ? "You are the SUPPORT AGENT on a Pager inbox bot. Scripts already sent intro, link, and deposit instructions where applicable."
    : "You are the AI AGENT layer on a Pager inbox bot. Preset SCRIPTS send funnel messages.";

  const baseJob = supportMode
    ? "Your job: human follow-up until deposit screenshot and game/account ID — all complex or emotional messages."
    : "Your job when routed: vague, complex, skeptical, or trust questions. Scripts handle mechanical funnel steps.";

  return [
    baseRole,
    baseJob,
    supportBlock,
    `Active market code: ${market}. Follow that market's currency and promo only.`,
    resolveAiMarketRules(country, ctx),
    "CRITICAL: Never invent or paste any URL, tinyurl, bit.ly, t.me, or mirror link. Only refer to the registration/Telegram link already sent in this chat from saved replies (say «le lien que je t'ai envoyé» / «the link I sent»).",
    "If the site does not load: tell them to refresh, use Chrome, reopen THE SAME link already in the chat. Never provide a different link.",
    "Push toward registration → ID screenshot → deposit → balance screenshot. Do not skip ahead to Telegram handoff without deposit proof.",
    supportMode ? "Max 5 short sentences. No markdown. No JSON. No URLs." : "Max 5 short sentences. No markdown. No JSON. No URLs.",
  ]
    .filter(Boolean)
    .join(" ");
}

function buildUserPrompt(ctx: AiAssistContext): string {
  const market = resolveAiMarket(ctx.country, ctx);
  const languageCountry = resolveAiLanguageCountry(market);
  const parts = [
    `Country: ${market}`,
    `Required reply language: ${describeAiMarketLanguage(languageCountry)}`,
    `Funnel step: ${ctx.funnelStep}`,
    `Classifier intent: ${ctx.intent}`,
  ];
  if (market === "MG") {
    parts.push(
      "Currency lock: MGA only. Never mention CFA/FCFA. Match deposit amounts to the MGA table in recent outgoings.",
    );
  } else if (market === "DJ") {
    parts.push(
      "Currency lock: DJF only. Never mention CFA/FCFA/MGA. Match amounts to the DJF table in recent outgoings.",
    );
  } else if (market === "JO") {
    parts.push("Currency lock: JOD only. Never mention CFA/MGA/DJF.");
  }
  if (ctx.support?.active) {
    parts.push(`Support phase: ${ctx.support.phase}`);
  }
  if (ctx.agentTrigger === "deposit_script_just_sent") {
    parts.push(
      "Trigger: deposit instruction script was just sent automatically. Short operator follow-up: motivate deposit, ask for screenshot when done. Do not repeat the full step list.",
    );
  }
  if (ctx.agentTrigger === "registration_proof_ack") {
    parts.push(
      "Trigger: registration screenshot recognized. Acknowledge and guide to deposit + screenshot.",
    );
  }
  parts.push(
    `Planned script keys (do not duplicate verbatim): ${ctx.scriptKeys?.join(", ") || "none"}`,
  );
  if (ctx.customerText.trim()) {
    parts.push(`Latest customer message: ${ctx.customerText}`);
  }
  if (ctx.recentCustomerTexts.length > 1) {
    parts.push(`Recent customer lines:\n${ctx.recentCustomerTexts.slice(0, 5).join("\n")}`);
  }
  if (ctx.recentOutgoingTexts.length) {
    parts.push(
      `Recent operator/bot outgoings (context only — do NOT reply to these unless the customer quoted them):\n${ctx.recentOutgoingTexts.slice(-4).join("\n---\n")}`,
    );
  }
  parts.push(
    "Reply ONLY to the latest customer message above. Scripts already sent mechanical steps — do not echo or expand our own script text.",
  );
  return parts.join("\n\n");
}

function buildLanguageRetryUserPrompt(country: CountryCode): string {
  return `Your previous reply used the wrong language. Rewrite from scratch. ${buildAiLanguageLockRule(country)}`;
}

async function completeWithLanguageGuard(
  env: AppEnv,
  country: CountryCode,
  system: string,
  user: string | Array<{ type: string; text?: string; image_url?: { url: string } }>,
  model?: string,
  market?: SupportCountry,
): Promise<string | undefined> {
  const apiKey = env.AI_API_KEY!.trim();
  const resolvedModel = model?.trim() || env.AI_MODEL;
  const languageCountry = resolveAiLanguageCountry(market ?? country);
  let reply = sanitizeAiReply(
    await openAiChatCompletion(env, resolvedModel, system, user),
    languageCountry,
    market ?? country,
  );
  if (reply && aiReplyLooksWrongLanguage(languageCountry, reply)) {
    console.warn(`AI assist wrong language for ${market ?? country}, retrying once`);
    reply = sanitizeAiReply(
      await openAiChatCompletion(
        env,
        resolvedModel,
        system,
        typeof user === "string"
          ? `${user}\n\n${buildLanguageRetryUserPrompt(languageCountry)}`
          : [
              ...(user as Array<{ type: string; text?: string; image_url?: { url: string } }>),
              { type: "text", text: buildLanguageRetryUserPrompt(languageCountry) },
            ],
      ),
      languageCountry,
      market ?? country,
    );
  }
  if (reply && aiReplyLooksWrongLanguage(languageCountry, reply)) {
    console.warn(`AI assist still wrong language for ${market ?? country} — dropping reply`);
    return undefined;
  }
  return reply;
}

function buildVisionSystemPrompt(country: CountryCode, support?: SupportSnapshot): string {
  const supportHint = support?.active
    ? "SUPPORT AGENT: praise registration proof, guide deposit + screenshot; thank for balance shot; ask for clearer image if needed."
    : "Describe briefly what you see if relevant, then reply to the customer.";
  return [
    "You see a customer screenshot (registration / app / deposit proof / loading error / mobile-money SMS).",
    "If the image shows a Telegram/chat thread: ignore operator/bot bubbles (our scripts) — only react to the customer's new app screenshot or their caption.",
    "Do not reply to or repeat text visible from our own automated messages in the screenshot.",
    "If registration button is loading / page stuck: help refresh + Chrome + same link already in chat + remind promo from our script. No new URLs.",
    "If mobile-money SMS only: ask for 1xBET balance screenshot — SMS is not enough.",
    "If account ID / DÉPÔT screen with ID: acknowledge and push deposit (scripts may send deposit text).",
    "If 1xBET balance visible: congratulate — deposit proof OK.",
    buildSystemPrompt(country, support ? ({ country, support } as AiAssistContext) : undefined),
    supportHint,
    "Plain text reply only. No URLs. Never invent links.",
  ].join(" ");
}

async function openAiChatCompletion(
  env: AppEnv,
  model: string,
  system: string,
  user: string | Array<{ type: string; text?: string; image_url?: { url: string } }>,
): Promise<string | undefined> {
  const apiKey = env.AI_API_KEY!.trim();
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

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
  if (env.AI_HTTP_REFERER?.trim()) {
    headers["HTTP-Referer"] = env.AI_HTTP_REFERER.trim();
  }
  if (env.AI_APP_TITLE?.trim()) {
    headers["X-Title"] = env.AI_APP_TITLE.trim();
  }

  const response = await fetch(env.AI_BASE_URL, {
    method: "POST",
    headers,
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
    const hint =
      env.AI_API_KEY?.startsWith("sk-or-") && env.AI_BASE_URL.includes("api.openai.com")
        ? " (OpenRouter key requires AI_BASE_URL=https://openrouter.ai/api/v1/chat/completions)"
        : "";
    console.warn(`AI assist HTTP ${response.status}${hint}: ${body.slice(0, 280)}`);
    return undefined;
  }
  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = payload.choices?.[0]?.message?.content?.trim();
  return text || undefined;
}

function sanitizeAiReply(
  reply: string | undefined,
  country?: CountryCode,
  market?: SupportCountry,
): string | undefined {
  if (!reply?.trim()) {
    return undefined;
  }
  if (/https?:\/\/\S+|www\.\S+|tinyurl\.com|bit\.ly|t\.me\/|cutt\.ly/i.test(reply)) {
    console.warn("AI assist rejected reply containing URL/link");
    return undefined;
  }
  const trimmed = reply.trim();
  const resolvedMarket = market ?? country;
  if (
    resolvedMarket === "MG" &&
    /\b(cfa|fcfa|francs?\s*cfa)\b/i.test(trimmed)
  ) {
    console.warn("AI assist rejected MG reply containing CFA");
    return undefined;
  }
  if (
    resolvedMarket === "DJ" &&
    /\b(cfa|fcfa|mga|ariary)\b/i.test(trimmed)
  ) {
    console.warn("AI assist rejected DJ reply containing wrong currency");
    return undefined;
  }
  if (country && aiReplyLooksWrongLanguage(country, trimmed)) {
    return undefined;
  }
  return trimmed;
}

/**
 * Cheap YES/NO classifier: after «Quel âge», is this message stating an age?
 * Covers phonetics / typos / wrong DeepL language (e.g. «Trantan» = trente ans).
 * Does not send a customer reply — only advances the funnel when true.
 */
export async function aiLooksLikeAgeAnswer(
  env: AppEnv,
  customerText: string,
  recentCustomerTexts: string[] = [],
): Promise<boolean> {
  if (!env.AI_ENABLED || !env.AI_API_KEY?.trim()) {
    return false;
  }
  const t = (customerText || "").trim();
  if (!t || t.length > 80) {
    return false;
  }
  // Pure noise / long questions are not ages.
  if (/[?]/.test(t) && t.length > 20) {
    return false;
  }
  const recent = recentCustomerTexts
    .slice(-3)
    .map((line) => (line || "").trim())
    .filter(Boolean)
    .join(" | ");
  const system = [
    "You classify whether a customer message answers an age question.",
    "Context: bot asked age in French (Quel âge avez-vous?). Market often Cameroon / French Africa.",
    "Accept: digits (30), French words (trente ans), glued phonetics (Trantan, trentans), typos (22 ens), other languages stating age 15-99.",
    "Reject: greetings, yes/no alone, deposit amounts, questions, random words unrelated to age.",
    "Reply with exactly YES or NO. No other text.",
  ].join(" ");
  const user = recent
    ? `Recent customer lines: ${recent}\nLatest message: ${t}`
    : `Latest message: ${t}`;
  try {
    const raw = await openAiChatCompletion(env, env.AI_MODEL, system, user);
    const verdict = (raw || "").trim().toUpperCase();
    if (verdict.startsWith("YES")) {
      return true;
    }
    if (verdict.startsWith("NO")) {
      return false;
    }
    return /\bYES\b/.test(verdict);
  } catch (error) {
    console.warn(
      "AI age classify failed:",
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}

/** OpenAI call — invoked only via ai-agent routing. */
export async function maybeAiAssistReply(
  env: AppEnv,
  ctx: AiAssistContext,
): Promise<string | undefined> {
  if (!env.AI_ENABLED || !env.AI_API_KEY?.trim()) {
    return undefined;
  }
  if (!ctx.customerText.trim() && !ctx.agentTrigger && !ctx.forceSupportAgent) {
    return undefined;
  }

  try {
    const market = resolveAiMarket(ctx.country, ctx);
    return await completeWithLanguageGuard(
      env,
      ctx.country,
      buildSystemPrompt(ctx.country, ctx),
      buildUserPrompt(ctx),
      undefined,
      market,
    );
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
  const market = resolveAiMarket(ctx.country, {
    country: ctx.country,
    support: ctx.support,
  } as AiAssistContext);
  const languageCountry = resolveAiLanguageCountry(market);
  const dataUrl = `data:${ctx.mimeType};base64,${ctx.imageBase64}`;
  const userParts = [
    {
      type: "text",
      text: [
        `Country: ${market}`,
        `Required reply language: ${describeAiMarketLanguage(languageCountry)}`,
        `Funnel step: ${ctx.funnelStep}`,
        `OCR/proof classifier: ${ctx.proofKind}`,
        `Caption: ${ctx.caption || "(none)"}`,
        ctx.support?.active ? `Support phase: ${ctx.support.phase}` : "",
        market === "MG"
          ? "Currency lock: MGA only. Never mention CFA/FCFA."
          : market === "DJ"
            ? "Currency lock: DJF only. Never mention CFA/MGA."
            : "",
      ]
        .filter(Boolean)
        .join("\n"),
    },
    { type: "image_url", image_url: { url: dataUrl } },
  ];

  try {
    return await completeWithLanguageGuard(
      env,
      ctx.country,
      buildVisionSystemPrompt(ctx.country, ctx.support),
      userParts,
      model,
      market,
    );
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

export type CmVisionExtract = {
  ocrText: string;
  login17?: string;
  screen: "registration_success" | "app_balance" | "other";
};

/** Read CM proof fields from a screenshot when Tesseract misses Login 17 or balance. */
export async function maybeAiVisionExtractCmProof(
  env: AppEnv,
  options: {
    imageBase64: string;
    mimeType: string;
    caption: string;
    depositScriptAlreadySent: boolean;
  },
): Promise<CmVisionExtract | undefined> {
  if (!env.AI_ENABLED || !env.AI_API_KEY?.trim()) {
    return undefined;
  }
  const model = env.AI_VISION_MODEL?.trim() || env.AI_MODEL;
  const dataUrl = `data:${options.mimeType};base64,${options.imageBase64}`;
  const system = [
    "You read customer screenshots for a Cameroon (CM) 1xBET onboarding funnel.",
    "Our client Login IDs ALWAYS start with 17 (ten digits typical). Ignore IDs starting with 16.",
    "Reply with ONE JSON object only, no markdown:",
    '{"ocrText":"all visible text you can read","login17":"17xxxxxxxx or empty","screen":"registration_success|app_balance|other"}',
    "registration_success = Inscription réussie / login password screen.",
    "app_balance = 1xBET home with balance like 1020 F in the header.",
  ].join(" ");
  const userParts = [
    {
      type: "text",
      text: [
        `Caption: ${options.caption || "(none)"}`,
        `Deposit script already sent in chat: ${options.depositScriptAlreadySent ? "yes" : "no"}`,
      ].join("\n"),
    },
    { type: "image_url", image_url: { url: dataUrl } },
  ];

  try {
    const raw = await openAiChatCompletion(env, model, system, userParts);
    if (!raw?.trim()) {
      return undefined;
    }
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return undefined;
    }
    const parsed = JSON.parse(jsonMatch[0]) as {
      ocrText?: string;
      login17?: string;
      screen?: string;
    };
    const ocrText = (parsed.ocrText || "").trim();
    let login17 = (parsed.login17 || "").replace(/\D/g, "");
    if (login17 && !/^17\d{5,}$/.test(login17)) {
      login17 = "";
    }
    const screen =
      parsed.screen === "registration_success" || parsed.screen === "app_balance"
        ? parsed.screen
        : "other";
    if (!ocrText && !login17) {
      return undefined;
    }
    return { ocrText, login17: login17 || undefined, screen };
  } catch (error) {
    console.warn("CM AI vision extract failed:", error instanceof Error ? error.message : error);
    return undefined;
  }
}

export function cmVisionExtractToCombinedText(
  extract: CmVisionExtract,
  caption: string,
): string {
  const parts = [caption, extract.ocrText];
  if (extract.login17) {
    parts.push(`Login: ${extract.login17}`);
  }
  if (extract.screen === "registration_success") {
    parts.push("Inscription réussie");
  }
  if (extract.screen === "app_balance") {
    parts.push("1xbet balance F");
  }
  return parts.filter(Boolean).join("\n");
}
