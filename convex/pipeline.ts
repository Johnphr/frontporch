// After a call ends (scheduled by cartesia.pollCall).
//
//   processCall({ callId }):
//     1. claimProcessing: atomic, so two runs can't both process one call (a claim older
//        than 15 min is assumed crashed and can be retaken)
//     2. voicemail / no answer / under 30 words from him -> status `no_conversation`
//     3. onboarding: llm.extractProfile (merged with what earlier calls learned) ->
//        elders.profile; stage -> "active" once the profile is usable, else he gets
//        another onboarding call. No post from onboarding (team default 3). Then a
//        question-bank refresh is scheduled (best effort) so the first story call has one.
//        story (slices 2-3), each step isolated (lib/planner.runSteps):
//          memories  llm.extractKnowledge -> memories.addMany (+ resolve the open threads he
//                    finished; only thread ids we sent are passed back)
//          post      llm.writePost, given the time left of the 10-min action limit
//                    (lib/postQuality.postBudgetMs; may decline: no post; below the quality bar -> saved as
//                    needs_review, not posted) -> one posts row per call
//                    (posts.by_call) -> linkedapi.createPost, scheduled only for a new row
//                    and only when AUTO_POST isn't "off" (off = preview-only, for tests)
//          plan      conversation.refreshQuestionBank (scheduled)
//     4. status `done` + processedAt; any error (or a failed post / plan step) -> `process_failed`
//        + error. Memories are best effort: if that step fails the call is still `done`, with
//        error "memories step failed (not retried)". A retry is safe: memories.addMany skips a
//        callId it already has and the post row is reused, so no duplicate memories or post.
//
// Retry by hand: npx convex run pipeline:processCall '{"callId":"<id>"}'
// Without a phone: pipeline:seedEndedCall with a tests/fixtures call (convex/README.md).
// Owner: Core: Brain.

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, type ActionCtx } from "./_generated/server";
import { clip, isNoConversation, type Turn } from "./lib/cartesia";
import type { MemoryDoc } from "./lib/dataRefs";
import { markBankRowUsed } from "./conversation";
import { inboundPlanToMark } from "./lib/inbound";
import { canClaimProcessing, finishPatch, isProfileUsable, mergeProfile, type Profile } from "./lib/onboarding";
import { runSteps, type StepReport } from "./lib/planner";
import { parseAutoPost } from "./lib/postFlow";
import { MIN_POST_BUDGET_MS, holdDecision, postBudgetMs } from "./lib/postQuality";
import { postQuality } from "./schema";

// Convex exposes env vars on process.env (declared so we don't need @types/node).
declare const process: { env: Record<string, string | undefined> };

const PROCESSABLE = new Set(["ended", "process_failed"]);

export const claimProcessing = internalMutation({
  args: { callId: v.id("calls") },
  handler: async (ctx, { callId }) => {
    const call = await ctx.db.get(callId);
    if (!call) return { ok: false as const, reason: "Call not found" };
    if (!PROCESSABLE.has(call.status)) return { ok: false as const, reason: `Call is "${call.status}"` };
    const check = canClaimProcessing(call, Date.now());
    if (!check.ok) return check;
    const elder = await ctx.db.get(call.elderId);
    if (!elder) return { ok: false as const, reason: "Elder not found" };
    await ctx.db.patch(callId, { processingAt: Date.now() });
    return {
      ok: true as const,
      call: { kind: call.kind, endReason: call.endReason, transcript: call.transcript },
      elder: { _id: elder._id, profile: elder.profile, knownBackground: elder.knownBackground },
    };
  },
});

