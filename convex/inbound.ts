// Inbound calls: he calls the Front Porch number; the inbound agent (lib/prompts/inbound.ts)
// answers and calls the lookup_caller tool, which reaches http.ts -> handleLookup here.
//
//   handleLookup      caller number -> elder (by_phone) -> same plan as an outbound call
//                     (onboarding: known background; story: conversation.planNextCall) ->
//                     calls row (direction "inbound", in_progress, one per Cartesia call id)
//                     + the existing cartesia.pollCall chain -> JSON for the agent.
//                     Unknown number -> { caller_known: "no" }: no row, nothing revealed.
//   syncInboundCalls  every 10 min (crons.ts): lists recent calls on the inbound agent and
//                     records any finished one from an elder that has no row (the tool was
//                     skipped or our endpoint was down), so its transcript is still processed.
//
// After that it's the outbound path: pollCall -> applyPoll -> pipeline.processCall
// (memories, post, question-bank refresh). An inbound call is recorded even if an outbound
// row to him is still open (it's a real, separate conversation); while the inbound row is
// open, cartesia.startCall's open-call guard won't ring him.
//
// Never log names, numbers, transcripts or raw Cartesia bodies; ids and statuses only.
// Env: CARTESIA_API_KEY, CARTESIA_INBOUND_AGENT_ID (backstop). Owner: Voice + Brain.

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { classifyHttp, nextPollDelayMs, templateVariables } from "./lib/cartesia";
import { cartesiaFetch, httpError } from "./lib/cartesiaHttp";
import {
  BACKSTOP_WINDOW_MS,
  backstopDecision,
  callerCandidates,
  inboundRowDecision,
  knownCallerResponse,
  lookupErrorResponse,
  unknownCallerResponse,
  type BackstopCall,
  type LookupResponse,
} from "./lib/inbound";
import { buildOnboardingVariables, callLanguage, firstName, planNextCall, type CallKind } from "./lib/onboarding";
import { asElderV2 } from "./lib/v2Fields";

declare const process: { env: Record<string, string | undefined> };

const MAX_BACKSTOP_PAGES = 5;

type ElderForLookup = {
  _id: Id<"elders">;
  phone: string;
  name: string;
  language?: string;
  stage?: "onboarding" | "active";
  profile?: Doc<"elders">["profile"];
  knownBackground?: string;
};

/** First elder whose stored phone equals one of the (normalized) candidates. */
export const findElderByPhone = internalQuery({
  args: { phones: v.array(v.string()) },
  handler: async (ctx, { phones }): Promise<ElderForLookup | null> => {
    for (const phone of phones.slice(0, 4)) {
      const elder = await ctx.db
        .query("elders")
        .withIndex("by_phone", (q) => q.eq("phone", phone))
        .first();
      if (elder) {
        return {
          _id: elder._id,
          phone: elder.phone,
          name: elder.name,
          language: elder.language,
          stage: elder.stage,
          profile: elder.profile,
          knownBackground: elder.knownBackground,
        };
      }
    }
    return null;
  },
});

export const getCallByCartesia = internalQuery({
  args: { cartesiaCallId: v.string() },
  handler: async (ctx, { cartesiaCallId }) =>
    await ctx.db
      .query("calls")
      .withIndex("by_cartesia", (q) => q.eq("cartesiaCallId", cartesiaCallId))
      .first(),
});

/**
 * One row per Cartesia call id (the tool may be retried, and the backstop may see the same
 * call): insert `in_progress` + start the existing poll chain, or reuse the row.
 */
export const recordInboundCall = internalMutation({
  args: {
    elderId: v.id("elders"),
    cartesiaCallId: v.string(),
    kind: v.union(v.literal("onboarding"), v.literal("story")),
    pollDelayMs: v.optional(v.number()),
  },
  handler: async (ctx, { elderId, cartesiaCallId, kind, pollDelayMs }) => {
    const existing = await ctx.db
      .query("calls")
      .withIndex("by_cartesia", (q) => q.eq("cartesiaCallId", cartesiaCallId))
      .first();
    if (inboundRowDecision(existing) === "reuse" && existing) return { callId: existing._id, created: false };
    const callId = await ctx.db.insert("calls", {
      elderId,
      kind,
      direction: "inbound",
      status: "in_progress",
      transcript: [],
      cartesiaCallId,
      pollAttempts: 0,
    });
    await ctx.scheduler.runAfter(pollDelayMs ?? nextPollDelayMs(0), internal.cartesia.pollCall, { callId });
    return { callId, created: true };
  },
});

export const savePlan = internalMutation({
  args: { callId: v.id("calls"), plan: v.any() },
  handler: async (ctx, { callId, plan }) => {
    const call = await ctx.db.get(callId);
    if (call && call.plan === undefined) await ctx.db.patch(callId, { plan });
  },
});

/** Story variables when planning fails mid-call: enough for a warm, open conversation. */
function fallbackStoryVariables(name: string, lang: "en" | "es"): Record<string, string> {
  return templateVariables({ first_name: firstName(name, lang), profile: "", memories: "", feedback: "", question: "" });
}

