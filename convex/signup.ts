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
// Family code: `register` also returns a 6-digit code, once (hash in elders.familyCodeHash).
// `signIn({ phone, code })` is how he gets back to his page from any browser: it mints a NEW
// token (the old device's stops working). `startOver({ phone, code })` archives his sign-up so
// the number can sign up again. Both: 5 wrong codes per phone per 15 min, and an unknown phone
// answers exactly like a wrong code. `setFamilyCode` (internal) gives older rows a code.
//
// Remaining risk: the SMS check is fake for now, so anyone can sign up a NEW number and make it
// ring (onboarding only, at most CALLS_PER_DAY a day, 10 min apart; no global cap). That's why
// `requestCall` is off by default: PUBLIC_CALLS=on rings only CALL_ALLOWLIST numbers,
// PUBLIC_CALLS=all rings anyone (lib/signupRules.publicCallAllowed). The weekly cron uses the
// same gate for website sign-ups in onboarding (lib/signupRules.cronMayCall), and their first
// weekly slot is tomorrow. LinkedIn and Bluesky are locked once he's active.

import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { action, internalAction, internalMutation, internalQuery, query, type MutationCtx } from "./_generated/server";
import { callState, retryOffer, type CallState } from "./lib/callStatus";
import { getCharacter, publicCharacters, type Character } from "./lib/characters";
import { connectBlueskyAccount, type ConnectResult } from "./lib/accountConnect";
import { startOAuthConnectFlow, startXConnectFlow, type StartResult } from "./lib/oauthFlow";
import type { FetchFn } from "./lib/blueskyClient";
import { planNextCall } from "./lib/onboarding";
import {
  CALLS_PER_DAY,
  archiveFields,
  callRateLimit,
  canonicalLinkedInProfileUrl,
  familyCodeHash,
  languageTag,
  newElderFields,
  newFamilyCode,
  newSignupToken,
  normalizeFamilyCode,
  normalizeName,
  normalizePhone,
  publicCallAllowed,
  recordSignInAttempt,
  sameTokenHash,
  signInDecision,
  signupTokenHash,
  type SignInRefusal,
} from "./lib/signupRules";
import { asElderV2 } from "./lib/v2Fields";

// Convex exposes env vars on process.env (declared so we don't need @types/node).
declare const process: { env: Record<string, string | undefined> };

type CallRequest =
  | { ok: true; callId: Id<"calls"> }
  | { ok: false; reason: "disabled" | "rate_limited" | "already_onboarded" | "failed"; message: string; callId?: Id<"calls"> };

type Registration = { ok: true; elderId: Id<"elders">; token: string; familyCode: string } | { ok: false; reason: "already_signed_up" };
type SignIn = { ok: true; elderId: Id<"elders">; token: string } | { ok: false; reason: SignInRefusal };
type StartOver = { ok: true } | { ok: false; reason: SignInRefusal };

const DISABLED = "Calls from the sign-up page are turned off for now.";
const FAILED = "We couldn't start the call. Please try again later.";
const NOT_FOUND = "Sign-up not found.";
const language = v.union(v.literal("en"), v.literal("es"));

export const listCharacters = query({
  args: {},
  handler: async (): Promise<Character[]> => publicCharacters(),
});

const BAD_PHONE = "Please enter a phone number with country code, e.g. +14155550123.";

/**
 * New elder in onboarding -> { elderId, token, familyCode }. A known phone -> already_signed_up
 * (his row isn't touched and no id, token or code is given out). An action so the token and code
 * come from real randomness. `timeZone` is the browser's (checked; else from the phone's country).
 * Known, accepted leak: already_signed_up tells anyone whether a number is signed up. Hiding
 * it would mean telling a real person "done" when nothing happened; nothing else is revealed.
 */
export const register = action({
  args: { name: v.string(), phone: v.string(), language, timeZone: v.optional(v.string()) },
  handler: async (ctx, args): Promise<Registration> => {
    const name = normalizeName(args.name);
    if (!name) throw new ConvexError("Please enter your name (up to 100 characters).");
    const phone = normalizePhone(args.phone);
    if (!phone) throw new ConvexError(BAD_PHONE);
    const token = newSignupToken();
    const tokenHash = await signupTokenHash(token);
    const familyCode = newFamilyCode();
    const codeHash = await familyCodeHash(familyCode);
    if (!tokenHash || !codeHash) throw new Error("signup secret malformed"); // can't happen
    const elderId: Id<"elders"> | null = await ctx.runMutation(internal.signup.createElder, {
      name,
      phone,
      language: args.language,
      ...(args.timeZone ? { timeZone: args.timeZone.slice(0, 100) } : {}),
      tokenHash,
      codeHash,
      now: Date.now(),
    });
    return elderId ? { ok: true, elderId, token, familyCode } : { ok: false, reason: "already_signed_up" };
  },
});

