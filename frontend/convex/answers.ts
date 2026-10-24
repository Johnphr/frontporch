import { query, mutation, type QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { assertBackend, firstName } from "./lib/auth";
import { answerStatus, postQuality, postVariants, publication } from "./schema";

// ---------- backend only (secret required) ----------

export const createDraft = mutation({
  args: {
    secret: v.string(),
    elderId: v.id("elders"),
    questionId: v.id("questions"),
    callId: v.optional(v.id("calls")),
    transcript: v.string(),
    title: v.string(),
    body: v.string(),
    shortVersion: v.string(),
    keyPoints: v.array(v.string()),
    readback: v.optional(v.string()),
  },
  handler: async (ctx, { secret, ...answer }) => {
    assertBackend(secret);
    return await ctx.db.insert("answers", {
      ...answer,
      status: "draft",
      publications: [],
    });
  },
});

export const getPrivate = query({
  args: { secret: v.string(), answerId: v.id("answers") },
  handler: async (ctx, { secret, answerId }) => {
    assertBackend(secret);
    return await ctx.db.get(answerId);
  },
});

export const setStatus = mutation({
  args: { secret: v.string(), answerId: v.id("answers"), status: answerStatus },
  handler: async (ctx, { secret, answerId, status }) => {
    assertBackend(secret);
    await ctx.db.patch(answerId, { status });
  },
});

/** Record a publish result, replacing any earlier entry for the same platform. */
export const setPublication = mutation({
  args: { secret: v.string(), answerId: v.id("answers"), publication },
  handler: async (ctx, { secret, answerId, publication }) => {
    assertBackend(secret);
    const answer = await ctx.db.get(answerId);
    if (!answer) throw new Error("Answer not found");
    const others = answer.publications.filter((p) => p.platform !== publication.platform);
    await ctx.db.patch(answerId, { publications: [...others, publication] });
  },
});

/** Save per-platform post texts + the faithfulness check (backend post_writer.py). */
export const setPosts = mutation({
  args: {
    secret: v.string(),
    answerId: v.id("answers"),
    variants: postVariants,
    quality: postQuality,
  },
  handler: async (ctx, { secret, answerId, variants, quality }) => {
    assertBackend(secret);
    const answer = await ctx.db.get(answerId);
    if (!answer) throw new Error("Answer not found");
    await ctx.db.patch(answerId, { variants, quality });
  },
});

// ---------- public (React app) ----------

async function withContext(ctx: QueryCtx, answer: Doc<"answers">) {
  const elder = await ctx.db.get(answer.elderId);
  const question = await ctx.db.get(answer.questionId);
  return { elder, question };
}

async function toPublic(ctx: QueryCtx, answer: Doc<"answers">) {
  const { elder, question } = await withContext(ctx, answer);
  return {
    _id: answer._id,
    _creationTime: answer._creationTime,
    title: answer.title,
    body: answer.body,
    shortVersion: answer.shortVersion,
    keyPoints: answer.keyPoints,
    elderFirstName: firstName(elder?.name),
    questionTitle: question?.title,
    questionUrl: question?.sourceUrl,
    publications: answer.publications,
    variants: answer.variants,
    quality: answer.quality,
  };
}

export const listPublished = query({
  args: {},
  handler: async (ctx) => {
    const answers = await ctx.db
      .query("answers")
      .withIndex("by_status", (q) => q.eq("status", "published"))
      .order("desc")
      .take(100);
    return await Promise.all(answers.map((a) => toPublic(ctx, a)));
  },
});

export const getPublic = query({
  args: { answerId: v.id("answers") },
  handler: async (ctx, { answerId }) => {
    const answer = await ctx.db.get(answerId);
    if (!answer || answer.status !== "published") return null;
    return await toPublic(ctx, answer);
  },
});

/** Everything, for the organizer dashboard. */
export const listAll = query({
  args: {},
  handler: async (ctx) => {
    const answers = await ctx.db.query("answers").order("desc").take(100);
    return await Promise.all(
      answers.map(async (a) => {
        const { elder, question } = await withContext(ctx, a);
        return {
          ...a,
          elderName: elder?.name,
          questionTitle: question?.title,
          questionUrl: question?.sourceUrl,
        };
      }),
    );
  },
});
