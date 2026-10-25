// OAuth connects (Threads; X keeps its own rows in xAuth.ts but shares reserveConnect): the database side. Internal functions only.
//   reserveConnect  count a "Connect" click (sign-up token, rate limit, locked once active)
//   createState     store the random state (+ PKCE verifier) for the callback
//   consumeState    single use, at most 15 minutes old, same platform (lib/oauthFlow.checkState)
//   saveTokens      after the callback: his encrypted tokens on elderAccounts
//   getForLogin     for lib/threadsLogin.ts only: the row with the ciphertext (decrypted there, in the action)
//   updateTokens    after a refresh
//   markInvalid     the platform refused his token: stop until he reconnects
// Rules: lib/oauthFlow.ts. Nothing here decrypts, returns a plaintext token or logs one.

import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server";
import { shortAccountError } from "./lib/accountConnect";
import { checkState, STATE_CLEANUP_AFTER_MS, type StateError } from "./lib/oauthFlow";
import { connectLocked, connectRateLimit, recordAttempt, sameTokenHash } from "./lib/signupRules";

const platform = v.union(v.literal("threads"), v.literal("x"));
const sealed = v.object({ ciphertext: v.string(), iv: v.string() });

async function accountRow(ctx: QueryCtx | MutationCtx, elderId: Id<"elders">, p: Doc<"elderAccounts">["platform"]) {
  return ctx.db
    .query("elderAccounts")
    .withIndex("by_elder_platform", (q) => q.eq("elderId", elderId).eq("platform", p))
    .unique();
}

/** Same rule as accounts.reserveConnect (that one only takes bluesky / reddit). */
export const reserveConnect = internalMutation({
  args: { elderId: v.id("elders"), tokenHash: v.string(), platform, now: v.number() },
  handler: async (ctx, { elderId, tokenHash, platform: p, now }): Promise<{ ok: true } | { ok: false; error: "not_found" | "locked" | "rate_limited" }> => {
    const elder = await ctx.db.get(elderId);
    if (!elder || !sameTokenHash(elder.signupTokenHash, tokenHash)) return { ok: false, error: "not_found" };
    const row = await accountRow(ctx, elderId, p);
    if (connectLocked(elder.stage, row?.status)) return { ok: false, error: "locked" };
    const times = row?.attemptTimes ?? [];
    if (!connectRateLimit(times, now).ok) return { ok: false, error: "rate_limited" };
    const attemptTimes = recordAttempt(times, now);
    if (row) await ctx.db.patch(row._id, { attemptTimes });
    else await ctx.db.insert("elderAccounts", { elderId, platform: p, status: "disconnected", attemptTimes });
    return { ok: true };
  },
});

export const createState = internalMutation({
  args: { elderId: v.id("elders"), platform, state: v.string(), codeVerifier: v.optional(v.string()), now: v.number() },
  handler: async (ctx, { elderId, platform: p, state, codeVerifier, now }): Promise<null> => {
    await ctx.db.insert("oauthStates", { state, elderId, platform: p, createdAt: now, ...(codeVerifier ? { codeVerifier } : {}) });
    // Tidy a few old rows (oldest first): they can never be used again.
    const old = await ctx.db.query("oauthStates").order("asc").take(20);
    for (const row of old) if (now - row.createdAt > STATE_CLEANUP_AFTER_MS) await ctx.db.delete(row._id);
    return null;
  },
});

export const consumeState = internalMutation({
  args: { state: v.string(), platform, now: v.number() },
  handler: async (
    ctx,
    { state, platform: p, now },
  ): Promise<{ ok: true; elderId: Id<"elders">; codeVerifier?: string } | { ok: false; error: StateError }> => {
    const row = await ctx.db
      .query("oauthStates")
      .withIndex("by_state", (q) => q.eq("state", state))
      .first();
    const check = checkState(row, p, now);
    if (!check.ok) return check;
    await ctx.db.patch(row!._id, { usedAt: now });
    return { ok: true, elderId: row!.elderId, ...(row!.codeVerifier ? { codeVerifier: row!.codeVerifier } : {}) };
  },
});

/** After the callback. `signup: true` keeps the sign-up rule (no changes once he's active). `secret` is already encrypted. */
export const saveTokens = internalMutation({
  args: {
    elderId: v.id("elders"),
    platform,
    handle: v.optional(v.string()),
    externalUserId: v.string(),
    secret: sealed,
    tokenExpiresAt: v.number(),
    scopes: v.array(v.string()),
    now: v.number(),
    signup: v.optional(v.boolean()),
  },
  handler: async (ctx, { elderId, platform: p, handle, externalUserId, secret, tokenExpiresAt, scopes, now, signup }): Promise<{ ok: true } | { ok: false; error: "not_found" | "locked" }> => {
    const elder = await ctx.db.get(elderId);
    if (!elder) return { ok: false, error: "not_found" };
    const row = await accountRow(ctx, elderId, p);
    if (signup && connectLocked(elder.stage, row?.status)) return { ok: false, error: "locked" };
    const fields = {
      handle,
      externalUserId,
      secret,
      tokenExpiresAt,
      scopes,
      status: "connected" as const,
      connectedAt: now,
      lastCheckedAt: now,
      lastError: undefined,
    };
    if (row) await ctx.db.patch(row._id, fields);
    else await ctx.db.insert("elderAccounts", { elderId, platform: p, ...fields });
    return { ok: true };
  },
});

/** For lib/threadsLogin.ts only: his OAuth account with the ciphertext. */
export const getForLogin = internalQuery({
  args: { elderId: v.id("elders"), platform },
  handler: async (ctx, { elderId, platform: p }) => {
    const row = await accountRow(ctx, elderId, p);
    if (!row) return null;
    return {
      status: row.status,
      handle: row.handle ?? null,
      externalUserId: row.externalUserId ?? null,
      secret: row.secret ?? null,
      tokenExpiresAt: row.tokenExpiresAt ?? null,
      scopes: row.scopes ?? [],
    };
  },
});

/** A refreshed token. Only while the row is still connected (a disconnect wins). */
export const updateTokens = internalMutation({
  args: { elderId: v.id("elders"), platform, secret: sealed, tokenExpiresAt: v.number(), now: v.number() },
  handler: async (ctx, { elderId, platform: p, secret, tokenExpiresAt, now }): Promise<boolean> => {
    const row = await accountRow(ctx, elderId, p);
    if (!row || row.status !== "connected") return false;
    await ctx.db.patch(row._id, { secret, tokenExpiresAt, lastCheckedAt: now, lastError: undefined });
    return true;
  },
});

/** The platform refused his token (revoked, expired). Logins stop until he reconnects. */
export const markInvalid = internalMutation({
  args: { elderId: v.id("elders"), platform, error: v.optional(v.string()) },
  handler: async (ctx, { elderId, platform: p, error }): Promise<null> => {
    const row = await accountRow(ctx, elderId, p);
    if (!row || row.status !== "connected") return null;
    await ctx.db.patch(row._id, { status: "invalid", lastCheckedAt: Date.now(), lastError: shortAccountError(error ?? "Token refused") });
    return null;
  },
});

/** Stop using his account and drop the encrypted tokens. */
export const disconnect = internalMutation({
  args: { elderId: v.id("elders"), platform },
  handler: async (ctx, { elderId, platform: p }): Promise<null> => {
    const row = await accountRow(ctx, elderId, p);
    if (!row) return null;
    await ctx.db.patch(row._id, { status: "disconnected", secret: undefined, tokenExpiresAt: undefined, lastError: undefined });
    return null;
  },
});