/** For register: insert his row, or null if the phone is already signed up (nothing changes). */
export const createElder = internalMutation({
  args: {
    name: v.string(),
    phone: v.string(),
    language,
    timeZone: v.optional(v.string()),
    tokenHash: v.string(),
    codeHash: v.optional(v.string()),
    now: v.number(),
  },
  handler: async (ctx, { tokenHash, codeHash, now, ...input }): Promise<Id<"elders"> | null> => {
    const existing = await ctx.db
      .query("elders")
      .withIndex("by_phone", (q) => q.eq("phone", input.phone))
      .unique();
    if (existing) return null;
    return await ctx.db.insert("elders", newElderFields(input, now, tokenHash, codeHash));
  },
});

// ---------- Sign in from any device: phone + family code ----------

/**
 * Phone + family code -> { elderId, token } (a NEW token: the device that signed up, or signed in
 * before, is signed out) or { ok: false, reason: wrong_code | too_many_tries }. An unknown phone
 * is wrong_code too, and its tries count the same way, so nothing says whether a number is signed
 * up. The code is hashed here (Web Crypto) and checked in checkSignIn; neither is ever logged.
 */
export const signIn = action({
  args: { phone: v.string(), code: v.string() },
  handler: async (ctx, args): Promise<SignIn> => {
    const phone = normalizePhone(args.phone);
    if (!phone) throw new ConvexError(BAD_PHONE);
    if (!normalizeFamilyCode(args.code)) return { ok: false, reason: "wrong_code" };
    const token = newSignupToken();
    const tokenHash = await signupTokenHash(token);
    if (!tokenHash) throw new Error("signup token malformed"); // can't happen
    const res: { ok: true; elderId: Id<"elders"> } | { ok: false; reason: SignInRefusal } = await ctx.runMutation(internal.signup.checkSignIn, {
      phone,
      codeHash: (await familyCodeHash(args.code)) ?? "",
      tokenHash,
      now: Date.now(),
    });
    return res.ok ? { ok: true, elderId: res.elderId, token } : res;
  },
});

const signInKey = (phone: string) => `signin:${phone}`;

/** Wrong-code times for this phone (connectAttempts "signin:<phone>"), and the row they live in. */
async function signInAttempts(ctx: MutationCtx, phone: string) {
  const row = await ctx.db
    .query("connectAttempts")
    .withIndex("by_key", (q) => q.eq("key", signInKey(phone)))
    .unique();
  return { row, times: row?.times ?? [] };
}

/**
 * The phone + code check both sign-in mutations share: rate limit, then his row and code.
 * A wrong code is counted (the row is made if needed); a right one clears the count.
 */
async function checkCode(ctx: MutationCtx, phone: string, codeHash: string, now: number) {
  const elder = await ctx.db
    .query("elders")
    .withIndex("by_phone", (q) => q.eq("phone", phone))
    .unique();
  const { row, times } = await signInAttempts(ctx, phone);
  const decision = signInDecision(elder, codeHash, times, now);
  if (decision.ok && elder) {
    if (row) await ctx.db.delete(row._id);
    return { ok: true as const, elder };
  }
  const reason: SignInRefusal = decision.ok ? "wrong_code" : decision.reason; // ok without a row can't happen
  if (reason === "wrong_code") {
    const next = recordSignInAttempt(times, now);
    if (row) await ctx.db.patch(row._id, { times: next });
    else await ctx.db.insert("connectAttempts", { key: signInKey(phone), times: next });
  }
  return { ok: false as const, reason };
}

/** For signIn: check the code, then replace his token hash with the new one. */
export const checkSignIn = internalMutation({
  args: { phone: v.string(), codeHash: v.string(), tokenHash: v.string(), now: v.number() },
  handler: async (ctx, { phone, codeHash, tokenHash, now }): Promise<{ ok: true; elderId: Id<"elders"> } | { ok: false; reason: SignInRefusal }> => {
    const check = await checkCode(ctx, phone, codeHash, now);
    if (!check.ok) return check;
    await ctx.db.patch(check.elder._id, { signupTokenHash: tokenHash });
    return { ok: true, elderId: check.elder._id };
  },
});

/**
 * "Start over" for a number that's already signed up, behind his family code: his row is archived
 * (stage "archived", phone freed, token and code dropped) and his connected accounts disconnected
 * (secrets dropped). Posts and calls stay as history; crons skip him. Same answers and rate limit as signIn.
 */
