import type { BotConfig, TemplateRole } from "./config.js";
import { getTemplateBank } from "./config.js";
import type { PagerClient, PagerSavedReply } from "./pager-client.js";

const replyCache = new Map<string, PagerSavedReply[]>();

export async function resolveTemplateText(
  config: BotConfig,
  client: PagerClient,
  options: {
    folderId?: string;
    yamlBankName: string;
    role: TemplateRole;
  },
): Promise<string | undefined> {
  const yamlBank = getTemplateBank(config, options.yamlBankName);
  const yamlText = yamlBank.roles[options.role];
  if (!options.folderId) {
    return yamlText;
  }

  const replies = await loadFolderReplies(client, options.folderId);
  if (!replies.length) {
    return yamlText;
  }

  const fromPager = matchReplyByNeedle(replies, yamlText);
  return fromPager?.text ?? yamlText;
}

async function loadFolderReplies(client: PagerClient, folderId: string): Promise<PagerSavedReply[]> {
  const cached = replyCache.get(folderId);
  if (cached) {
    return cached;
  }

  const replies = await client.getSavedReplies(folderId);
  replyCache.set(folderId, replies);
  return replies;
}

function matchReplyByNeedle(
  replies: PagerSavedReply[],
  yamlText: string,
): PagerSavedReply | undefined {
  const needle = normalizeNeedle(yamlText);
  if (!needle) {
    return replies[0];
  }

  const matched = replies.find((reply) => {
    const body = normalizeNeedle(reply.text);
    return body.includes(needle) || needle.includes(body.slice(0, 40));
  });
  return matched ?? replies[0];
}

function normalizeNeedle(value: string): string {
  return value.trim().toLowerCase().slice(0, 40);
}

export function clearTemplateReplyCache(): void {
  replyCache.clear();
}
