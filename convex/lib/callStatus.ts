// What the sign-up page tells him about his latest call (signup.callStatus). Pure mapping from our
// call statuses + Cartesia's documented values (Get Call: status created | started | completed |
// failed; end_reason dial_no_answer, dial_busy, voicemail_detected, ...). The page turns each state
// into a friendly es/en message (frontend/onboarding-ui/src/i18n.js `status`). No Convex imports.

import { CALL_COOLDOWN_MS, CALLS_PER_DAY } from "./signupRules.ts";

const DAY_MS = 24 * 60 * 60_000;

export type CallState =
  | "none" // no call yet
  | "dialing" // queued, or Cartesia "created"
  | "in_call" // Cartesia "started" (ringing or talking: Cartesia doesn't tell them apart)
  | "wrapping_up" // call over, we're writing it up
  | "done"
  | "no_answer"
  | "busy"
  | "voicemail"
  | "unreachable"
  | "ended_early"
  | "busy_lines"
  | "start_failed"
  | "unsure"
  | "trouble";

/** States where the call is still happening (the page keeps checking). */
export const LIVE_STATES: ReadonlySet<CallState> = new Set(["dialing", "in_call", "wrapping_up"]);

const NO_CONVERSATION_REASONS: Record<string, CallState> = {
  dial_no_answer: "no_answer",
  dial_timeout: "no_answer",
  dial_busy: "busy",
  voicemail_detected: "voicemail",
  dial_failed: "unreachable",
  concurrency_limit: "busy_lines",
  config_error: "trouble",
  network_error: "trouble",
  agent_error: "trouble",
  error: "trouble",
};

const STALE_MS = 90 * 60_000; // = lib/onboarding.OPEN_CALL_WINDOW_MS: an open row older than this is stuck

/** One calls row (only the fields that matter) -> what to tell him. */
export function callState(
  call: { status: string; _creationTime: number; endReason?: string; liveStatus?: string } | null,
  now: number,
): CallState {
  if (!call) return "none";
  const open = call.status === "queued" || call.status === "in_progress" || call.status === "ended";
  if (open && now - call._creationTime > STALE_MS) return "trouble";
  switch (call.status) {
    case "queued":
      return "dialing";
    case "in_progress":
      return call.liveStatus === "started" ? "in_call" : "dialing";
    case "ended": // already known not to be a conversation (voicemail, no answer): say so now
      return NO_CONVERSATION_REASONS[(call.endReason ?? "").toLowerCase()] ?? "wrapping_up";
    case "done":
    case "process_failed": // the call itself went fine; only our write-up failed (we rerun it by hand)
      return "done";
    case "no_conversation":
      return NO_CONVERSATION_REASONS[(call.endReason ?? "").toLowerCase()] ?? "ended_early";
    case "failed":
      return "start_failed";
    case "start_unknown":
      return "unsure";
    default: // poll_error, poll_timeout, anything new
      return "trouble";
  }
}

/**
 * When requestCall would accept another call (signup rules: 10 min apart, at most CALLS_PER_DAY a
 * day). `callTimes` = creation times of his newest CALLS_PER_DAY calls.
 */
export function retryAllowedAt(callTimes: number[], now: number): number {
  const cooldownEnd = Math.max(0, ...callTimes.map((t) => t + CALL_COOLDOWN_MS));
  const today = callTimes.filter((t) => now - t < DAY_MS).sort((a, b) => a - b);
  const dayEnd = today.length >= CALLS_PER_DAY ? today[today.length - CALLS_PER_DAY] + DAY_MS : 0;
  return Math.max(now, cooldownEnd, dayEnd);
}

/**
 * May the page offer "Try again"? Only for a finished call that didn't work, while he's still in
 * onboarding (requestCall only places that call) and page calls are on; `retryAt` says when.
 */
export function retryOffer(
  state: CallState,
  opts: { createdAt: number; onboarding: boolean; callsOn: boolean; callTimes: number[]; now: number },
): { canRetry: boolean; retryAt?: number } {
  if (state === "none" || state === "done" || LIVE_STATES.has(state)) return { canRetry: false };
  if (!opts.onboarding || !opts.callsOn) return { canRetry: false };
  // unsure: the phone may have rung, so a new call is blocked for the open-call window too.
  const openUntil = state === "unsure" ? opts.createdAt + STALE_MS : 0;
  const retryAt = Math.max(openUntil, retryAllowedAt(opts.callTimes, opts.now));
  return retryAt <= opts.now ? { canRetry: true } : { canRetry: false, retryAt };
}
