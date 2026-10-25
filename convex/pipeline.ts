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
//        story (slices 2-3), each step isolated (lib/fastPost.runStepGroups): memories and
//        post run at the same time (the post reads the transcript, his profile and saved
//        reader feedback, never this call's new memories); then reply and plan.
//          memories  llm.extractKnowledge -> memories.addMany (+ resolve the open threads he
//                    finished; only thread ids we sent are passed back)
//          post      llm.writePost (FAST_POST=on: one draft, no judge, falls back to the full
//                    loop), given the time left of the 10-min action limit
//                    (lib/postQuality.postBudgetMs; may decline: no post; opens with the question
//                    when an audience / reader question started the call: getAskedQuestion) -> insertPost: one
//                    posts row per call (posts.by_call) with its language; below the quality
//                    bar (heldFor "quality") or too long for a 5-post Bluesky thread ("thread_fit")
//                    -> needs_review, not posted; else publish.publishPost (Bluesky thread,
//                    Reddit when on, LinkedIn when on) is scheduled at once in the same mutation,
//                    only for a new row and only when AUTO_POST is on (else saved, not posted).
//                    posts.timings starts here (hang-up, detected, written)
//          reply     threadReplies.draftForCall (scheduled; only when the question came from
//                    a Bluesky thread, or Reddit once REDDIT_POSTING is on)
//          plan      conversation.refreshQuestionBank (scheduled)
//     4. status `done` + processedAt; any error (or a failed post / plan step) -> `process_failed`
//        + error. Memories are best effort: if that step fails the call is still `done`, with
//        error "memories step failed (not retried)". A retry is safe: memories.addMany skips a
//        callId it already has and the post row is reused, so no duplicate memories or post.
//
// Undo (isolated; never fails the call), before anything else so even a short call counts:
// lib/undo.detectTakeDown reads the transcript. Pip said his exact take-down line -> the call is
// flagged (calls.takeDown) and undo.removeLatest is scheduled for his latest earlier post. He
// asked in his own words only, or asked not to post today's story -> flagged, nothing deleted.
// Either way this call's own post is held (undo.holdPostForCall, again after the post step).
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
import { postingMayBeLive } from "./lib/callLoop";
import { inboundPlanToMark } from "./lib/inbound";
import { canClaimProcessing, finishPatch, isProfileUsable, mergeProfile, type Profile } from "./lib/onboarding";
import { fastPostOn, initialTimings, runStepGroups } from "./lib/fastPost";
import type { Step, StepReport } from "./lib/planner";
import { threadFitProblem } from "./lib/blueskyThread";
import { parseAutoPost } from "./lib/postFlow";
import { MIN_POST_BUDGET_MS, askedQuestionForCall, holdDecision, postBudgetMs, type AskedQuestion } from "./lib/postQuality";
import { postLanguage } from "./publish";
import { CALL_REASON, detectTakeDown, holdReason, postRemovalPatch, type TakeDownHow } from "./lib/undo";
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

/**
 * One post per call: returns the existing row if this call already has one. Decides here, once:
 * the language it goes out in (publish.postLanguage, saved on posts.language), and whether it's
 * held (lib/postQuality.holdDecision: below the quality bar, or too long for a Bluesky thread
 * in that language). A new post that isn't held is scheduled to publish in this same mutation
 * (unless AUTO_POST=off), so a saved post is never left unscheduled. A take-down on this call
 * (calls.takeDown) saves it already taken down (removedAt + a "held:" reason), not scheduled.
 */
