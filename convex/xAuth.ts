// Connecting his X account (OAuth 2.0 + PKCE). Pure logic: lib/xOAuth.ts; his login: lib/xLogin.ts.
//
//   startConnect({ elderId, returnTo? }) -> { url }   internal; the public signup:startOAuthConnect
//                                  calls it. Saves a single-use state row with a PKCE verifier.
//   xOAuthCallback                 GET /oauth/x/callback (http.ts): consume the state, exchange
//                                  the code, read /users/me, save his tokens encrypted, then
//                                  redirect to SIGNUP_SITE_URL ?connected=x or ?connect_error=<code>
//   getForLogin / saveRefreshedTokens / markInvalid   for lib/xLogin.ts (refresh + rotation)
//
// Tokens are sealed with lib/accountCrypto.ts (ACCOUNTS_ENC_KEY, bound to elderId + "x").
// No tokens, codes or ids in redirects or logs.
// Env: X_CLIENT_ID, X_CLIENT_SECRET, CONVEX_SITE_URL (built in), SIGNUP_SITE_URL, ACCOUNTS_ENC_KEY.

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { httpAction, internalAction, internalMutation, internalQuery } from "./_generated/server";
import { encryptSecret, loadAccountKey } from "./lib/accountCrypto";
import { canSaveRefreshed, X_SAVE_STATUSES } from "./lib/tokenSave";
import { X_PLATFORM, type XAccountForLogin } from "./lib/xLogin";
import {
  checkXState,
  codeChallengeS256,
  makeCodeVerifier,
  randomToken,
  runXCallback,
  tokensToJson,
  xAdapter,
  xRedirectUri,
  type FetchFn,
  type StateError,
} from "./lib/xOAuth";

declare const process: { env: Record<string, string | undefined> };

const HTTP_TIMEOUT_MS = 20_000;
const sealed = v.object({ ciphertext: v.string(), iv: v.string() });

const timedFetch: FetchFn = async (url, init) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};

async function xRow(ctx: { db: any }, elderId: Id<"elders">) {
  return ctx.db
    .query("elderAccounts")
    .withIndex("by_elder_platform", (q: any) => q.eq("elderId", elderId).eq("platform", "x"))
    .unique();
}

// ---------- state ----------

export const createState = internalMutation({
  args: { elderId: v.id("elders"), state: v.string(), codeVerifier: v.string(), returnTo: v.optional(v.string()) },
  handler: async (ctx, { elderId, state, codeVerifier, returnTo }): Promise<null> => {
    if (!(await ctx.db.get(elderId))) throw new Error("Elder not found");
    await ctx.db.insert("oauthStates", { state, elderId, platform: "x", codeVerifier, createdAt: Date.now(), ...(returnTo ? { returnTo } : {}) });
    return null;
  },
});

/** Single use: marks the row used whatever happens next. */
export const consumeState = internalMutation({
  args: { state: v.string() },
  handler: async (
    ctx,
    { state },
  ): Promise<{ ok: true; elderId: Id<"elders">; codeVerifier: string; returnTo?: string } | { ok: false; error: StateError }> => {
    const row = await ctx.db.query("oauthStates").withIndex("by_state", (q) => q.eq("state", state)).unique();
    const now = Date.now();
    const check = checkXState(row, now);
    if (row && row.usedAt === undefined && row.platform === "x") await ctx.db.patch(row._id, { usedAt: now });
    if (!check.ok) return check;
    return { ok: true, elderId: row!.elderId, codeVerifier: row!.codeVerifier!, ...(row!.returnTo ? { returnTo: row!.returnTo } : {}) };
  },
});

// ---------- tokens ----------

export const saveTokens = internalMutation({
  args: {
    elderId: v.id("elders"),
    secret: sealed,
    externalUserId: v.string(),
    handle: v.string(),
    tokenExpiresAt: v.number(),
    scopes: v.array(v.string()),
  },
  handler: async (ctx, a): Promise<null> => {
    if (!(await ctx.db.get(a.elderId))) throw new Error("Elder not found");
    const now = Date.now();
    const fields = {
      secret: a.secret,
      externalUserId: a.externalUserId,
      handle: a.handle,
      tokenExpiresAt: a.tokenExpiresAt,
      scopes: a.scopes,
      status: "connected" as const,
      connectedAt: now,
      lastCheckedAt: now,
      lastError: undefined,
    };
    const existing = await xRow(ctx, a.elderId);
    if (existing) await ctx.db.patch(existing._id, fields);
    else await ctx.db.insert("elderAccounts", { elderId: a.elderId, platform: "x", ...fields });
    return null;
  },
});

