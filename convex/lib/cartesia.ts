// Cartesia Managed Agents: pure helpers (no Convex), unit-tested in tests/cartesia.test.ts.
//
// Cartesia runs the whole call (number, speech-to-text, in-call LLM, voice). We:
//   - push the agent's prompt + settings      POST/PATCH /v1/agents   (buildAgentConfig)
//     (/v1 is the Managed Agents API; the older /agents/{id} only takes flat Line SDK fields)
//   - start a call with per-call variables    POST /agents/calls      (buildOutboundCallBody)
//   - poll the finished call for the text     GET  /agents/calls/{id} (isCallFinished, normalizeTranscript)
// Call webhooks aren't available yet, so convex/cartesia.ts polls.

export const CARTESIA_API = "https://api.cartesia.ai";
export const CARTESIA_VERSION = "2026-08-14";
export const DEFAULT_MODEL = "claude-haiku-4.5"; // in-call model; list: GET /agents/models
export const RINGING_TIMEOUT_SECONDS = 30;
/** Silence is thinking (voice/conversation-guide.md rule 4): check in late, hang up much later. */
export const INACTIVITY_CHECK_IN_SECS = 30;
export const INACTIVITY_END_CALL_SECS = 120;

/** Poll budget: first check after 2 min, then every minute, ~61 min in total. */
export const MAX_POLL_ATTEMPTS = 60;
/** Fewer words than this from him is a voicemail greeting or a dropped call, not an interview. */
export const MIN_ELDER_WORDS = 30;
const MAX_STORED_ERROR = 300;

export type Turn = { role: "pip" | "elder"; text: string };

// Cartesia's docs don't list role values; map the usual names and drop the rest.
const ELDER_ROLES = new Set(["user", "customer", "human", "caller", "elder"]);
const PIP_ROLES = new Set(["assistant", "agent", "bot", "ai", "pip"]);
const IGNORED_ROLES = new Set(["system", "tool", "function"]);

// Status values beyond "created" / "started" aren't documented; these are the likely end states.
// An end_time, end_reason or error_message also means the call is over.
const TERMINAL_STATUSES = new Set([
  "completed", "ended", "finished", "failed", "error", "canceled", "cancelled",
  "no_answer", "busy", "voicemail",
]);
const NO_CONVERSATION_REASONS = ["voicemail", "no_answer", "no-answer", "busy", "not_answered", "machine"];

type Json = Record<string, unknown>;
const isRecord = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

function mapRole(role: string): Turn["role"] | null {
  const r = role.trim().toLowerCase();
  if (ELDER_ROLES.has(r)) return "elder";
  if (PIP_ROLES.has(r)) return "pip";
  return null;
}

/**
 * Cartesia transcript -> exactly { role, text } turns (the calls.transcript validator rejects
 * extra keys). Drops tool/system/unknown roles and empty text; merges consecutive turns by the
 * same speaker, since speech-to-text splits one answer into many segments.
 */
export function normalizeTranscript(raw: unknown): Turn[] {
  if (!Array.isArray(raw)) return [];
  const turns: Turn[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const role = mapRole(str(item.role));
    const text = str(item.text).replace(/\s+/g, " ").trim();
    if (!role || !text) continue;
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.text = `${last.text} ${text}`;
    else turns.push({ role, text });
  }
  return turns;
}

/** Role names we couldn't map, for logging (never the text: it's his private words). */
export function unknownRoles(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out = new Set<string>();
  for (const item of raw) {
    const role = isRecord(item) ? str(item.role).trim().toLowerCase() : "";
    if (role && !mapRole(role) && !IGNORED_ROLES.has(role)) out.add(role);
  }
  return [...out];
}

export function isCallFinished(call: unknown): boolean {
  if (!isRecord(call)) return false;
  if (TERMINAL_STATUSES.has(str(call.status).toLowerCase())) return true;
  return Boolean(str(call.end_time) || str(call.end_reason) || str(call.error_message));
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** Voicemail, no answer, or too little from him to learn anything. */
export function isNoConversation(endReason: string | undefined, turns: Turn[]): boolean {
  const reason = (endReason ?? "").toLowerCase();
  if (NO_CONVERSATION_REASONS.some((r) => reason.includes(r))) return true;
  const words = turns.filter((t) => t.role === "elder").reduce((n, t) => n + wordCount(t.text), 0);
  return words < MIN_ELDER_WORDS;
}

export function nextPollDelayMs(attempt: number): number {
  return attempt <= 0 ? 120_000 : 60_000;
}

export function shouldGiveUp(attempt: number): boolean {
  return attempt >= MAX_POLL_ATTEMPTS;
}

/** HTTP status -> what to do. 0 = network error / timeout. */
export function classifyHttp(status: number): "ok" | "retry" | "fatal" {
  if (status >= 200 && status < 300) return "ok";
  if (status === 0 || status === 408 || status === 429 || status >= 500) return "retry";
  return "fatal";
}

/** Error text is stored on rows and logged; keep it short. */
export function clip(text: string): string {
  return text.length > MAX_STORED_ERROR ? text.slice(0, MAX_STORED_ERROR) : text;
}

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Values for {{variable_name}} placeholders. Every variable is always sent, and an empty value
 * becomes "none", so Pip never reads a raw placeholder out loud.
 */
export function templateVariables(values: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(values)) {
    if (!VARIABLE_NAME.test(name)) throw new Error(`Invalid Cartesia variable name: ${name}`);
    out[name] = value.trim() || "none";
  }
  return out;
}