export const finishProcessing = internalMutation({
  args: { callId: v.id("calls"), status: v.string(), error: v.optional(v.string()) },
  handler: async (ctx, { callId, status, error }) => {
    // Releases the claim (a failed run can be retried right away); keeps Cartesia's reason.
    await ctx.db.patch(callId, finishPatch(status, error, Date.now()));
    // Inbound: his question counts as used only now that a real conversation happened.
    const call = await ctx.db.get(callId);
    const bankId = inboundPlanToMark(call, status);
    const bankDocId = bankId ? ctx.db.normalizeId("questionBank", bankId) : null;
    if (call && bankDocId) await markBankRowUsed(ctx, call.elderId, bankDocId, callId);
  },
});

/** Merges inside the transaction, so two calls processed at once can't drop an update. */
export const saveProfile = internalMutation({
  args: {
    elderId: v.id("elders"),
    extracted: v.object({
      industry: v.optional(v.string()),
      specialty: v.optional(v.string()),
      careerSummary: v.optional(v.string()),
      topics: v.optional(v.array(v.string())),
      storySeeds: v.optional(v.array(v.string())),
      topicsToAvoid: v.optional(v.array(v.string())),
    }),
  },
  handler: async (ctx, { elderId, extracted }): Promise<{ usable: boolean }> => {
    const elder = await ctx.db.get(elderId);
    if (!elder) throw new Error("Elder not found");
    const profile = mergeProfile(elder.profile, extracted);
    const usable = isProfileUsable(profile);
    await ctx.db.patch(elderId, { profile, stage: usable ? "active" : "onboarding" });
    return { usable };
  },
});

/** One post per call: returns the existing row if this call already has one. */
export const insertPost = internalMutation({
  args: {
    elderId: v.id("elders"),
    callId: v.id("calls"),
    text: v.string(),
    // Post quality (lib/postQuality.ts): below the bar it's saved held. The judge's notes stay on
    // `quality` only (shown once on /posts); guardIssues is left for the fact-check.
    quality: v.optional(postQuality),
    hold: v.optional(v.object({ summary: v.string() })),
  },
  handler: async (ctx, args): Promise<{ postId: Id<"posts">; created: boolean }> => {
    const existing = await ctx.db
      .query("posts")
      .withIndex("by_call", (q) => q.eq("callId", args.callId))
      .first();
    if (existing) return { postId: existing._id, created: false };
    const postId = await ctx.db.insert("posts", {
      elderId: args.elderId,
      callId: args.callId,
      text: args.text,
      status: args.hold ? "needs_review" : "pending",
      ...(args.quality ? { quality: args.quality } : {}),
      ...(args.hold ? { heldFor: "quality" as const, guardSummary: args.hold.summary } : {}),
    });
    return { postId, created: true };
  },
});

export const findPostForCall = internalQuery({
  args: { callId: v.id("calls") },
  handler: async (ctx, { callId }) => {
    const post = await ctx.db
      .query("posts")
      .withIndex("by_call", (q) => q.eq("callId", callId))
      .first();
    return post ? { postId: post._id, status: post.status } : null;
  },
});

/**
 * Dev/testing: a finished call from a fixture (tests/fixtures/onboarding_call.json,
 * story_call.json), so the whole post-call flow runs without a phone. Use a throwaway seeded
 * elder: fixture facts merge into his profile and memories. A story fixture would post to his
 * real LinkedIn, so it's refused while posting is live unless allowPost is set.
 */
export const seedEndedCall = internalMutation({
  args: {
    elderId: v.id("elders"),
    kind: v.union(v.literal("onboarding"), v.literal("story")),
    turns: v.array(v.object({ role: v.union(v.literal("pip"), v.literal("elder")), text: v.string() })),
    summary: v.optional(v.string()),
    endReason: v.optional(v.string()),
    cartesiaCallId: v.optional(v.string()),
    allowPost: v.optional(v.boolean()),
  },
  handler: async (ctx, { elderId, kind, turns, allowPost, ...rest }) => {
    const postingLive =
      parseAutoPost(process.env.AUTO_POST) && Boolean(process.env.LINKEDAPI_TOKEN && process.env.LINKEDAPI_ID_TOKEN);
    if (kind === "story" && postingLive && !allowPost) {
      throw new Error("This fixture would post to his LinkedIn: set AUTO_POST=off (or pass allowPost: true)");
    }
    const callId = await ctx.db.insert("calls", { elderId, kind, status: "ended", transcript: turns, ...rest });
    await ctx.scheduler.runAfter(0, internal.pipeline.processCall, { callId });
    return callId;
  },
});

