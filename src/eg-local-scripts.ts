/** Egypt: outbound text comes from Pager saved replies only (no local .txt / embedded copy). */

export function isEgBareLinkOnlyMessage(text: string): boolean {
  const trimmed = (text || "").trim();
  if (!trimmed) {
    return false;
  }
  if (/^https?:\/\/\S+$/i.test(trimmed)) {
    return true;
  }
  return (
    /tinyurl\.com\//i.test(trimmed) &&
    trimmed.length < 160 &&
    !/[\u0600-\u06FF]/.test(trimmed)
  );
}

/** Block a lone URL when registration text has not gone out yet (caller sends reg first). */
export function shouldBlockEgBareLinkSend(
  replyText: string,
  options: { regAlreadyInHistory: boolean; regSentThisTurn: boolean },
): boolean {
  if (options.regAlreadyInHistory || options.regSentThisTurn) {
    return false;
  }
  return isEgBareLinkOnlyMessage(replyText);
}
