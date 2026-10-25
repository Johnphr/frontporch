// Sign-up page API (public): sign up -> choose a character -> connect Bluesky (optional) -> first call -> its status.
// These are the only public functions: anyone with the deployment URL can call them, so they
// return only ids, tokens, characters and ok/reason results (never elder rows or transcripts),
// and validate every argument. Rules live in lib/signupRules.ts (unit-tested).
//
// Sign-up token: `register` creates his row and returns a random token (only its SHA-256 hash is
// stored). Every later step (setCharacter, connectBluesky, setLinkedin, requestCall) needs it, so
// knowing a phone number or an elderId isn't enough to change a sign-up. An existing number gets
// no token (and no elderId): re-issuing one would hand it to anyone who types his number.
//
// Remaining risk: the SMS check is fake for now, so anyone can sign up a NEW number and make it
// ring (onboarding only, at most CALLS_PER_DAY a day, 10 min apart; no global cap). That's why
// `requestCall` is off by default: PUBLIC_CALLS=on rings only CALL_ALLOWLIST numbers,
// PUBLIC_CALLS=all rings anyone (lib/signupRules.publicCallAllowed). LinkedIn and Bluesky are
// locked once he's active.

import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { action, internalMutation, internalQuery, query } from "./_generated/server";
import { callState, retryOffer, type CallState } from "./lib/callStatus";
import { getCharacter, publicCharacters, type Character } from "./lib/characters";
import { connectBlueskyAccount, type ConnectResult } from "./lib/accountConnect";
import type { FetchFn } from "./lib/blueskyClient";
import { planNextCall } from "./lib/onboarding";
import {
  CALLS_PER_DAY,
  callRateLimit,
  canonicalLinkedInProfileUrl,
  newElderFields,
  newSignupToken,
  normalizeName,
  normalizePhone,
  publicCallAllowed,
  sameTokenHash,
  signupTokenHash,
} from "./lib/signupRules";
import { asElderV2 } from "./lib/v2Fields";

// Convex exposes env vars on process.env (declared so we don't need @types/node).
declare const process: { env: Record<string, string | undefined> };

type CallRequest =
  | { ok: true; callId: Id<"calls"> }
  | { ok: false; reason: "disabled" | "rate_limited" | "already_onboarded" | "failed"; message: string; callId?: Id<"calls"> };

type Registration = { ok: true; elderId: Id<"elders">; token: string } | { ok: false; reason: "already_signed_up" };

const DISABLED = "Calls from the sign-up page are turned off for now.";
const FAILED = "We couldn't start the call. Please try again later.";
const NOT_FOUND = "Sign-up not found.";
const language = v.union(v.literal("en"), v.literal("es"));

export const listCharacters = query({
  args: {},
  handler: async (): Promise<Character[]> => publicCharacters(),
});

/**
 * New elder in onboarding -> { elderId, token }. A known phone -> already_signed_up (his row
 * isn't touched and no id or token is given out). An action so the token comes from real
 * randomness. `timeZone` is the browser's (checked; else from the phone's country).
 * Known, accepted leak: already_signed_up tells anyone whether a number is signed up. Hiding
 * it would mean telling a real person "done" when nothing happened; nothing else is revealed.
 */
export const register = action({
  args: { name: v.string(), phone: v.string(), language, timeZone: v.optional(v.string()) },
  handler: async (ctx, args): Promise<Registration> => {
    const name = normalizeName(args.name);
    if (!name) throw new ConvexError("Please enter your name (up to 100 characters).");
    const phone = normalizePhone(args.phone);
    if (!phone) throw new ConvexError("Please enter a phone number with country code, e.g. +14155550123.");
    const token = newSignupToken();
    const tokenHash = await signupTokenHash(token);
    if (!tokenHash) throw new Error("signup token malformed"); // can't happen
    const elderId: Id<"elders"> | null = await ctx.runMutation(internal.signup.createElder, {
      name,
      phone,
      language: args.language,
      ...(args.timeZone ? { timeZone: args.timeZone.slice(0, 100) } : {}),
      tokenHash,
      now: Date.now(),
    });
    return elderId ? { ok: true, elderId, token } : { ok: false, reason: "already_signed_up" };
  },
});

