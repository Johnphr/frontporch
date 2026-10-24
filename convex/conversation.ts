// The question planner: what Pip talks about next.
//
//   refreshQuestionBank({ elderId })  after every call, when reader comments arrive,
//                                     and from prepareCall. Rebuilds the ranked bank
//                                     from his profile, open threads, memories,
//                                     reader feedback, audience + recent topics.
//   prepareCall({ elderId })          ~1h before his call (schedule.tick): fresh
//                                     audience questions (Apify) + recent topics in
//                                     his field (Claude web search) -> refresh.
//   planNextCall({ elderId })         at call time (vapi.startCall): CallPlan + the
//                                     prompt variables for vapi/prompts/*.md.
//   markPlanUsed({ elderId, bankId, callId })   vapi.startCall, once the call is placed.
//
// Ranking rules live in lib/planner.ts (pure, tested). Owner: Core: Brain.

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import {
  engagementRecentFeedback,
  memoriesListForElder,
  memoriesSearch,
  type MemoryDoc,
  type MemoryHit,
} from "./lib/dataRefs";
import {
  buildCallPlan,
  fallbackCandidates,
  rankCandidates,
  toPromptVariables,
  type CallPlan,
  type Candidate,
  type CandidateSource,
  type PromptVariables,
} from "./lib/planner";
import { asElderV2, isOnboarding, type ElderV2 } from "./lib/v2Fields";

const bankItemValidator = v.object({
  question: v.string(),
  why: v.string(),
  source: v.string(),
  sourceRef: v.optional(v.string()),
  topicKey: v.string(),
  priority: v.number(),
  firstSeenAt: v.number(),
});

const recentTopicValidator = v.object({
  title: v.string(),
  summary: v.string(),
  url: v.string(),
  question: v.string(),
});

type RecentTopic = { title: string; summary: string; url: string; question: string };

type BankRow = {
  _id: Id<"questionBank">;
  question: string;
  why: string;
  source: string;
  sourceRef?: string;
  topicKey: string;
  priority: number;
  firstSeenAt: number;
};

type PlanningContext = {
  elder: ElderV2 | null;
  queued: BankRow[];
  recentlyUsedTopics: string[];
};

// ---------- queries + mutations ----------

export const getPlanningContext = internalQuery({
  args: { elderId: v.id("elders") },
  handler: async (ctx, { elderId }): Promise<PlanningContext> => {
    const elder = asElderV2(await ctx.db.get(elderId));
    const queued = await ctx.db
      .query("questionBank")
      .withIndex("by_elder_status_priority", (q) => q.eq("elderId", elderId).eq("status", "queued"))
      .order("desc")
      .take(50);
    const used = await ctx.db
      .query("questionBank")
      .withIndex("by_elder_status_priority", (q) => q.eq("elderId", elderId).eq("status", "used"))
      .take(100);
    const recentlyUsedTopics = used
      .sort((a, b) => (b.usedAt ?? 0) - (a.usedAt ?? 0))
      .slice(0, 10)
      .map((u) => u.topicKey.replace(/-/g, " "));
    return {
      elder,
      queued: queued.map((r) => ({
        _id: r._id,
        question: r.question,
        why: r.why,
        source: r.source,
        sourceRef: r.sourceRef,
        topicKey: r.topicKey,
        priority: r.priority,
        firstSeenAt: r.firstSeenAt,
      })),
      recentlyUsedTopics,
    };
  },
});

/** Swap the queued bank for a freshly ranked one. Used rows stay as history. */
export const replaceQueued = internalMutation({
  args: { elderId: v.id("elders"), items: v.array(bankItemValidator) },
  handler: async (ctx, { elderId, items }) => {
    const old = await ctx.db
      .query("questionBank")
      .withIndex("by_elder_status_priority", (q) => q.eq("elderId", elderId).eq("status", "queued"))
      .collect();
    for (const row of old) await ctx.db.delete(row._id);
    for (const item of items) {
      await ctx.db.insert("questionBank", { elderId, ...item, status: "queued" });
    }
    return { removed: old.length, queued: items.length };
  },
});

export const listQueued = internalQuery({
  args: { elderId: v.id("elders"), limit: v.optional(v.number()) },
  handler: async (ctx, { elderId, limit }) =>
    ctx.db
      .query("questionBank")
      .withIndex("by_elder_status_priority", (q) => q.eq("elderId", elderId).eq("status", "queued"))
      .order("desc")
      .take(Math.max(1, Math.min(Math.floor(limit ?? 12), 50))),
});

/**
 * vapi.startCall calls this once the call is placed, with plan.bankId from
 * planNextCall. Marks the question used (and the audience question behind it).
 */
