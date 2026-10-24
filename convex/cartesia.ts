// Phone calls through Cartesia Managed Agents (slice 1: the onboarding call).
//
//   npx convex run cartesia:syncAgent                      push prompt + settings from code
//   npx convex run cartesia:startCall '{"elderId":"<id>"}' call him (add "force":true to skip
//                                                          the "already calling" guard)
//
// startCall: env check -> reserveCall (one transaction: no second open call, inserts the
//   `queued` row) -> known background (cached, else apify.scrapeProfile once) ->
//   POST /agents/calls -> markStarted (`in_progress` + first poll, one transaction), or
//   `failed` (clear refusal) / `start_unknown` (timeout or 5xx: the phone may be ringing;
//   check Cartesia's call log, it blocks a new call for 90 min).
// pollCall: GET /agents/calls/{id} every minute until it's over (Cartesia has no call
//   webhooks yet). applyPoll writes each result with a compare-and-set on status + attempt
//   count and schedules the next step in the same transaction, so a duplicate chain stops
//   instead of undoing `ended`/`done`. Finished -> `ended` -> pipeline.processCall.
//
// Never log names, numbers, transcripts or raw Cartesia bodies; ids and statuses only.
// Env: CARTESIA_API_KEY, CARTESIA_ONBOARDING_AGENT_ID, CARTESIA_FROM_NUMBER_ID,
//      CARTESIA_VOICE_ID (optional), CARTESIA_MODEL (optional). Owner: Voice + Brain.