/** For register: insert his row, or null if the phone is already signed up (nothing changes). */
export const createElder = internalMutation({
  args: { name: v.string(), phone: v.string(), language, timeZone: v.optional(v.string()), tokenHash: v.string(), now: v.number() },
  handler: async (ctx, { tokenHash, now, ...input }): Promise<Id<"elders"> | null> => {
    const existing = await ctx.db
      .query("elders")
      .withIndex("by_phone", (q) => q.eq("phone", input.phone))
      .unique();
    if (existing) return null;
    return await ctx.db.insert("elders", newElderFields(input, now, tokenHash));
  },
});

// setCharacter / setLinkedin are actions: the token is hashed here (Web Crypto), then an
// internal mutation checks the hash, like reserveConnect / callCheck.

type Saved = { ok: true } | { ok: false; error: "not_found" | "locked" };

export const setCharacter = action({
  args: { elderId: v.id("elders"), token: v.string(), characterId: v.string() },
  handler: async (ctx, { elderId, token, characterId }): Promise<null> => {
    if (!getCharacter(characterId)) throw new ConvexError("Unknown character.");
    const tokenHash = (await signupTokenHash(token)) ?? "";
    const saved: Saved = await ctx.runMutation(internal.signup.saveCharacter, { elderId, tokenHash, characterId });
    if (!saved.ok) throw new ConvexError(NOT_FOUND);
    return null;
  },
});

/** For setCharacter: check the token hash, then save his character. */
export const saveCharacter = internalMutation({
  args: { elderId: v.id("elders"), tokenHash: v.string(), characterId: v.string() },
  handler: async (ctx, { elderId, tokenHash, characterId }): Promise<Saved> => {
    const elder = await ctx.db.get(elderId);
    if (!elder || !sameTokenHash(elder.signupTokenHash, tokenHash)) return { ok: false, error: "not_found" };
    await ctx.db.patch(elderId, { characterId });
    return { ok: true };
  },
});

/** Retired from the website (it connects Bluesky now); kept for old clients and scripts. */
export const setLinkedin = action({
  args: { elderId: v.id("elders"), token: v.string(), url: v.string() },
  handler: async (ctx, { elderId, token, url }): Promise<null> => {
    const linkedinUrl = canonicalLinkedInProfileUrl(url);
    if (!linkedinUrl) throw new ConvexError("Please enter a LinkedIn profile link, e.g. linkedin.com/in/your-name.");
    const tokenHash = (await signupTokenHash(token)) ?? "";
    const saved: Saved = await ctx.runMutation(internal.signup.saveLinkedin, { elderId, tokenHash, linkedinUrl });
    if (!saved.ok) throw new ConvexError(saved.error === "locked" ? "Your LinkedIn is already set up." : NOT_FOUND);
    return null;
  },
});

/** For setLinkedin: check the token hash, then save the (already canonical) profile URL. */
export const saveLinkedin = internalMutation({
  args: { elderId: v.id("elders"), tokenHash: v.string(), linkedinUrl: v.string() },
  handler: async (ctx, { elderId, tokenHash, linkedinUrl }): Promise<Saved> => {
    const elder = await ctx.db.get(elderId);
    if (!elder || !sameTokenHash(elder.signupTokenHash, tokenHash)) return { ok: false, error: "not_found" };
    if (elder.stage === "active") return { ok: false, error: "locked" };
    if (elder.linkedinUrl === linkedinUrl) return { ok: true };
    // A cached background came from the old profile: drop it so onboarding scrapes the new one.
    await ctx.db.patch(elderId, { linkedinUrl, knownBackground: undefined });
    return { ok: true };
  },
});