export const markPlanUsed = internalMutation({
  args: { elderId: v.id("elders"), bankId: v.id("questionBank"), callId: v.optional(v.id("calls")) },
  handler: async (ctx, { elderId, bankId, callId }) => {
    const row = await ctx.db.get(bankId);
    if (!row || row.elderId !== elderId) return { ok: false };
    const now = Date.now();
    await ctx.db.patch(bankId, { status: "used", usedAt: now, ...(callId ? { usedInCallId: callId } : {}) });
    if (row.source === "audience" && row.sourceRef) {
      const audienceId = ctx.db.normalizeId("audienceQuestions", row.sourceRef);
      if (audienceId) await ctx.db.patch(audienceId, { usedAt: now, ...(callId ? { usedInCallId: callId } : {}) });
    }
    return { ok: true };
  },
});

export const saveKnownBackground = internalMutation({
  args: { elderId: v.id("elders"), knownBackground: v.string() },
  handler: async (ctx, { elderId, knownBackground }) => {
    await ctx.db.patch(elderId, { knownBackground });
  },
});

// ---------- actions ----------

type RefreshResult = { queued: number; usedClaude: boolean; errors: string[] };

/** Best effort: a missing Data function (or any failure) just means "no input from it". */
async function attempt<T>(errors: string[], label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    errors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
    return fallback;
  }
}

export const refreshQuestionBank = internalAction({
  args: {
    elderId: v.id("elders"),
    recentTopics: v.optional(v.array(recentTopicValidator)),
    freshAudience: v.optional(v.array(v.object({ id: v.string(), title: v.string() }))),
  },
  handler: async (ctx, args): Promise<RefreshResult> => {
    const errors: string[] = [];
    const context: PlanningContext = await ctx.runQuery(internal.conversation.getPlanningContext, {
      elderId: args.elderId,
    });
    if (!context.elder) throw new Error("Elder not found");
    const profile = context.elder.profile;

    const memories: MemoryDoc[] = await attempt(
      errors,
      "memories",
      () => ctx.runQuery(memoriesListForElder, { elderId: args.elderId, limit: 200 }),
      [],
    );
    const openThreads = memories
      .filter((m) => m.kind === "open_thread" && m.status !== "resolved")
      .slice(0, 15)
      .map((m) => ({ id: m._id, text: m.text }));
    const storyMemories = memories
      .filter((m) => m.kind === "fact" || m.kind === "story_seed" || m.kind === "person" || m.kind === "place")
      .sort((a, b) => (b.lastMentionedAt ?? b._creationTime) - (a.lastMentionedAt ?? a._creationTime))
      .slice(0, 30)
      .map((m) => (m.name ? `${m.name}: ${m.text}` : m.text));
    const covered = [
      ...memories.filter((m) => m.kind === "topic_covered").map((m) => m.text),
      ...context.recentlyUsedTopics,
    ];
    const avoid = [...memories.filter((m) => m.kind === "avoid").map((m) => m.text), ...(profile?.topicsToAvoid ?? [])];

    const feedbackPosts = await attempt(
      errors,
      "engagement",
      () => ctx.runQuery(engagementRecentFeedback, { elderId: args.elderId, sinceDays: 14 }),
      [],
    );
    const feedback = feedbackPosts.length
      ? await attempt(
          errors,
          "summarizeFeedback",
          () =>
            ctx.runAction(internal.llm.summarizeFeedback, {
              posts: feedbackPosts.map((p) => ({
                linkedinUrl: p.linkedinUrl,
                ...(p.postText ? { postText: p.postText } : {}),
                reactions: p.reactions,
                comments: p.comments,
              })),
            }),
          { resonated: "", readerQuestions: [] as string[], line: "" },
        )
      : { resonated: "", readerQuestions: [] as string[], line: "" };

    const audienceRows = await attempt<{ _id: string; title: string }[]>(
      errors,
      "audienceQuestions",
      () => ctx.runQuery(internal.apify.topAudienceQuestions, { elderId: args.elderId, limit: 8 }),
      [],
    );
    const audienceQuestions = [
      ...audienceRows.map((r) => ({ id: String(r._id), title: r.title })),
      ...(args.freshAudience ?? []),
    ].filter((q, i, all) => all.findIndex((x) => x.id === q.id) === i);
    const recentTopics: RecentTopic[] = args.recentTopics ?? [];

    let usedClaude = true;
    let candidates: Candidate[] = await attempt(
      errors,
      "planQuestions",
      async () =>
        (
          await ctx.runAction(internal.llm.planQuestions, {
            ...(profile ? { profile } : {}),
            openThreads,
            memories: storyMemories,
            covered,
            avoid,
            readerQuestions: feedback.readerQuestions,
            audienceQuestions,
            recentTopics,
          })
        ).candidates,
      [],
    );
    if (candidates.length === 0) {
      usedClaude = false;
      candidates = fallbackCandidates({
        openThreads,
        readerQuestions: feedback.readerQuestions,
        audienceQuestions,
        recentTopics,
      });
    }

    // Keep what's already queued in the mix so its age (firstSeenAt) carries over.
    const existing: Candidate[] = context.queued.map((r) => ({
      question: r.question,
      why: r.why,
      source: r.source as CandidateSource,
      ...(r.sourceRef ? { sourceRef: r.sourceRef } : {}),
      topicKey: r.topicKey,
      firstSeenAt: r.firstSeenAt,
    }));
    const ranked = rankCandidates([...candidates, ...existing], { avoid, covered, now: Date.now(), limit: 12 });
    await ctx.runMutation(internal.conversation.replaceQueued, {
      elderId: args.elderId,
      items: ranked.map((r) => ({
        question: r.question,
        why: r.why,
        source: r.source,
        ...(r.sourceRef ? { sourceRef: r.sourceRef } : {}),
        topicKey: r.topicKey,
        priority: r.priority,
        firstSeenAt: r.firstSeenAt,
      })),
    });
    return { queued: ranked.length, usedClaude, errors };
  },
});

