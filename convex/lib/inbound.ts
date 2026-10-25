// Inbound calls (he calls the MEMORIA number): pure helpers, unit-tested in
// tests/inbound.test.ts. No runtime imports beyond ./ (Node runs them directly).
//
// One phone number routes to one Cartesia agent, and nothing lets us hand that agent a
// per-caller plan before it speaks. So the inbound agent greets generically, then calls the
// `lookup_caller` webhook tool (docs.cartesia.ai/agents/webhook-tools): Cartesia fills
// caller_id (+ conversation_id when it has one) from system variables, our Convex HTTP action
// finds the elder by phone and answers with his plan as JSON. The tool result is read by the
// in-call model (any 2xx text body, max 16 KiB); `assignments` also copy a few fields into the
// call's dynamic variables, so the call record shows who it was.
//
// Voice: a Cartesia agent has ONE voice (config.audio.output.voice_id), fixed for the call; no
// mid-call voice change and no hand-off to another agent exist (docs.cartesia.ai/agents/
// configuration, /agents/system-tools). So the call-in line speaks as one host for everyone:
// CARTESIA_INBOUND_HOST (inboundHost). An elder whose host is someone else gets a callback: the
// line's host says his host will call right back and hangs up, then his host's own agent calls
// him (inbound.recordHandoff). It never claims to be a voice it isn't.

import { characterFor, getCharacter, type CharacterConfig } from "./characters.ts";
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
  // "tel:+1415..." / "sip:+1415...@host" are how some carriers write a caller id.
  const trimmed = raw.trim().replace(/^(?:tel|sip):/i, "").replace(/@.*$/, "");
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

export type LookupRequest = { callerId: string; conversationId?: string };

export type ParsedLookup =
  | ({ ok: true } & LookupRequest)
  /** bad_body: not the tool's JSON (-> 400). no_caller_id: a withheld/unusable number (-> "unknown"). */
  | { ok: false; reason: "bad_body" | "no_caller_id" };

/** Printable, no spaces, at most 128 chars: Cartesia's id format isn't documented, so stay open. */
const CALL_ID = /^[\x21-\x7E]{1,128}$/;

/**
 * The tool's JSON body -> validated fields. caller_id must be a string (Cartesia sends "" when
 * the number is withheld: that's a polite "unknown", not a 400). conversation_id is optional:
 * without a usable one the call is verified by listing the inbound agent's live calls instead.
 * The id is only ever used as an index value and in URL paths through encodeURIComponent.
 */
export function parseLookupRequest(body: unknown): ParsedLookup {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, reason: "bad_body" };
  const b = body as Record<string, unknown>;
  if (typeof b.caller_id !== "string") return { ok: false, reason: "bad_body" };
  const callerId = normalizePhone(b.caller_id);
  if (!callerId) return { ok: false, reason: "no_caller_id" };
  const conv = typeof b.conversation_id === "string" ? b.conversation_id.trim() : "";
  return { ok: true, callerId, ...(CALL_ID.test(conv) ? { conversationId: conv } : {}) };
}

/** Which host answers the call-in line: CARTESIA_INBOUND_HOST, else the default for CARTESIA_INBOUND_LANGUAGE. */
export function inboundHost(env: { CARTESIA_INBOUND_HOST?: string; CARTESIA_INBOUND_LANGUAGE?: string }): CharacterConfig {
  const id = (env.CARTESIA_INBOUND_HOST ?? "").trim().toLowerCase();
  const lang: CallLanguage = env.CARTESIA_INBOUND_LANGUAGE === "es" ? "es" : "en";
  return getCharacter(id) ?? characterFor(undefined, lang);
}

/** Wait before his host calls back: the line's host says goodbye and hangs up first (a busy line won't ring). */
export const CALLBACK_DELAY_MS = 20_000;
/** endReason of the short inbound call that ended in a callback (no conversation, not a miss). */
export const HANDOFF_END_REASON = "handoff";

/** After the lookup: talk now (his host is the line's host) or hand off to his host's callback. */
export function inboundNextStep(lineHostId: string, hisHostId: string): "talk" | "callback" {
  return lineHostId === hisHostId ? "talk" : "callback";
}

/** The env says a host that doesn't exist: syncAgent refuses rather than silently using Daniel. */
export function inboundHostProblem(env: { CARTESIA_INBOUND_HOST?: string }): string | undefined {
  const id = (env.CARTESIA_INBOUND_HOST ?? "").trim().toLowerCase();
  return id && !getCharacter(id) ? `Unknown CARTESIA_INBOUND_HOST "${id}" (see lib/characters.ts)` : undefined;
}

