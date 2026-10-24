import { query, mutation, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { assertBackend, maskPhone } from "./lib/auth";
import { isProfileUsable, normalizeProfile } from "./lib/onboarding";
import { localParts, normalizeDay } from "./lib/schedule";

// ---------- backend only (secret required) ----------

export const create = mutation({
  args: {
    secret: v.string(),
    name: v.string(),
    phone: v.string(),
    expertise: v.array(v.string()),
    language: v.string(),
    bio: v.optional(v.string()),
  },
  handler: async (ctx, { secret, ...elder }) => {
    assertBackend(secret);
    const existing = await ctx.db
      .query("elders")
      .withIndex("by_phone", (q) => q.eq("phone", elder.phone))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, elder);
      return existing._id;
    }
    return await ctx.db.insert("elders", elder);
  },
});

export const getByPhone = query({
  args: { secret: v.string(), phone: v.string() },
  handler: async (ctx, { secret, phone }) => {
    assertBackend(secret);
    return await ctx.db
      .query("elders")
      .withIndex("by_phone", (q) => q.eq("phone", phone))
      .unique();
  },
});

export const getPrivate = query({
  args: { secret: v.string(), elderId: v.id("elders") },
  handler: async (ctx, { secret, elderId }) => {
    assertBackend(secret);
    return await ctx.db.get(elderId);
  },
});

export const listPrivate = query({
  args: { secret: v.string() },
  handler: async (ctx, { secret }) => {
    assertBackend(secret);
    return await ctx.db.query("elders").collect();
  },
});

// ---------- internal (npx convex run) ----------

/**
 * Add or update someone to call, for testing:
 *   npx convex run elders:seed '{"name":"Walter Smith","phone":"+14155550123",
 *     "timezone":"America/Los_Angeles","callDay":"sunday","callHour":10}'
 * Then: npx convex run cartesia:startCall '{"elderId":"<returned id>"}'
 */
export const seed = internalMutation({
  args: {
    name: v.string(),
    phone: v.string(), // E.164
    linkedinUrl: v.optional(v.string()),
    language: v.optional(v.string()),
    // weekly call slot for schedule.tick, his local time
    timezone: v.optional(v.string()), // IANA, e.g. America/Los_Angeles
    callDay: v.optional(v.string()), // sunday..saturday
    callHour: v.optional(v.number()), // 0-23
    // dev only: skip onboarding (a usable profile makes him "active" for story calls)
    profile: v.optional(v.any()),
  },
  handler: async (ctx, { language, callDay, profile: rawProfile, ...fields }) => {
    if (!/^\+[1-9]\d{6,14}$/.test(fields.phone)) throw new Error("phone must be E.164, e.g. +14155550123");
    const day = callDay === undefined ? undefined : normalizeDay(callDay);
    if (callDay !== undefined && !day) throw new Error("callDay must be a weekday, e.g. sunday");
    if (fields.callHour !== undefined && !(Number.isInteger(fields.callHour) && fields.callHour >= 0 && fields.callHour <= 23)) {
      throw new Error("callHour must be an integer 0-23");
    }
    if (fields.timezone !== undefined) {
      try {
        localParts(Date.now(), fields.timezone);
      } catch {
        throw new Error("timezone must be an IANA name, e.g. America/Los_Angeles");
      }
    }
    const profile = rawProfile === undefined ? undefined : normalizeProfile(rawProfile);
    const patch = {
      ...fields,
      ...(day ? { callDay: day } : {}),
      ...(language ? { language } : {}),
      ...(profile ? { profile, stage: isProfileUsable(profile) ? ("active" as const) : ("onboarding" as const) } : {}),
    };
    const existing = await ctx.db
      .query("elders")
      .withIndex("by_phone", (q) => q.eq("phone", fields.phone))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, patch);
      return existing._id;
    }
    return await ctx.db.insert("elders", {
      stage: "onboarding",
      ...patch,
      language: language ?? "en-US",
      expertise: [], // v1 field, still required by the schema
    });
  },
});

// ---------- public (React app) ----------

export const list = query({
  args: {},
  handler: async (ctx) => {
    const elders = await ctx.db.query("elders").collect();
    return elders.map((e) => ({
      _id: e._id,
      name: e.name,
      expertise: e.expertise,
      language: e.language,
      bio: e.bio,
      phoneMasked: maskPhone(e.phone),
    }));
  },
});
