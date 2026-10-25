// Inbound calls (he calls the Front Porch number): pure helpers, unit-tested in
// tests/inbound.test.ts. No runtime imports beyond ./ (Node runs them directly).
//
// One phone number routes to one Cartesia agent, and nothing lets us hand that agent a
// per-caller plan before it speaks. So the inbound agent greets generically, then calls the
// `lookup_caller` webhook tool (docs.cartesia.ai/agents/webhook-tools): Cartesia fills
// caller_id + conversation_id from system variables, our Convex HTTP action finds the elder
// by phone and answers with his plan as JSON. The tool result is read by the in-call model
// (any 2xx text body, max 16 KiB); `assignments` also copy a few fields into the call's
// dynamic variables, so the call record shows who it was.

import type { CallLanguage } from "./prompts/principles.ts";
import { isE164 } from "./signupRules.ts";

export const LOOKUP_TOOL_NAME = "lookup_caller";
export const LOOKUP_PATH = "/cartesia/inbound-lookup";
/** Cartesia waits this long for our answer (default 20, max 120). Planning is DB + one embedding. */
export const LOOKUP_TIMEOUT_SECS = 20;
/** Backstop: how far back syncInboundCalls looks for inbound calls the lookup never saw. */
export const BACKSTOP_WINDOW_MS = 3 * 60 * 60_000;
/** Max size of the JSON we send back (Cartesia passes at most 16 KiB of it to the model). */
export const MAX_LOOKUP_BYTES = 15_000;

// The E.164 rule elders.seed and the sign-up page use (lib/signupRules.ts): one place.
export { isE164 };

/**
 * A phone number as Cartesia or a person writes it -> E.164 ("+14155550123"), or "" if it
 * can't be one. 10 bare digits are read as a US/Canada number (+1), like our seed examples.
 */
export function normalizePhone(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  const plus = trimmed.startsWith("+") || trimmed.startsWith("00");
  let digits = trimmed.replace(/\D/g, "");
  if (trimmed.startsWith("00")) digits = digits.slice(2);
  if (!plus) {
    if (digits.length === 10) digits = `1${digits}`;
    else if (!(digits.length === 11 && digits.startsWith("1"))) return "";
  }
  const out = `+${digits}`;
  return isE164(out) ? out : "";
}

/**
 * Who called, from GET /agents/calls `telephony_params`. The API reference says `to` is the
 * caller and `from` the agent; the webhooks page says the opposite. Return both (normalized,
 * `from` first, deduped) and let the caller of this function keep the one that is an elder.
 */
export function callerCandidates(telephony: unknown): string[] {
  if (!telephony || typeof telephony !== "object") return [];
  const t = telephony as Record<string, unknown>;
  const out: string[] = [];
  for (const raw of [t.from, t.to]) {
    const phone = normalizePhone(raw);
    if (phone && !out.includes(phone)) out.push(phone);
  }
  return out;
}

/** Constant-time string compare against a secret. No secret configured = always false. */
export function sameSecret(given: string | null | undefined, secret: string | undefined): boolean {
  if (!secret) return false;
  const g = given ?? "";
  const len = Math.max(g.length, secret.length);
  let diff = g.length ^ secret.length;
  for (let i = 0; i < len; i++) diff |= (g.charCodeAt(i) || 0) ^ (secret.charCodeAt(i) || 0);
  return diff === 0;
}

/** Constant-time check of `Authorization: Bearer <secret>`. No secret configured = always false. */
export function verifyBearer(header: string | null | undefined, secret: string | undefined): boolean {
  const match = /^Bearer\s+(.+)$/i.exec((header ?? "").trim());
  return sameSecret(match ? match[1].trim() : "", secret);
}

export type LookupRequest = { callerId: string; conversationId: string };

/** Printable, no spaces, at most 128 chars: Cartesia's id format isn't documented, so stay open. */
const CALL_ID = /^[\x21-\x7E]{1,128}$/;

/**
 * The tool's JSON body -> validated fields. Both are required: the caller number to find him,
 * and the conversation id so the call can be verified with Cartesia before any data goes out.
 * The id is only ever used as an index value and in URL paths through encodeURIComponent.
 */
export function parseLookupRequest(body: unknown): LookupRequest | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const callerId = normalizePhone(b.caller_id);
  if (!callerId) return null;
  const conv = typeof b.conversation_id === "string" ? b.conversation_id.trim() : "";
  if (!CALL_ID.test(conv)) return null;
  return { callerId, conversationId: conv };
}

/** `GET /agents/calls/{id}` path for any call id (never interpolated raw). */
export function callPath(callId: string): string {
  return `/agents/calls/${encodeURIComponent(callId)}`;
}

const LIVE = new Set(["created", "started"]);

export type VerifyResult =
  | { ok: true; callId: string }
  | { ok: false; reason: "bad_response" | "agent_mismatch" | "not_live" | "caller_mismatch" };

/**
 * Is this Cartesia call (GET /agents/calls/{id} body: id, agent_id, status, telephony_params)
 * a live call on OUR inbound agent from this caller? Fail closed on anything unexpected. This
 * is what makes a leaked tool secret useless on its own: the caller must really be on the line.
 */
