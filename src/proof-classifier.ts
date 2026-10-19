import tesseract from "tesseract.js";
import type { PlaybookConfig, CountryCode, ProofKind } from "./config.js";
import {
  extractCmClientLoginId17,
  isCmRegistrationSuccessProof,
  isRegistrationFormInProgress,
  resolveCmProofScriptAction,
  type CmProofScriptAction,
} from "./cm-proof.js";
import {
  isUnfundedWalletScreenshot,
  looksLikeDepositFormInProgress,
  looksLikeMobileMoneySms,
  looksLikePlatformBalance,
  looksLikeSiteLoadingStuck,
  readFunnelScreenshot,
} from "./funnel-screenshot.js";

const { recognize } = tesseract;

export type ProofClassification = {
  proofKind: ProofKind;
  combinedText: string;
  reason: string;
};

export async function classifyProofFromImage(
  playbook: PlaybookConfig,
  image: Buffer,
  options?: {
    caption?: string;
    ocrEnabled?: boolean;
    ocrLang?: string;
    country?: CountryCode;
  },
): Promise<ProofClassification> {
  const ocrText =
    options?.ocrEnabled === false
      ? ""
      : (
          await recognize(image, options?.ocrLang ?? "eng", {
            logger: () => undefined,
          })
        ).data.text;

  return classifyProofFromText(playbook, [options?.caption ?? "", ocrText].join("\n"), options?.country);
}

