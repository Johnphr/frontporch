// Inbound calls: he calls the Front Porch number; the inbound agent (lib/prompts/inbound.ts)
// answers and calls the lookup_caller tool, which reaches http.ts -> handleLookup here.
//
//   handleLookup      1. a repeated lookup for the same call gets the exact same answer back
//                        (cached on the calls row): the plan never changes mid-call
//                     2. verify with Cartesia that this is a LIVE call on our inbound agent from
//                        this caller (GET /agents/calls/{id} when the tool sent a conversation
//                        id; else, or on 404, list the agent's calls and take the single live one
//                        from this caller). A leaked tool secret alone gets nothing.
//                     3. caller number -> elder (by_phone, then normalized-phone scan) -> same
//                        plan as an outbound call (onboarding: known background; story:
//                        conversation.planNextCall) -> calls row (direction "inbound",
//                        in_progress, the verified Cartesia call id) + cartesia.pollCall.
//                     Unknown number -> { caller_known: "no" }: no row, nothing revealed.
//                     Returns { response, reason, elderId? }; http.ts logs ONE line per lookup
//                     (`inbound-lookup: known|unknown|error <reason>`) and keeps the outcome in
//                     inboundLookups (recordLookup; read with lastLookups from the dashboard).
//   syncInboundCalls  every 10 min (crons.ts): lists recent calls on the inbound agent and
//                     records any finished one from an elder that has no row (the tool was
//                     skipped or our endpoint was down), or attaches the real call id to a
//                     lookup row recorded under a different id. One batched query per page.
//
// The bank question of an inbound story call is marked used by pipeline.finishProcessing once
// the call was a real conversation (lib/inbound.inboundPlanToMark), not at lookup time.
// After that it's the outbound path: pollCall -> applyPoll -> pipeline.processCall.
// An inbound call is recorded even if an outbound row to him is still open (it's a real,
// separate conversation); while the inbound row is open, startCall's open-call guard won't ring him.
//
// Never log names, numbers, transcripts or raw Cartesia bodies; ids and statuses only.
// Env: CARTESIA_API_KEY, CARTESIA_INBOUND_AGENT_ID. Owner: Voice + Brain.

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { classifyHttp, nextPollDelayMs, templateVariables } from "./lib/cartesia";
import { cartesiaFetch, httpError } from "./lib/cartesiaHttp";
import {
  BACKSTOP_WINDOW_MS,
  VERIFY_TIMEOUT_MS,
  backstopDecision,
  callPath,
  callerCandidates,
  inboundHost,
  knownCallerResponse,
  lookupErrorResponse,
  lookupReuseDecision,
  matchBackstopRow,
  normalizePhone,
  pickLiveCallForCaller,
  unknownCallerResponse,
  verifyLiveCall,
  type BackstopCall,
  type LookupOutcome,
  type LookupResponse,
} from "./lib/inbound";
import { buildOnboardingVariables, callCharacter, firstName, planNextCall, type CallKind } from "./lib/onboarding";
import { asElderV2 } from "./lib/v2Fields";

declare const process: { env: Record<string, string | undefined> };

const MAX_BACKSTOP_PAGES = 5;
/** Normalized-phone fallback scans at most this many elders (the table is small). */
const MAX_PHONE_SCAN = 2000;

type ElderForLookup = {
  _id: Id<"elders">;
  phone: string; // normalized E.164 (what matched)
  name: string;
  language?: string;
  characterId?: string;
  stage?: Doc<"elders">["stage"];
  profile?: Doc<"elders">["profile"];
  knownBackground?: string;
};

function forLookup(elder: Doc<"elders">, phone: string): ElderForLookup {
  return {
    _id: elder._id,
    phone,
    name: elder.name,
    language: elder.language,
    characterId: elder.characterId,
    stage: elder.stage,
    profile: elder.profile,
    knownBackground: elder.knownBackground,
  };
}

/**
 * Elders for the given (normalized) numbers: by_phone first, then a bounded scan comparing
 * normalized stored phones, so a number typed in the dashboard as "+1 (415) 555-0123" still
 * matches. Returns phone -> elder for every number that is one.
 */
