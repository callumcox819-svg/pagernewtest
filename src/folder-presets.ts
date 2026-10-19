import type { PagerSavedReply } from "./pager-client.js";

/** Melbet-style folder markets only — NOT used for 1xBET KE/GT/EC engines. */
export type FolderMarketCode =
  | "MA"
  | "MR"
  | "DJ"
  | "BF"
  | "CM"
  | "BJ"
  | "CR"
  | "SN"
  | "PK"
  | "PE";

export type PresetLanguage = "fr" | "es" | "en" | "ur";

export type FolderMarket = {
  language: PresetLanguage;
  hints: string[];
  label: string;
};

export const FOLDER_MARKETS: Record<FolderMarketCode, FolderMarket> = {
  MA: {
    language: "fr",
    hints: ["марокк", "мароко", "марок", "morocco", "maroc", "المغرب"],
    label: "Марокко",
  },
  MR: { language: "fr", hints: ["мавритан", "mauritan"], label: "Мавритания" },
  DJ: { language: "fr", hints: ["джибут", "djibouti", "djib"], label: "Джибути" },
  BF: { language: "fr", hints: ["буркина", "burkina"], label: "Буркина-Фасо" },
  CM: { language: "fr", hints: ["камер", "cameroon", "cameroun"], label: "Камерун" },
  BJ: { language: "fr", hints: ["бенін", "бенин", "benin", "bénin"], label: "Бенин" },
  CR: { language: "es", hints: ["коста", "costa"], label: "Коста-Рика" },
  SN: { language: "fr", hints: ["сенегал", "senegal", "sénégal"], label: "Сенегал" },
  /** Saved-reply folder e.g. «скрипт папка Урду (Пакистан)». */
  PK: {
    language: "ur",
    hints: ["урду", "urdu", "пакистан", "pakistan", "pakistani", "pkr"],
    label: "Пакистан",
  },
  /** Saved-reply folder e.g. «скрипт папка Перу» — Spanish like CR. */
  PE: {
    language: "es",
    hints: ["перу", "peru", "perú", "lima"],
    label: "Перу",
  },
};

/** Melbet folder-order markets — 1xBET KE/GT/EC use dedicated Pager script engines. */
export const FOLDER_ONLY_COUNTRIES = ["MA", "MR", "BF", "BJ", "CR", "SN", "PK", "PE"] as const;

export type FolderOnlyCountry = (typeof FOLDER_ONLY_COUNTRIES)[number];

export function isFolderMarket(country: string): country is FolderMarketCode {
  return Object.prototype.hasOwnProperty.call(FOLDER_MARKETS, country);
}

export function isFolderOnlyCountry(country: string): country is FolderOnlyCountry {
  return (FOLDER_ONLY_COUNTRIES as readonly string[]).includes(country);
}

export function folderMarketLanguage(country: string): PresetLanguage | undefined {
  return isFolderMarket(country) ? FOLDER_MARKETS[country].language : undefined;
}

export type PresetKind =
  | "intro"
  | "details"
  | "table"
  | "ready"
  | "registration"
  | "link"
  | "promo"
  | "ask_id"
  | "deposit"
  | "telegram"
  | "other";

export type PresetPlan =
  | {
      action: "send";
      texts: string[];
      /** Last preset index included in this send bundle. */
      index: number;
      role: string;
      table: boolean;
      moveToInProgress?: boolean;
    }
  | { action: "hold"; reason: string };

const AMOUNT_PAIR =
  /(\d[\d\s.,]{0,12})\s*(?:mru|djf|xof|fcfa|cfa|crc|kes|gtq|usd|eur|€|mad|pen|sol|s\/\.?)?\s*[-–—]\s*(\d[\d\s.,]{0,12})/gi;