export function classifyProofFromText(
  playbook: PlaybookConfig,
  inputText: string,
  country?: CountryCode,
): ProofClassification {
  const normalized = normalize(inputText);

  if (!normalized) {
    return {
      proofKind: "unclear_screenshot",
      combinedText: inputText,
      reason: "No OCR or caption text available",
    };
  }

  const hasRegistrationUiMarker =
    playbook.registrationKeywords.some((keyword) => normalized.includes(normalize(keyword))) ||
    /(inscription|1xbet|xbet|melbet|betwinner|paris sportifs|cr[eé]er un compte|cree un compte|t[eé]l[eé]charger|telecharger|installer|apk|promo|code promo|limite d.?age|phone number|num[eé]ro de t[eé]l[eé]phone|cameroun|cash056|eg011|egypt0011)/i.test(
      inputText,
    ) ||
    /(تسجيل|حساب|انشاء|إنشاء|1xbet|xbet|تحميل|تطبيق|رابط|promo|كود)/i.test(inputText);

  const hasIdMarker =
    hasRegistrationUiMarker ||
    /(id|client|account|uid|رقم|عميل|identifiant|compte|joueur|player|profil|profile|mon compte)/i.test(
      inputText,
    );

  const hasLongDigits = /\b\d{5,}\b/.test(inputText);
  const login17 = country === "CM" ? extractCmClientLoginId17(inputText) : undefined;
  const hasClientGameId =
    country === "CM"
      ? Boolean(login17)
      : /\b((?:15|16|17|18|19)\d{7,10})\b/.test(inputText);

  const scene = readFunnelScreenshot(inputText);
  if (scene.scene === "mobile_money_sms" || looksLikeMobileMoneySms(inputText)) {
    return {
      proofKind: "unclear_screenshot",
      combinedText: inputText,
      reason: "Mobile-money SMS receipt — need 1xBET balance screenshot",
    };
  }
  if (scene.scene === "wrong_betting_brand") {
    return {
      proofKind: "unclear_screenshot",
      combinedText: inputText,
      reason: scene.reason || "Wrong bookmaker (not 1xBET) — redirect to our link+promo",
    };
  }
  if (scene.scene === "site_loading_stuck" || looksLikeSiteLoadingStuck(inputText)) {
    return {
      proofKind: "unclear_screenshot",
      combinedText: inputText,
      reason: "Site/registration UI stuck loading — help reopen same link",
    };
  }

  // Open Dépôt / Confirmer / MVola screen — progress, not funded balance.
  if (scene.scene === "deposit_form" || looksLikeDepositFormInProgress(inputText)) {
    return {
      proofKind: "unclear_screenshot",
      combinedText: inputText,
      reason: "Deposit form in progress (Dépôt/Confirmer) — wait for balance after confirm",
    };
  }

  // Still filling the INSCRIPTION form — not proof of a finished account.
  if (isRegistrationFormInProgress(inputText) || scene.scene === "registration_form") {
    return {
      proofKind: "unclear_screenshot",
      combinedText: inputText,
      reason: "Registration form in progress (INSCRIPTION), not completed account",
    };
  }

  // 0 MGA / empty wallet — never «deposit done».
  if (isUnfundedWalletScreenshot(inputText)) {
    return {
      proofKind:
        scene.accountId || scene.scene === "account_id_ready"
          ? "id_screenshot"
          : "unclear_screenshot",
      combinedText: inputText,
      reason: "Wallet balance is 0 — first deposit not done",
    };
  }

  if (scene.scene === "platform_balance" || looksLikePlatformBalance(inputText)) {
    return {
      proofKind: "deposit_balance_screenshot",
      combinedText: inputText,
      reason: scene.reason || "1xBET funded balance visible",
    };
  }

  if (scene.scene === "account_id_ready" && scene.accountId) {
    return {
      proofKind: "id_screenshot",
      combinedText: inputText,
      reason: scene.reason,
    };
  }

  if (country === "CM" && login17 && isCmRegistrationSuccessProof(inputText)) {
    return {
      proofKind: "registration_screenshot",
      combinedText: inputText,
      reason: `CM inscription réussie login ${login17}`,
    };
  }

  if (
    country === "CM" &&
    login17 &&
    /inscription\s*r[eé]ussie|r[eé]ussie|successful|login\s*:/i.test(inputText)
  ) {
    return {
      proofKind: "registration_screenshot",
      combinedText: inputText,
      reason: `CM registration login ${login17}`,
    };
  }

  if (hasClientGameId && (hasIdMarker || hasLongDigits) && country !== "CM") {
    return {
      proofKind: "id_screenshot",
      combinedText: inputText,
      reason: "Detected ZM game/account id starting with 16/17",
    };
  }

  if (hasClientGameId && (hasIdMarker || hasLongDigits) && country === "CM" && login17) {
    return {
      proofKind: "id_screenshot",
      combinedText: inputText,
      reason: `CM client login id ${login17}`,
    };
  }

  // «Faire un dépôt» on an empty profile is NOT funded proof.
  const hasDepositMarker =
    !looksLikeDepositFormInProgress(inputText) &&
    !isUnfundedWalletScreenshot(inputText) &&
    looksLikePlatformBalance(inputText);

  if (hasDepositMarker) {
    return {
      proofKind: "deposit_balance_screenshot",
      combinedText: inputText,
      reason: "Detected funded 1xBET balance",
    };
  }

  if (hasIdMarker && hasLongDigits) {
    return {
      proofKind: "id_screenshot",
      combinedText: inputText,
      reason: "Detected account or client identifier markers",
    };
  }

  // Bare «inscription» UI without login success ≠ completed registration proof.
  if (hasRegistrationUiMarker && !login17 && country === "CM") {
    return {
      proofKind: "unclear_screenshot",
      combinedText: inputText,
      reason: "Registration UI without completed login id",
    };
  }

  if (hasIdMarker || hasLongDigits || hasRegistrationUiMarker) {
    return {
      proofKind: "registration_screenshot",
      combinedText: inputText,
      reason: "Detected registration-like account details",
    };
  }

  return {
    proofKind: "unclear_screenshot",
    combinedText: inputText,
    reason: "Could not confidently classify screenshot",
  };
}

/** Re-classify OCR/AI text and pick CM deposit or game-id script (Login IDs starting with 17 only). */
export function resolveCmProofScriptFromCombinedText(
  playbook: PlaybookConfig,
  combinedText: string,
  outgoingTexts: string[],
): CmProofScriptAction | undefined {
  const classification = classifyProofFromText(playbook, combinedText, "CM");
  return resolveCmProofScriptAction(
    classification.proofKind,
    classification.combinedText,
    outgoingTexts,
  );
}

function normalize(value?: string): string {
  return value?.toLowerCase().trim() ?? "";
}