/** The lookup_caller tool, called by the inbound agent right after its greeting. */
export const handleLookup = internalAction({
  args: { callerId: v.string(), conversationId: v.optional(v.string()) },
  handler: async (ctx, { callerId, conversationId }): Promise<LookupResponse> => {
    const elder = await ctx.runQuery(internal.inbound.findElderByPhone, { phones: [callerId] });
    if (!elder) {
      console.log("inbound.handleLookup: unknown caller"); // no number in logs
      return unknownCallerResponse();
    }
    const normalized = asElderV2(elder) ?? { _id: String(elder._id), name: elder.name };
    const kind: CallKind = planNextCall(normalized).kind;
    const lang = callLanguage(elder.language);

    let callId: Id<"calls"> | undefined;
    let created = false;
    if (conversationId) {
      try {
        const rec = await ctx.runMutation(internal.inbound.recordInboundCall, {
          elderId: elder._id,
          cartesiaCallId: conversationId,
          kind,
        });
        callId = rec.callId;
        created = rec.created;
      } catch {
        // Still answer him; the backstop records the call after it ends.
        console.warn(`inbound.handleLookup: elder ${elder._id} call row not recorded`);
      }
    }

    try {
      let variables: Record<string, string>;
      if (kind === "story") {
        try {
          const planned = await ctx.runAction(internal.conversation.planNextCall, { elderId: elder._id });
          variables = planned.dynamicVariables;
          if (callId && created) {
            await ctx.runMutation(internal.inbound.savePlan, { callId, plan: planned.plan });
            const bankId = (planned.plan as { bankId?: string }).bankId;
            if (bankId) {
              await ctx.runMutation(internal.conversation.markPlanUsed, {
                elderId: elder._id,
                bankId: bankId as Id<"questionBank">,
                callId,
              });
            }
          }
        } catch {
          console.warn(`inbound.handleLookup: elder ${elder._id} story planning failed; open chat instead`);
          variables = fallbackStoryVariables(elder.name, lang);
        }
      } else {
        variables = buildOnboardingVariables(elder, elder.knownBackground, lang);
      }
      console.log(`inbound.handleLookup: elder ${elder._id} ${kind} (${lang})${callId ? ` call ${callId}` : ""}`);
      return knownCallerResponse({ kind, lang, variables });
    } catch {
      console.warn(`inbound.handleLookup: elder ${elder._id} lookup failed`);
      return lookupErrorResponse();
    }
  },
});

type BackstopReport = { listed: number; ingested: number; skipped: Record<string, number>; error?: string };

/**
 * Backstop for calls the lookup never recorded: GET /agents/calls on the inbound agent for the
 * last few hours, and record finished calls from elders that have no row. pollCall then picks
 * up the transcript as usual. Without CARTESIA_INBOUND_AGENT_ID it does nothing.
 */
export const syncInboundCalls = internalAction({
  args: {},
  handler: async (ctx): Promise<BackstopReport> => {
    const agentId = process.env.CARTESIA_INBOUND_AGENT_ID;
    const report: BackstopReport = { listed: 0, ingested: 0, skipped: {} };
    if (!agentId || !process.env.CARTESIA_API_KEY) return { ...report, error: "inbound agent not configured" };
    const since = new Date(Date.now() - BACKSTOP_WINDOW_MS).toISOString();
    let after: string | undefined;
    for (let page = 0; page < MAX_BACKSTOP_PAGES; page++) {
      const qs = new URLSearchParams({ agent_id: agentId, start_time_gte: since, limit: "100" });
      if (after) qs.set("starting_after", after);
      const res = await cartesiaFetch(`/agents/calls?${qs.toString()}`, { method: "GET" });
      if (classifyHttp(res.status) !== "ok") return { ...report, error: httpError(res) };
      const calls: BackstopCall[] = Array.isArray(res.json?.data) ? res.json.data : [];
      report.listed += calls.length;
      for (const call of calls) {
        const id = typeof call.id === "string" ? call.id : "";
        const hasRow = id ? Boolean(await ctx.runQuery(internal.inbound.getCallByCartesia, { cartesiaCallId: id })) : false;
        const phones = callerCandidates(call.telephony_params);
        const elder = !hasRow && phones.length ? await ctx.runQuery(internal.inbound.findElderByPhone, { phones }) : null;
        const decision = backstopDecision(call, { hasRow, elderPhone: elder?.phone });
        if (!decision.ingest || !elder) {
          const reason = decision.ingest ? "caller is not an elder" : decision.reason;
          report.skipped[reason] = (report.skipped[reason] ?? 0) + 1;
          continue;
        }
        const kind = planNextCall(asElderV2(elder) ?? { _id: String(elder._id), name: elder.name }).kind;
        const rec = await ctx.runMutation(internal.inbound.recordInboundCall, {
          elderId: elder._id,
          cartesiaCallId: id,
          kind,
          pollDelayMs: 0, // it's already over: fetch the transcript now
        });
        if (rec.created) {
          report.ingested += 1;
          console.log(`inbound.syncInboundCalls: recorded missed inbound call ${rec.callId}`);
        }
      }
      const next = typeof res.json?.next_page === "string" ? res.json.next_page : undefined;
      if (!res.json?.has_more || !next) break;
      after = next;
    }
    return report;
  },
});