/** Story call steps (slices 2-3). Each step is isolated; processCall decides which failures retry. */
async function runStoryCall(
  ctx: ActionCtx,
  callId: Id<"calls">,
  elder: { _id: Id<"elders">; profile?: Profile },
  turns: Turn[],
  startedAt: number, // when processCall started: the post step stays inside the 10-min action limit
): Promise<StepReport[]> {
  const profile = elder.profile;
  return runSteps([
    {
      step: "memories",
      run: async () => {
        let open: MemoryDoc[] = [];
        try {
          open = await ctx.runQuery(internal.memories.listForElder, {
            elderId: elder._id,
            kinds: ["open_thread"],
            status: "active",
            limit: 20,
          });
        } catch {
          // memories.listForElder unavailable: extract without open threads
        }
        const knowledge = await ctx.runAction(internal.llm.extractKnowledge, {
          turns,
          ...(profile ? { profile } : {}),
          openThreads: open.map((m) => ({ id: m._id, text: m.text })),
        });
        // Only ids we actually sent: a garbled id from the model would fail
        // addMany's v.id("memories") validator and lose the whole batch.
        const openIds = new Map(open.map((m) => [String(m._id), m._id]));
        const resolveThreadIds = knowledge.resolvedThreadIds
          .map((id) => openIds.get(id))
          .filter((id): id is Id<"memories"> => id !== undefined);
        if (knowledge.items.length === 0 && resolveThreadIds.length === 0) return "nothing new";
        const saved = await ctx.runAction(internal.memories.addMany, {
          elderId: elder._id,
          callId,
          items: knowledge.items,
          ...(resolveThreadIds.length ? { resolveThreadIds } : {}),
        });
        return `${saved.inserted} new, ${saved.merged} merged, ${saved.resolved} threads resolved`;
      },
    },
    {
      step: "post",
      run: async () => {
        // A retry reuses the call's post instead of writing another.
        const already = await ctx.runQuery(internal.pipeline.findPostForCall, { callId });
        if (already) return `post ${already.postId} already exists (${already.status})`;
        const saved = await ctx.runQuery(internal.conversation.getSavedFeedback, { elderId: elder._id });
        const feedback = saved?.resonated || saved?.feedbackLine || "";
        // What's left of processCall's 10 minutes (lib/postQuality.ts, "Time"). Too little:
        // fail the step (process_failed) rather than be cut off mid-write; a retry is safe.
        const budgetMs = postBudgetMs(startedAt, Date.now());
        if (budgetMs < MIN_POST_BUDGET_MS) throw new Error("not enough time left in this run for the post step");
        const post = await ctx.runAction(internal.llm.writePost, {
          turns,
          ...(profile ? { profile } : {}),
          ...(feedback ? { feedback } : {}),
          budgetMs,
        });
        if (post.skip) return `no post: ${post.reason}`;
        // Below the quality bar: saved as needs_review (shown on /posts), never auto-posted.
        const hold = holdDecision(post.quality);
        const { postId, created } = await ctx.runMutation(internal.pipeline.insertPost, {
          elderId: elder._id,
          callId,
          text: post.text,
          quality: post.quality,
          ...(hold ? { hold: { summary: hold.summary } } : {}),
        });
        if (!created) return `post ${postId} already exists`;
        if (hold) return `post ${postId} held for review (quality ${post.quality.score}/100); post it with linkedapi:approvePost`;
        // AUTO_POST=off (tests): keep the row `pending`; preview with linkedapi:previewPost,
        // post on purpose with linkedapi:createPost.
        if (!parseAutoPost(process.env.AUTO_POST)) {
          return `post ${postId} saved, preview only (AUTO_POST=off)`;
        }
        // Posting runs on its own (guard + LinkedAPI + polling) so it can't hold up the rest.
        await ctx.scheduler.runAfter(0, internal.linkedapi.createPost, { postId });
        return `post ${postId} scheduled`;
      },
    },
    {
      step: "plan",
      run: async () => {
        await ctx.scheduler.runAfter(0, internal.conversation.refreshQuestionBank, { elderId: elder._id });
        return "question bank refresh scheduled";
      },
    },
  ]);
}

