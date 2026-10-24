import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { assertBackend } from "./lib/auth";

// ---------- backend only (secret required) ----------

/** A thank-you or follow-up from a reader. Read aloud on the elder's next call. */
export const add = mutation({
  args: {
    secret: v.string(),
    answerId: v.id("answers"),
    platform: v.string(),
    author: v.string(),
    text: v.string(),
  },
  handler: async (ctx, { secret, answerId, platform, author, text }) => {
    assertBackend(secret);
    const answer = await ctx.db.get(answerId);
    if (!answer) throw new Error("Answer not found");
    return await ctx.db.insert("replies", {
      answerId,
      elderId: answer.elderId,
      platform,
      author,
      text,
      readToElder: false,
    });
  },
});

export const unreadForElder = query({
  args: { secret: v.string(), elderId: v.id("elders") },
  handler: async (ctx, { secret, elderId }) => {
    assertBackend(secret);
    const replies = await ctx.db
      .query("replies")
      .withIndex("by_elder_unread", (q) =>
        q.eq("elderId", elderId).eq("readToElder", false),
      )
      .collect();
    return await Promise.all(
      replies.map(async (r) => {
        const answer = await ctx.db.get(r.answerId);
        const question = answer ? await ctx.db.get(answer.questionId) : null;
        return { ...r, questionTitle: question?.title };
      }),
    );
  },
});

export const markRead = mutation({
  args: { secret: v.string(), replyId: v.id("replies") },
  handler: async (ctx, { secret, replyId }) => {
    assertBackend(secret);
    await ctx.db.patch(replyId, { readToElder: true });
  },
});

// ---------- public (React app) ----------

export const listForAnswer = query({
  args: { answerId: v.id("answers") },
  handler: async (ctx, { answerId }) => {
    return await ctx.db
      .query("replies")
      .withIndex("by_answer", (q) => q.eq("answerId", answerId))
      .order("desc")
      .collect();
  },
});