export function verifyLiveCall(call: unknown, want: { agentId: string; callerId: string }): VerifyResult {
  if (!call || typeof call !== "object") return { ok: false, reason: "bad_response" };
  const c = call as Record<string, unknown>;
  const id = typeof c.id === "string" && c.id ? c.id : "";
  if (!id) return { ok: false, reason: "bad_response" };
  if (!want.agentId || c.agent_id !== want.agentId) return { ok: false, reason: "agent_mismatch" };
  const status = typeof c.status === "string" ? c.status.toLowerCase() : "";
  if (!LIVE.has(status)) return { ok: false, reason: "not_live" };
  if (!callerCandidates(c.telephony_params).includes(want.callerId)) return { ok: false, reason: "caller_mismatch" };
  return { ok: true, callId: id };
}

/**
 * Fallback when GET by the conversation id fails (the docs don't say system__conversation_id is
 * the call id): among calls listed on the inbound agent, the one live call from this caller.
 * Ambiguous (two live calls from the same number) = no match.
 */
export function pickLiveCallForCaller(list: unknown, want: { agentId: string; callerId: string }): string | undefined {
  if (!Array.isArray(list)) return undefined;
  const hits = list
    .map((c) => verifyLiveCall(c, want))
    .filter((r): r is { ok: true; callId: string } => r.ok);
  return hits.length === 1 ? hits[0].callId : undefined;
}

export type LookupResponse = Record<string, string>;

/**
 * Unknown number: nothing about anyone, just enough for the agent to say a polite goodbye.
 * Field names match the known-caller answer so the prompt reads one shape.
 */
export function unknownCallerResponse(): LookupResponse {
  return { caller_known: "no", call_kind: "none", language: "en", speak_as: "Pip", first_name: "" };
}

/** Lookup failed on our side: the agent apologizes and ends the call (no details). */
export function lookupErrorResponse(): LookupResponse {
  return { caller_known: "error", call_kind: "none", language: "en", speak_as: "Pip", first_name: "" };
}

/**
 * Known caller: who to be (his character), in which language, which call, and the same
 * variables an outbound call of that kind sends to the character agents: first_name, goal and
 * context (lib/prompts/agent.ts). Values are already "none"-filled strings.
 */
export function knownCallerResponse(a: {
  kind: "onboarding" | "story";
  lang: CallLanguage;
  /** His character (lib/characters.ts): who the inbound agent speaks as, and how. */
  character: { name: string; personality?: string };
  variables: Record<string, string>;
}): LookupResponse {
  const out: LookupResponse = {
    caller_known: "yes",
    call_kind: a.kind,
    language: a.lang,
    speak_as: a.character.name,
    persona: a.character.personality?.trim() || "none",
  };
  for (const [k, value] of Object.entries(a.variables)) out[k] = String(value);
  return clampResponse(out);
}

/** Keep the answer under Cartesia's 16 KiB tool-result cap by trimming the longest field. */
export function clampResponse(res: LookupResponse, maxBytes = MAX_LOOKUP_BYTES): LookupResponse {
  const out = { ...res };
  const size = () => new TextEncoder().encode(JSON.stringify(out)).length;
  let guard = 0;
  while (size() > maxBytes && guard++ < 50) {
    const longest = Object.keys(out).sort((x, y) => out[y].length - out[x].length)[0];
    out[longest] = `${out[longest].slice(0, Math.floor(out[longest].length * 0.7))}…`;
  }
  return out;
}

/** Copied into the call's dynamic variables (visible in GET /agents/calls), for debugging. */
export const LOOKUP_ASSIGNMENTS = [
  { dynamic_variable: "caller_known", value_path: "caller_known" },
  { dynamic_variable: "call_kind", value_path: "call_kind" },
  { dynamic_variable: "first_name", value_path: "first_name" },
  { dynamic_variable: "language", value_path: "language" },
];

/** POST /v1/agents/tools body for the lookup (shape from docs.cartesia.ai/agents/webhook-tools). */
export function buildLookupTool(a: { url: string; secret: string }) {
  return {
    type: "webhook",
    name: LOOKUP_TOOL_NAME,
    description:
      "Look up who is calling, from their phone number (filled in automatically). Call it right after your greeting, before anything else. It returns whether the caller is a Front Porch member, which call this is, the language to speak, and what you know about them.",
    pre_tool_speech: "auto",
    execution_mode: "immediate",
    response_timeout_secs: LOOKUP_TIMEOUT_SECS,
    api_schema: {
      url: a.url,
      method: "POST",
      request_body_schema: {
        type: "object",
        properties: {
          caller_id: { type: "string", dynamic_variable: "system__caller_id" },
          conversation_id: { type: "string", dynamic_variable: "system__conversation_id" },
        },
        required: ["caller_id", "conversation_id"],
      },
      authentication: { mode: "bearer", token: { type: "secret", secret_value: a.secret } },
    },
    assignments: LOOKUP_ASSIGNMENTS,
  };
}

