import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { assertBackend } from "./lib/auth";

// ---------- backend only (secret required) ----------

export const start = mutation({
  args: {
    secret: v.string(),
    callSid: v.string(),
    elderId: v.id("elders"),
    questionId: v.optional(v.id("questions")),
  },
  handler: async (ctx, { secret, ...call }) => {
    assertBackend(secret);
    return await ctx.db.insert("calls", {
      ...call,
      status: "in-progress",
      transcript: [],
    });
  },
});

export const addTurn = mutation({
  args: { secret: v.string(), callId: v.id("calls"), role: v.string(), text: v.string() },
  handler: async (ctx, { secret, callId, role, text }) => {
    assertBackend(secret);
    const call = await ctx.db.get(callId);
    if (!call) throw new Error("Call not found");
    await ctx.db.patch(callId, { transcript: [...call.transcript, { role, text }] });
  },
});

export const setStatus = mutation({
  args: { secret: v.string(), callId: v.id("calls"), status: v.string() },
  handler: async (ctx, { secret, callId, status }) => {
    assertBackend(secret);
    await ctx.db.patch(callId, { status });
  },
});

// ---------- public (React app) ----------

export const listRecent = query({
  args: {},
  handler: async (ctx) => {
    const calls = await ctx.db.query("calls").order("desc").take(20);
    return await Promise.all(
      calls.map(async (c) => {
        const elder = await ctx.db.get(c.elderId);
        const question = c.questionId ? await ctx.db.get(c.questionId) : null;
        return {
          _id: c._id,
          _creationTime: c._creationTime,
          status: c.status,
          transcript: c.transcript,
          elderName: elder?.name,
          questionTitle: question?.title,
        };
      }),
    );
  },
});