async function eldersByPhones(
  ctx: { db: any },
  phones: string[],
): Promise<Map<string, ElderForLookup>> {
  const wanted = [...new Set(phones.filter(Boolean))].slice(0, 200);
  const found = new Map<string, ElderForLookup>();
  for (const phone of wanted) {
    const elder: Doc<"elders"> | null = await ctx.db
      .query("elders")
      .withIndex("by_phone", (q: any) => q.eq("phone", phone))
      .first();
    if (elder) found.set(phone, forLookup(elder, phone));
  }
  const missing = new Set(wanted.filter((p) => !found.has(p)));
  if (missing.size) {
    const all: Doc<"elders">[] = await ctx.db.query("elders").take(MAX_PHONE_SCAN);
    for (const elder of all) {
      const norm = normalizePhone(elder.phone);
      if (norm && missing.has(norm) && !found.has(norm)) found.set(norm, forLookup(elder, norm));
    }
  }
  return found;
}

/** First elder whose (normalized) stored phone equals one of the candidates. */
export const findElderByPhone = internalQuery({
  args: { phones: v.array(v.string()) },
  handler: async (ctx, { phones }): Promise<ElderForLookup | null> => {
    const found = await eldersByPhones(ctx, phones.slice(0, 4));
    for (const phone of phones) {
      const elder = found.get(phone);
      if (elder) return elder;
    }
    return null;
  },
});

/** A calls row by Cartesia call id or by the lookup's conversation id. */
async function rowByAnyId(ctx: { db: any }, id: string): Promise<Doc<"calls"> | null> {
  return (
    (await ctx.db
      .query("calls")
      .withIndex("by_cartesia", (q: any) => q.eq("cartesiaCallId", id))
      .first()) ??
    (await ctx.db
      .query("calls")
      .withIndex("by_conversation", (q: any) => q.eq("cartesiaConversationId", id))
      .first())
  );
}

/** For the lookup: the row a previous lookup of this call made (and the answer it gave). */
export const getLookupRow = internalQuery({
  args: { ids: v.array(v.string()) },
  handler: async (ctx, { ids }) => {
    for (const id of ids.slice(0, 2)) {
      const row = await rowByAnyId(ctx, id);
      if (row) return { _id: row._id, elderId: row.elderId, inboundLookup: row.inboundLookup };
    }
    return null;
  },
});

/**
 * One row per Cartesia call (the tool may be retried, and the backstop may see the same call):
 * insert `in_progress` + start the existing poll chain, or reuse the row.
 */
export const recordInboundCall = internalMutation({
  args: {
    elderId: v.id("elders"),
    cartesiaCallId: v.string(), // the id GET /agents/calls/{id} accepts
    conversationId: v.optional(v.string()), // the lookup's system__conversation_id, if different
    kind: v.union(v.literal("onboarding"), v.literal("story")),
    pollDelayMs: v.optional(v.number()),
  },
  handler: async (ctx, { elderId, cartesiaCallId, conversationId, kind, pollDelayMs }) => {
    const existing =
      (await rowByAnyId(ctx, cartesiaCallId)) ?? (conversationId ? await rowByAnyId(ctx, conversationId) : null);
    const decision = lookupReuseDecision(existing ? { _id: existing._id, inboundLookup: existing.inboundLookup } : null);
    if (existing && decision.action !== "insert") {
      return {
        callId: existing._id,
        created: false,
        ...(decision.action === "cached" ? { cached: decision.response } : {}),
      };
    }
    const callId = await ctx.db.insert("calls", {
      elderId,
      kind,
      direction: "inbound",
      status: "in_progress",
      transcript: [],
      cartesiaCallId,
      ...(conversationId && conversationId !== cartesiaCallId ? { cartesiaConversationId: conversationId } : {}),
      pollAttempts: 0,
    });
    await ctx.scheduler.runAfter(pollDelayMs ?? nextPollDelayMs(0), internal.cartesia.pollCall, { callId });
    return { callId, created: true };
  },
});

/** The plan (with bankId, marked used later by pipeline.finishProcessing) + the exact answer sent. */
export const saveLookup = internalMutation({
  args: { callId: v.id("calls"), plan: v.optional(v.any()), response: v.any() },
  handler: async (ctx, { callId, plan, response }) => {
    const call = await ctx.db.get(callId);
    if (!call || call.inboundLookup !== undefined) return;
    await ctx.db.patch(callId, { inboundLookup: response, ...(plan !== undefined && call.plan === undefined ? { plan } : {}) });
  },
});