export function foldPresetText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[’`']/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function isTablePresetText(text: string): boolean {
  const matches = text.match(AMOUNT_PAIR);
  return (matches?.length ?? 0) >= 2;
}

export function findTablePresetIndex(replies: PagerSavedReply[]): number {
  return replies.findIndex((reply) => isTablePresetText(reply.text));
}

function isHowItWorksOverview(raw: string, folded: string): boolean {
  if (
    /[eé]tape par [eé]tape|how it works|comment cela|voici ce que|d[eé]p[oô]t minimum|groupe priv/i.test(
      folded,
    )
  ) {
    return true;
  }
  // MA Arabic «كيفية العمل» / numbered overview — must NOT become registration/deposit
  // just because steps mention تسجيل / إيداع / 10 درهم.
  if (
    /كيفية العمل|كيف (?:يعمل|تشتغل|نشتغل)|طريقة العمل|الخطوات|خطوة بخطوة|إليك كيف|اليك كيف|إليك ما|اليك ما/i.test(
      raw,
    )
  ) {
    return true;
  }
  const numbered =
    /(?:^|\n)\s*1[\).:\-\s]/m.test(raw) && /(?:^|\n)\s*2[\).:\-\s]/m.test(raw);
  if (
    numbered &&
    raw.length > 100 &&
    /(?:d[eé]p[oô]t|إيداع|ايداع|inscri|تسجيل|compte|حساب|promo|درهم|mad\b)/i.test(folded)
  ) {
    return true;
  }
  return false;
}

export function classifyPresetKind(text: string): PresetKind {
  const raw = (text || "").trim();
  const t = foldPresetText(raw);
  if (!t) {
    return "other";
  }
  if (/t\.me\//i.test(raw) || /telegram\.me\//i.test(raw)) {
    return "telegram";
  }
  if (isTablePresetText(raw)) {
    return "table";
  }
  // Overview / how-it-works BEFORE deposit+registration needles (MA Arabic scripts).
  if (isHowItWorksOverview(raw, t)) {
    return "details";
  }
  if (
    /^https?:\/\/\S+$/i.test(raw) ||
    ((/tinyurl\.com|bit\.ly|cutt\.ly|voici le lien|here'?s the link|lien\s*:/i.test(t) ||
      (/https?:\/\//i.test(raw) && raw.length < 160)) &&
      !/deposit|d[eé]p[oô]t|إيداع|telegram|t\.me/i.test(t))
  ) {
    return "link";
  }
  if (
    /(?:^|\b)(?:game\s*)?id\b|айди|identifiant|account id|player id|معرف|رقم (?:الحساب|اللاعب)|id du compte|ton id|votre id/i.test(
      t,
    )
  ) {
    return "ask_id";
  }
  if (
    /deposit|d[eé]p[oô]t|إيداع|ايداع|\bsolde\b|\bbalance\b|bouton.*\$|\$\)/i.test(t) &&
    !/inscription|تسجيل|registr|chrome/i.test(t)
  ) {
    return "deposit";
  }
  if (/^(code promo|promo code)\b/i.test(t) || (/code promo|promo code/i.test(t) && t.length < 100)) {
    return "promo";
  }
  if (
    /inscription|تسجيل|registr|chrome|code promo|lien d'inscription|mrc\d+|bji\d+|mad\d+/i.test(t)
  ) {
    return "registration";
  }
  if (
    /pr[eê]t|ready to|d[eé]marrer avec|es-tu pr|هل أنت مستعد|هل انت مستعد|واش نتي واجد|واش نتا واجد/i.test(
      t,
    )
  ) {
    return "ready";
  }
  if (/bonjour|salam|gagner|casino|مرحبا|أهلا|je suis ici/i.test(t)) {
    return "intro";
  }
  return "other";
}

function replyWasSent(replyText: string, outgoingTexts: string[]): boolean {
  const folded = foldPresetText(replyText);
  const needle = folded.slice(0, 80);
  if (needle.length < 24) {
    // Short link-only presets: match by URL / full body.
    const raw = replyText.trim();
    if (/^https?:\/\/\S+$/i.test(raw)) {
      return outgoingTexts.some((outgoing) => (outgoing || "").includes(raw));
    }
    if (needle.length < 8) {
      return false;
    }
  }
  return outgoingTexts.some((outgoing) => {
    const body = foldPresetText(outgoing);
    if (!body) {
      return false;
    }
    if (body.includes(needle)) {
      return true;
    }
    return body.length >= 24 && needle.includes(body.slice(0, 80));
  });
}

export function lastSentPresetIndex(replies: PagerSavedReply[], outgoingTexts: string[]): number {
  for (let index = replies.length - 1; index >= 0; index -= 1) {
    if (replyWasSent(replies[index]?.text ?? "", outgoingTexts)) {
      return index;
    }
  }
  return -1;
}

function isDecline(language: PresetLanguage, text: string): boolean {
  const folded = foldPresetText(text);
  if (!folded) {
    return false;
  }
  if (language === "es") {
    return /^(no|nop|nel|luego|despues|ahora no|no tengo|no me interesa|no quiero|para|dejalo|basta)\b/.test(
      folded,
    ) || /\b(no me interesa|ninguno|ninguna|no quiero)\b/.test(folded);
  }
  if (language === "en") {
    return (
      /^(no|nope|nah|later|not now|not interested|stop|leave me|dont|don't|pass)\b/.test(folded) ||
      /\b(not interested|none of them|nothing suits|don't want|dont want)\b/.test(folded)
    );
  }
  if (language === "ur") {
    const raw = text.trim();
    return (
      /^(نہیں|نهیں|نا|نہيں|nahi|nahin|no|nope)\b/i.test(raw) ||
      /\b(نہیں|نهیں|دلچسپی نہیں|interested nahi|not interested|chor do|band karo)\b/i.test(raw) ||
      /^(nahi|nahin|na ji)([\s,!.]+.*)?$/i.test(folded)
    );
  }
  return (
    /^(non|nan|pas interesse|pas d'argent|j'ai pas|je n'ai pas|plus tard|pas maintenant|arrete|stop|laisse|la)\b/.test(
      folded,
    ) ||
    /\b(pas interess|non merci|ne (me )?(prefere|veux|aime|interesse) pas|je (ne )?prefere pas|chuis ne|rien (ne )?(me )?(va|convient|interesse)|pas pour moi|aucun montant|aucune option)\b/.test(
      folded,
    )
  );
}

function isBareAgreement(language: PresetLanguage, text: string): boolean {
  const raw = text.trim();
  if (!raw || raw.length > 80 || raw.includes("?")) {
    return false;
  }
  const folded = foldPresetText(raw);
  if (!folded || isDecline(language, folded)) {
    return false;
  }
  if (
    /\b(comment|pourquoi|combien|quel|quelle|cuando|como|por que|why|how)\b/.test(folded) &&
    !/^(oui|ouais|ok|si|dale|claro|yes)\b/.test(folded)
  ) {
    return false;
  }
  // Strong acks only — Darija chatter (cv / mzyan) is soft-early, not deposit/TG fuel.
  if (
    /^(ok|okay|okey|oui|ouais|yes|yep|yeah|si|sí|dale|wakha|wa5a|واخا|تمام|ماشي|دacord|d'accord|safi|صافي|hania|labas|جی|ہاں|हां|haan|han|ji|theek)([\s,!.❤🤞💪👍]+.*)?$/i.test(
      folded,
    ) ||
    /^(جی ہاں|جی هاں|ٹھیک ہے|ठीक ہے)([\s,!.❤🤞💪👍]+.*)?$/i.test(text.trim())
  ) {
    return true;
  }
  // MA Arabic / Darija ready — «أنا مستعد» must advance past intro (was silent for hours).
  if (
    /^(أنا|انا)?\s*(مستعد|جاهز|واجدة?|واجي)([\s,!.❤🤞💪👍]+.*)?$/i.test(raw) ||
    /^(نعم|اييه|أوكي|اوكي|يلا|هيا|زائد|معاك|معااك)([\s,!.❤🤞💪👍]+.*)?$/i.test(raw) ||
    /^(i'?m\s+ready|i am ready|ready|i want( money)?( sir)?|lets? go)([\s,!.❤🤞💪👍]+.*)?$/i.test(
      folded,
    )
  ) {
    return true;
  }
  if (language === "ur") {
    return /^(جی|ہاں|हां|haan|han|ji|ok|okay|yes|theek|thik|bilkul|zaroor|چلیں|چلو)([\s,!.❤🤞💪👍]+.*)?$/i.test(
      folded,
    ) || /^(جی ہاں|ٹھیک|ٹھیک ہے)([\s,!.]+.*)?$/i.test(text.trim());
  }
  const pattern =
    language === "es"
      ? /^(si|ok|okay|okey|dale|va|vale|listo|de acuerdo|claro|bueno|quiero|me interesa|vamos|perfecto|sale|simon|yes|ya)([\s,!.]+.*)?$/
      : language === "en"
        ? /^(yes|yep|yeah|ok|okay|okey|sure|alright|ready|go|continue|interested|i want|show me|tell me|next|fine|good|perfect|lets go|let's go|i'm in|im in)([\s,!.]+.*)?$/
        : /^(oui|ouais|ouai|ok|okay|okey|d'accord|daccord|dac|yes|si|bien sur|parfait|vas-y|vas y|go|ca marche|je suis pret|je suis prete|pret|prete|interesse|je veux|montre|montrez|explique|continue|suivant|allons-y|d'acc|wakha|wa5a|safi|hania)([\s,!.]+.*)?$/;
  return pattern.test(folded);
}

/** Soft continue only for early narrative steps — never for reg/id/deposit/tg. */
function isSoftAdvanceReply(language: PresetLanguage, text: string): boolean {
  const raw = text.trim();
  if (!raw || raw.includes("?") || raw.length > 48) {
    return false;
  }
  if (isBareAgreement(language, raw)) {
    return true;
  }
  if (isDecline(language, raw)) {
    return false;
  }
  const folded = foldPresetText(raw);
  if (!folded) {
    return false;
  }
  if (
    /\b(comment|pourquoi|combien|quel|quelle|cuando|como|por que|why|how|what|quel prix)\b/.test(
      folded,
    )
  ) {
    return false;
  }
  // Darija / thanks / short slang — early funnel only (gated by canSoftAdvanceTo).
  if (
    /^(cv|cava|ca va|mzyan|ah mzyan|bikhir|merci|thanks|thank you|thx|bien|super|salam|ahla|labas|nadi|bip|بخير|مزيان|السلام|آپ|acha|achha|shukriya)([\s,!.❤🤞💪👍]+.*)?$/i.test(
      folded,
    )
  ) {
    return true;
  }
  return folded.length <= 24;
}

/** Customer is registering / registered — advance to ask_id (or next funnel step). */
function isRegistrationProgressReply(language: PresetLanguage, text: string): boolean {
  const raw = (text || "").trim();
  if (!raw || raw.length > 120 || isDecline(language, raw)) {
    return false;
  }
  const folded = foldPresetText(raw);
  if (!folded) {
    return false;
  }
  // MA Darija / FR — «Hta nsawb cont akhor», fini, deja, etc.
  if (
    /\b(nsawb|nsoub|ndir|ghadi|ghang|hta|compte|cont\b|akhor|inscrit|nsjl|nsajel|sajel|darit|dirt|finich|fini|termine|deja|je (vais|suis)|j ai (fini|fait|cree)|cest (fait|bon))\b/.test(
      folded,
    )
  ) {
    return true;
  }
  // PE / ES
  if (
    language === "es" &&
    /\b(ya me registre|me registre|registrad[oa]|listo|hecho|termine|ya esta|ya cree|creo la cuenta|abri|cuenta|ya lo hice|ya hice|estoy listo|voy a registr)\b/.test(
      folded,
    )
  ) {
    return true;
  }
  // PK / Urdu (latin + common)
  if (
    language === "ur" &&
    /\b(register|registered|account ban|account bana|hogaya|ho gaya|done|kar liya|ban gaya)\b/.test(
      folded,
    )
  ) {
    return true;
  }
  return false;
}

function isTableAmountChoice(text: string): boolean {
  const folded = foldPresetText(text);
  if (!folded || folded.length > 40 || text.includes("?")) {
    return false;
  }
  if (/^\d{1,2}$/.test(folded) || /^\d{1,2}\s*ans?$/.test(folded)) {
    return false;
  }
  if (/\b\d{1,2}\s*ans?\b/.test(folded) && !/-|–|—/.test(folded)) {
    return false;
  }
  return /\d/.test(folded);
}

const LATE_KINDS = new Set<PresetKind>([
  "registration",
  "link",
  "promo",
  "ask_id",
  "deposit",
  "telegram",
]);

function canSoftAdvanceTo(kind: PresetKind): boolean {
  return !LATE_KINDS.has(kind);
}

function isNarrativeKind(kind: PresetKind): boolean {
  return kind === "details" || kind === "other";
}

function buildSendBundle(
  replies: PagerSavedReply[],
  startIndex: number,
): { texts: string[]; endIndex: number; kinds: PresetKind[]; table: boolean } {
  const first = replies[startIndex];
  const firstText = (first?.text || "").trim();
  const firstKind = classifyPresetKind(firstText);
  const texts = [firstText];
  const kinds: PresetKind[] = [firstKind];
  let endIndex = startIndex;

  // Pair consecutive "how it works" / narrative parts into one turn.
  if (isNarrativeKind(firstKind) || firstKind === "intro") {
    const second = replies[startIndex + 1];
    const secondText = (second?.text || "").trim();
    if (secondText) {
      const secondKind = classifyPresetKind(secondText);
      if (isNarrativeKind(secondKind) && firstKind !== "intro") {
        texts.push(secondText);
        kinds.push(secondKind);
        endIndex = startIndex + 1;
      } else if (firstKind === "details" && secondKind === "details") {
        texts.push(secondText);
        kinds.push(secondKind);
        endIndex = startIndex + 1;
      }
    }
  }

  // Registration (+ ready) always ships with link + promo in the same turn.
  if (firstKind === "registration" || firstKind === "ready") {
    for (let index = startIndex + 1; index < replies.length && index <= startIndex + 3; index += 1) {
      const text = (replies[index]?.text || "").trim();
      if (!text) {
        break;
      }
      const kind = classifyPresetKind(text);
      if (kind === "link" || kind === "promo" || kind === "registration") {
        texts.push(text);
        kinds.push(kind);
        endIndex = index;
        continue;
      }
      break;
    }
  }

  // Lone link → attach following promo.
  if (firstKind === "link") {
    const next = replies[startIndex + 1];
    const nextText = (next?.text || "").trim();
    if (nextText && classifyPresetKind(nextText) === "promo") {
      texts.push(nextText);
      kinds.push("promo");
      endIndex = startIndex + 1;
    }
  }

  return {
    texts: texts.filter(Boolean),
    endIndex,
    kinds,
    table: kinds.includes("table") || texts.some((text) => isTablePresetText(text)),
  };
}

/**
 * Next saved-reply step for folder markets (MA/MR/…).
 * - Early steps can soft-advance on short replies.
 * - Reg/link/promo go out together; then chat should move to «в процессе».
 * - Deposit / TG / ask ID never soft-advance.
 */
export function planFolderPresetAdvance(
  replies: PagerSavedReply[],
  outgoingTexts: string[],
  customerText: string,
  language: PresetLanguage,
): PresetPlan | null {
  if (!replies.length || !customerText.trim()) {
    return null;
  }
  if (isDecline(language, customerText)) {
    return null;
  }

  const last = lastSentPresetIndex(replies, outgoingTexts);
  const tableIndex = findTablePresetIndex(replies);

  if (last < 0) {
    const first = replies[0];
    if (!first?.text.trim()) {
      return null;
    }
    const firstKind = classifyPresetKind(first.text);
    // Opening intro/details: single message. Registration opener: ship link+promo too.
    if (firstKind === "registration" || firstKind === "ready" || firstKind === "link") {
      const bundle = buildSendBundle(replies, 0);
      return {
        action: "send",
        texts: bundle.texts,
        index: bundle.endIndex,
        role: `preset:${bundle.endIndex + 1}`,
        table: bundle.table,
        moveToInProgress: true,
      };
    }
    return {
      action: "send",
      texts: [first.text.trim()],
      index: 0,
      role: "preset:1",
      table: firstKind === "table",
    };
  }

  const next = last + 1;
  if (next >= replies.length) {
    return { action: "hold", reason: "agreement-after-last-preset" };
  }

  const nextKind = classifyPresetKind(replies[next]?.text ?? "");
  const atOrPastTable = tableIndex >= 0 && last >= tableIndex;
  const tablePick = last === tableIndex && isTableAmountChoice(customerText);
  const strongAck = isBareAgreement(language, customerText) || tablePick;
  const softOk =
    !atOrPastTable &&
    canSoftAdvanceTo(nextKind) &&
    isSoftAdvanceReply(language, customerText);
  // Before the money table: any non-decline reply advances intro/details (Darija chatter).
  const earlyAnyReply =
    !atOrPastTable &&
    canSoftAdvanceTo(nextKind) &&
    !isDecline(language, customerText) &&
    Boolean(customerText.trim()) &&
    !customerText.includes("?");

  // Registration bundle: soft slang OK. Ask-ID: also accept «I'm registering / done».
  // Deposit / TG stay strong-ack only (money / handoff).
  const regBundle = nextKind === "registration" || nextKind === "link" || nextKind === "promo";
  const regProgress = isRegistrationProgressReply(language, customerText);
  const agreed = regBundle
    ? strongAck || isSoftAdvanceReply(language, customerText) || regProgress
    : nextKind === "ask_id"
      ? strongAck || isSoftAdvanceReply(language, customerText) || regProgress
      : LATE_KINDS.has(nextKind)
        ? strongAck
        : strongAck || softOk || earlyAnyReply || regProgress;

  if (!agreed) {
    return null;
  }

  const bundle = buildSendBundle(replies, next);
  if (!bundle.texts.length) {
    return { action: "hold", reason: "empty-next-preset" };
  }

  const moveToInProgress = bundle.kinds.some(
    (kind) => kind === "registration" || kind === "link" || kind === "promo",
  );

  return {
    action: "send",
    texts: bundle.texts,
    index: bundle.endIndex,
    role: `preset:${bundle.endIndex + 1}`,
    table: bundle.table,
    moveToInProgress,
  };
}

/**
 * Force the next unsent preset bundle (AI/vision confirmed positive / proof).
 * Skips agreement gates — caller must have classified the turn.
 */
export function planForcedNextFolderPreset(
  replies: PagerSavedReply[],
  outgoingTexts: string[],
): PresetPlan | null {
  if (!replies.length) {
    return null;
  }
  const last = lastSentPresetIndex(replies, outgoingTexts);
  const next = last + 1;
  if (next >= replies.length) {
    return { action: "hold", reason: "forced-after-last-preset" };
  }
  const bundle = buildSendBundle(replies, next);
  if (!bundle.texts.length) {
    return { action: "hold", reason: "empty-next-preset" };
  }
  const moveToInProgress = bundle.kinds.some(
    (kind) => kind === "registration" || kind === "link" || kind === "promo",
  );
  return {
    action: "send",
    texts: bundle.texts,
    index: bundle.endIndex,
    role: `preset:${bundle.endIndex + 1}`,
    table: bundle.table,
    moveToInProgress,
  };
}

/** Jump to the first unsent preset matching preferred kinds (e.g. deposit after ID proof). */
export function planFolderPresetForKinds(
  replies: PagerSavedReply[],
  outgoingTexts: string[],
  kinds: PresetKind[],
): PresetPlan | null {
  if (!replies.length || !kinds.length) {
    return null;
  }
  const want = new Set(kinds);
  for (let index = 0; index < replies.length; index += 1) {
    const text = (replies[index]?.text || "").trim();
    if (!text) {
      continue;
    }
    const kind = classifyPresetKind(text);
    if (!want.has(kind)) {
      continue;
    }
    if (replyWasSent(text, outgoingTexts)) {
      continue;
    }
    const bundle = buildSendBundle(replies, index);
    if (!bundle.texts.length) {
      continue;
    }
    const moveToInProgress = bundle.kinds.some(
      (item) => item === "registration" || item === "link" || item === "promo",
    );
    return {
      action: "send",
      texts: bundle.texts,
      index: bundle.endIndex,
      role: `preset:${bundle.endIndex + 1}`,
      table: bundle.table,
      moveToInProgress,
    };
  }
  return null;
}
