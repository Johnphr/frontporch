// His X login: the ONE place that reads his X tokens (publishing, undo, engagement).
// The tokens are sealed in elderAccounts.secret like Bluesky's app password
// (lib/accountCrypto.ts, key ACCOUNTS_ENC_KEY, bound to elderId + "x"). Decrypted here only,
// in the caller's action. Refreshes when the access token expires within 5 minutes and saves
// the rotated refresh token (xAuth.saveRefreshedTokens, compare-and-swap on the old IV, so
// two runs refreshing at once end up on the same saved token).
// Returns null when he has no usable X login. Never throws on a missing key. Never log what it returns.

import { makeFunctionReference } from "convex/server";
import { AccountKeyError, decryptSecret, encryptSecret, loadAccountKey, type Platform, type SealedSecret } from "./accountCrypto.ts";
import { REFRESH_MARGIN_MS, isRefreshRefused, tokensFromJson, tokensToJson, xAdapter, type FetchFn, type OAuthAdapter, type XTokens } from "./xOAuth.ts";

declare const process: { env: Record<string, string | undefined> };

export type XLogin = { accessToken: string; userId: string; username: string };

export type XAccountForLogin = {
  status: string;
  handle: string | null;
  externalUserId: string | null;
  secret: SealedSecret | null;
  tokenExpiresAt: number | null;
} | null;

export type XLoginCtx = {
  runQuery: (ref: any, args: any) => Promise<any>;
  runMutation: (ref: any, args: any) => Promise<any>;
};

// The AAD platform his X tokens are sealed with.
export const X_PLATFORM: Platform = "x";

const GET_FOR_LOGIN = makeFunctionReference<"query", { elderId: string }, XAccountForLogin>("xAuth:getForLogin");
const SAVE_REFRESHED = makeFunctionReference<
  "mutation",
  { elderId: string; expectedIv: string; secret: SealedSecret; tokenExpiresAt: number },
  { saved: boolean }
>("xAuth:saveRefreshedTokens");
const MARK_INVALID = makeFunctionReference<"mutation", { elderId: string; expectedIv: string; error: string }, null>("xAuth:markInvalid");

export type XLoginOptions = {
  env?: Record<string, string | undefined>;
  fetchFn?: FetchFn;
  now?: () => number;
  adapter?: OAuthAdapter;
};

type Opened = { row: NonNullable<XAccountForLogin> & { secret: SealedSecret }; tokens: XTokens };

async function open(ctx: XLoginCtx, key: CryptoKey, elderId: string): Promise<Opened | null> {
  const row: XAccountForLogin = await ctx.runQuery(GET_FOR_LOGIN, { elderId });
  if (!row || row.status !== "connected" || !row.secret || !row.externalUserId) return null;
  try {
    const tokens = tokensFromJson(await decryptSecret(key, row.secret, elderId, X_PLATFORM));
    return tokens ? { row: row as Opened["row"], tokens } : null;
  } catch {
    console.warn(`xLogin: elder ${elderId} X tokens could not be decrypted`);
    return null;
  }
}

const loginOf = (o: Opened): XLogin => ({ accessToken: o.tokens.accessToken, userId: o.row.externalUserId!, username: o.row.handle ?? "" });
const fresh = (o: Opened, now: number) => (o.row.tokenExpiresAt ?? 0) - now > REFRESH_MARGIN_MS;
const usable = (o: Opened, now: number) => (o.row.tokenExpiresAt ?? 0) > now;

/** His X login (refreshed if needed), or null. */
export async function xLoginForElder(ctx: XLoginCtx, elderId: string, opts: XLoginOptions = {}): Promise<XLogin | null> {
  const env = opts.env ?? process.env;
  const fetchFn = opts.fetchFn ?? (fetch as unknown as FetchFn);
  const now = opts.now ?? Date.now;
  const adapter = opts.adapter ?? xAdapter;

  let key: CryptoKey;
  try {
    key = await loadAccountKey(env.ACCOUNTS_ENC_KEY);
  } catch (error) {
    if (error instanceof AccountKeyError) console.warn("xLogin: ACCOUNTS_ENC_KEY is missing or malformed; X is off");
    return null;
  }

  const first = await open(ctx, key, elderId);
  if (!first) return null;
  if (fresh(first, now())) return loginOf(first);
  if (!first.tokens.refreshToken) return usable(first, now()) ? loginOf(first) : null;

  let refreshed;
  try {
    refreshed = await adapter.refresh(fetchFn, first.tokens);
  } catch (error) {
    // Another run may have refreshed with the same (now used) refresh token: use what it saved.
    const again = await open(ctx, key, elderId);
    if (again && again.row.secret.iv !== first.row.secret.iv && usable(again, now())) return loginOf(again);
    if (isRefreshRefused(error)) {
      await ctx.runMutation(MARK_INVALID, { elderId, expectedIv: first.row.secret.iv, error: "X refused the token refresh; he needs to connect X again." });
      return null;
    }
    console.warn(`xLogin: elder ${elderId} X refresh failed (${error instanceof Error ? error.message : "error"})`);
    return usable(first, now()) ? loginOf(first) : null;
  }

  const tokens: XTokens = { accessToken: refreshed.accessToken, refreshToken: refreshed.refreshToken ?? first.tokens.refreshToken };
  const secret = await encryptSecret(key, tokensToJson(tokens), elderId, X_PLATFORM);
  const { saved } = await ctx.runMutation(SAVE_REFRESHED, { elderId, expectedIv: first.row.secret.iv, secret, tokenExpiresAt: refreshed.expiresAt });
  if (saved) return { accessToken: tokens.accessToken, userId: first.row.externalUserId!, username: first.row.handle ?? "" };
  // Lost the race: another run saved its tokens first. Use those (ours may already be revoked).
  const winner = await open(ctx, key, elderId);
  return winner && usable(winner, now()) ? loginOf(winner) : null;
}
