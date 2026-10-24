// Post-call pipeline. After a Cartesia call ends, cartesia.pollCall does:
//   const turns = normalizeCartesiaTranscript(call.transcript)        (lib/cartesiaTranscript.ts)
//   const callId = await ctx.runMutation(internal.pipeline.recordCallResult, {
//     cartesiaCallId, elderId, kind, turns, summary, endReason })
//   await ctx.scheduler.runAfter(0, internal.pipeline.processCall, { callId })
//
// processCall runs ONCE per call: it claims the calls row (sets processedAt) before
// doing anything, so a retry or a second trigger is a no-op. To re-run on purpose
// (e.g. after fixing a failed step), use pipeline.reprocessCall({ callId }).
//
// Steps (each isolated: one failure never stops the rest):
//   1. memories    llm.extractKnowledge -> memories.addMany (+ resolve finished open threads)
//   2. profile     onboarding: llm.extractProfile -> elders.profile; stage "active" once usable
//      post        story call: llm.writePost (may decline) -> one posts row per call
//                  -> linkedapi.createPost (scheduled; it has its own claim, no double posting)
//   3. plan        conversation.refreshQuestionBank (scheduled)
// Steps are skipped on voicemail / no answer / failed dials, or when he barely spoke
// (a call that merely ended on silence or a hang-up still counts).
// Returns a step report, visible in the Convex dashboard logs.
//
// Owner: Core: Brain.

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { memoriesAddMany, memoriesListForElder, type MemoryDoc } from "./lib/dataRefs";
import {
  isNearSilentCall,
  isNoConversation,
  isUsableProfile,
  processDecision,
  runSteps,
  type StepReport,
} from "./lib/planner";
import { asElderV2 } from "./lib/v2Fields";
import { elderProfile } from "./schema";

const turnValidator = v.object({ role: v.union(v.literal("pip"), v.literal("elder")), text: v.string() });
const kindValidator = v.union(v.literal("onboarding"), v.literal("story"));

// ---------- recording the call (called by cartesia.pollCall) ----------

/**
 * Save a finished Cartesia call on its calls row (found by cartesiaCallId, created if
 * missing). Returns the callId to pass to processCall.
 */
export const recordCallResult = internalMutation({
  args: {
    cartesiaCallId: v.string(),
    elderId: v.id("elders"),
    kind: kindValidator,
    turns: v.array(turnValidator),
    summary: v.optional(v.string()),
    endReason: v.string(),
  },
  handler: async (ctx, r): Promise<Id<"calls">> => {
    const existing = await ctx.db
      .query("calls")
      .withIndex("by_cartesia", (q) => q.eq("cartesiaCallId", r.cartesiaCallId))
      .first();
    if (existing && existing.elderId !== r.elderId) {
      throw new Error(`Cartesia call ${r.cartesiaCallId} belongs to another elder`);
    }
    const fields = {
      status: "completed",
      kind: r.kind,
      transcript: r.turns,
      endReason: r.endReason,
      ...(r.summary ? { summary: r.summary } : {}),
    };
    if (existing) {
      await ctx.db.patch(existing._id, fields);
      return existing._id;
    }
    return ctx.db.insert("calls", { elderId: r.elderId, cartesiaCallId: r.cartesiaCallId, ...fields });
  },
});

// ---------- claim + helpers ----------

type ClaimedCall = {
  callId: Id<"calls">;
  elderId: Id<"elders">;
  kind: "onboarding" | "story";
  turns: { role: string; text: string }[];
  endReason: string;
  cartesiaCallId?: string;
};

type ClaimResult = { ok: true; call: ClaimedCall } | { ok: false; reason: string };

/** Atomic: read the call and set processedAt in one transaction, or say why not. */
export const claimCall = internalMutation({
  args: { callId: v.id("calls") },
  handler: async (ctx, { callId }): Promise<ClaimResult> => {
    const call = await ctx.db.get(callId);
    const decision = processDecision(call);
    if (decision.action === "skip" || !call) {
      return { ok: false, reason: decision.action === "skip" ? decision.reason : "not found" };
    }
    await ctx.db.patch(callId, { processedAt: Date.now() });
    return {
      ok: true,
      call: {
        callId,
        elderId: call.elderId,
        kind: call.kind ?? "story",
        turns: call.transcript,
        endReason: call.endReason ?? "",
        ...(call.cartesiaCallId ? { cartesiaCallId: call.cartesiaCallId } : {}),
      },
    };
  },
});

/**
 * Deliberate re-run: clears processedAt and schedules processCall again. Memories
 * merge (addMany skips a callId it already has) and the post row is reused, so this
 * never creates a second LinkedIn post.
 */
export const reprocessCall = internalMutation({
  args: { callId: v.id("calls") },
  handler: async (ctx, { callId }) => {
    const call = await ctx.db.get(callId);
    if (!call) throw new Error("Call not found");
    await ctx.db.patch(callId, { processedAt: undefined });
    await ctx.scheduler.runAfter(0, internal.pipeline.processCall, { callId });
    return { scheduled: true };
  },
});