/** Story variables when planning fails mid-call: enough for a warm, open conversation. */
const FALLBACK_STORY_GOAL =
  "Have a warm, open chat about their working life and hear one good story, in their own words, with concrete detail.";

function fallbackStoryVariables(name: string, lang: "en" | "es"): Record<string, string> {
  return templateVariables({ first_name: firstName(name, lang), goal: FALLBACK_STORY_GOAL, context: "" });
}

type Verification =
  | { ok: true; callId: string }
  | { ok: false; reason: "not_configured" | "unreachable" | "agent_mismatch" | "not_live" | "caller_mismatch" | "bad_response" | "not_found" };

/**
 * Is the caller really on a live call with our inbound agent right now? GET the call by the
 * lookup's conversation id when the tool sent one; if it didn't, or Cartesia doesn't know that
 * id, list the inbound agent's recent calls and take the single live one from this caller.
 */
async function verifyCall(callerId: string, conversationId: string | undefined): Promise<Verification> {
  const agentId = process.env.CARTESIA_INBOUND_AGENT_ID;
  if (!agentId || !process.env.CARTESIA_API_KEY) return { ok: false, reason: "not_configured" };
  const want = { agentId, callerId };
  if (conversationId) {
    const res = await cartesiaFetch(callPath(conversationId), { method: "GET", timeoutMs: VERIFY_TIMEOUT_MS });
    if (classifyHttp(res.status) === "ok") {
      const r = verifyLiveCall(res.json, want);
      return r.ok ? r : { ok: false, reason: r.reason };
    }
    if (res.status !== 404) return { ok: false, reason: "unreachable" };
  }
  const since = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
  const qs = new URLSearchParams({ agent_id: agentId, start_time_gte: since, limit: "50" });
  const list = await cartesiaFetch(`/agents/calls?${qs.toString()}`, { method: "GET", timeoutMs: VERIFY_TIMEOUT_MS });
  if (classifyHttp(list.status) !== "ok") return { ok: false, reason: "unreachable" };
  const callId = pickLiveCallForCaller(list.json?.data, want);
  return callId ? { ok: true, callId } : { ok: false, reason: "not_found" };
}

/** What the tool gets, plus why (a code-chosen word for the log line and the inboundLookups row). */
export type LookupResult = { response: LookupResponse; reason: string; elderId?: Id<"elders"> };

/** The lookup_caller tool, called by the inbound agent right after its greeting. */
export const handleLookup = internalAction({
  args: { callerId: v.string(), conversationId: v.optional(v.string()) },
  handler: async (ctx, { callerId, conversationId }): Promise<LookupResult> => {
    const host = inboundHost(process.env); // whose voice is on the line

    // 1. Same call asked before: same answer (only to the same caller).
    if (conversationId) {
      const prior = await ctx.runQuery(internal.inbound.getLookupRow, { ids: [conversationId] });
      if (prior) {
        const decision = lookupReuseDecision(prior);
        const elder = await ctx.runQuery(internal.inbound.findElderByPhone, { phones: [callerId] });
        if (decision.action === "cached" && elder && elder._id === prior.elderId) {
          return { response: decision.response, reason: "cached", elderId: elder._id };
        }
      }
    }

    // 2. Verify the call with Cartesia before any elder data goes out (fail closed).
    const verified = await verifyCall(callerId, conversationId);
    if (!verified.ok) {
      if (verified.reason === "caller_mismatch") return { response: unknownCallerResponse(host), reason: "caller_mismatch" };
      return { response: lookupErrorResponse(host), reason: `not_verified:${verified.reason}` };
    }

    // 3. Who is it?
    const elder = await ctx.runQuery(internal.inbound.findElderByPhone, { phones: [callerId] });
    if (!elder) return { response: unknownCallerResponse(host), reason: "no_elder" };
    const normalized = asElderV2(elder) ?? { _id: String(elder._id), name: elder.name };
    const kind: CallKind = planNextCall(normalized).kind;
    const character = callCharacter(elder); // the host who calls him (his voice is NOT on this line unless it's `host`)
    const lang = character.language;

    let callId: Id<"calls"> | undefined;
    try {
      const rec = await ctx.runMutation(internal.inbound.recordInboundCall, {
        elderId: elder._id,
        cartesiaCallId: verified.callId,
        conversationId,
        kind,
      });
      if (rec.cached) return { response: rec.cached, reason: "cached", elderId: elder._id }; // a concurrent lookup already answered
      callId = rec.callId;
    } catch {
      // Still answer him; the backstop records the call after it ends.
      console.warn(`inbound.handleLookup: elder ${elder._id} call row not recorded`);
    }

    try {
      let variables: Record<string, string>;
      let plan: unknown;
      let reason: string = kind;
      if (kind === "story") {
        try {
          const planned = await ctx.runAction(internal.conversation.planNextCall, { elderId: elder._id });
          variables = planned.dynamicVariables;
          plan = planned.plan; // its bankId is marked used after the call, if it was a real conversation
        } catch {
          variables = fallbackStoryVariables(elder.name, lang);
          reason = "story:open_chat"; // planning failed; a warm open chat instead
        }
      } else {
        variables = buildOnboardingVariables(elder, elder.knownBackground, lang);
      }
      const response = knownCallerResponse({ kind, lang, character, host, variables });
      if (callId) await ctx.runMutation(internal.inbound.saveLookup, { callId, plan, response });
      return { response, reason: `${reason}${callId ? "" : ":no_row"}`, elderId: elder._id };
    } catch {
      return { response: lookupErrorResponse(host), reason: "build_failed", elderId: elder._id };
    }
  },
});

