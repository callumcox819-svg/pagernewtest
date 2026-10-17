import type { AppEnv } from "./env.js";
import type { AppMetaStore } from "./app-meta-store.js";
import type { ChatState, StateStore } from "./state-store.js";

const ACCESS_META_KEY = "bot_access_users";
const ADMIN_META_KEY = "bot_admin_users";
const SEEDED_META_KEY = "bot_access_seeded";

export type BotAccessSnapshot = {
  owners: number[];
  admins: number[];
  allowed: number[];
};

function parseIdList(raw: string | undefined): number[] {
  if (!raw?.trim()) {
    return [];
  }
  const ids = new Set<number>();
  for (const part of raw.split(/[\s,;]+/)) {
    const id = Number(part.trim());
    if (Number.isFinite(id) && id !== 0) {
      ids.add(Math.trunc(id));
    }
  }
  return [...ids];
}

async function readIdSet(store: AppMetaStore, key: string): Promise<Set<number>> {
  const raw = await store.get(key);
  if (!raw?.trim()) {
    return new Set();
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return new Set();
    }
    return new Set(
      parsed
        .map((value) => Number(value))
        .filter((id) => Number.isFinite(id) && id !== 0)
        .map((id) => Math.trunc(id)),
    );
  } catch {
    return new Set(parseIdList(raw));
  }
}

async function writeIdSet(store: AppMetaStore, key: string, ids: Set<number>): Promise<void> {
  const sorted = [...ids].sort((a, b) => a - b);
  await store.set(key, JSON.stringify(sorted));
}

export function envOwnerIds(env: AppEnv): number[] {
  // ADMIN_IDS is the Railway variable already in use — same privilege as BOT_OWNER_IDS.
  return [...new Set([...parseIdList(env.ADMIN_IDS), ...parseIdList(env.BOT_OWNER_IDS)])];
}

export function envAdminIds(env: AppEnv): number[] {
  return parseIdList(env.BOT_ADMIN_IDS);
}

export function envAllowedIds(env: AppEnv): number[] {
  return parseIdList(env.BOT_ALLOWED_IDS);
}

export function isOwner(env: AppEnv, userId: number): boolean {
  return envOwnerIds(env).includes(userId);
}

export async function isAdmin(
  env: AppEnv,
  store: AppMetaStore,
  userId: number,
): Promise<boolean> {
  if (isOwner(env, userId)) {
    return true;
  }
  if (envAdminIds(env).includes(userId)) {
    return true;
  }
  const admins = await readIdSet(store, ADMIN_META_KEY);
  return admins.has(userId);
}

export async function hasBotAccess(
  env: AppEnv,
  store: AppMetaStore,
  userId: number,
): Promise<boolean> {
  if (isOwner(env, userId)) {
    return true;
  }
  if (envAdminIds(env).includes(userId)) {
    return true;
  }
  if (envAllowedIds(env).includes(userId)) {
    return true;
  }
  if (await isAdmin(env, store, userId)) {
    return true;
  }
  const allowed = await readIdSet(store, ACCESS_META_KEY);
  return allowed.has(userId);
}

/** First boot: give access to everyone who already has chat state. */
export async function ensureAccessSeeded(
  env: AppEnv,
  meta: AppMetaStore,
  stateStore: StateStore,
): Promise<void> {
  const seeded = await meta.get(SEEDED_META_KEY);
  if (seeded === "1") {
    return;
  }

  const allowed = await readIdSet(meta, ACCESS_META_KEY);
  for (const id of envOwnerIds(env)) {
    allowed.add(id);
  }
  for (const id of envAdminIds(env)) {
    allowed.add(id);
  }
  for (const id of envAllowedIds(env)) {
    allowed.add(id);
  }

  const states = await stateStore.listAll();
  for (const state of states) {
    if (Number.isFinite(state.chatId) && state.chatId !== 0) {
      allowed.add(Math.trunc(state.chatId));
    }
  }

  await writeIdSet(meta, ACCESS_META_KEY, allowed);
  await meta.set(SEEDED_META_KEY, "1");
  console.log(`Bot access: seeded ${allowed.size} user(s) (existing operators kept)`);
}

export async function grantBotAccess(
  env: AppEnv,
  store: AppMetaStore,
  userId: number,
): Promise<boolean> {
  const id = Math.trunc(userId);
  if (!Number.isFinite(id) || id === 0) {
    return false;
  }
  if (await hasBotAccess(env, store, id)) {
    return true;
  }
  const allowed = await readIdSet(store, ACCESS_META_KEY);
  allowed.add(id);
  await writeIdSet(store, ACCESS_META_KEY, allowed);
  return true;
}