const timedFetch: FetchFn = async (url, init) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Connect his own Bluesky account (needs his sign-up token): handle + an app password (never his real password: an app
 * password can't change his password or delete his account, and he can revoke it any time). Logs in once to check it,
 * then saves it encrypted (convex/accounts.ts). Rate limited (his tries, per handle, and in all), and locked once he's active.
 * Returns { ok, handle } or { ok: false, error: code }; never echoes the password.
 */
export const connectBluesky = action({
  args: { elderId: v.id("elders"), token: v.string(), handle: v.string(), appPassword: v.string() },
  handler: async (ctx, { elderId, token, handle, appPassword }): Promise<ConnectResult> => {
    const now = Date.now();
    const tokenHash = (await signupTokenHash(token)) ?? "";
    return connectBlueskyAccount(
      {
        fetchFn: timedFetch,
        env: process.env,
        reserve: (h) => ctx.runMutation(internal.accounts.reserveConnect, { elderId, tokenHash, platform: "bluesky", handle: h, now }),
        save: ({ handle: h, did, secret }) =>
          ctx.runMutation(internal.accounts.saveAccount, { elderId, platform: "bluesky", handle: h, did, secret, now, signup: true }),
        warn: (message) => console.warn(message),
      },
      elderId,
      { handle, appPassword },
    );
  },
});

/** For requestCall: is his next call onboarding, and when were his latest calls created. */
export const callCheck = internalQuery({
  args: { elderId: v.id("elders"), tokenHash: v.string() },
  handler: async (
    ctx,
    { elderId, tokenHash },
  ): Promise<{ phone: string; onboarding: boolean; callTimes: number[] } | null> => {
    const row = await ctx.db.get(elderId);
    const elder = asElderV2(row);
    if (!row || !elder || !sameTokenHash(row.signupTokenHash, tokenHash)) return null;
    const recent = await ctx.db
      .query("calls")
      .withIndex("by_elder", (q) => q.eq("elderId", elderId))
      .order("desc")
      .take(CALLS_PER_DAY); // the newest few decide both limits
    return {
      phone: row.phone,
      onboarding: planNextCall(elder).kind === "onboarding",
      callTimes: recent.map((c) => c._creationTime),
    };
  },
});

/**
 * Ring him for his onboarding call (needs his sign-up token). Gated by PUBLIC_CALLS (+ CALL_ALLOWLIST), then the rate limit; startCall's
 * reserveCall still refuses a second open call, so two requests at once can't both ring.
 */
export const requestCall = action({
  args: { elderId: v.id("elders"), token: v.string() },
  handler: async (ctx, { elderId, token }): Promise<CallRequest> => {
    const mode = process.env.PUBLIC_CALLS;
    if (mode !== "on" && mode !== "all") return { ok: false, reason: "disabled", message: DISABLED };
    const check = await ctx.runQuery(internal.signup.callCheck, { elderId, tokenHash: (await signupTokenHash(token)) ?? "" });
    if (!check) return { ok: false, reason: "failed", message: NOT_FOUND };
    if (!publicCallAllowed(mode, process.env.CALL_ALLOWLIST, check.phone)) {
      return { ok: false, reason: "disabled", message: DISABLED };
    }
    if (!check.onboarding) {
      return { ok: false, reason: "already_onboarded", message: "Your first call is done." };
    }
    const limit = callRateLimit(check.callTimes, Date.now());
    if (!limit.ok) return { ok: false, reason: "rate_limited", message: limit.message };
    try {
      const result = await ctx.runAction(internal.cartesia.startCall, { elderId });
      if (result.status === "started") return { ok: true, callId: result.callId as Id<"calls"> };
      console.warn(`signup.requestCall: elder ${elderId} not called (${result.status})`);
      // The row exists: the page can show what happened (callStatus).
      if (result.status === "failed") return { ok: false, reason: "failed", message: FAILED, callId: result.callId as Id<"calls"> };
    } catch {
      // Fixed text: the error can name env vars or quote Cartesia's response.
      console.warn(`signup.requestCall: elder ${elderId} startCall threw`);
    }
    return { ok: false, reason: "failed", message: FAILED };
  },
});

const STATUS_WINDOW_MS = 3 * 60 * 60_000;

/**
 * The sign-up page's view of the call it asked for: a friendly state (lib/callStatus.ts) and
 * whether "Try again" is allowed yet. Keyed by the callId requestCall returned, and only for a
 * call made in the last 3 hours, so it never exposes his later calls. No transcript, no phone.
 */
export const callStatus = query({
  args: { callId: v.id("calls") },
  handler: async (ctx, { callId }): Promise<{ state: CallState; canRetry: boolean; retryAt?: number }> => {
    const now = Date.now();
    const call = await ctx.db.get(callId);
    if (!call || now - call._creationTime > STATUS_WINDOW_MS) return { state: "none", canRetry: false };
    const state = callState(call, now);
    const row = await ctx.db.get(call.elderId);
    const elder = asElderV2(row);
    if (!row || !elder) return { state, canRetry: false };
    const recent = await ctx.db
      .query("calls")
      .withIndex("by_elder", (q) => q.eq("elderId", call.elderId))
      .order("desc")
      .take(CALLS_PER_DAY);
    const mode = process.env.PUBLIC_CALLS;
    return {
      state,
      ...retryOffer(state, {
        createdAt: call._creationTime,
        onboarding: planNextCall(elder).kind === "onboarding",
        callsOn: (mode === "on" || mode === "all") && publicCallAllowed(mode, process.env.CALL_ALLOWLIST, row.phone),
        callTimes: recent.map((c) => c._creationTime),
        now,
      }),
    };
  },
});