/** One row per lookup request (any outcome, 401/400 included): what the team checks after a test call. */
export const recordLookup = internalMutation({
  args: {
    outcome: v.union(v.literal("known"), v.literal("unknown"), v.literal("error")),
    reason: v.optional(v.string()),
    elderId: v.optional(v.id("elders")),
  },
  handler: async (ctx, { outcome, reason, elderId }) => {
    await ctx.db.insert("inboundLookups", {
      at: Date.now(),
      outcome,
      ...(reason ? { reason: reason.slice(0, 80) } : {}),
      ...(elderId ? { elderId } : {}),
    });
  },
});

/** The last N lookup outcomes, newest first: `npx convex run inbound:lastLookups '{"limit":5}'`. */
export const lastLookups = internalQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }): Promise<{ at: string; outcome: LookupOutcome; reason?: string; elderId?: Id<"elders"> }[]> => {
    const rows = await ctx.db.query("inboundLookups").order("desc").take(Math.min(Math.max(limit ?? 10, 1), 100));
    return rows.map((r) => ({
      at: new Date(r.at).toISOString(),
      outcome: r.outcome,
      ...(r.reason ? { reason: r.reason } : {}),
      ...(r.elderId ? { elderId: r.elderId } : {}),
    }));
  },
});

/**
 * Backstop context for one page of listed calls, in ONE query: which listed ids already have a
 * row, which candidate phones are elders, and those elders' open inbound rows (no transcript
 * yet) from the backstop window, for matching a lookup row recorded under a different id.
 */
export const backstopContext = internalQuery({
  args: { ids: v.array(v.string()), phones: v.array(v.string()), sinceMs: v.number() },
  handler: async (ctx, { ids, phones, sinceMs }) => {
    const idsWithRow: string[] = [];
    for (const id of ids.slice(0, 100)) if (await rowByAnyId(ctx, id)) idsWithRow.push(id);
    const elders = await eldersByPhones(ctx, phones);
    const openInbound: { _id: Id<"calls">; elderId: Id<"elders">; createdAt: number }[] = [];
    for (const elderId of new Set([...elders.values()].map((e) => e._id))) {
      const rows = await ctx.db
        .query("calls")
        .withIndex("by_elder", (q) => q.eq("elderId", elderId))
        .order("desc")
        .take(20);
      for (const r of rows) {
        if (r._creationTime < sinceMs) continue;
        if (r.direction === "inbound" && r.transcript.length === 0 && !r.processedAt) {
          openInbound.push({ _id: r._id, elderId: r.elderId, createdAt: r._creationTime });
        }
      }
    }
    return { idsWithRow, elders: [...elders.entries()], openInbound };
  },
});