/** Lookup URL from the deployment's site URL (https://<name>.convex.site). */
export function lookupUrl(siteUrl: string | undefined): string {
  const base = (siteUrl ?? "").trim().replace(/\/+$/, "");
  if (!/^https:\/\//.test(base)) {
    throw new Error("No HTTPS site URL for the lookup tool: set INBOUND_SITE_URL (e.g. https://<deployment>.convex.site)");
  }
  return `${base}${LOOKUP_PATH}`;
}

/**
 * Lookup-time row decision. Cartesia may retry the tool, or the model may call it twice, so:
 * no row -> insert; a row that already answered a lookup -> send the SAME answer again (never
 * re-plan mid-call: the question would change); a row without one (the backstop made it) -> reuse.
 */
export function lookupReuseDecision(
  existing: { _id: string; inboundLookup?: unknown } | null,
): { action: "insert" } | { action: "cached"; response: LookupResponse } | { action: "reuse" } {
  if (!existing) return { action: "insert" };
  const cached = existing.inboundLookup;
  if (cached && typeof cached === "object" && !Array.isArray(cached)) {
    const response: LookupResponse = {};
    for (const [k, value] of Object.entries(cached as Record<string, unknown>)) response[k] = String(value);
    return { action: "cached", response };
  }
  return { action: "reuse" };
}

/** Backstop: how close (ms) a lookup-made row must be to a listed call's start to be the same call. */
export const ATTACH_WINDOW_MS = 10 * 60_000;

export type OpenInboundRow = { _id: string; elderId: string; createdAt: number };

/**
 * Backstop row matching for a finished listed call. A row with this id (or conversation id):
 * nothing to do. Else, if the same elder has exactly one open inbound row (no transcript yet)
 * created near the call's start, it's the same call recorded under a different id: attach the
 * listed id to it instead of inserting a duplicate. Else insert.
 */
export function matchBackstopRow(
  listed: { id: string; startMs?: number; elderId: string },
  ctx: { idHasRow: boolean; openInbound: OpenInboundRow[] },
  windowMs = ATTACH_WINDOW_MS,
): { kind: "has_row" } | { kind: "attach"; rowId: string } | { kind: "insert" } {
  if (ctx.idHasRow) return { kind: "has_row" };
  const near = ctx.openInbound.filter(
    (r) =>
      r.elderId === listed.elderId &&
      (listed.startMs === undefined || Math.abs(r.createdAt - listed.startMs) <= windowMs),
  );
  return near.length === 1 ? { kind: "attach", rowId: near[0]._id } : { kind: "insert" };
}

/**
 * Inbound calls mark their bank question used only once processing found a real conversation
 * (not at lookup time: a timed-out lookup or a hang-up must not consume his best question).
 * Outbound calls already marked it when the phone rang.
 */
export function inboundPlanToMark(call: { direction?: string; plan?: unknown } | null, status: string): string | null {
  if (!call || call.direction !== "inbound") return null;
  if (status !== "done" && status !== "process_failed") return null;
  const bankId = (call.plan as { bankId?: unknown } | undefined)?.bankId;
  return typeof bankId === "string" && bankId ? bankId : null;
}

/**
 * syncAgent for the inbound pieces: create only when asked ('{"inbound":true}'); a plain sync
 * updates only when BOTH ids are set (never creates a stray lookup tool), otherwise skips.
 */
export function inboundSyncMode(mayCreate: boolean, agentId?: string, toolId?: string): "create" | "update" | "skip" {
  if (mayCreate) return "create";
  return agentId && toolId ? "update" : "skip";
}

/** Short budget for the verification fetch: the whole lookup must fit Cartesia's 20 s tool wait. */
export const VERIFY_TIMEOUT_MS = 5_000;

const FINISHED = new Set(["completed", "failed"]);

export type BackstopCall = {
  id?: unknown;
  status?: unknown;
  end_time?: unknown;
  telephony_params?: unknown;
};

/**
 * Backstop (syncInboundCalls): should this listed call get a calls row now? Only finished
 * inbound calls we have no row for (the lookup never ran), from a number that is an elder.
 */
export function backstopDecision(
  call: BackstopCall,
  ctx: { hasRow: boolean; elderPhone?: string },
): { ingest: true } | { ingest: false; reason: string } {
  if (typeof call.id !== "string" || !call.id) return { ingest: false, reason: "no id" };
  const tp = (call.telephony_params ?? {}) as Record<string, unknown>;
  const direction = typeof tp.direction === "string" ? tp.direction.toLowerCase() : "";
  if (direction && direction !== "inbound") return { ingest: false, reason: "not inbound" };
  const status = typeof call.status === "string" ? call.status.toLowerCase() : "";
  if (!FINISHED.has(status) && !(typeof call.end_time === "string" && call.end_time)) {
    return { ingest: false, reason: "still in progress" };
  }
  if (ctx.hasRow) return { ingest: false, reason: "already recorded" };
  if (!ctx.elderPhone) return { ingest: false, reason: "caller is not an elder" };
  return { ingest: true };
}
