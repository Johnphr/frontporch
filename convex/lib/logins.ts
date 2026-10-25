// The ONE place that reads his Bluesky / Reddit login. Thread replies, the Bluesky question
// search, publishing and engagement all go through these, passing their action ctx.
//
// Bluesky: his own account, connected at sign-up (signup.connectBluesky -> elderAccounts).
// Read with ctx.runQuery(accounts:getForLogin) and decrypted HERE, in the caller's action
// (lib/accountCrypto.ts, key ACCOUNTS_ENC_KEY). Queries and mutations never decrypt.
// The env demo account (BLUESKY_HANDLE / BLUESKY_APP_PASSWORD) is used only when
// DEMO_ACCOUNT_FALLBACK=on and he has no connected account, or in pure tests (no ctx, no elder).
// Reddit: per-elder accounts are coming soon (no connect flow yet), so only the env demo
// account, under the same rule, and only when REDDIT_POSTING=on.
// Never log what these return.
//
// Env: ACCOUNTS_ENC_KEY, DEMO_ACCOUNT_FALLBACK, BLUESKY_HANDLE, BLUESKY_APP_PASSWORD,
//      BLUESKY_SERVICE (optional), REDDIT_POSTING, REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET,
//      REDDIT_USERNAME, REDDIT_PASSWORD, REDDIT_USER_AGENT.

import { makeFunctionReference } from "convex/server";
import { decryptSecret, loadAccountKey, type Platform, type SealedSecret } from "./accountCrypto.ts";
import { BlueskyHttpError, blueskyService } from "./blueskyClient.ts";

declare const process: { env: Record<string, string | undefined> };

export type Env = Record<string, string | undefined>;

/** What a login lookup needs from a Convex action ctx (null in pure tests). */
export type LoginCtx = { runQuery: (ref: any, args: any) => Promise<any> } | null;

export type BlueskyLogin = { service: string; identifier: string; password: string };

export type RedditLogin = {
  clientId: string;
  clientSecret: string;
  username: string;
  password: string;
  userAgent: string;
};

/** accounts.getForLogin's result. */
type AccountForLogin = { status: string; handle: string | null; did: string | null; secret: SealedSecret | null } | null;

const GET_FOR_LOGIN = makeFunctionReference<"query", { elderId: string; platform: Platform }, AccountForLogin>("accounts:getForLogin");
const MARK_INVALID = makeFunctionReference<"mutation", { elderId: string; platform: Platform; error?: string }, null>("accounts:markInvalid");

const isOn = (value: string | undefined) => ["on", "true", "1", "yes"].includes((value ?? "").trim().toLowerCase());

/** May we use the env demo account? Only when switched on, or in pure tests with no elder. */
function demoAllowed(ctx: LoginCtx, elderId: string | null, env: Env): boolean {
  return isOn(env.DEMO_ACCOUNT_FALLBACK) || (ctx === null && elderId === null);
}

function envBlueskyLogin(env: Env): BlueskyLogin | null {
  const identifier = env.BLUESKY_HANDLE?.trim();
  const password = env.BLUESKY_APP_PASSWORD;
  if (!identifier || !password) return null;
  return { service: blueskyService(env.BLUESKY_SERVICE), identifier, password };
}

/**
 * His Bluesky login, or null when it isn't set up. His own connected account wins; if he has
 * one but it can't be decrypted we return null (never someone else's account). Throws
 * AccountKeyError if he has an account and ACCOUNTS_ENC_KEY is missing or malformed.
 */
export async function blueskyLoginForElder(ctx: LoginCtx, elderId: string | null, env: Env = process.env): Promise<BlueskyLogin | null> {
  if (ctx && elderId) {
    const row: AccountForLogin = await ctx.runQuery(GET_FOR_LOGIN, { elderId, platform: "bluesky" });
    if (row && row.status === "connected" && row.secret && row.handle) {
      const key = await loadAccountKey(env.ACCOUNTS_ENC_KEY);
      try {
        const password = await decryptSecret(key, row.secret, elderId, "bluesky");
        return { service: blueskyService(env.BLUESKY_SERVICE), identifier: row.handle, password };
      } catch {
        console.warn(`logins: elder ${elderId} Bluesky secret could not be decrypted`);
        return null;
      }
    }
  }
  return demoAllowed(ctx, elderId, env) ? envBlueskyLogin(env) : null;
}

/**
 * His Reddit login, or null when it isn't set up OR posting is switched off (REDDIT_POSTING,
 * off by default while the Reddit API approval is pending).
 * Per-elder Reddit (coming soon): look up his elderAccounts row here once Reddit OAuth exists.
 */
export async function redditLoginForElder(ctx: LoginCtx, elderId: string | null, env: Env = process.env): Promise<RedditLogin | null> {
  if (!isOn(env.REDDIT_POSTING)) return null;
  if (!demoAllowed(ctx, elderId, env)) return null;
  const { REDDIT_CLIENT_ID: clientId, REDDIT_CLIENT_SECRET: clientSecret, REDDIT_USERNAME: username, REDDIT_PASSWORD: password } = env;
  if (!clientId || !clientSecret || !username || !password) return null;
  return { clientId, clientSecret, username, password, userAgent: env.REDDIT_USER_AGENT || `web:frontporch:v1 (by /u/${username})` };
}

/** Bluesky refused the login itself (createSession): his app password was revoked or changed. */
export function isBlueskyLoginRefused(error: unknown): boolean {
  return (
    error instanceof BlueskyHttpError &&
    error.message.startsWith("Bluesky login ") &&
    (error.status === 401 || error.xrpcError === "AuthenticationRequired")
  );
}

/**
 * For callers: after a Bluesky call fails, pass the error here. If Bluesky refused his login,
 * his account is marked invalid (accounts.markInvalid) so we stop trying until he reconnects.
 * Returns whether it did. A no-op for the env demo account (he has no connected row).
 */
export async function reportBlueskyLoginError(
  ctx: { runMutation: (ref: any, args: any) => Promise<any> },
  elderId: string | null,
  error: unknown,
): Promise<boolean> {
  if (!elderId || !isBlueskyLoginRefused(error)) return false;
  await ctx.runMutation(MARK_INVALID, { elderId, platform: "bluesky", error: (error as Error).message });
  return true;
}
