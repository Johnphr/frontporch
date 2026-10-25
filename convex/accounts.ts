// His own social accounts (elderAccounts table). Internal functions only: sign-up connects one
// through signup.connectBluesky, and lib/logins.ts reads it back for posting.
//
// The app password is stored AES-GCM encrypted (lib/accountCrypto.ts) and is only decrypted in
// actions (lib/logins.ts). Nothing here decrypts, returns a plaintext secret, or logs one.
// `getForLogin` is the one function that returns the ciphertext; only lib/logins.ts calls it.
// Reddit: no per-elder connect yet (coming soon); rows for it can't be created from sign-up.
// Threads and X rows are written by oauth.ts / xAuth.ts (OAuth connect); `status` lists them too.

import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server";
import { shortAccountError } from "./lib/accountConnect";
import {
  GLOBAL_CONNECTS_PER_HOUR,
  HANDLE_CONNECTS_PER_HOUR,
  connectCaps,
  connectRateLimit,
  recordAttempt,
  sameTokenHash,
} from "./lib/signupRules";

const platform = v.union(v.literal("bluesky"), v.literal("reddit"));
const sealed = v.object({ ciphertext: v.string(), iv: v.string() });

async function accountRow(ctx: QueryCtx | MutationCtx, elderId: Id<"elders">, p: Doc<"elderAccounts">["platform"]) {
  return ctx.db
    .query("elderAccounts")
    .withIndex("by_elder_platform", (q) => q.eq("elderId", elderId).eq("platform", p))
    .unique();
}

/** For lib/logins.ts only: his account with the ciphertext (decrypted there, in the action). */
export const getForLogin = internalQuery({
  args: { elderId: v.id("elders"), platform },
  handler: async (ctx, { elderId, platform: p }) => {
    const row = await accountRow(ctx, elderId, p);
    if (!row) return null;
    return {
      status: row.status,
      handle: row.handle ?? null,
      did: row.did ?? null,
      secret: row.secret ?? null,
      connectedAt: row.connectedAt ?? null, // lib/logins.ts: ever connected -> never the demo account
    };
  },
});

/** What's connected for him (every platform: Bluesky, Reddit, Threads, X), with no secret or token. */
export const status = internalQuery({
  args: { elderId: v.id("elders") },
  handler: async (ctx, { elderId }) => {
    const rows = await ctx.db
      .query("elderAccounts")
      .withIndex("by_elder_platform", (q) => q.eq("elderId", elderId))
      .collect();
    return rows.map((r) => ({
      platform: r.platform,
      handle: r.handle ?? null,
      status: r.status,
      connectedAt: r.connectedAt ?? null,
    }));
  },
});

async function attemptRow(ctx: MutationCtx, key: string) {
  return ctx.db
    .query("connectAttempts")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique();
}

/** Add `now` to one connectAttempts row (created if missing). */
async function recordCap(ctx: MutationCtx, key: string, row: Doc<"connectAttempts"> | null, now: number, max: number) {
  const times = recordAttempt(row?.times ?? [], now, max);
  if (row) await ctx.db.patch(row._id, { times });
  else await ctx.db.insert("connectAttempts", { key, times });
}

/**
 * Sign-up: count one connect attempt. Refuses an unknown elder or a wrong sign-up token (hash), an active one (his accounts are
 * locked once he's active, like setLinkedin), and too many tries: his own (lib/signupRules.connectRateLimit), then per handle
 * and in all (connectCaps), so new sign-ups can't be used to guess a handle's password through us. `handle` is normalized.
 * A refused attempt isn't counted.
 */
export const reserveConnect = internalMutation({
  args: { elderId: v.id("elders"), tokenHash: v.string(), platform, handle: v.string(), now: v.number() },
  handler: async (
    ctx,
    { elderId, tokenHash, platform: p, handle, now },
  ): Promise<{ ok: true } | { ok: false; error: "not_found" | "locked" | "rate_limited" | "busy" }> => {
    const elder = await ctx.db.get(elderId);
    if (!elder || !sameTokenHash(elder.signupTokenHash, tokenHash)) return { ok: false, error: "not_found" };
    if (elder.stage === "active") return { ok: false, error: "locked" };
    const row = await accountRow(ctx, elderId, p);
    const times = row?.attemptTimes ?? [];
    if (!connectRateLimit(times, now).ok) return { ok: false, error: "rate_limited" };
    const handleKey = `${p}:${handle.toLowerCase()}`;
    const handleRow = await attemptRow(ctx, handleKey);
    const globalRow = await attemptRow(ctx, "global");
    const caps = connectCaps({ handle: handleRow?.times ?? [], global: globalRow?.times ?? [] }, now);
    if (!caps.ok) return caps;

    const attemptTimes = recordAttempt(times, now);
    if (row) await ctx.db.patch(row._id, { attemptTimes });
    else await ctx.db.insert("elderAccounts", { elderId, platform: p, status: "disconnected", attemptTimes });
    await recordCap(ctx, handleKey, handleRow, now, HANDLE_CONNECTS_PER_HOUR);
    await recordCap(ctx, "global", globalRow, now, GLOBAL_CONNECTS_PER_HOUR);
    return { ok: true };
  },
});

/**
 * Save or update his account after the login was verified. `signup: true` keeps the sign-up
 * rule (no changes once he's active). `secret` is already encrypted.
 */
export const saveAccount = internalMutation({
  args: {
    elderId: v.id("elders"),
    platform,
    handle: v.string(),
    did: v.optional(v.string()),
    secret: sealed,
    now: v.number(),
    signup: v.optional(v.boolean()),
  },
  handler: async (ctx, { elderId, platform: p, handle, did, secret, now, signup }): Promise<{ ok: true } | { ok: false; error: "not_found" | "locked" }> => {
    const elder = await ctx.db.get(elderId);
    if (!elder) return { ok: false, error: "not_found" };
    if (signup && elder.stage === "active") return { ok: false, error: "locked" };
    const fields = { handle, did, secret, status: "connected" as const, connectedAt: now, lastCheckedAt: now, lastError: undefined };
    const row = await accountRow(ctx, elderId, p);
    if (row) await ctx.db.patch(row._id, fields);
    else await ctx.db.insert("elderAccounts", { elderId, platform: p, ...fields });
    return { ok: true };
  },
});

/** The platform refused his saved login (e.g. Bluesky: app password revoked). Logins stop until he reconnects. */
export const markInvalid = internalMutation({
  args: { elderId: v.id("elders"), platform, error: v.optional(v.string()) },
  handler: async (ctx, { elderId, platform: p, error }): Promise<null> => {
    const row = await accountRow(ctx, elderId, p);
    if (!row || row.status !== "connected") return null;
    await ctx.db.patch(row._id, {
      status: "invalid",
      lastCheckedAt: Date.now(),
      lastError: shortAccountError(error ?? "Login refused"),
    });
    return null;
  },
});

/** Stop using his account and drop the encrypted secret. */
export const disconnect = internalMutation({
  args: { elderId: v.id("elders"), platform },
  handler: async (ctx, { elderId, platform: p }): Promise<null> => {
    const row = await accountRow(ctx, elderId, p);
    if (!row) return null;
    await ctx.db.patch(row._id, { status: "disconnected", secret: undefined, lastError: undefined });
    return null;
  },
});