export const processCall = internalAction({
  args: { callId: v.id("calls") },
  handler: async (ctx, { callId }): Promise<{ status: string; reason?: string }> => {
    const startedAt = Date.now();
    const claim = await ctx.runMutation(internal.pipeline.claimProcessing, { callId });
    if (!claim.ok) return { status: "skipped", reason: claim.reason };
    const { call, elder } = claim;

    try {
      const turns = call.transcript as Turn[];
      if (isNoConversation(call.endReason, turns)) {
        await ctx.runMutation(internal.pipeline.finishProcessing, { callId, status: "no_conversation" });
        console.log(`pipeline.processCall: call ${callId} no_conversation (${call.endReason ?? "few words"})`);
        return { status: "no_conversation" };
      }
      if (call.kind === "story") {
        const steps = await runStoryCall(ctx, callId, elder, turns, startedAt);
        // Memories are best effort (e.g. no OPENAI_API_KEY yet): only the post and the plan refresh
        // decide on a retry; a lost memories step stays visible as a fixed marker on the `done` row.
        const failed = steps.filter((s) => s.status === "failed" && s.step !== "memories");
        const memoriesLost = steps.some((s) => s.step === "memories" && s.status === "failed");
        // Step details can quote the model or his words: keep only step names in errors.
        const error = failed.length
          ? `story steps failed: ${failed.map((s) => s.step).join(", ")}`
          : memoriesLost ? "memories step failed (not retried)" : undefined;
        await ctx.runMutation(internal.pipeline.finishProcessing, {
          callId,
          status: failed.length ? "process_failed" : "done",
          ...(error ? { error } : {}),
        });
        console.log(`pipeline.processCall: call ${callId} story ${failed.length ? "process_failed" : "done"}`, JSON.stringify(steps.map((s) => `${s.step}:${s.status}`)));
        return failed.length ? { status: "process_failed", reason: error } : { status: "done" };
      }
      if (call.kind !== "onboarding") throw new Error(`Unknown call kind "${call.kind ?? "unknown"}"`);

      const extracted: Profile = await ctx.runAction(internal.llm.extractProfile, {
        turns: call.transcript,
        knownBackground: elder.knownBackground,
        existingProfile: elder.profile,
      });
      const { usable } = await ctx.runMutation(internal.pipeline.saveProfile, { elderId: elder._id, extracted });
      await ctx.runMutation(internal.pipeline.finishProcessing, { callId, status: "done" });
      if (usable) {
        // Best effort: have a question bank ready for his first story call.
        try {
          await ctx.scheduler.runAfter(0, internal.conversation.refreshQuestionBank, { elderId: elder._id });
        } catch {
          console.warn(`pipeline.processCall: call ${callId} bank refresh not scheduled`);
        }
      }
      console.log(`pipeline.processCall: call ${callId} done (profile ${usable ? "usable, stage active" : "thin, onboarding again"})`);
      return { status: "done" };
    } catch (err) {
      const error = clip(err instanceof Error ? err.message : String(err));
      await ctx.runMutation(internal.pipeline.finishProcessing, { callId, status: "process_failed", error });
      console.warn(`pipeline.processCall: call ${callId} process_failed`);
      return { status: "process_failed", reason: error };
    }
  },
});
