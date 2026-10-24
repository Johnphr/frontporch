// Sign-up page API (public): sign up -> choose a character -> optional LinkedIn -> first call.
// These are the only public functions: anyone with the deployment URL can call them, so they
// return only ids, characters and ok/reason results (never elder rows or transcripts), and
// validate every argument. Rules live in lib/signupRules.ts (unit-tested).
//
// Remaining risk: the SMS check is fake for now, so whoever knows a phone number can get its
// elderId from `register`, change its character, and make it ring (onboarding only, at most
// CALLS_PER_DAY a day, 10 min apart). Each new number gets its own limit: there is no global cap.
// That's why `requestCall` is off unless PUBLIC_CALLS=on. LinkedIn is locked once he's active,
// since his posts' engagement is scraped from it.

import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { action, internalQuery, mutation, query } from "./_generated/server";
import { getCharacter, publicCharacters, type Character } from "./lib/characters";
import { planNextCall } from "./lib/onboarding";
import {
  CALLS_PER_DAY,
  callRateLimit,
  canonicalLinkedInProfileUrl,
  languageTag,
  normalizeName,
  normalizePhone,
} from "./lib/signupRules";
import { asElderV2 } from "./lib/v2Fields";

// Convex exposes env vars on process.env (declared so we don't need @types/node).
declare const process: { env: Record<string, string | undefined> };

type CallRequest =
  | { ok: true }
  | { ok: false; reason: "disabled" | "rate_limited" | "failed"; message: string };

const FAILED = "We couldn't start the call. Please try again later.";

export const listCharacters = query({
  args: {},
  handler: async (): Promise<Character[]> => publicCharacters(),
});

/** New elder in onboarding, or the existing id for a known phone (nothing on his row changes). */
export const register = mutation({
  args: { name: v.string(), phone: v.string(), language: v.union(v.literal("en"), v.literal("es")) },
  handler: async (ctx, args): Promise<Id<"elders">> => {
    const name = normalizeName(args.name);
    if (!name) throw new ConvexError("Please enter your name (up to 100 characters).");
    const phone = normalizePhone(args.phone);
    if (!phone) throw new ConvexError("Please enter a phone number with country code, e.g. +14155550123.");
    const existing = await ctx.db
      .query("elders")
      .withIndex("by_phone", (q) => q.eq("phone", phone))
      .unique();
    if (existing) return existing._id;
    return await ctx.db.insert("elders", {
      name,
      phone,
      language: languageTag(args.language),
      stage: "onboarding",
      expertise: [], // v1 field, still required by the schema
    });
  },
});

export const setCharacter = mutation({
  args: { elderId: v.id("elders"), characterId: v.string() },
  handler: async (ctx, { elderId, characterId }): Promise<null> => {
    if (!getCharacter(characterId)) throw new ConvexError("Unknown character.");
    if (!(await ctx.db.get(elderId))) throw new ConvexError("Sign-up not found.");
    await ctx.db.patch(elderId, { characterId });
    return null;
  },
});

export const setLinkedin = mutation({
  args: { elderId: v.id("elders"), url: v.string() },
  handler: async (ctx, { elderId, url }): Promise<null> => {
    const linkedinUrl = canonicalLinkedInProfileUrl(url);
    if (!linkedinUrl) throw new ConvexError("Please enter a LinkedIn profile link, e.g. linkedin.com/in/your-name.");
    const elder = await ctx.db.get(elderId);
    if (!elder) throw new ConvexError("Sign-up not found.");
    if (elder.stage === "active") throw new ConvexError("Your LinkedIn is already set up.");
    if (elder.linkedinUrl === linkedinUrl) return null;
    // A cached background came from the old profile: drop it so onboarding scrapes the new one.
    await ctx.db.patch(elderId, { linkedinUrl, knownBackground: undefined });
    return null;
  },
});

/** For requestCall: is his next call onboarding, and when were his latest calls created. */
export const callCheck = internalQuery({
  args: { elderId: v.id("elders") },
  handler: async (ctx, { elderId }): Promise<{ onboarding: boolean; callTimes: number[] } | null> => {
    const elder = asElderV2(await ctx.db.get(elderId));
    if (!elder) return null;
    const recent = await ctx.db
      .query("calls")
      .withIndex("by_elder", (q) => q.eq("elderId", elderId))
      .order("desc")
      .take(CALLS_PER_DAY); // the newest few decide both limits
    return { onboarding: planNextCall(elder).kind === "onboarding", callTimes: recent.map((c) => c._creationTime) };
  },
});

/**
 * Ring him for his onboarding call. Gated by PUBLIC_CALLS=on, then the rate limit; startCall's
 * reserveCall still refuses a second open call, so two requests at once can't both ring.
 */
export const requestCall = action({
  args: { elderId: v.id("elders") },
  handler: async (ctx, { elderId }): Promise<CallRequest> => {
    if (process.env.PUBLIC_CALLS !== "on") {
      return { ok: false, reason: "disabled", message: "Calls from the sign-up page are turned off for now." };
    }
    const check = await ctx.runQuery(internal.signup.callCheck, { elderId });
    if (!check) return { ok: false, reason: "failed", message: "Sign-up not found." };
    if (!check.onboarding) {
      return { ok: false, reason: "failed", message: "Your first call is done; your weekly calls are scheduled." };
    }
    const limit = callRateLimit(check.callTimes, Date.now());
    if (!limit.ok) return { ok: false, reason: "rate_limited", message: limit.message };
    try {
      const result = await ctx.runAction(internal.cartesia.startCall, { elderId });
      if (result.status === "started") return { ok: true };
      console.warn(`signup.requestCall: elder ${elderId} not called (${result.status})`);
    } catch {
      // Fixed text: the error can name env vars or quote Cartesia's response.
      console.warn(`signup.requestCall: elder ${elderId} startCall threw`);
    }
    return { ok: false, reason: "failed", message: FAILED };
  },
});
