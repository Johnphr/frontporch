import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { assertBackend } from "./lib/auth";
import { questionStatus } from "./schema";
import type { Id } from "./_generated/dataModel";

const incomingQuestion = v.object({
  source: v.string(),
  title: v.string(),
  body: v.optional(v.string()),
  sourceUrl: v.optional(v.string()),
  externalId: v.optional(v.string()),
  // feat/question-sources: optional metadata computed by the backend
  community: v.optional(v.string()),
  score: v.optional(v.number()),
  answerCount: v.optional(v.number()),
  postedAt: v.optional(v.number()),
  tags: v.optional(v.array(v.string())),
  fingerprint: v.optional(v.string()),
  priority: v.optional(v.number()),
});

// ---------- backend only (secret required) ----------

/**
 * Insert questions, skipping any we already have: same externalId, or the same
 * fingerprint (the same question found on another site). Returns new ids.
 */
export const upsertMany = mutation({
  args: { secret: v.string(), questions: v.array(incomingQuestion) },
  handler: async (ctx, { secret, questions }) => {
    assertBackend(secret);
    const created: Id<"questions">[] = [];
    for (const q of questions) {
      if (q.externalId) {
        const existing = await ctx.db
          .query("questions")
          .withIndex("by_external", (i) => i.eq("externalId", q.externalId))
          .first();
        if (existing) continue;
      }
      if (q.fingerprint) {
        const sameQuestion = await ctx.db
          .query("questions")
          .withIndex("by_fingerprint", (i) => i.eq("fingerprint", q.fingerprint))
          .first();
        if (sameQuestion) continue;
      }
      created.push(
        await ctx.db.insert("questions", { ...q, topics: [], status: "new" }),
      );
    }
    return created;
  },
});

export const listPrivate = query({
  args: { secret: v.string(), status: questionStatus },
  handler: async (ctx, { secret, status }) => {
    assertBackend(secret);
    return await ctx.db
      .query("questions")
      .withIndex("by_status", (q) => q.eq("status", status))
      .collect();
  },
});

export const getPrivate = query({
  args: { secret: v.string(), questionId: v.id("questions") },
  handler: async (ctx, { secret, questionId }) => {
    assertBackend(secret);
    return await ctx.db.get(questionId);
  },
});

export const assign = mutation({
  args: {
    secret: v.string(),
    questionId: v.id("questions"),
    elderId: v.id("elders"),
    topics: v.array(v.string()),
  },
  handler: async (ctx, { secret, questionId, elderId, topics }) => {
    assertBackend(secret);
    await ctx.db.patch(questionId, {
      status: "assigned",
      assignedElderId: elderId,
      topics,
    });
  },
});

export const skip = mutation({
  args: { secret: v.string(), questionId: v.id("questions"), reason: v.string() },
  handler: async (ctx, { secret, questionId, reason }) => {
    assertBackend(secret);
    await ctx.db.patch(questionId, { status: "skipped", skipReason: reason });
  },
});

/**
 * Next question for this elder's call. Family questions (source "family") come
 * first, then the highest priority, then the oldest.
 */
export const nextForElder = query({
  args: { secret: v.string(), elderId: v.id("elders") },
  handler: async (ctx, { secret, elderId }) => {
    assertBackend(secret);
    const assigned = await ctx.db
      .query("questions")
      .withIndex("by_elder_status", (q) =>
        q.eq("assignedElderId", elderId).eq("status", "assigned"),
      )
      .collect();
    assigned.sort((a, b) => {
      const familyA = a.source === "family" ? 0 : 1;
      const familyB = b.source === "family" ? 0 : 1;
      if (familyA !== familyB) return familyA - familyB;
      const byPriority = (b.priority ?? 0) - (a.priority ?? 0);
      if (byPriority !== 0) return byPriority;
      return a._creationTime - b._creationTime;
    });
    return assigned[0] ?? null;
  },
});

export const setStatus = mutation({
  args: { secret: v.string(), questionId: v.id("questions"), status: questionStatus },
  handler: async (ctx, { secret, questionId, status }) => {
    assertBackend(secret);
    await ctx.db.patch(questionId, { status });
  },
});

// ---------- public (React app) ----------

export const list = query({
  args: { status: v.optional(questionStatus) },
  handler: async (ctx, { status }) => {
    const questions = status
      ? await ctx.db
          .query("questions")
          .withIndex("by_status", (q) => q.eq("status", status))
          .order("desc")
          .take(100)
      : await ctx.db.query("questions").order("desc").take(100);
    return await Promise.all(
      questions.map(async (q) => {
        const elder = q.assignedElderId ? await ctx.db.get(q.assignedElderId) : null;
        return { ...q, assignedElderName: elder?.name };
      }),
    );
  },
});
