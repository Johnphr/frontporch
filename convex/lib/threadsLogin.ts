// The ONE place that reads his Threads login (like lib/logins.ts for Bluesky). Publishing,
// undo and engagement call it from their action, passing the action ctx.
//
// Reads oauth:getForLogin, decrypts HERE (in the caller's action, key ACCOUNTS_ENC_KEY), and
// refreshes the token when it expires in under 7 days and is over 24 h old (Meta's rule),
// saving the new one (oauth:updateTokens). A failed refresh keeps the current token while it
// still works. Never throws for a missing key or a bad row: returns null with a warning.
// Never log what this returns. Env: ACCOUNTS_ENC_KEY, THREADS_APP_ID, THREADS_APP_SECRET.

import { makeFunctionReference } from "convex/server";
import { loadAccountKey, type SealedSecret } from "./accountCrypto.ts";
import type { FetchFn } from "./blueskyClient.ts";
import { openTokens, sealTokens } from "./oauthFlow.ts";
import { OAuthHttpError, shouldRefresh, threadsAdapter, type OAuthEnv, type OAuthTokens } from "./oauthPlatforms.ts";

declare const process: { env: Record<string, string | undefined> };

export type ThreadsLogin = { accessToken: string; userId: string; username?: string };

export type ThreadsLoginCtx = {
  runQuery: (ref: any, args: any) => Promise<any>;
  runMutation: (ref: any, args: any) => Promise<any>;
};

type Row = {
  status: string;
  handle: string | null;
  externalUserId: string | null;
  secret: SealedSecret | null;
  tokenExpiresAt: number | null;
} | null;

const GET_FOR_LOGIN = makeFunctionReference<"query", { elderId: string; platform: "threads" }, Row>("oauth:getForLogin");
const UPDATE_TOKENS = makeFunctionReference<"mutation", { elderId: string; platform: "threads"; secret: SealedSecret; tokenExpiresAt: number; now: number }, boolean>("oauth:updateTokens");
const MARK_INVALID = makeFunctionReference<"mutation", { elderId: string; platform: "threads"; error?: string }, null>("oauth:markInvalid");

export type ThreadsLoginOptions = {
  env?: OAuthEnv;
  fetchFn?: FetchFn;
  now?: () => number;
  warn?: (message: string) => void;
};

/** His Threads login, or null when he hasn't connected one (or it can't be used). */
export async function threadsLoginForElder(ctx: ThreadsLoginCtx, elderId: string, opts: ThreadsLoginOptions = {}): Promise<ThreadsLogin | null> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now;
  const warn = opts.warn ?? ((m: string) => console.warn(m));
  const row: Row = await ctx.runQuery(GET_FOR_LOGIN, { elderId, platform: "threads" });
  if (!row || row.status !== "connected" || !row.secret || !row.externalUserId) return null;

  let key: CryptoKey;
  try {
    key = await loadAccountKey(env.ACCOUNTS_ENC_KEY);
  } catch (error) {
    warn(`threadsLogin: ${(error as Error).message}`); // names the env var only
    return null;
  }
  let tokens: OAuthTokens;
  try {
    tokens = await openTokens(key, row.secret, elderId, "threads", row);
  } catch {
    warn(`threadsLogin: elder ${elderId} Threads token could not be decrypted`);
    return null;
  }

  const t = now();
  if (tokens.expiresAt && tokens.expiresAt <= t) {
    warn(`threadsLogin: elder ${elderId} Threads token expired; he needs to reconnect`);
    await ctx.runMutation(MARK_INVALID, { elderId, platform: "threads", error: "Token expired" }).catch(() => null);
    return null;
  }
  if (shouldRefresh(tokens, t)) tokens = await refreshAndSave(ctx, elderId, key, tokens, { env, now, warn, fetchFn: opts.fetchFn ?? (fetch as unknown as FetchFn) });
  return { accessToken: tokens.accessToken, userId: tokens.userId, ...(tokens.username ? { username: tokens.username } : {}) };
}

/** Refresh + save; on any failure keep the current (still valid) token. */
async function refreshAndSave(
  ctx: ThreadsLoginCtx,
  elderId: string,
  key: CryptoKey,
  tokens: OAuthTokens,
  o: { env: OAuthEnv; now: () => number; warn: (m: string) => void; fetchFn: FetchFn },
): Promise<OAuthTokens> {
  const adapter = threadsAdapter(o.env, o.now);
  if (!adapter) {
    o.warn("threadsLogin: THREADS_APP_ID / THREADS_APP_SECRET not set; token not refreshed");
    return tokens;
  }
  try {
    const fresh = await adapter.refresh(o.fetchFn, tokens);
    const secret = await sealTokens(key, fresh, elderId, "threads");
    await ctx.runMutation(UPDATE_TOKENS, { elderId, platform: "threads", secret, tokenExpiresAt: fresh.expiresAt, now: o.now() });
    return fresh;
  } catch (error) {
    o.warn(`threadsLogin: elder ${elderId} refresh failed (${error instanceof OAuthHttpError ? error.message : "error"})`);
    return tokens;
  }
}

/** Meta error code 190 = the token is invalid / expired / revoked. */
export function isThreadsTokenRefused(status: number, code: number | undefined): boolean {
  return code === 190 || status === 401;
}

/** After a Threads call fails with a refused token: mark his account invalid. Returns whether it did. */
export async function reportThreadsLoginError(
  ctx: Pick<ThreadsLoginCtx, "runMutation">,
  elderId: string,
  error: { status: number; code?: number } | unknown,
): Promise<boolean> {
  const e = error as { status?: unknown; code?: unknown } | null;
  if (!e || typeof e.status !== "number") return false;
  if (!isThreadsTokenRefused(e.status, typeof e.code === "number" ? e.code : undefined)) return false;
  await ctx.runMutation(MARK_INVALID, { elderId, platform: "threads", error: `Threads refused the token (HTTP ${e.status})` });
  return true;
}