/** The backstop found the real call id for a lookup row: attach it and (re)start polling. */
export const attachCallId = internalMutation({
  args: { callId: v.id("calls"), cartesiaCallId: v.string() },
  handler: async (ctx, { callId, cartesiaCallId }) => {
    const row = await ctx.db.get(callId);
    if (!row || row.transcript.length > 0 || row.processedAt) return { attached: false };
    if (row.cartesiaCallId === cartesiaCallId) return { attached: false };
    await ctx.db.patch(callId, {
      cartesiaCallId,
      ...(row.cartesiaCallId && !row.cartesiaConversationId ? { cartesiaConversationId: row.cartesiaCallId } : {}),
      status: "in_progress",
      pollAttempts: 0, endedAt: undefined, // re-opened: callLoop waits for this call again
    });
    await ctx.scheduler.runAfter(0, internal.cartesia.pollCall, { callId });
    return { attached: true };
  },
});

type BackstopReport = { listed: number; ingested: number; attached: number; skipped: Record<string, number>; error?: string };

/**
 * Backstop for calls the lookup never recorded: GET /agents/calls on the inbound agent for the
 * last few hours, and record finished calls from elders that have no row (or attach the id to
 * the lookup row that recorded the same call under another id). pollCall then picks up the
 * transcript as usual. Without CARTESIA_INBOUND_AGENT_ID it does nothing.
 */
export const syncInboundCalls = internalAction({
  args: {},
  handler: async (ctx): Promise<BackstopReport> => {
    const agentId = process.env.CARTESIA_INBOUND_AGENT_ID;
    const report: BackstopReport = { listed: 0, ingested: 0, attached: 0, skipped: {} };
    if (!agentId || !process.env.CARTESIA_API_KEY) return { ...report, error: "inbound agent not configured" };
    const sinceMs = Date.now() - BACKSTOP_WINDOW_MS;
    const since = new Date(sinceMs).toISOString();
    const skip = (reason: string) => {
      report.skipped[reason] = (report.skipped[reason] ?? 0) + 1;
    };
    let after: string | undefined;
    for (let page = 0; page < MAX_BACKSTOP_PAGES; page++) {
      const qs = new URLSearchParams({ agent_id: agentId, start_time_gte: since, limit: "100" });
      if (after) qs.set("starting_after", after);
      const res = await cartesiaFetch(`/agents/calls?${qs.toString()}`, { method: "GET" });
      if (classifyHttp(res.status) !== "ok") return { ...report, error: httpError(res) };
      const calls: BackstopCall[] = Array.isArray(res.json?.data) ? res.json.data : [];
      report.listed += calls.length;

      const ids = calls.map((c) => (typeof c.id === "string" ? c.id : "")).filter(Boolean);
      const phones = [...new Set(calls.flatMap((c) => callerCandidates(c.telephony_params)))];
      const context = ids.length
        ? await ctx.runQuery(internal.inbound.backstopContext, { ids, phones, sinceMs })
        : { idsWithRow: [] as string[], elders: [] as [string, ElderForLookup][], openInbound: [] };
      const hasRow = new Set(context.idsWithRow);
      const elderByPhone = new Map(context.elders);

      for (const call of calls) {
        const id = typeof call.id === "string" ? call.id : "";
        const elder = callerCandidates(call.telephony_params)
          .map((p) => elderByPhone.get(p))
          .find((e): e is ElderForLookup => Boolean(e));
        const decision = backstopDecision(call, { hasRow: hasRow.has(id), elderPhone: elder?.phone });
        if (!decision.ingest || !elder) {
          skip(decision.ingest ? "caller is not an elder" : decision.reason);
          continue;
        }
        const startMs = typeof (call as { start_time?: unknown }).start_time === "string"
          ? Date.parse((call as { start_time: string }).start_time)
          : NaN;
        const match = matchBackstopRow(
          { id, elderId: String(elder._id), ...(Number.isFinite(startMs) ? { startMs } : {}) },
          { idHasRow: false, openInbound: context.openInbound.map((r) => ({ ...r, _id: String(r._id), elderId: String(r.elderId) })) },
        );
        if (match.kind === "attach") {
          const rowId = context.openInbound.find((r) => String(r._id) === match.rowId)?._id;
          if (rowId) {
            const att = await ctx.runMutation(internal.inbound.attachCallId, { callId: rowId, cartesiaCallId: id });
            if (att.attached) {
              report.attached += 1;
              console.log(`inbound.syncInboundCalls: attached call id to ${rowId}`);
              continue;
            }
          }
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
