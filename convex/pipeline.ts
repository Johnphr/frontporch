// Post-call pipeline, scheduled by vapi.webhook on Vapi's end-of-call-report:
//   ctx.scheduler.runAfter(0, internal.pipeline.processCall, callResult)
//
// Steps (each isolated: one failure never stops the rest):
//   1. save        transcript + summary + endedReason on the calls row (created if missing)
//   2. memories    llm.extractKnowledge -> memories.addMany (+ resolve finished open threads)
//   3. profile     onboarding: llm.extractProfile -> elders.profile, stage = "active"
//      post        story call: llm.writePost -> posts row -> linkedapi.createPost (scheduled)
//   4. plan        conversation.refreshQuestionBank (scheduled)
// Steps 2-4 are skipped on voicemail / no answer or when he barely spoke.
// Returns a step report, visible in the Convex dashboard logs.
//
// Owner: Core: Brain.

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, type QueryCtx } from "./_generated/server";
import { memoriesAddMany, memoriesListForElder, type MemoryDoc } from "./lib/dataRefs";
import { isNearSilentCall, isNoConversation, runSteps, type StepReport } from "./lib/planner";
import { asElderV2 } from "./lib/v2Fields";

const turnValidator = v.object({ role: v.string(), text: v.string() });

/** ARCHITECTURE.md "Contracts": vapi.webhook -> pipeline.processCall. */
const callResultValidator = {
  vapiCallId: v.string(),
  elderId: v.id("elders"),
  kind: v.union(v.literal("onboarding"), v.literal("story")),
  turns: v.array(turnValidator),
  summary: v.optional(v.string()),
  endedReason: v.string(),
};

const profileValidator = v.object({
  industry: v.string(),
  specialty: v.string(),
  careerSummary: v.string(),
  topicsToAvoid: v.array(v.string()),
});

// ---------- queries + mutations ----------

/** Find the calls row Voice inserted at call start (by Vapi call id, for this elder). */
async function lookupCall(ctx: QueryCtx, vapiCallId: string, elderId: Id<"elders">): Promise<Id<"calls"> | null> {
  const row = await ctx.db
    .query("calls")
    .withIndex("by_vapi", (q) => q.eq("vapiCallId", vapiCallId))
    .first();
  return row && row.elderId === elderId ? row._id : null;
}

export const findCall = internalQuery({
  args: { vapiCallId: v.string(), elderId: v.id("elders") },
  handler: async (ctx, { vapiCallId, elderId }): Promise<Id<"calls"> | null> => lookupCall(ctx, vapiCallId, elderId),
});

export const saveCallResult = internalMutation({
  args: callResultValidator,
  handler: async (ctx, r): Promise<Id<"calls">> => {
    const callId = await lookupCall(ctx, r.vapiCallId, r.elderId);
    const v2 = {
      kind: r.kind,
      vapiCallId: r.vapiCallId,
      summary: r.summary,
      endedReason: r.endedReason,
    };
    if (callId) {
      await ctx.db.patch(callId, { status: "completed", transcript: r.turns, ...v2 });
      return callId;
    }
    return ctx.db.insert("calls", {
      elderId: r.elderId,
      status: "completed",
      transcript: r.turns,
      ...v2,
    });
  },
});

export const getElderProfile = internalQuery({
  args: { elderId: v.id("elders") },
  handler: async (ctx, { elderId }) => {
    const elder = asElderV2(await ctx.db.get(elderId));
    return elder ? { profile: elder.profile ?? null, knownBackground: elder.knownBackground ?? null } : null;
  },
});

export const saveProfile = internalMutation({
  args: { elderId: v.id("elders"), profile: profileValidator },
  handler: async (ctx, { elderId, profile }) => {
    await ctx.db.patch(elderId, { profile, stage: "active" });
  },
});

export const insertPost = internalMutation({
  args: { elderId: v.id("elders"), callId: v.id("calls"), text: v.string() },
  handler: async (ctx, args): Promise<Id<"posts">> =>
    ctx.db.insert("posts", { elderId: args.elderId, callId: args.callId, text: args.text, status: "pending" }),
});

// ---------- the pipeline ----------

type ProcessResult = { callId: Id<"calls"> | null; steps: StepReport[] };

export const processCall = internalAction({
  args: callResultValidator,
  handler: async (ctx, r): Promise<ProcessResult> => {
    let callId: Id<"calls"> | null = null;
    const skipContent = isNoConversation(r.endedReason)
      ? `no conversation (${r.endedReason})`
      : isNearSilentCall(r.turns)
        ? "he barely spoke"
        : false;

    const elderInfo = await ctx.runQuery(internal.pipeline.getElderProfile, { elderId: r.elderId });
    const profile = elderInfo?.profile ?? undefined;

    const steps = await runSteps([
      {
        step: "save",
        run: async () => {
          callId = await ctx.runMutation(internal.pipeline.saveCallResult, r);
          return `call ${callId}`;
        },
      },
      {
        step: "memories",
        skip: skipContent,
        run: async () => {
          let open: MemoryDoc[] = [];
          try {
            open = await ctx.runQuery(memoriesListForElder, {
              elderId: r.elderId,
              kinds: ["open_thread"],
              status: "active",
              limit: 20,
            });
          } catch {
            // memories.listForElder not deployed yet: extract without open threads
          }
          const knowledge = await ctx.runAction(internal.llm.extractKnowledge, {
            turns: r.turns,
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
            elderId: r.elderId,
            ...(callId ? { callId } : {}),
            items: knowledge.items,
            ...(resolveThreadIds.length ? { resolveThreadIds } : {}),
          });
          return `${saved.inserted} new, ${saved.merged} merged, ${saved.resolved} threads resolved`;
        },
      },
      r.kind === "onboarding"
        ? {
            step: "profile",
            skip: skipContent,
            run: async () => {
              const newProfile = await ctx.runAction(internal.llm.extractProfile, {
                turns: r.turns,
                ...(elderInfo?.knownBackground ? { knownBackground: elderInfo.knownBackground } : {}),
              });
              await ctx.runMutation(internal.pipeline.saveProfile, { elderId: r.elderId, profile: newProfile });
              return `${newProfile.industry} / ${newProfile.specialty}`;
            },
          }
        : {
            step: "post",
            skip: skipContent,
            run: async () => {
              if (!callId) throw new Error("No calls row (save step failed), so the post has nothing to link to");
              const post = await ctx.runAction(internal.llm.writePost, {
                turns: r.turns,
                ...(profile ? { profile } : {}),
              });
              const postId = await ctx.runMutation(internal.pipeline.insertPost, {
                elderId: r.elderId,
                callId,
                text: post.text,
              });
              // Posting runs on its own (guard + LinkedAPI + polling) so it can't hold up the rest.
              await ctx.scheduler.runAfter(0, internal.linkedapi.createPost, { postId });
              return `post ${postId} scheduled`;
            },
          },
      {
        step: "plan",
        skip: skipContent,
        run: async () => {
          await ctx.scheduler.runAfter(0, internal.conversation.refreshQuestionBank, { elderId: r.elderId });
          return "question bank refresh scheduled";
        },
      },
    ]);

    console.log(`processCall ${r.vapiCallId}`, JSON.stringify(steps));
    return { callId, steps };
  },
});
