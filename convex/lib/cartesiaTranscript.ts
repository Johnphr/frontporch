// Cartesia Managed Agents call -> our shapes. Pure, no runtime imports (unit-tested).
//
// GET /agents/calls/{id} returns (docs.cartesia.ai, api-reference/agents/calls/get-call):
//   status: created | started | completed | failed
//   end_reason: agent_hangup | voicemail_detected | client_hangup | api_cancelled |
//     max_duration | call_inactivity | client_inactivity | client_disconnected |
//     dial_no_answer | dial_busy | dial_failed | dial_timeout | concurrency_limit |
//     agent_error | network_error | config_error | error   (nullable)
//   summary: string | null
//   transcript: [{ role: "user" | "assistant" | "system", text, start_timestamp,
//                  end_timestamp, tool_calls?, ... }] | null
//
// cartesia.pollCall uses cartesiaCallOutcome() to decide when the call is over, then
// passes the result to pipeline.recordCallResult.

export type Turn = { role: "pip" | "elder"; text: string };

const PIP_ROLES = new Set(["assistant", "agent", "bot", "pip", "ai"]);
const ELDER_ROLES = new Set(["user", "customer", "human", "caller", "elder"]);

/**
 * Cartesia transcript items -> Turn[]: assistant -> "pip", user -> "elder"; system,
 * tool-only and empty items are dropped; consecutive turns by the same speaker are
 * joined (speech-to-text often splits one answer into several items).
 * Accepts the transcript array itself or the whole call object.
 */
export function normalizeCartesiaTranscript(raw: unknown): Turn[] {
  const items: unknown[] = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { transcript?: unknown }).transcript)
      ? ((raw as { transcript: unknown[] }).transcript)
      : [];
  const sorted = items
    .map((item, index) => ({ item, index }))
    .filter((x): x is { item: Record<string, unknown>; index: number } => !!x.item && typeof x.item === "object")
    .sort((a, b) => startOf(a.item) - startOf(b.item) || a.index - b.index);

  const turns: Turn[] = [];
  for (const { item } of sorted) {
    const roleRaw = typeof item.role === "string" ? item.role.trim().toLowerCase() : "";
    const role: Turn["role"] | null = PIP_ROLES.has(roleRaw) ? "pip" : ELDER_ROLES.has(roleRaw) ? "elder" : null;
    const text = typeof item.text === "string" ? item.text.replace(/\s+/g, " ").trim() : "";
    if (!role || !text) continue;
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.text = `${last.text} ${text}`;
    else turns.push({ role, text });
  }
  return turns;
}

function startOf(item: Record<string, unknown>): number {
  const t = item.start_timestamp;
  return typeof t === "number" && Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
}

export type CallOutcome = {
  /** the call is over (completed or failed): safe to record and process */
  finished: boolean;
  status: string;
  endReason: string;
  summary?: string;
  turns: Turn[];
};

/** Read a GET /agents/calls/{id} response into what recordCallResult needs. */
export function cartesiaCallOutcome(raw: unknown): CallOutcome {
  const call = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const status = typeof call.status === "string" ? call.status : "unknown";
  const endReason =
    typeof call.end_reason === "string" && call.end_reason
      ? call.end_reason
      : status === "failed"
        ? typeof call.error_message === "string" && call.error_message
          ? `error: ${call.error_message}`
          : "error"
        : "";
  const summary = typeof call.summary === "string" && call.summary.trim() ? call.summary.trim() : undefined;
  return {
    finished: status === "completed" || status === "failed",
    status,
    endReason,
    ...(summary ? { summary } : {}),
    turns: normalizeCartesiaTranscript(call.transcript ?? []),
  };
}
