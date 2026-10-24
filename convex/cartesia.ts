// Phone calls through Cartesia Managed Agents: onboarding (slice 1) and weekly story calls
// (slice 2), in his language (elders.language: Pip in English, Juanito in Spanish). The agents
// are defined in code and pushed by cartesiaAgents:syncAgent.
//
//   npx convex run cartesia:startCall '{"elderId":"<id>"}' call him (add "force":true to skip
//                                                          the "already calling" guard)
//
// startCall: next call kind + language (onboarding until his profile is usable, then story) ->
//   env check for that agent -> reserveCall (one transaction: no second open call, kind unchanged,
//   inserts the `queued` row) -> variables: onboarding = known background (cached, else
//   apify.scrapeProfile once); story = conversation.planNextCall (one goal: a story from today's
//   question) -> POST /agents/calls with that agent -> markStarted (`in_progress` + first poll,
//   one transaction; story calls also save their plan) -> story: conversation.markPlanUsed. Or
//   `failed` (clear refusal, or story planning failed) / `start_unknown` (timeout or 5xx: the
//   phone may be ringing; check Cartesia's call log, it blocks a new call for 90 min).
// pollCall: GET /agents/calls/{id} every minute until it's over (Cartesia has no call
//   webhooks yet). applyPoll writes each result with a compare-and-set on status + attempt
//   count and schedules the next step in the same transaction, so a duplicate chain stops
//   instead of undoing `ended`/`done`. Finished -> `ended` -> pipeline.processCall.
//
// Never log names, numbers, transcripts or raw Cartesia bodies; ids and statuses only.
// Env: CARTESIA_API_KEY, CARTESIA_FROM_NUMBER_ID, CARTESIA_ONBOARDING_AGENT_ID,
//      CARTESIA_STORY_AGENT_ID (+ the _ES pair for Spanish elders). Owner: Voice + Brain.

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import {
  buildOutboundCallBody,
  classifyHttp,
  clip,
  isCallFinished,
  nextPollDelayMs,
  normalizeTranscript,
  parseOutboundResponse,
  planPollUpdate,
  shouldGiveUp,
  startFailureStatus,
  unknownRoles,
  type PollOutcome,
} from "./lib/cartesia";
import { cartesiaFetch, httpError, requireEnv } from "./lib/cartesiaHttp";
import { callPath } from "./lib/inbound";
import {
  agentEnvName,
  buildOnboardingVariables,
  callLanguage,
  planNextCall,
  reserveDecision,
  type CallKind,
} from "./lib/onboarding";
import type { CallLanguage } from "./lib/prompts/principles";
import { asElderV2 } from "./lib/v2Fields";

// Convex exposes env vars on process.env (declared so we don't need @types/node).
declare const process: { env: Record<string, string | undefined> };

const MAX_SUMMARY_CHARS = 4000;

// ---------- database helpers ----------

const callKind = v.union(v.literal("onboarding"), v.literal("story"));

/** Which call he gets next (onboarding until his profile is usable, then story), and in which language. */
export const nextCallKind = internalQuery({
  args: { elderId: v.id("elders") },
  handler: async (ctx, { elderId }): Promise<{ kind: CallKind; lang: CallLanguage } | null> => {
    const elder = asElderV2(await ctx.db.get(elderId));
    return elder ? { kind: planNextCall(elder).kind, lang: callLanguage(elder.language) } : null;
  },
});

/**
 * One transaction: refuse a second open call (or a kind that changed since startCall checked
 * its env), else insert the `queued` row (lib: reserveDecision).
 */
export const reserveCall = internalMutation({
  args: { elderId: v.id("elders"), force: v.boolean(), expectedKind: v.optional(callKind) },
  handler: async (ctx, { elderId, force, expectedKind }) => {
    const elder = await ctx.db.get(elderId);
    if (!elder) return { ok: false as const, reason: "Elder not found" };
    const recent = await ctx.db
      .query("calls")
      .withIndex("by_elder", (q) => q.eq("elderId", elderId))
      .order("desc")
      .take(5);
    // Same normalized input as conversation.planNextCall, so both pick the same kind.
    const decision = reserveDecision(asElderV2(elder) ?? {}, recent, Date.now(), { force, expectedKind });
    if (!decision.ok) return { ok: false as const, reason: decision.reason };
    const callId = await ctx.db.insert("calls", {
      elderId,
      kind: decision.kind,
      direction: "outbound",
      status: "queued",
      transcript: [],
    });
    return {
      ok: true as const,
      callId,
      kind: decision.kind,
      elder: { name: elder.name, phone: elder.phone, linkedinUrl: elder.linkedinUrl, knownBackground: elder.knownBackground },
    };
  },
});

export const getCall = internalQuery({
  args: { callId: v.id("calls") },
  handler: async (ctx, { callId }) => await ctx.db.get(callId),
});

const turnValidator = v.object({ role: v.string(), text: v.string() });