import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import {
  CARTESIA_API,
  CARTESIA_VERSION,
  buildAgentConfig,
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
import { buildOnboardingVariables, hasOpenCall, planNextCall } from "./lib/onboarding";
import { ONBOARDING_AGENT_NAME, ONBOARDING_GREETING, ONBOARDING_INSTRUCTIONS } from "./lib/prompts/onboarding";

// Convex exposes env vars on process.env (declared so we don't need @types/node).
declare const process: { env: Record<string, string | undefined> };

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_SUMMARY_CHARS = 4000;

function requireEnv(names: string[]): Record<string, string> {
  const missing = names.filter((n) => !process.env[n]);
  if (missing.length) {
    throw new Error(`Missing Convex env: ${missing.join(", ")} (set with: npx convex env set NAME value)`);
  }
  return Object.fromEntries(names.map((n) => [n, process.env[n] as string]));
}

async function cartesiaFetch(
  path: string,
  init: { method: string; body?: unknown },
): Promise<{ status: number; json: any; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${CARTESIA_API}${path}`, {
      method: init.method,
      headers: {
        "X-API-Key": process.env.CARTESIA_API_KEY ?? "",
        "Cartesia-Version": CARTESIA_VERSION,
        "Content-Type": "application/json",
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: controller.signal,
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, json };
  } catch (err) {
    return { status: 0, json: null, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Short description of a failed Cartesia response. Call endpoints keep only the status: their
 * messages can echo the phone number. The agent endpoint's message is kept (it only ever sees
 * our prompt + settings) because it says what to fix.
 */
function httpError(res: { status: number; json: any }, withDetail = false): string {
  const detail = withDetail && typeof res.json?.message === "string" ? `: ${res.json.message}` : "";
  return clip(`Cartesia HTTP ${res.status}${detail}`);
}

// ---------- agent ----------

export const syncAgent = internalAction({
  args: {},
  handler: async (): Promise<{ agentId: string; created: boolean }> => {
    requireEnv(["CARTESIA_API_KEY"]);
    const body = buildAgentConfig({
      name: ONBOARDING_AGENT_NAME,
      instructions: ONBOARDING_INSTRUCTIONS,
      initialMessage: ONBOARDING_GREETING,
      model: process.env.CARTESIA_MODEL,
      voiceId: process.env.CARTESIA_VOICE_ID,
      placeholders: { first_name: "there", known_background: "none" },
    });
    const existing = process.env.CARTESIA_ONBOARDING_AGENT_ID;
    const res = await cartesiaFetch(existing ? `/v1/agents/${existing}` : "/v1/agents", {
      method: existing ? "PATCH" : "POST",
      body,
    });
    if (classifyHttp(res.status) !== "ok") throw new Error(httpError(res, true));
    const agentId = existing ?? res.json?.id ?? res.json?.agent_id;
    if (!agentId) throw new Error("Cartesia created the agent but returned no id; copy it from the dashboard");
    if (!existing) console.log(`cartesia.syncAgent: created ${agentId}. Run: npx convex env set CARTESIA_ONBOARDING_AGENT_ID ${agentId}`);
    return { agentId, created: !existing };
  },
});

// ---------- database helpers ----------

/** One transaction: refuse a second open call, else insert the `queued` row. */
export const reserveCall = internalMutation({
  args: { elderId: v.id("elders"), force: v.boolean() },
  handler: async (ctx, { elderId, force }) => {
    const elder = await ctx.db.get(elderId);
    if (!elder) return { ok: false as const, reason: "Elder not found" };
    if (planNextCall(elder).kind !== "onboarding") {
      return { ok: false as const, reason: "He's already onboarded; story calls come in slice 2" };
    }
    const recent = await ctx.db
      .query("calls")
      .withIndex("by_elder", (q) => q.eq("elderId", elderId))
      .order("desc")
      .take(5);
    if (!force && hasOpenCall(recent, Date.now())) {
      return { ok: false as const, reason: "A call to him is already open (pass force: true to call anyway)" };
    }
    const callId = await ctx.db.insert("calls", { elderId, kind: "onboarding", status: "queued", transcript: [] });
    return {
      ok: true as const,
      callId,
      elder: { name: elder.name, phone: elder.phone, linkedinUrl: elder.linkedinUrl, knownBackground: elder.knownBackground },
    };
  },
});

export const getCall = internalQuery({
  args: { callId: v.id("calls") },
  handler: async (ctx, { callId }) => await ctx.db.get(callId),
});

const turnValidator = v.object({ role: v.string(), text: v.string() });

/** `queued` -> `in_progress` and the first poll, in one transaction. */
export const markStarted = internalMutation({
  args: { callId: v.id("calls"), cartesiaCallId: v.string() },
  handler: async (ctx, { callId, cartesiaCallId }) => {
    const call = await ctx.db.get(callId);
    if (!call || call.status !== "queued") return false;
    await ctx.db.patch(callId, { status: "in_progress", cartesiaCallId, pollAttempts: 0 });
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
  | { status: "started"; callId: string; cartesiaCallId: string }
  | { status: "refused"; reason: string }
  | { status: "failed"; callId: string; error: string };

export const startCall = internalAction({
  args: { elderId: v.id("elders"), force: v.optional(v.boolean()) },
  handler: async (ctx, { elderId, force }): Promise<StartResult> => {
    const env = requireEnv(["CARTESIA_API_KEY", "CARTESIA_ONBOARDING_AGENT_ID", "CARTESIA_FROM_NUMBER_ID"]);
    const reserved = await ctx.runMutation(internal.cartesia.reserveCall, { elderId, force: force ?? false });
    if (!reserved.ok) return { status: "refused", reason: reserved.reason };
    const { callId, elder } = reserved;

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

    const res = await cartesiaFetch("/agents/calls", {
      method: "POST",
      body: buildOutboundCallBody({
        agentId: env.CARTESIA_ONBOARDING_AGENT_ID,
        fromNumberId: env.CARTESIA_FROM_NUMBER_ID,
        toNumber: elder.phone,
        variables: buildOnboardingVariables(elder, knownBackground),
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

    await ctx.runMutation(internal.cartesia.markStarted, { callId, cartesiaCallId: parsed.callId });
    console.log(`cartesia.startCall: call ${callId} started (cartesia ${parsed.callId})`);
    return { status: "started", callId, cartesiaCallId: parsed.callId };
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
      const res = await cartesiaFetch(`/agents/calls/${call.cartesiaCallId}`, { method: "GET" });
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