export const insertPost = internalMutation({
  args: {
    elderId: v.id("elders"),
    callId: v.id("calls"),
    text: v.string(),
    // Post quality (lib/postQuality.ts): below the bar it's saved held. The judge's notes stay on
    // `quality` only (shown once on /posts); guardIssues is left for the fact-check.
    quality: v.optional(postQuality),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ postId: Id<"posts">; created: boolean; held?: "quality" | "thread_fit"; scheduled?: boolean }> => {
    const existing = await ctx.db
      .query("posts")
      .withIndex("by_call", (q) => q.eq("callId", args.callId))
      .first();
    if (existing) return { postId: existing._id, created: false };
    const language = postLanguage(await ctx.db.get(args.elderId));
    const hold = holdDecision(args.quality, threadFitProblem(args.text, language));
    // He asked for a take-down on this call (calls.takeDown): saved already held, never scheduled.
    // holdOwnPost stays as the backstop.
    const call = await ctx.db.get(args.callId);
    const takeDown = call?.takeDown;
    const postId = await ctx.db.insert("posts", {
      elderId: args.elderId,
      callId: args.callId,
      text: args.text,
      language,
      status: hold ? "needs_review" : "pending",
      ...(args.quality ? { quality: args.quality } : {}),
      timings: initialTimings(call, Date.now()),
      ...(hold ? { heldFor: hold.heldFor, guardSummary: hold.summary } : {}),
      ...(takeDown ? postRemovalPatch({}, holdReason(takeDown.how), Date.now()) : {}),
    });
    if (takeDown) return { postId, created: true, scheduled: false };
    if (hold) return { postId, created: true, held: hold.heldFor };
    // AUTO_POST=off (tests): keep the row `pending` (see it on /posts), post on purpose.
    const scheduled = parseAutoPost(process.env.AUTO_POST);
    if (scheduled) await ctx.scheduler.runAfter(0, internal.publish.publishPost, { postId });
    return { postId, created: true, scheduled };
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
 * The question this call answered, when a real person asked it: the audience question (its
 * title) or the reader question behind the plan's bank row. Text only, cleaned and clipped
 * (lib/postQuality.askedQuestionForCall); never a name, url or community. null otherwise.
 */
export const getAskedQuestion = internalQuery({
  args: { callId: v.id("calls") },
  handler: async (ctx, { callId }): Promise<AskedQuestion | null> => {
    const call = await ctx.db.get(callId);
    if (!call) return null;
    const bankId = (call.plan as { bankId?: unknown } | undefined)?.bankId;
    const bankDocId = typeof bankId === "string" ? ctx.db.normalizeId("questionBank", bankId) : null;
    const bankRow = bankDocId ? await ctx.db.get(bankDocId) : null;
    if (!bankRow || bankRow.elderId !== call.elderId) return null;
    const audienceId = bankRow.source === "audience" && bankRow.sourceRef ? ctx.db.normalizeId("audienceQuestions", bankRow.sourceRef) : null;
    const audience = audienceId ? await ctx.db.get(audienceId) : null;
    return askedQuestionForCall(
      call.plan,
      { _id: bankRow._id, source: bankRow.source, sourceRef: bankRow.sourceRef, question: bankRow.question },
      audience && audience.elderId === call.elderId ? { _id: audience._id, title: audience.title } : null,
    );
  },
});

/**
 * Dev/testing: a finished call from a fixture (tests/fixtures/onboarding_call.json,
 * story_call.json), so the whole post-call flow runs without a phone. Use a throwaway seeded
 * elder: fixture facts merge into his profile and memories. A story fixture would post to his
 * real accounts, so it's refused unless AUTO_POST=off or allowPost is set.
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
    if (kind === "story" && postingMayBeLive(process.env) && !allowPost) {
      throw new Error("This fixture could post publicly (story post, thread reply): set AUTO_POST=off (or pass allowPost: true)");
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
  const fast = fastPostOn(process.env);
  const memories: Step = {
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
  };
  const postStep: Step = {
    step: "post",
    run: async () => {
      // A retry reuses the call's post instead of writing another.
      const already = await ctx.runQuery(internal.pipeline.findPostForCall, { callId });
      if (already) return `post ${already.postId} already exists (${already.status})`;
      // What's left of processCall's 10 minutes (lib/postQuality.ts, "Time"). Too little:
      // fail the step (process_failed) rather than be cut off mid-write; a retry is safe.
      const budgetMs = postBudgetMs(startedAt, Date.now());
      if (budgetMs < MIN_POST_BUDGET_MS) throw new Error("not enough time left in this run for the post step");
      // Read together: saved reader feedback; the language it goes out in (the same one
      // insertPost saves), for the writer's fit check; a question a real person asked
      // (audience / reader, best effort), which the post opens with.
      const [saved, language, askedQuestion] = await Promise.all([
        ctx.runQuery(internal.conversation.getSavedFeedback, { elderId: elder._id }),
        ctx.runQuery(internal.publish.languageForElder, { elderId: elder._id }),
        ctx.runQuery(internal.pipeline.getAskedQuestion, { callId }).catch((): AskedQuestion | null => null),
      ]);
      const feedback = saved?.resonated || saved?.feedbackLine || "";
      const post = await ctx.runAction(internal.llm.writePost, {
        turns,
        ...(profile ? { profile } : {}),
        ...(feedback ? { feedback } : {}),
        budgetMs,
        language,
        ...(askedQuestion ? { askedQuestion } : {}),
        ...(fast ? { fast: true } : {}),
      });
      if (post.fallback) console.log(`pipeline.processCall: call ${callId} fast post fell back to the full loop (${post.fallback})`);
      if (post.skip) return `no post: ${post.reason}`;
      // insertPost holds it (below the quality bar, or too long for a Bluesky thread: shown on
      // /posts, never auto-posted) or schedules publish.publishPost, in one mutation.
      const inserted = await ctx.runMutation(internal.pipeline.insertPost, {
        elderId: elder._id,
        callId,
        text: post.text,
        quality: post.quality,
      });
      const { postId } = inserted;
      if (!inserted.created) return `post ${postId} already exists`;
      if (inserted.held === "thread_fit") return `post ${postId} held: too long for a Bluesky thread; shorten it, then publish:approvePost`;
      if (inserted.held) return `post ${postId} held for review (quality ${post.quality.score}/100); post it with publish:approvePost`;
      if (!inserted.scheduled) {
        return `post ${postId} saved, not posted (AUTO_POST=off); post it with: npx convex run publish:publishPost '{"postId":"${postId}"}'`;
      }
      return `post ${postId} scheduled${post.quality.mode === "fast" ? " (fast)" : ""}`;
    },
  };
  return runStepGroups([
    // Both at once: the post doesn't read this call's new memories.
    [memories, postStep],
    // Then (scheduled, quick):
    [
      {
        // Answer the online thread this call's question came from (threadReplies.ts; no-op otherwise).
        step: "reply",
        run: async () => {
          await ctx.scheduler.runAfter(0, internal.threadReplies.draftForCall, { callId });
          return "thread reply draft scheduled";
        },
      },
      {
        step: "plan",
        run: async () => {
          await ctx.scheduler.runAfter(0, internal.conversation.refreshQuestionBank, { elderId: elder._id });
          return "question bank refresh scheduled";
        },
      },
    ],
  ]);
}

/**
 * Undo step, isolated (lib/undo.detectTakeDown). Never throws. Returns how he asked, or null.
 *   line         Pip said the exact take-down line: undo.removeLatest for his latest earlier post
 *   today / unconfirmed   nothing deleted; the call is flagged for family (calls.takeDown)
 * Every kind holds this call's own post (on a re-run it may already exist).
 */
async function takeDownIfAsked(ctx: ActionCtx, callId: Id<"calls">, elderId: Id<"elders">, turns: Turn[]): Promise<TakeDownHow | null> {
  try {
    const found = detectTakeDown(turns);
    if (!found.asked) return null;
    await ctx.runMutation(internal.undo.recordCallTakeDown, { callId, how: found.how });
    if (found.how === "line") {
      await ctx.scheduler.runAfter(0, internal.undo.removeLatest, { elderId, reason: CALL_REASON, askedOnCallId: callId });
    }
    await ctx.runMutation(internal.undo.holdPostForCall, { callId });
    console.log(`pipeline.processCall: call ${callId} take-down (${found.how})${found.how === "line" ? "; undo.removeLatest scheduled" : "; nothing deleted, flagged"}`);
    return found.how;
  } catch {
    console.warn(`pipeline.processCall: call ${callId} take-down step failed`);
    return null;
  }
}

/** After the post step: hold this call's new post too (before publish.ts can send it). Never throws. */
async function holdOwnPost(ctx: ActionCtx, callId: Id<"calls">, takeDown: TakeDownHow | null): Promise<void> {
  if (!takeDown) return;
  try {
    const held = await ctx.runMutation(internal.undo.holdPostForCall, { callId });
    if (held.held) console.log(`pipeline.processCall: call ${callId} own post ${held.postId} held (take-down on this call)`);
  } catch {
    console.warn(`pipeline.processCall: call ${callId} holding its own post failed`);
  }
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
      const takeDown = await takeDownIfAsked(ctx, callId, elder._id, turns); // undo: before the short-call exit (a call can be just that)
      if (isNoConversation(call.endReason, turns)) {
        await ctx.runMutation(internal.pipeline.finishProcessing, { callId, status: "no_conversation" });
        console.log(`pipeline.processCall: call ${callId} no_conversation (${call.endReason ?? "few words"})`);
        return { status: "no_conversation" };
      }
      if (call.kind === "story") {
        // Before runStoryCall schedules the plan refresh: that refresh must leave out the reader
        // comments this conversation already shared.
        try {
          await ctx.runMutation(internal.conversation.markCommentsMentioned, { callId });
        } catch {
          console.warn(`pipeline.processCall: call ${callId} marking shared comments failed`);
        }
        const steps = await runStoryCall(ctx, callId, elder, turns, startedAt);
        await holdOwnPost(ctx, callId, takeDown);
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