export async function revokeBotAccess(
  env: AppEnv,
  store: AppMetaStore,
  userId: number,
): Promise<{ ok: boolean; reason?: string }> {
  const id = Math.trunc(userId);
  if (!Number.isFinite(id) || id === 0) {
    return { ok: false, reason: "Некорректный ID" };
  }
  if (isOwner(env, id)) {
    return { ok: false, reason: "Нельзя забрать доступ у владельца (ADMIN_IDS / BOT_OWNER_IDS)" };
  }
  if (envAllowedIds(env).includes(id) || envAdminIds(env).includes(id)) {
    return {
      ok: false,
      reason: "ID задан в переменных окружения — убери его из BOT_ALLOWED_IDS / BOT_ADMIN_IDS",
    };
  }
  const allowed = await readIdSet(store, ACCESS_META_KEY);
  const admins = await readIdSet(store, ADMIN_META_KEY);
  allowed.delete(id);
  admins.delete(id);
  await writeIdSet(store, ACCESS_META_KEY, allowed);
  await writeIdSet(store, ADMIN_META_KEY, admins);
  return { ok: true };
}

export async function grantAdminRights(
  env: AppEnv,
  store: AppMetaStore,
  userId: number,
): Promise<{ ok: boolean; reason?: string }> {
  const id = Math.trunc(userId);
  if (!Number.isFinite(id) || id === 0) {
    return { ok: false, reason: "Некорректный ID" };
  }
  if (isOwner(env, id)) {
    return { ok: true };
  }
  await grantBotAccess(env, store, id);
  const admins = await readIdSet(store, ADMIN_META_KEY);
  admins.add(id);
  await writeIdSet(store, ADMIN_META_KEY, admins);
  return { ok: true };
}

export async function revokeAdminRights(
  env: AppEnv,
  store: AppMetaStore,
  userId: number,
): Promise<{ ok: boolean; reason?: string }> {
  const id = Math.trunc(userId);
  if (!Number.isFinite(id) || id === 0) {
    return { ok: false, reason: "Некорректный ID" };
  }
  if (isOwner(env, id)) {
    return { ok: false, reason: "Нельзя снять админку у владельца" };
  }
  if (envAdminIds(env).includes(id)) {
    return { ok: false, reason: "ID задан в BOT_ADMIN_IDS — убери из переменных" };
  }
  const admins = await readIdSet(store, ADMIN_META_KEY);
  admins.delete(id);
  await writeIdSet(store, ADMIN_META_KEY, admins);
  return { ok: true };
}

export async function getAccessSnapshot(
  env: AppEnv,
  store: AppMetaStore,
): Promise<BotAccessSnapshot> {
  const owners = envOwnerIds(env);
  const envAdmins = envAdminIds(env);
  const runtimeAdmins = await readIdSet(store, ADMIN_META_KEY);
  const allowed = await readIdSet(store, ACCESS_META_KEY);
  for (const id of envAllowedIds(env)) {
    allowed.add(id);
  }
  for (const id of owners) {
    allowed.add(id);
  }
  for (const id of envAdmins) {
    allowed.add(id);
  }
  for (const id of runtimeAdmins) {
    allowed.add(id);
  }
  const admins = new Set<number>([...envAdmins, ...runtimeAdmins]);
  for (const id of owners) {
    admins.add(id);
  }
  return {
    owners,
    admins: [...admins].sort((a, b) => a - b),
    allowed: [...allowed].sort((a, b) => a - b),
  };
}

export function parseTelegramUserId(text: string): number | undefined {
  const raw = text.trim().replace(/^@/, "");
  if (!/^-?\d+$/.test(raw)) {
    return undefined;
  }
  const id = Number(raw);
  if (!Number.isFinite(id) || id === 0) {
    return undefined;
  }
  return Math.trunc(id);
}

export function summarizeOperatorForAdmin(state: ChatState | undefined, userId: number): string {
  if (!state) {
    return [
      `👤 Пользователь ${userId}`,
      "Состояние в боте: нет (ещё не писал боту или state удалён).",
      "Доступ можно выдать/забрать отдельно.",
    ].join("\n");
  }

  const channels = Object.entries(state.channels ?? {});
  const enabled = channels.filter(([, row]) => row.enabled);
  const pager = state.pagerAccount;
  const hasPager = Boolean(pager?.cookies?.trim() || (pager?.email && pager?.password));
  const lines = [
    `👤 Пользователь ${userId}`,
    `Pager: ${hasPager ? "✅ подключён" : "❌ нет"}`,
    hasPager
      ? `Орг: ${pager?.organizationName || pager?.organizationSlug || "—"}`
      : undefined,
    `Каналов включено: ${enabled.length} из ${channels.length || 0}`,
    `Пауза: ${state.paused ? "да" : "нет"}`,
  ].filter(Boolean) as string[];

  if (enabled.length) {
    lines.push("", "Включённые каналы:");
    for (const [channelId, row] of enabled.slice(0, 12)) {
      const folders = row.statusFolders ?? [];
      const botOn = folders.filter((folder) => folder.enabled).length;
      const aiOn = folders.filter((folder) => folder.aiEnabled ?? folder.enabled).length;
      const name =
        pager?.liveChannels?.find((channel) => channel.id === channelId)?.name ?? channelId.slice(0, 8);
      lines.push(
        `• ${name} · ${row.country} · банк ${row.templateBank ?? "—"} · папки ${botOn}/${folders.length} · AI ${aiOn}/${folders.length}`,
      );
    }
    if (enabled.length > 12) {
      lines.push(`… ещё ${enabled.length - 12}`);
    }
  }

  return lines.join("\n");
}
