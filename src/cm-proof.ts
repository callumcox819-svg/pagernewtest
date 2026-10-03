import type { ProofKind } from "./config.js";
import { depositSentInHistory, regLinkSentInHistory, gameIdSentInHistory } from "./cm-script-engine.js";

/** 1xBET client login / game IDs (15–19…, historically 17). */
export const CM_CLIENT_LOGIN_ID = /\b((?:15|16|17|18|19)\d{7,10})\b/;
/** @deprecated use CM_CLIENT_LOGIN_ID */
export const CM_CLIENT_LOGIN_17 = CM_CLIENT_LOGIN_ID;

export function extractCmClientLoginId17(text: string): string | undefined {
  const match = (text || "").match(CM_CLIENT_LOGIN_ID);
  return match?.[1];
}

export function isCmRegistrationSuccessProof(text: string): boolean {
  const login = extractCmClientLoginId17(text);
  if (!login) {
    return false;
  }
  return /(inscription\s*r[eé]ussie|registration\s*successful|login\s*:|mot de passe|password|compte\s*cr[eé][eé])/i.test(
    text,
  );
}

export function isCmDepositBalanceProof(text: string, proofKind: ProofKind): boolean {
  if (proofKind === "deposit_balance_screenshot") {
    return true;
  }
  return (
    /(1xbet|xbet|1x\s*bet)/i.test(text) &&
    (/\b\d{2,5}\s*F\b/i.test(text) || /solde|balance|d[eé]p[oô]t|recharge|wallet/i.test(text))
  );
}

export type CmProofScriptAction = "09_deposit" | "08_game_id";

/** After «в процессе регистрации» — auto-send deposit or game-id scripts from screenshots. */
export function resolveCmProofScriptAction(
  proofKind: ProofKind,
  combinedText: string,
  outgoingTexts: string[],
): CmProofScriptAction | undefined {
  const linkSent = regLinkSentInHistory(outgoingTexts);
  const depositScriptSent = depositSentInHistory(outgoingTexts);
  const gameIdSent = gameIdSentInHistory(outgoingTexts);
  const login17 = extractCmClientLoginId17(combinedText);

  if (
    linkSent &&
    !depositScriptSent &&
    (isCmRegistrationSuccessProof(combinedText) ||
      (login17 && proofKind === "registration_screenshot") ||
      (login17 && proofKind === "id_screenshot"))
  ) {
    return "09_deposit";
  }

  if (
    linkSent &&
    depositScriptSent &&
    !gameIdSent &&
    (isCmDepositBalanceProof(combinedText, proofKind) ||
      (login17 && proofKind === "id_screenshot"))
  ) {
    return "08_game_id";
  }

  return undefined;
}