export const getElderProfile = internalQuery({
  args: { elderId: v.id("elders") },
  handler: async (ctx, { elderId }) => {
    const elder = asElderV2(await ctx.db.get(elderId));
    return elder ? { profile: elder.profile ?? null, knownBackground: elder.knownBackground ?? null } : null;
  },
});

/** Save the profile; he moves to story calls only once it's usable (else onboard again). */
export const saveProfile = internalMutation({
  args: { elderId: v.id("elders"), profile: elderProfile },
  handler: async (ctx, { elderId, profile }): Promise<{ stage: "onboarding" | "active" }> => {
    const stage = isUsableProfile(profile) ? "active" : "onboarding";
    await ctx.db.patch(elderId, { profile, stage });
    return { stage };
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

// ---------- the pipeline ----------

type ProcessResult =
  | { callId: Id<"calls">; steps: StepReport[] }
  | { callId: Id<"calls">; skipped: string };

export const processCall = internalAction({
  args: { callId: v.id("calls") },
  handler: async (ctx, { callId }): Promise<ProcessResult> => {
    const claim: ClaimResult = await ctx.runMutation(internal.pipeline.claimCall, { callId });
    if (!claim.ok) {
      console.log(`processCall ${callId} skipped: ${claim.reason}`);
      return { callId, skipped: claim.reason };
    }
    const call = claim.call;
    const skipContent = isNoConversation(call.endReason)
      ? `no conversation (${call.endReason})`
      : isNearSilentCall(call.turns)
        ? "he barely spoke"
        : false;

    const elderInfo = await ctx.runQuery(internal.pipeline.getElderProfile, { elderId: call.elderId });
    const profile = elderInfo?.profile ?? undefined;

    const steps = await runSteps([
      {
        step: "memories",
        skip: skipContent,
        run: async () => {
          let open: MemoryDoc[] = [];
          try {
            open = await ctx.runQuery(memoriesListForElder, {
              elderId: call.elderId,
              kinds: ["open_thread"],
              status: "active",
              limit: 20,
            });
          } catch {
            // memories.listForElder unavailable: extract without open threads
          }
          const knowledge = await ctx.runAction(internal.llm.extractKnowledge, {
            turns: call.turns,
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
            elderId: call.elderId,
            callId,
            items: knowledge.items,
            ...(resolveThreadIds.length ? { resolveThreadIds } : {}),
          });
          return `${saved.inserted} new, ${saved.merged} merged, ${saved.resolved} threads resolved`;
        },
      },
      call.kind === "onboarding"
        ? {
            step: "profile",
            skip: skipContent,
            run: async () => {
              const newProfile = await ctx.runAction(internal.llm.extractProfile, {
                turns: call.turns,
                ...(elderInfo?.knownBackground ? { knownBackground: elderInfo.knownBackground } : {}),
              });
              const { stage } = await ctx.runMutation(internal.pipeline.saveProfile, {
                elderId: call.elderId,
                profile: newProfile,
              });
              return `${newProfile.industry || "?"} / ${newProfile.specialty || "?"} -> stage ${stage}`;
            },
          }
        : {
            step: "post",
            skip: skipContent,
            run: async () => {
              // A re-run (reprocessCall) reuses the call's post instead of writing another.
              const already = await ctx.runQuery(internal.pipeline.findPostForCall, { callId });
              if (already) return `post ${already.postId} already exists (${already.status})`;
              const saved = await ctx.runQuery(internal.conversation.getSavedFeedback, { elderId: call.elderId });
              const feedback = saved?.resonated || saved?.feedbackLine || "";
              const post = await ctx.runAction(internal.llm.writePost, {
                turns: call.turns,
                ...(profile ? { profile } : {}),
                ...(feedback ? { feedback } : {}),
              });
              if (post.skip) return `no post: ${post.reason}`;
              const { postId, created } = await ctx.runMutation(internal.pipeline.insertPost, {
                elderId: call.elderId,
                callId,
                text: post.text,
              });
              if (!created) return `post ${postId} already exists`;
              // Posting runs on its own (guard + LinkedAPI + polling) so it can't hold up the rest.
              await ctx.scheduler.runAfter(0, internal.linkedapi.createPost, { postId });
              return `post ${postId} scheduled`;
            },
          },
      {
        step: "plan",
        skip: skipContent,
        run: async () => {
          await ctx.scheduler.runAfter(0, internal.conversation.refreshQuestionBank, { elderId: call.elderId });
          return "question bank refresh scheduled";
        },
      },
    ]);

    console.log(`processCall ${callId} (${call.cartesiaCallId ?? "no cartesia id"})`, JSON.stringify(steps));
    return { callId, steps };
  },
});