export type LookupOutcome = "known" | "unknown" | "error";

/** What the answer told the agent, for the one log line and the inboundLookups row. */
export function lookupOutcome(res: LookupResponse): LookupOutcome {
  return res.caller_known === "yes" ? "known" : res.caller_known === "no" ? "unknown" : "error";
}

/**
 * The one log line per lookup: outcome + a code-chosen reason. Reasons are lowercase words
 * joined by "_" and ":" (e.g. "not_verified:not_found"); anything else, digits included, is
 * dropped, so a number or a secret can never end up in the log.
 */
export function lookupLogLine(outcome: LookupOutcome, reason?: string): string {
  const safe = (reason ?? "").toLowerCase().replace(/[^a-z_:]/g, "");
  return `inbound-lookup: ${outcome}${safe ? ` ${safe}` : ""}`;
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

type HostName = { name: string; language?: CallLanguage };
const DEFAULT_HOST: HostName = { name: "Daniel", language: "en" };

/**
 * Unknown number: nothing about anyone, just enough for the agent to say a polite goodbye.
 * Field names match the known-caller answer so the prompt reads one shape.
 */
export function unknownCallerResponse(host: HostName = DEFAULT_HOST): LookupResponse {
  return { caller_known: "no", call_kind: "none", language: host.language ?? "en", speak_as: host.name, his_host: host.name, first_name: "" };
}

/** Lookup failed on our side: the agent apologizes and ends the call (no details). */
export function lookupErrorResponse(host: HostName = DEFAULT_HOST): LookupResponse {
  return { caller_known: "error", call_kind: "none", language: host.language ?? "en", speak_as: host.name, his_host: host.name, first_name: "" };
}

/**
 * Known caller: which call, in which language, and the same variables an outbound call of
 * that kind sends to the character agents: first_name, goal and context (lib/prompts/agent.ts).
 * speak_as is always the host whose voice answers the line (`host`); his_host is the host who
 * usually calls him. When they differ the agent introduces itself as his host's colleague.
 * Values are already "none"-filled strings.
 */
export function knownCallerResponse(a: {
  kind: "onboarding" | "story";
  lang: CallLanguage;
  /** His character (lib/characters.ts): the host who calls him. */
  character: { name: string };
  /** The call-in line's host (inboundHost). Missing = same as his character. */
  host?: { name: string };
  variables: Record<string, string>;
}): LookupResponse {
  const host = a.host ?? a.character;
  const out: LookupResponse = {
    caller_known: "yes",
    call_kind: a.kind,
    language: a.lang,
    speak_as: host.name,
    his_host: a.character.name,
    same_host: host.name === a.character.name ? "yes" : "no",
    next_step: "talk",
  };
  for (const [k, value] of Object.entries(a.variables)) out[k] = String(value);
  return clampResponse(out);
}

/**
 * Known caller whose host is someone else: only what the line's host needs to say "<his_host>
 * will call you right back" in his language. No goal or context: she never runs the conversation.
 */
export function callbackResponse(a: {
  kind: "onboarding" | "story";
  lang: CallLanguage;
  character: { name: string };
  host: { name: string };
  firstName: string;
}): LookupResponse {
  return {
    caller_known: "yes",
    call_kind: a.kind,
    language: a.lang,
    speak_as: a.host.name,
    his_host: a.character.name,
    same_host: "no",
    next_step: "callback",
    first_name: a.firstName.trim() || "none",
  };
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
  { dynamic_variable: "his_host", value_path: "his_host" },
  { dynamic_variable: "next_step", value_path: "next_step" },
];

/** POST /v1/agents/tools body for the lookup (shape from docs.cartesia.ai/agents/webhook-tools). */
export function buildLookupTool(a: { url: string; secret: string }) {
  return {
    type: "webhook",
    name: LOOKUP_TOOL_NAME,
    description:
      "Look up who is calling, from their phone number (filled in automatically). Call it right after your greeting, before anything else. It returns whether the caller is a Memoria member, which call this is, the language to speak, their first name, and what you know about them.",
    // off: the greeting already said "one moment"; nothing to say before the lookup.
    pre_tool_speech: "off",
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
        // Empty on purpose: Cartesia rejects `required` on dynamic_variable parameters (HTTP 400),
        // and an omitted list counts as every property. A missing caller_id still reaches
        // http.ts, which answers as an unknown caller (polite goodbye).
        required: [],
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