/** His X row for lib/xLogin.ts (sealed; decrypted only in the action). */
export const getForLogin = internalQuery({
  args: { elderId: v.id("elders") },
  handler: async (ctx, { elderId }): Promise<XAccountForLogin> => {
    const row = await xRow(ctx, elderId);
    if (!row) return null;
    return {
      status: row.status,
      handle: row.handle ?? null,
      externalUserId: row.externalUserId ?? null,
      secret: row.secret ?? null,
      tokenExpiresAt: row.tokenExpiresAt ?? null,
    };
  },
});

/**
 * Save refreshed tokens only if nobody else did since we read them (same IV). Also over
 * "invalid" with the same IV: a racing run whose refresh lost marks it invalid, but ours worked.
 */
export const saveRefreshedTokens = internalMutation({
  args: { elderId: v.id("elders"), expectedIv: v.string(), secret: sealed, tokenExpiresAt: v.number() },
  handler: async (ctx, { elderId, expectedIv, secret, tokenExpiresAt }): Promise<{ saved: boolean }> => {
    const row = await xRow(ctx, elderId);
    if (!row || !canSaveRefreshed(row, expectedIv, X_SAVE_STATUSES)) return { saved: false };
    await ctx.db.patch(row._id, { secret, tokenExpiresAt, status: "connected", lastCheckedAt: Date.now(), lastError: undefined });
    return { saved: true };
  },
});

/** X refused his refresh token: stop until he connects again (unless the tokens changed meanwhile). */
export const markInvalid = internalMutation({
  args: { elderId: v.id("elders"), expectedIv: v.string(), error: v.string() },
  handler: async (ctx, { elderId, expectedIv, error }): Promise<null> => {
    const row = await xRow(ctx, elderId);
    if (!row || row.secret?.iv !== expectedIv) return null;
    await ctx.db.patch(row._id, { status: "invalid", lastError: error.slice(0, 200), lastCheckedAt: Date.now() });
    return null;
  },
});

// ---------- connect ----------

/** The X authorize URL for him (a new single-use state + PKCE verifier). */
export const startConnect = internalAction({
  args: { elderId: v.id("elders"), returnTo: v.optional(v.string()) },
  handler: async (ctx, { elderId, returnTo }): Promise<{ url: string }> => {
    const redirectUri = xRedirectUri(process.env);
    if (!redirectUri || !process.env.X_CLIENT_ID?.trim() || !process.env.X_CLIENT_SECRET?.trim()) {
      throw new Error("X connect isn't set up (X_CLIENT_ID, X_CLIENT_SECRET).");
    }
    const state = randomToken(32);
    const codeVerifier = makeCodeVerifier();
    await ctx.runMutation(internal.xAuth.createState, { elderId, state, codeVerifier, ...(returnTo ? { returnTo } : {}) });
    return { url: xAdapter.authorizeUrl(state, redirectUri, await codeChallengeS256(codeVerifier)) };
  },
});

/** GET /oauth/x/callback (registered in http.ts). */
export const xOAuthCallback = httpAction(async (ctx, request) => {
  const query = new URL(request.url).searchParams;
  const redirectUri = xRedirectUri(process.env) ?? "";
  const out = await runXCallback(
    {
      siteUrl: process.env.SIGNUP_SITE_URL,
      consumeState: (state) => ctx.runMutation(internal.xAuth.consumeState, { state }),
      exchange: (code, verifier) => xAdapter.exchangeCode(timedFetch, code, redirectUri, verifier),
      save: async (elderId, t) => {
        const key = await loadAccountKey(process.env.ACCOUNTS_ENC_KEY);
        const secret = await encryptSecret(key, tokensToJson(t), elderId, X_PLATFORM);
        await ctx.runMutation(internal.xAuth.saveTokens, {
          elderId: elderId as Id<"elders">,
          secret,
          externalUserId: t.userId,
          handle: t.username,
          tokenExpiresAt: t.expiresAt,
          scopes: t.scopes ?? xAdapter.scopes,
        });
      },
    },
    query,
  );
  if ("redirect" in out) {
    const flag = new URL(out.redirect).searchParams;
    console.log(`xAuth: callback ${flag.get("connected") ? "connected" : `error ${flag.get("connect_error")}`}`);
    return new Response(null, { status: 302, headers: { Location: out.redirect, "Cache-Control": "no-store" } });
  }
  return new Response(out.text, { status: out.status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
});
