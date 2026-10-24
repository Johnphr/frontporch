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
//          post      llm.writePost (may decline: no post) -> one posts row per call
//                    (posts.by_call) -> linkedapi.createPost, scheduled only for a new row
//                    and only when AUTO_POST isn't "off" (off = preview-only, for tests)
//          plan      conversation.refreshQuestionBank (scheduled)
//     4. status `done` + processedAt; any error (or a failed story step) -> `process_failed`
//        + error. A retry is safe: memories.addMany skips a callId it already has and the
//        post row is reused, so no duplicate memories or second LinkedIn post.
//
// Retry by hand: npx convex run pipeline:processCall '{"callId":"<id>"}'
// Owner: Core: Brain.

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, type ActionCtx } from "./_generated/server";
import { clip, isNoConversation, type Turn } from "./lib/cartesia";
import { memoriesAddMany, memoriesListForElder, type MemoryDoc } from "./lib/dataRefs";
import { canClaimProcessing, finishPatch, isProfileUsable, mergeProfile, type Profile } from "./lib/onboarding";
import { runSteps, type StepReport } from "./lib/planner";
import { parseAutoPost } from "./lib/postFlow";

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
  args: { elderId: v.id("elders"), callId: v.id("calls"), text: v.string() },
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
      status: "pending",
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

/** Story call steps (slices 2-3). Each step is isolated; the caller turns failures into process_failed. */
async function runStoryCall(
  ctx: ActionCtx,
  callId: Id<"calls">,
  elder: { _id: Id<"elders">; profile?: Profile },
  turns: Turn[],
): Promise<StepReport[]> {
  const profile = elder.profile;
  return runSteps([
    {
      step: "memories",
      run: async () => {
        let open: MemoryDoc[] = [];
        try {
          open = await ctx.runQuery(memoriesListForElder, {
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
        const saved = await ctx.runAction(memoriesAddMany, {
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
        const post = await ctx.runAction(internal.llm.writePost, {
          turns,
          ...(profile ? { profile } : {}),
          ...(feedback ? { feedback } : {}),
        });
        if (post.skip) return `no post: ${post.reason}`;
        const { postId, created } = await ctx.runMutation(internal.pipeline.insertPost, {
          elderId: elder._id,
          callId,
          text: post.text,
        });
        if (!created) return `post ${postId} already exists`;
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
        const steps = await runStoryCall(ctx, callId, elder, turns);
        const failed = steps.filter((s) => s.status === "failed");
        // Step details can quote the model or his words: keep only step names in errors.
        const error = failed.length ? `story steps failed: ${failed.map((s) => s.step).join(", ")}` : undefined;
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
