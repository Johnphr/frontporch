import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { assertBackend, maskPhone } from "./lib/auth";

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