type PrepareResult = RefreshResult & { recentTopics: number; audience: string };

export const prepareCall = internalAction({
  args: { elderId: v.id("elders") },
  handler: async (ctx, { elderId }): Promise<PrepareResult> => {
    const errors: string[] = [];
    const context: PlanningContext = await ctx.runQuery(internal.conversation.getPlanningContext, { elderId });
    if (!context.elder) throw new Error("Elder not found");

    // Fresh questions people in his field are asking online (saved by apify itself;
    // refreshQuestionBank reads the best ones back via topAudienceQuestions).
    const audience = await attempt(
      errors,
      "findAudienceQuestions",
      async () => {
        const r = await ctx.runAction(internal.apify.findAudienceQuestions, { elderId });
        return `${r.inserted} new`;
      },
      "failed",
    );
    const recent = await attempt(
      errors,
      "findRecentTopics",
      () =>
        ctx.runAction(internal.llm.findRecentTopics, {
          ...(context.elder?.profile ? { profile: context.elder.profile } : {}),
        }),
      { topics: [] as RecentTopic[] },
    );
    const refreshed: RefreshResult = await ctx.runAction(internal.conversation.refreshQuestionBank, {
      elderId,
      recentTopics: recent.topics,
    });
    return { ...refreshed, errors: [...errors, ...refreshed.errors], recentTopics: recent.topics.length, audience };
  },
});

type PlanResult = { plan: CallPlan; variables: PromptVariables };

export const planNextCall = internalAction({
  args: { elderId: v.id("elders") },
  handler: async (ctx, { elderId }): Promise<PlanResult> => {
    let context: PlanningContext = await ctx.runQuery(internal.conversation.getPlanningContext, { elderId });
    const elder = context.elder;
    if (!elder) throw new Error("Elder not found");

    if (isOnboarding(elder)) {
      let knownBackground = elder.knownBackground ?? "";
      if (!knownBackground && elder.linkedinUrl) {
        try {
          const scraped = await ctx.runAction(internal.apify.scrapeProfile, { elderId });
          knownBackground = scraped.knownBackground;
          if (knownBackground) {
            await ctx.runMutation(internal.conversation.saveKnownBackground, { elderId, knownBackground });
          }
        } catch {
          // No background is fine: Pip just starts from scratch.
        }
      }
      const plan = buildCallPlan({ kind: "onboarding", knownBackground });
      return { plan, variables: toPromptVariables(plan, elder) };
    }

    if (context.queued.length === 0) {
      try {
        await ctx.runAction(internal.conversation.refreshQuestionBank, { elderId });
        context = await ctx.runQuery(internal.conversation.getPlanningContext, { elderId });
      } catch {
        // Falls back to the default opening question below.
      }
    }
    const bank = context.queued.map((r) => ({ _id: String(r._id), question: r.question, topicKey: r.topicKey }));
    const mainQuestion = bank[0]?.question;

    // Memories that relate to today's question, plus people/places so Pip can use names.
    let memories: { kind: string; text: string; name?: string }[] = [];
    try {
      const hits: MemoryHit[] = mainQuestion
        ? await ctx.runAction(memoriesSearch, { elderId, text: mainQuestion, k: 5 })
        : [];
      const people: MemoryHit[] = mainQuestion
        ? await ctx.runAction(memoriesSearch, { elderId, text: mainQuestion, k: 3, kinds: ["person", "place"] })
        : [];
      memories = [...people, ...hits].filter((m) => m.status !== "resolved");
    } catch {
      // Memory search not available yet: plan without it.
    }

    let feedbackLine = "";
    try {
      const posts = await ctx.runQuery(engagementRecentFeedback, { elderId, sinceDays: 10 });
      if (posts.length) {
        const summary = await ctx.runAction(internal.llm.summarizeFeedback, {
          posts: posts.map((p) => ({
            linkedinUrl: p.linkedinUrl,
            ...(p.postText ? { postText: p.postText } : {}),
            reactions: p.reactions,
            comments: p.comments,
          })),
        });
        feedbackLine = summary.line;
      }
    } catch {
      // No feedback line this time.
    }

    const plan = buildCallPlan({ kind: "story", bank, memories, feedbackLine });
    return { plan, variables: toPromptVariables(plan, elder) };
  },
});