/** `queued` -> `in_progress` and the first poll, in one transaction. Story calls keep their plan. */
export const markStarted = internalMutation({
  args: { callId: v.id("calls"), cartesiaCallId: v.string(), plan: v.optional(v.any()) },
  handler: async (ctx, { callId, cartesiaCallId, plan }) => {
    const call = await ctx.db.get(callId);
    if (!call || call.status !== "queued") return false;
    await ctx.db.patch(callId, {
      status: "in_progress",
      cartesiaCallId,
      pollAttempts: 0,
      ...(plan !== undefined ? { plan } : {}),
    });
    await ctx.scheduler.runAfter(nextPollDelayMs(0), internal.cartesia.pollCall, { callId });
    return true;
  },
});

export const markStartFailed = internalMutation({
  args: { callId: v.id("calls"), status: v.union(v.literal("failed"), v.literal("start_unknown")), error: v.string() },
  handler: async (ctx, { callId, status, error }) => {
    const call = await ctx.db.get(callId);
    if (!call || call.status !== "queued") return;
    await ctx.db.patch(callId, { status, error });
  },
});

const pollOutcome = v.union(
  v.object({ kind: v.literal("pending") }),
  v.object({ kind: v.literal("fatal"), error: v.string() }),
  v.object({ kind: v.literal("timeout") }),
  v.object({
    kind: v.literal("finished"),
    transcript: v.array(turnValidator),
    summary: v.optional(v.string()),
    endReason: v.optional(v.string()),
    error: v.optional(v.string()),
  }),
);

/** Compare-and-set for one poll result + the next step, in one transaction (lib: planPollUpdate). */
export const applyPoll = internalMutation({
  args: { callId: v.id("calls"), seenAttempts: v.number(), outcome: pollOutcome },
  handler: async (ctx, { callId, seenAttempts, outcome }) => {
    const call = await ctx.db.get(callId);
    const plan = call ? planPollUpdate(call, seenAttempts, outcome as PollOutcome, Date.now()) : null;
    if (!plan) return { applied: false, status: call?.status ?? "missing" };
    await ctx.db.patch(callId, plan.patch);
    if (plan.next === "poll") await ctx.scheduler.runAfter(plan.delayMs, internal.cartesia.pollCall, { callId });
    if (plan.next === "process") await ctx.scheduler.runAfter(0, internal.pipeline.processCall, { callId });
    return { applied: true, status: (plan.patch.status as string | undefined) ?? "in_progress" };
  },
});

export const saveKnownBackground = internalMutation({
  args: { elderId: v.id("elders"), knownBackground: v.string() },
  handler: async (ctx, { elderId, knownBackground }) => {
    await ctx.db.patch(elderId, { knownBackground });
  },
});

// ---------- calls ----------

type StartResult =
  | { status: "started"; kind: CallKind; callId: string; cartesiaCallId: string }
  | { status: "refused"; reason: string }
  | { status: "failed"; callId: string; error: string };

/**
 * Onboarding: variables from his (cached) LinkedIn background. Story (slice 2):
 * conversation.planNextCall builds the plan (question bank, memories, avoid topics, reader
 * feedback) and the dynamic variables for the story agent's prompt (lib/prompts/story.ts).
 */
