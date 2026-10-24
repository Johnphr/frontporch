// The question planner: what Pip talks about next.
//
//   refreshQuestionBank({ elderId })  after every call, when reader comments arrive,
//                                     and from prepareCall. Rebuilds the ranked bank
//                                     from his profile, open threads, memories,
//                                     reader feedback, audience + recent topics.
//   prepareCall({ elderId })          ~1h before his call (schedule.tick): fresh
//                                     audience questions (Apify) and recent topics in
//                                     his field (Claude web search), in parallel, then
//                                     schedules a refresh with them.
//   planNextCall({ elderId })         at call time -> { plan, dynamicVariables }. The
//                                     kind comes from PR #7's lib/onboarding.planNextCall
//                                     (cartesia.reserveCall uses the same rule). Onboarding:
//                                     PR #7's buildOnboardingVariables (first_name,
//                                     known_background). Story: question bank + memories +
//                                     avoid topics + saved feedback line, as Cartesia
//                                     dynamic_variables for voice/prompts/story-call.md.
//                                     Fast: never waits on a refresh or a Claude call.
//                                     cartesia.startCall's story branch (slice 2) calls it.
//   markPlanUsed({ elderId, bankId, callId })   cartesia.startCall, once a story call is placed.
//
// Ranking rules live in lib/planner.ts (pure, tested). Owner: Core: Brain.

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import type { MemoryDoc, MemoryHit } from "./lib/dataRefs";
import {
  FALLBACK_MAIN_QUESTION,
  buildCallPlan,
  fallbackCandidates,
  firstBankQuestion,
  rankCandidates,
  toPromptVariables,
  type CallPlan,
  type Candidate,
  type CandidateSource,
} from "./lib/planner";
import { templateVariables } from "./lib/cartesia";
import { buildOnboardingVariables, callLanguage } from "./lib/onboarding";
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
  feedbackLine: string;
  resonated: string;
};

const RECENTLY_USED_COUNT = 10;

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
    // Most recently used first (by usedAt), so "recently asked" really is recent.
    const used = await ctx.db
      .query("questionBank")
      .withIndex("by_elder_status_usedAt", (q) => q.eq("elderId", elderId).eq("status", "used"))
      .order("desc")
      .take(RECENTLY_USED_COUNT);
    const recentlyUsedTopics = used.map((u) => u.topicKey.replace(/-/g, " "));
    const meta = await ctx.db
      .query("questionBankMeta")
      .withIndex("by_elder", (q) => q.eq("elderId", elderId))
      .first();
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
      feedbackLine: meta?.feedbackLine ?? "",
      resonated: meta?.resonated ?? "",
    };
  },
});

/** The feedback the last refresh worked out (for the post writer). */
export const getSavedFeedback = internalQuery({
  args: { elderId: v.id("elders") },
  handler: async (ctx, { elderId }): Promise<{ feedbackLine: string; resonated: string } | null> => {
    const meta = await ctx.db
      .query("questionBankMeta")
      .withIndex("by_elder", (q) => q.eq("elderId", elderId))
      .first();
    return meta ? { feedbackLine: meta.feedbackLine, resonated: meta.resonated } : null;
  },
});