export type AgentSettings = {
  name: string;
  instructions: string;
  initialMessage: string;
  model?: string;
  voiceId?: string;
  language?: string;
  /** Defaults Cartesia uses when a call doesn't send a variable. */
  placeholders?: Record<string, string>;
  /** Shared webhook/client tool ids (POST /v1/agents/tools) the agent may call. */
  tools?: string[];
};

export function buildAgentConfig(s: AgentSettings) {
  return {
    name: s.name,
    config: {
      instructions: s.instructions,
      initial_message: s.initialMessage,
      model: { id: s.model || DEFAULT_MODEL },
      language: { primary: s.language || "en" },
      dynamic_variable_placeholders: s.placeholders ?? {},
      turn: {
        inactivity_check_in_secs: INACTIVITY_CHECK_IN_SECS,
        inactivity_end_call_secs: INACTIVITY_END_CALL_SECS,
      },
      ...(s.voiceId ? { audio: { output: { voice_id: s.voiceId } } } : {}),
      // docs.cartesia.ai/agents/configuration: `tools` lists shared tools by id, as objects.
      ...(s.tools?.length ? { tools: s.tools.map((id) => ({ id })) } : {}),
      system_tools: {
        end_call: {
          description:
            "End the call only after you have thanked them and said goodbye, or when they clearly want to stop.",
        },
      },
    },
  };
}

export function buildOutboundCallBody(a: {
  agentId: string;
  fromNumberId: string;
  toNumber: string;
  variables: Record<string, string>;
}) {
  return {
    agent_id: a.agentId,
    from_number_id: a.fromNumberId,
    ringing_timeout_seconds: RINGING_TIMEOUT_SECONDS,
    outbound_calls: [{ to_number: a.toNumber, dynamic_variables: a.variables }],
  };
}

export type StartFailure = { error: string; placed: "no" | "unknown" };

/**
 * POST /agents/calls answers per call: { agent_call_id } or { error }. A per-call error is a
 * clear refusal; anything else without an id is unclear (the phone may be ringing). Cartesia's
 * error text isn't kept: it can echo the number.
 */
export function parseOutboundResponse(json: unknown): { callId: string } | StartFailure {
  const first = isRecord(json) && Array.isArray(json.calls) ? json.calls[0] : undefined;
  const callId = isRecord(first) ? str(first.agent_call_id) : "";
  if (callId) return { callId };
  if (isRecord(first) && first.error) return { error: "Cartesia refused the call", placed: "no" };
  return { error: "Cartesia returned no call id", placed: "unknown" };
}

/**
 * HTTP failure on POST /agents/calls -> row status. Only a clear 4xx means nothing rang;
 * a timeout or server error may still have placed the call (`start_unknown` blocks a retry
 * until someone checks Cartesia's call log).
 */
export function startFailureStatus(httpStatus: number): "failed" | "start_unknown" {
  return httpStatus === 0 || httpStatus === 408 || httpStatus >= 500 ? "start_unknown" : "failed";
}

export type PollOutcome =
  | { kind: "pending" }
  | { kind: "fatal"; error: string }
  | { kind: "timeout" }
  | { kind: "finished"; transcript: Turn[]; summary?: string; endReason?: string; error?: string };

export type PollPlan = { patch: Record<string, unknown>; next: "poll" | "process" | null; delayMs: number };

const POLL_TIMEOUT_ERROR = "Stopped checking after about an hour; the call never finished in Cartesia";

/**
 * Compare-and-set for one poll result. Only the chain that saw the current attempt count on an
 * `in_progress` call may write; a duplicate or late chain gets null and stops, so it can't undo
 * `ended` / `done` or double-count attempts.
 */
export function planPollUpdate(
  call: { status: string; pollAttempts?: number },
  seenAttempts: number,
  outcome: PollOutcome,
  now: number,
): PollPlan | null {
  if (call.status !== "in_progress" || (call.pollAttempts ?? 0) !== seenAttempts) return null;
  const base = { pollAttempts: seenAttempts + 1, lastPolledAt: now };
  switch (outcome.kind) {
    case "pending":
      return { patch: base, next: "poll", delayMs: nextPollDelayMs(seenAttempts + 1) };
    case "fatal":
      return { patch: { ...base, status: "poll_error", error: outcome.error }, next: null, delayMs: 0 };
    case "timeout":
      return { patch: { ...base, status: "poll_timeout", error: POLL_TIMEOUT_ERROR }, next: null, delayMs: 0 };
    case "finished": {
      const patch: Record<string, unknown> = { ...base, status: "ended", transcript: outcome.transcript };
      for (const key of ["summary", "endReason", "error"] as const) {
        if (outcome[key] !== undefined) patch[key] = outcome[key];
      }
      return { patch, next: "process", delayMs: 0 };
    }
  }
}
