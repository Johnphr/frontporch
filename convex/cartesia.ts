// Phone calls through Cartesia Managed Agents (slice 1: the onboarding call).
//
//   npx convex run cartesia:syncAgent                      push prompt + settings from code
//   npx convex run cartesia:startCall '{"elderId":"<id>"}' call him (add "force":true to skip
//                                                          the "already calling" guard)
//
// startCall: env check -> reserveCall (one transaction: no second open call, inserts the
//   `queued` row) -> known background (cached, else apify.scrapeProfile once) ->
//   POST /agents/calls -> `in_progress` + cartesiaCallId -> pollCall in 2 min.
// pollCall: GET /agents/calls/{id} every minute until it's over (Cartesia has no call
//   webhooks yet) -> transcript saved, status `ended` -> pipeline.processCall.
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
  shouldGiveUp,
  unknownRoles,
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

/** Short, safe description of a failed Cartesia response (no request data echoed). */
function httpError(res: { status: number; json: any; error?: string }): string {
  const detail = typeof res.json?.message === "string" ? res.json.message : typeof res.json?.error === "string" ? res.json.error : res.error ?? "";
  return clip(`Cartesia HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
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
    if (classifyHttp(res.status) !== "ok") throw new Error(httpError(res));
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

export const updateCall = internalMutation({
  args: {
    callId: v.id("calls"),
    status: v.optional(v.string()),
    cartesiaCallId: v.optional(v.string()),
    transcript: v.optional(v.array(v.object({ role: v.string(), text: v.string() }))),
    summary: v.optional(v.string()),
    endReason: v.optional(v.string()),
    error: v.optional(v.string()),
    pollAttempts: v.optional(v.number()),
    lastPolledAt: v.optional(v.number()),
  },
  handler: async (ctx, { callId, ...fields }) => {
    const patch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields)) if (value !== undefined) patch[key] = value;
    await ctx.db.patch(callId, patch);
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
      } catch (err) {
        console.warn(`cartesia.startCall: profile prefill skipped (${clip(err instanceof Error ? err.message : String(err))})`);
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
        : {
            error:
              res.status === 0
                ? clip(`No answer from Cartesia (${res.error ?? "timeout"}); check its call log before retrying`)
                : httpError(res),
          };
    if ("error" in parsed) {
      await ctx.runMutation(internal.cartesia.updateCall, { callId, status: "failed", error: parsed.error });
      console.warn(`cartesia.startCall: call ${callId} failed to start`);
      return { status: "failed", callId, error: parsed.error };
    }

    await ctx.runMutation(internal.cartesia.updateCall, {
      callId,
      status: "in_progress",
      cartesiaCallId: parsed.callId,
      pollAttempts: 0,
    });
    await ctx.scheduler.runAfter(nextPollDelayMs(0), internal.cartesia.pollCall, { callId });
    console.log(`cartesia.startCall: call ${callId} started (cartesia ${parsed.callId})`);
    return { status: "started", callId, cartesiaCallId: parsed.callId };
  },
});

export const pollCall = internalAction({
  args: { callId: v.id("calls") },
  handler: async (ctx, { callId }): Promise<{ status: string }> => {
    const call = await ctx.runQuery(internal.cartesia.getCall, { callId });
    if (!call || call.status !== "in_progress" || !call.cartesiaCallId) return { status: call?.status ?? "missing" };

    const attempts = call.pollAttempts ?? 0;
    if (shouldGiveUp(attempts)) {
      const error = "Stopped checking after about an hour; the call never finished in Cartesia";
      await ctx.runMutation(internal.cartesia.updateCall, { callId, status: "poll_timeout", error });
      console.warn(`cartesia.pollCall: call ${callId} poll_timeout`);
      return { status: "poll_timeout" };
    }

    const res = await cartesiaFetch(`/agents/calls/${call.cartesiaCallId}`, { method: "GET" });
    await ctx.runMutation(internal.cartesia.updateCall, { callId, pollAttempts: attempts + 1, lastPolledAt: Date.now() });
    const outcome = classifyHttp(res.status);
    if (outcome === "fatal") {
      await ctx.runMutation(internal.cartesia.updateCall, { callId, status: "poll_error", error: httpError(res) });
      console.warn(`cartesia.pollCall: call ${callId} poll_error (HTTP ${res.status})`);
      return { status: "poll_error" };
    }
    if (outcome === "retry" || !isCallFinished(res.json)) {
      if (outcome === "ok") console.log(`cartesia.pollCall: call ${callId} still "${String(res.json?.status ?? "?")}"`);
      await ctx.scheduler.runAfter(nextPollDelayMs(attempts + 1), internal.cartesia.pollCall, { callId });
      return { status: "in_progress" };
    }

    const unknown = unknownRoles(res.json?.transcript);
    if (unknown.length) console.warn(`cartesia.pollCall: dropped transcript roles ${unknown.join(", ")}`);
    const summary = typeof res.json?.summary === "string" ? res.json.summary.slice(0, MAX_SUMMARY_CHARS) : undefined;
    const endReason = typeof res.json?.end_reason === "string" ? res.json.end_reason : undefined;
    const callError = typeof res.json?.error_message === "string" && res.json.error_message ? clip(res.json.error_message) : undefined;
    await ctx.runMutation(internal.cartesia.updateCall, {
      callId,
      status: "ended",
      transcript: normalizeTranscript(res.json?.transcript),
      summary,
      endReason,
      error: callError,
    });
    await ctx.scheduler.runAfter(0, internal.pipeline.processCall, { callId });
    console.log(`cartesia.pollCall: call ${callId} ended (${endReason ?? "no end_reason"})`);
    return { status: "ended" };
  },
});