export const startOver = action({
  args: { phone: v.string(), code: v.string() },
  handler: async (ctx, args): Promise<StartOver> => {
    const phone = normalizePhone(args.phone);
    if (!phone) throw new ConvexError(BAD_PHONE);
    if (!normalizeFamilyCode(args.code)) return { ok: false, reason: "wrong_code" };
    return await ctx.runMutation(internal.signup.archiveElder, { phone, codeHash: (await familyCodeHash(args.code)) ?? "", now: Date.now() });
  },
});

/** For startOver: check the code, then archive him and disconnect his accounts. */
export const archiveElder = internalMutation({
  args: { phone: v.string(), codeHash: v.string(), now: v.number() },
  handler: async (ctx, { phone, codeHash, now }): Promise<StartOver> => {
    const check = await checkCode(ctx, phone, codeHash, now);
    if (!check.ok) return check;
    const elderId = check.elder._id;
    await ctx.db.patch(elderId, archiveFields(phone, now));
    const accounts = await ctx.db
      .query("elderAccounts")
      .withIndex("by_elder_platform", (q) => q.eq("elderId", elderId))
      .collect();
    for (const a of accounts) await ctx.db.patch(a._id, { status: "disconnected", secret: undefined });
    console.log(`signup.startOver: elder ${elderId} archived`);
    return { ok: true };
  },
});

/**
 * Team tool (dashboard / `npx convex run signup:setFamilyCode '{"elderId":"<id>"}'`): give an
 * elder a family code, for rows made before codes existed or when his got lost. Makes one when
 * `code` isn't given. Returns the plaintext ONCE (shown only to whoever ran it); only its hash is
 * stored. An action, since hashing needs Web Crypto.
 */
export const setFamilyCode = internalAction({
  args: { elderId: v.id("elders"), code: v.optional(v.string()) },
  handler: async (ctx, { elderId, code }): Promise<{ familyCode: string }> => {
    const familyCode = code === undefined ? newFamilyCode() : normalizeFamilyCode(code);
    if (!familyCode) throw new ConvexError("The code must be 6 digits.");
    const codeHash = await familyCodeHash(familyCode);
    if (!codeHash) throw new Error("family code malformed"); // can't happen
    const saved: boolean = await ctx.runMutation(internal.signup.saveFamilyCode, { elderId, codeHash });
    if (!saved) throw new ConvexError("No such elder, or he is archived.");
    return { familyCode };
  },
});

/** For setFamilyCode: store the hash on a live elder. */
export const saveFamilyCode = internalMutation({
  args: { elderId: v.id("elders"), codeHash: v.string() },
  handler: async (ctx, { elderId, codeHash }): Promise<boolean> => {
    const elder = await ctx.db.get(elderId);
    if (!elder || elder.stage === "archived") return false;
    await ctx.db.patch(elderId, { familyCodeHash: codeHash });
    return true;
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
    const character = getCharacter(characterId);
    if (!elder || !character || !sameTokenHash(elder.signupTokenHash, tokenHash)) return { ok: false, error: "not_found" };
    // One language per character: switching host switches his call language too.
    await ctx.db.patch(elderId, { characterId, language: languageTag(character.language) });
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

/**
 * "Connect Threads" / "Connect X": needs his sign-up token. Rate limited like connectBluesky and
 * locked once he's active. Returns { ok, url } (the platform's consent page; the browser goes
 * there and comes back through http.ts /oauth/<platform>/callback) or { ok: false, error: code }.
 * X has its own state row + PKCE in xAuth.startConnect (one callback per platform).
 */
export const startOAuthConnect = action({
  args: { elderId: v.id("elders"), token: v.string(), platform: v.union(v.literal("threads"), v.literal("x")) },
  handler: async (ctx, { elderId, token, platform }): Promise<StartResult> => {
    const now = Date.now();
    const tokenHash = (await signupTokenHash(token)) ?? "";
    const reserve = () => ctx.runMutation(internal.oauth.reserveConnect, { elderId, tokenHash, platform, now });
    if (platform === "x") {
      return startXConnectFlow({
        env: process.env,
        reserve,
        start: () => ctx.runAction(internal.xAuth.startConnect, { elderId }),
        warn: (message) => console.warn(message),
      });
    }
    return startOAuthConnectFlow(
      {
        env: process.env,
        reserve,
        createState: async ({ state, codeVerifier }) => {
          await ctx.runMutation(internal.oauth.createState, { elderId, platform, state, now, ...(codeVerifier ? { codeVerifier } : {}) });
        },
        warn: (message) => console.warn(message),
      },
      platform,
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
