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
    /(balance|deposit|funded|egp|usd|zar|ksh|kes|fcfa|رصيد|ايداع|إيداع|solde)/i.test(inputText);

  if (hasDepositMarker) {
    return {
      proofKind: "deposit_balance_screenshot",
      combinedText: inputText,
      reason: "Detected balance or deposit markers",
    };
  }

  const hasIdMarker =
    playbook.registrationKeywords.some((keyword) => normalized.includes(normalize(keyword))) ||
    /(id|client|account|uid|رقم|عميل|identifiant|compte)/i.test(inputText);

  const hasLongDigits = /\b\d{5,}\b/.test(inputText);

  if (hasIdMarker && hasLongDigits) {
    return {
      proofKind: "id_screenshot",
      combinedText: inputText,
      reason: "Detected account or client identifier markers",
    };
  }

  if (hasIdMarker || hasLongDigits) {
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
