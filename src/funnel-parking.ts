import type { AppEnv } from "./env.js";
import { normalizeCustomerText } from "./customer-intent.js";

/** Parking folders after clear customer statements (not random words). */
export type FunnelParkingIntent = "no_money" | "not_ready" | "none";

/**
 * Clear «нет денег» / no money — must be about lacking funds, not «I deposited» etc.
 */
export function isClearNoMoneyPhrase(text: string): boolean {
  const t = normalizeCustomerText(text);
  if (!t || t.length > 160) {
    return false;
  }
  // Exclude deposit / already paid signals.
  if (
    /\b(j['']?ai (deja )?depose|j['']?ai paye|c['']?est fait|balance|solde|depot fait|deposit done|я внес|внес депозит)\b/i.test(
      t,
    )
  ) {
    return false;
  }
  return (
    /\b(нет\s*денег|нету\s*денег|нет\s*бабок|нет\s*бабла|денег\s*нет)\b/i.test(t) ||
    /\b(pas\s*d['']?argent|j['']?ai\s*pas\s*d['']?argent|je\s*n['']?ai\s*pas\s*d['']?argent|sans\s*argent|pas\s*les\s*moyens|pas\s*de\s*sous|pas\s*de\s*fric|manque\s*d['']?argent)\b/i.test(
      t,
    ) ||
    /\b(no\s*money|don'?t\s*have\s*(any\s*)?(money|cash)|do\s*not\s*have\s*(any\s*)?(money|cash)|not\s*enough\s*money|can'?t\s*afford|no\s*funds|no\s*cash|broke)\b/i.test(
      t,
    ) ||
    /(مش معايه فلوس|مش معاي فلوس|معنديش فلوس|مفيش فلوس|ما عندي فلوس|مش معايا فلوس)/i.test(t) ||
    /\b(no\s*tengo\s*dinero|sin\s*dinero|no\s*tengo\s*plata|no\s*puedo\s*pagar)\b/i.test(t) ||
    /\b(maintenant\s*)?(je\s*)?(n['']?ai\s*)?pas\s*(d['']?)?(argent|sous|moyens)\b/i.test(t)
  );
}

/**
 * Clear «не готов» / not ready now — deferral, not hard refuse / not «no money».
 */
export function isClearNotReadyPhrase(text: string): boolean {
  const t = normalizeCustomerText(text);
  if (!t || t.length > 160) {
    return false;
  }
  if (isClearNoMoneyPhrase(t)) {
    return false;
  }
  if (/\b(non merci|pas interesse|not interested|scam|arnaque|stop)\b/i.test(t)) {
    return false;
  }
  return (
    /\b(не\s*готов|неготов|пока\s*не\s*готов|не\s*сейчас|потом|позднее|позже|подожди|подождите|погоди)\b/i.test(
      t,
    ) ||
    // «Attend» / «Attends» / «Attendez» = wait — not ready now (common MG/CM typo without -s).
    /^(attend|attends|attendez|attendez\s*svp|attends?\s*(un\s*peu|un\s*moment|stp|svt|svp)?)\.?!*$/i.test(
      t,
    ) ||
    /\b(pas\s*pr[eê]t|je\s*ne\s*suis\s*pas\s*pr[eê]t|pas\s*maintenant|plus\s*tard|une\s*autre\s*fois|demain|quand\s*j['']?aurai|trop\s*occup[eé]|pas\s*le\s*temps|je\s*reviens|un\s*moment|laisse[- ]moi|attends?\s*un\s*peu)\b/i.test(
      t,
    ) ||
    /\b(not\s*ready|not\s*now|later|tomorrow|another\s*time|too\s*busy|no\s*time|come\s*back|^wait\b|wait\s*(a\s*bit|please)?)\b/i.test(
      t,
    ) ||
    /(بعدين|مش دلوقتي|مش الآن|لاحقا|مشغول|مش فاضي|استنى|استني)/i.test(t) ||
    /\b(no\s*estoy\s*listo|luego|mas\s*tarde|ahora\s*no|ma[nñ]ana|espera|esperame)\b/i.test(t)
  );
}

export function classifyParkingIntentHeuristic(text: string): FunnelParkingIntent {
  if (isClearNoMoneyPhrase(text)) {
    return "no_money";
  }
  if (isClearNotReadyPhrase(text)) {
    return "not_ready";
  }
  return "none";
}

/**
 * AI confirms parking intent — only NO_MONEY / NOT_READY / NONE.
 * Use when heuristic is unsure OR to double-check before moving folders.
 */
export async function aiClassifyParkingIntent(
  env: AppEnv,
  customerText: string,
): Promise<FunnelParkingIntent> {
  if (!env.AI_ENABLED || !env.AI_API_KEY?.trim()) {
    return "none";
  }
  const t = (customerText || "").trim();
  if (!t || t.length > 220) {
    return "none";
  }

  const system = [
    "Classify the customer message for a registration/deposit funnel bot.",
    "Reply with exactly one token:",
    "NO_MONEY — they clearly say they have no money / cannot deposit now because of lack of funds.",
    "NOT_READY — they are not ready now (later, busy, tomorrow, not ready) but NOT about lacking money and NOT a hard refuse.",
    "NONE — anything else (interest, questions, decline/scam, greetings, deposit proof, random words).",
    "Do NOT guess. Random short words, slang without clear meaning, or mixed unclear text → NONE.",
  ].join(" ");

  try {
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
        max_tokens: 12,
        messages: [
          { role: "system", content: system },
          { role: "user", content: `Customer message: ${t}` },
        ],
      }),
    });
    if (!response.ok) {
      return "none";
    }
    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const raw = (payload.choices?.[0]?.message?.content || "").trim().toUpperCase();
    if (raw.includes("NO_MONEY")) {
      return "no_money";
    }
    if (raw.includes("NOT_READY")) {
      return "not_ready";
    }
    return "none";
  } catch (error) {
    console.warn(
      "AI parking classify failed:",
      error instanceof Error ? error.message : error,
    );
    return "none";
  }
}

/**
 * Resolve parking intent:
 * - clear phrase («нет денег», «pas d'argent», «не готов»…) → trust heuristic;
 * - otherwise AI must return NO_MONEY / NOT_READY (random words → NONE, no move).
 */
export async function resolveFunnelParkingIntent(
  env: AppEnv,
  customerText: string,
): Promise<FunnelParkingIntent> {
  const clear = classifyParkingIntentHeuristic(customerText);
  if (clear !== "none") {
    return clear;
  }
  return aiClassifyParkingIntent(env, customerText);
}
