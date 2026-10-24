// After a call ends (scheduled by cartesia.pollCall).
//
//   processCall({ callId }):
//     1. claimProcessing: atomic, so two runs can't both process one call (a claim older
//        than 15 min is assumed crashed and can be retaken)
//     2. voicemail / no answer / under 30 words from him -> status `no_conversation`
//     3. onboarding: llm.extractProfile (merged with what earlier calls learned) ->
//        elders.profile; stage -> "active" once the profile is usable, else he gets
//        another onboarding call. No post from onboarding (team default 3).
//     4. status `done` + processedAt; any error -> `process_failed` + error.
//   Story calls (memories, post via linkedapi.createPost) arrive in slice 2.
//
// Retry by hand: npx convex run pipeline:processCall '{"callId":"<id>"}'
// Owner: Core: Brain.

import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, internalMutation } from "./_generated/server";
import { clip, isNoConversation, type Turn } from "./lib/cartesia";
import { canClaimProcessing, finishPatch, isProfileUsable, mergeProfile, type Profile } from "./lib/onboarding";

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
      if (call.kind !== "onboarding") throw new Error(`"${call.kind ?? "unknown"}" calls arrive in slice 2`);

      const extracted: Profile = await ctx.runAction(internal.llm.extractProfile, {
        turns: call.transcript,
        knownBackground: elder.knownBackground,
        existingProfile: elder.profile,
      });
      const { usable } = await ctx.runMutation(internal.pipeline.saveProfile, { elderId: elder._id, extracted });
      await ctx.runMutation(internal.pipeline.finishProcessing, { callId, status: "done" });
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
