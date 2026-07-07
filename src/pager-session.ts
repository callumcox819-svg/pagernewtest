import { ClerkPasswordAuthClient, enrichPagerCookies } from "./clerk-auth.js";
import { PagerClient } from "./pager-client.js";
import type { AppEnv } from "./env.js";
import type { ChatState, StateStore } from "./state-store.js";

export type PagerSessionResult = {
  state: ChatState;
  client: PagerClient;
};

export function resolvePagerOrgSlug(state: ChatState): string | undefined {
  return (
    state.pagerAccount?.organizationSlug ??
    state.pagerAccount?.organizationName?.toLowerCase()
  );
}

export function buildPagerAccountPatch(
  state: ChatState,
  session: {
    organizationId?: string;
    organizationSlug?: string;
    organizationName?: string;
    cookieHeader: string;
    pagerUserId?: string;
  },
): NonNullable<ChatState["pagerAccount"]> {
  const base =
    state.pagerAccount ?? { authMode: "cookies", connectedAt: new Date().toISOString() };
  return {
    ...base,
    cookies: enrichPagerCookies(session.cookieHeader, {
      organizationId: session.organizationId ?? base.organizationId,
      pagerUserId: session.pagerUserId,
    }),
    organizationId: session.organizationId ?? base.organizationId,
    organizationSlug: session.organizationSlug ?? base.organizationSlug,
    organizationName: session.organizationName ?? base.organizationName,
  };
}

export async function ensurePagerSession(
  deps: { env: AppEnv; stateStore: StateStore },
  state: ChatState,
): Promise<PagerSessionResult | null> {
  const account = state.pagerAccount;
  const storedCookies = account?.cookies?.trim();
  if (!storedCookies && !(account?.email && account?.password)) {
    return null;
  }

  if (storedCookies) {
    const client = new PagerClient({
      baseUrl: deps.env.PAGER_BASE_URL,
      cookieHeader: enrichPagerCookies(storedCookies, {
        organizationId: account?.organizationId,
      }),
      orgId: account?.organizationId,
      orgSlug: resolvePagerOrgSlug(state),
      locale: "uk",
    });

    try {
      const session = await client.bootstrapSession();
      const patched = await deps.stateStore.patch(state.chatId, {
        pagerAccount: buildPagerAccountPatch(state, {
          ...session,
          cookieHeader: client.getCookieHeader(),
        }),
      });
      return { state: patched ?? state, client };
    } catch (error) {
      console.warn(
        `Pager cookie session failed for chat ${state.chatId}, trying stored credentials:`,
        formatError(error),
      );
    }
  }

  if (account?.authMode === "credentials" && account.email && account.password) {
    return refreshPagerSessionWithCredentials(deps, state);
  }

  return null;
}

export async function refreshPagerSessionWithCredentials(
  deps: { env: AppEnv; stateStore: StateStore },
  state: ChatState,
): Promise<PagerSessionResult | null> {
  const account = state.pagerAccount;
  if (!account?.email || !account.password) {
    return null;
  }

  const login = await new ClerkPasswordAuthClient({ frontendApi: "clerk.pager.co.ua" }).signInWithPassword(
    account.email,
    account.password,
  );

  const client = new PagerClient({
    baseUrl: deps.env.PAGER_BASE_URL,
    cookieHeader: enrichPagerCookies(login.cookieHeader, {
      organizationId: login.organizationId,
      pagerUserId: login.pagerUserId,
    }),
    orgId: login.organizationId,
    orgSlug: resolvePagerOrgSlug(state),
    locale: "uk",
  });

  const session = await client.validateSession();
  await client.prepareSession();
  const bootstrap = await client.bootstrapSession();

  const patched = await deps.stateStore.patch(state.chatId, {
    pagerAccount: {
      ...account,
      authMode: "credentials",
      cookies: enrichPagerCookies(client.getCookieHeader(), {
        organizationId: bootstrap.organizationId ?? session.organizationId ?? login.organizationId,
        pagerUserId: login.pagerUserId,
      }),
      organizationId: bootstrap.organizationId ?? session.organizationId ?? login.organizationId,
      organizationName: bootstrap.organizationName ?? session.organizationName,
      organizationSlug: bootstrap.organizationSlug ?? session.organizationSlug,
      liveChannels: session.channels.map((channel) => ({
        id: channel.id,
        name: channel.name,
        channelSource: channel.channelSource,
      })),
      liveTemplateBanks: session.templateBanks.map((bank) => ({
        id: bank.id,
        name: bank.name,
        replyCount: bank.replyCount,
      })),
      connectedAt: account.connectedAt,
    },
  });

  console.log(`Pager session auto-refreshed for chat ${state.chatId}`);
  return { state: patched ?? state, client };
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
