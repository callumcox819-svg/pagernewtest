import tesseract from "tesseract.js";
import type { PlaybookConfig, ProofKind } from "./config.js";

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

  return classifyProofFromText(playbook, [options?.caption ?? "", ocrText].join("\n"));
}

export function classifyProofFromText(
  playbook: PlaybookConfig,
  inputText: string,
): ProofClassification {
  const normalized = normalize(inputText);

  if (!normalized) {
    return {
      proofKind: "unclear_screenshot",
      combinedText: inputText,
      reason: "No OCR or caption text available",
    };
  }

  const hasDepositMarker =
    playbook.depositKeywords.some((keyword) => normalized.includes(normalize(keyword))) ||
    /(balance|deposit|funded|egp|usd|zar|ksh|kes|fcfa|رصيد|ايداع|إيداع|solde|recharger|retrait)/i.test(
      inputText,
    );

  if (hasDepositMarker) {
    return {
      proofKind: "deposit_balance_screenshot",
      combinedText: inputText,
      reason: "Detected balance or deposit markers",
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

  if (hasIdMarker && hasLongDigits) {
    return {
      proofKind: "id_screenshot",
      combinedText: inputText,
      reason: "Detected account or client identifier markers",
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

function normalize(value?: string): string {
  return value?.toLowerCase().trim() ?? "";
}