/** Swap the queued bank for a freshly ranked one. Used rows stay as history. */
export const replaceQueued = internalMutation({
  args: {
    elderId: v.id("elders"),
    items: v.array(bankItemValidator),
    feedbackLine: v.optional(v.string()),
    resonated: v.optional(v.string()),
  },
  handler: async (ctx, { elderId, items, feedbackLine, resonated }) => {
    const old = await ctx.db
      .query("questionBank")
      .withIndex("by_elder_status_priority", (q) => q.eq("elderId", elderId).eq("status", "queued"))
      .collect();
    for (const row of old) await ctx.db.delete(row._id);
    for (const item of items) {
      await ctx.db.insert("questionBank", { elderId, ...item, status: "queued" });
    }
    if (feedbackLine !== undefined || resonated !== undefined) {
      const meta = await ctx.db
        .query("questionBankMeta")
        .withIndex("by_elder", (q) => q.eq("elderId", elderId))
        .first();
      const fields = { feedbackLine: feedbackLine ?? "", resonated: resonated ?? "", refreshedAt: Date.now() };
      if (meta) await ctx.db.patch(meta._id, fields);
      else await ctx.db.insert("questionBankMeta", { elderId, ...fields });
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
 * cartesia.startCall calls this once the call is placed, with plan.bankId from
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
      () => ctx.runQuery(internal.memories.listForElder, { elderId: args.elderId, limit: 200 }),
      [],
    );
    const openThreads = memories
      .filter((m) => m.kind === "open_thread" && m.status !== "resolved")
      .slice(0, 15)
      .map((m) => ({ id: m._id, text: m.text }));
    // Story seeds from onboarding (profile) come first: they're the slice-2 call topics.
    const storyMemories = [
      ...(profile?.storySeeds ?? []).map((seed) => `Story seed: ${seed}`),
      ...memories
        .filter((m) => m.kind === "fact" || m.kind === "story_seed" || m.kind === "person" || m.kind === "place")
        .sort((a, b) => (b.lastMentionedAt ?? b._creationTime) - (a.lastMentionedAt ?? a._creationTime))
        .slice(0, 30)
        .map((m) => (m.name ? `${m.name}: ${m.text}` : m.text)),
    ];
    // covered: topics he already talked about (open threads / readers may revisit them).
    // recentlyUsed: topics of questions asked in his last calls (never repeated).
    const covered = memories.filter((m) => m.kind === "topic_covered").map((m) => m.text);
    const recentlyUsed = context.recentlyUsedTopics;
    const avoid = [...memories.filter((m) => m.kind === "avoid").map((m) => m.text), ...(profile?.topicsToAvoid ?? [])];

    const feedbackPosts = await attempt(
      errors,
      "engagement",
      () => ctx.runQuery(internal.engagement.recentFeedback, { elderId: args.elderId, sinceDays: 14 }),
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
            recentlyAsked: recentlyUsed,
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

    // Keep what's already queued in the mix so its age (firstSeenAt) carries over
    // (rankCandidates keeps the oldest firstSeenAt per topic, whatever the order).
    const existing: Candidate[] = context.queued.map((r) => ({
      question: r.question,
      why: r.why,
      source: r.source as CandidateSource,
      ...(r.sourceRef ? { sourceRef: r.sourceRef } : {}),
      topicKey: r.topicKey,
      firstSeenAt: r.firstSeenAt,
    }));
    const ranked = rankCandidates([...candidates, ...existing], {
      avoid,
      covered,
      recentlyUsed,
      now: Date.now(),
      limit: 12,
    });
    await ctx.runMutation(internal.conversation.replaceQueued, {
      elderId: args.elderId,
      feedbackLine: feedback.line,
      resonated: feedback.resonated,
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

type PrepareResult = { refreshScheduled: boolean; recentTopics: number; audience: string; errors: string[] };

export const prepareCall = internalAction({
  args: { elderId: v.id("elders") },
  handler: async (ctx, { elderId }): Promise<PrepareResult> => {
    const errors: string[] = [];
    const context: PlanningContext = await ctx.runQuery(internal.conversation.getPlanningContext, { elderId });
    if (!context.elder) throw new Error("Elder not found");

    // Both lookups run at once (each can take minutes). Apify saves its own results;
    // refreshQuestionBank reads the best ones back via topAudienceQuestions.
    const [audienceRun, recentRun] = await Promise.allSettled([
      ctx.runAction(internal.apify.findAudienceQuestions, { elderId }),
      ctx.runAction(internal.llm.findRecentTopics, {
        ...(context.elder.profile ? { profile: context.elder.profile } : {}),
      }),
    ]);
    const message = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));
    let audience = "failed";
    if (audienceRun.status === "fulfilled") audience = `${audienceRun.value.inserted} new`;
    else errors.push(`findAudienceQuestions: ${message(audienceRun.reason)}`);
    let recentTopics: RecentTopic[] = [];
    if (recentRun.status === "fulfilled") recentTopics = recentRun.value.topics;
    else errors.push(`findRecentTopics: ${message(recentRun.reason)}`);

    // The refresh runs on its own so this action stays well inside Convex's time limit.
    await ctx.scheduler.runAfter(0, internal.conversation.refreshQuestionBank, { elderId, recentTopics });
    if (errors.length) console.warn(`prepareCall ${elderId} failed: ${errors.map((e) => e.split(":")[0]).join(", ")}`);
    return { refreshScheduled: true, recentTopics: recentTopics.length, audience, errors };
  },
});

/** cartesia.startCall sends dynamicVariables as `dynamic_variables` on POST /agents/calls. */
type PlanResult = { plan: CallPlan; dynamicVariables: Record<string, string> };

export const planNextCall = internalAction({
  args: { elderId: v.id("elders") },
  handler: async (ctx, { elderId }): Promise<PlanResult> => {
    const context: PlanningContext = await ctx.runQuery(internal.conversation.getPlanningContext, { elderId });
    const elder = context.elder;
    if (!elder) throw new Error("Elder not found");
    const lang = callLanguage(elder.language);

    // Topics he doesn't want to discuss always reach Pip (outside the memories budget).
    let avoidMemories: string[] = [];
    try {
      const rows: MemoryDoc[] = await ctx.runQuery(internal.memories.listForElder, { elderId, kinds: ["avoid"], limit: 10 });
      avoidMemories = rows.map((m) => m.text);
    } catch {
      // memories not available: the profile's topicsToAvoid still go through.
    }

    if (isOnboarding(elder)) {
      // Same variables cartesia.startCall sends (it scrapes + caches the background; we read the cache).
      const knownBackground = elder.knownBackground ?? "";
      const plan = buildCallPlan({ kind: "onboarding", knownBackground });
      return { plan, dynamicVariables: buildOnboardingVariables(elder, knownBackground, lang) };
    }

    if (context.queued.length === 0) {
      // Don't make the call wait: use the default question now and fill the bank for next time.
      await ctx.scheduler.runAfter(0, internal.conversation.refreshQuestionBank, { elderId });
    }
    const bank = context.queued.map((r) => ({ _id: String(r._id), question: r.question, topicKey: r.topicKey }));
    const question = firstBankQuestion(bank)?.question ?? FALLBACK_MAIN_QUESTION;

    // Memories related to today's question, plus people/places so Pip can use names. Each
    // embedding request is capped (memories.ts), so this can't stall the call. Unfinished-story
    // memories stay out: they'd read as a second plan (the question bank already ranks them first).
    const settled = await Promise.allSettled([
      ctx.runAction(internal.memories.search, { elderId, text: question, k: 3, kinds: ["person", "place"] }),
      ctx.runAction(internal.memories.search, { elderId, text: question, k: 5 }),
    ]);
    const hits: MemoryHit[] = settled.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
    const memories = hits.filter((m) => m.status !== "resolved" && m.kind !== "open_thread");

    // Worked out by the last refresh (after the previous call / new comments).
    const feedbackLine = context.feedbackLine;

    const plan = buildCallPlan({ kind: "story", bank, memories, feedbackLine });
    return { plan, dynamicVariables: templateVariables(toPromptVariables(plan, elder, { avoid: avoidMemories, lang })) };
  },
});