export const startCall = internalAction({
  args: { elderId: v.id("elders"), force: v.optional(v.boolean()) },
  handler: async (ctx, { elderId, force }): Promise<StartResult> => {
    // Check the env for the agent he'll get BEFORE reserving, so a missing story agent id
    // never leaves a queued row behind.
    const next = await ctx.runQuery(internal.cartesia.nextCallKind, { elderId });
    if (!next) return { status: "refused", reason: "Elder not found" };
    const { kind: expectedKind, lang } = next;
    // A missing agent id throws here, before any row: the cron's slot for this week is then lost
    // (schedule.tick records it first), so keep all four agent ids set once elders use them.
    const agentVar = agentEnvName(expectedKind, lang);
    const env = requireEnv(["CARTESIA_API_KEY", agentVar, "CARTESIA_FROM_NUMBER_ID"]);
    const reserved = await ctx.runMutation(internal.cartesia.reserveCall, {
      elderId,
      force: force ?? false,
      expectedKind,
    });
    if (!reserved.ok) {
      console.warn(`cartesia.startCall: elder ${elderId} refused (${reserved.reason})`); // fixed reasons only
      return { status: "refused", reason: reserved.reason };
    }
    const { callId, elder, kind } = reserved;

    let variables: Record<string, string>;
    let plan: { bankId?: string } | undefined;
    if (kind === "story") {
      try {
        const planned = await ctx.runAction(internal.conversation.planNextCall, { elderId });
        if (planned.plan.kind !== "story") throw new Error(`planner returned a ${planned.plan.kind} plan`);
        plan = planned.plan;
        variables = planned.dynamicVariables;
      } catch {
        // Fixed text: a planning error could quote his memories or profile.
        const error = "Planning the story call failed";
        await ctx.runMutation(internal.cartesia.markStartFailed, { callId, status: "failed", error });
        console.warn(`cartesia.startCall: call ${callId} failed (planning)`);
        return { status: "failed", callId, error };
      }
    } else {
      // Optional: his LinkedIn work history, scraped once and cached on the elder.
      let knownBackground = elder.knownBackground;
      if (!knownBackground && elder.linkedinUrl) {
        try {
          const scraped = await ctx.runAction(internal.apify.scrapeProfile, { elderId });
          knownBackground = scraped.knownBackground;
          await ctx.runMutation(internal.cartesia.saveKnownBackground, { elderId, knownBackground });
        } catch {
          // The scraper's message can contain his LinkedIn URL (his name): log a fixed string.
          console.warn(`cartesia.startCall: call ${callId} profile prefill skipped (scrape failed)`);
        }
      }
      variables = buildOnboardingVariables(elder, knownBackground, lang);
    }

    const res = await cartesiaFetch("/agents/calls", {
      method: "POST",
      body: buildOutboundCallBody({
        agentId: env[agentVar],
        fromNumberId: env.CARTESIA_FROM_NUMBER_ID,
        toNumber: elder.phone,
        variables,
      }),
    });
    const parsed =
      classifyHttp(res.status) === "ok"
        ? parseOutboundResponse(res.json)
        : { error: res.status === 0 ? "No answer from Cartesia (timeout or network)" : httpError(res), placed: startFailureStatus(res.status) === "failed" ? ("no" as const) : ("unknown" as const) };
    if ("error" in parsed) {
      const status = parsed.placed === "no" ? "failed" : "start_unknown";
      const error =
        status === "start_unknown" ? `${parsed.error}; the phone may be ringing: check Cartesia's call log before retrying` : parsed.error;
      await ctx.runMutation(internal.cartesia.markStartFailed, { callId, status, error });
      console.warn(`cartesia.startCall: call ${callId} ${status}`);
      return { status: "failed", callId, error };
    }

    await ctx.runMutation(internal.cartesia.markStarted, {
      callId,
      cartesiaCallId: parsed.callId,
      ...(plan ? { plan } : {}),
    });
    // The bank question is used once the phone actually rang, not when it was only planned.
    if (plan?.bankId) {
      try {
        const bankId = plan.bankId as Id<"questionBank">;
        await ctx.runMutation(internal.conversation.markPlanUsed, { elderId, bankId, callId });
      } catch {
        console.warn(`cartesia.startCall: call ${callId} started, but marking its bank question used failed`);
      }
    }
    console.log(`cartesia.startCall: ${kind} (${lang}) call ${callId} started (cartesia ${parsed.callId})`);
    return { status: "started", kind, callId, cartesiaCallId: parsed.callId };
  },
});

export const pollCall = internalAction({
  args: { callId: v.id("calls") },
  handler: async (ctx, { callId }): Promise<{ status: string }> => {
    const call = await ctx.runQuery(internal.cartesia.getCall, { callId });
    if (!call || call.status !== "in_progress" || !call.cartesiaCallId) return { status: call?.status ?? "missing" };

    const seenAttempts = call.pollAttempts ?? 0;
    let outcome: PollOutcome;
    if (shouldGiveUp(seenAttempts)) {
      outcome = { kind: "timeout" };
    } else {
      const res = await cartesiaFetch(callPath(call.cartesiaCallId), { method: "GET" });
      const http = classifyHttp(res.status);
      if (http === "fatal") {
        outcome = { kind: "fatal", error: httpError(res) };
      } else if (http === "retry" || !isCallFinished(res.json)) {
        if (http === "ok") console.log(`cartesia.pollCall: call ${callId} still "${String(res.json?.status ?? "?")}"`);
        outcome = { kind: "pending" };
      } else {
        const unknown = unknownRoles(res.json?.transcript);
        if (unknown.length) console.warn(`cartesia.pollCall: dropped transcript roles ${unknown.join(", ")}`);
        const str = (x: unknown) => (typeof x === "string" && x ? x : undefined);
        outcome = {
          kind: "finished",
          transcript: normalizeTranscript(res.json?.transcript),
          summary: str(res.json?.summary)?.slice(0, MAX_SUMMARY_CHARS),
          endReason: str(res.json?.end_reason),
          // Cartesia's own reason for a failed call; short, and only about the call itself
          error: str(res.json?.error_message) && clip(res.json.error_message),
        };
      }
    }

    const result = await ctx.runMutation(internal.cartesia.applyPoll, { callId, seenAttempts, outcome });
    if (!result.applied) return { status: result.status }; // another chain already moved it on
    if (result.status !== "in_progress") console.log(`cartesia.pollCall: call ${callId} ${result.status}`);
    return { status: result.status };
  },
});
