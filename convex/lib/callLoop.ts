// The repeating-call loop (callLoop.tick, every minute): pure decisions, no Convex imports.
//
// CALL_INTERVAL_MINUTES (Convex env, change it any time) = minutes between the END of one call and
// the start of the next. While a call is still open (ringing, talking, or being written up) the loop
// waits; the interval only starts once it has ended. Unset / 0 / invalid = loop off. Only numbers in
// CALL_ALLOWLIST are looped unless CALL_LOOP=all (remove a number to stop calling it).

import { hasOpenCall, OPEN_CALL_WINDOW_MS } from "./onboarding.ts";
import { parseAutoPost } from "./postFlow.ts";
import { publicCallAllowed } from "./signupRules.ts";

/** Minutes between calls, or null when the loop is off. Capped at 30 days. */
export function parseIntervalMinutes(raw: string | undefined): number | null {
  const minutes = Number((raw ?? "").trim());
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  return Math.min(minutes, 30 * 24 * 60);
}

export type LoopCall = {
  status: string;
  _creationTime: number;
  endedAt?: number;
  lastPolledAt?: number;
  endReason?: string;
};

/** When a call ended. Old rows have no endedAt: the last poll (or the start) is the best guess. */
export function callEndedAt(call: LoopCall): number {
  return call.endedAt ?? call.lastPolledAt ?? call._creationTime;
}

/** After this many his-side misses in a row the loop stops calling him until a real conversation happens. */
export const MAX_FAILED_IN_A_ROW = 3;

/** End reasons that are our (or Cartesia's) fault, not his: they neither count nor reset the streak. */
const OUR_SIDE_REASONS = new Set(["concurrency_limit", "config_error", "agent_error", "network_error", "error"]);

/** "his": he was dialled and didn't talk (or we lost the call) · "ours": our failure · "talked". */
function outcome(call: LoopCall): "his" | "ours" | "talked" | "other" {
  if (call.status === "done" || call.status === "process_failed") return "talked";
  if (call.status === "failed") return "ours";
  if (call.status === "no_conversation") return OUR_SIDE_REASONS.has((call.endReason ?? "").toLowerCase()) ? "ours" : "his";
  if (call.status === "start_unknown" || call.status === "poll_timeout" || call.status === "poll_error") return "his";
  return "other";
}

/** His-side misses since his last real conversation (our-side failures skipped). */
export function missedInARow(recent: LoopCall[]): number {
  let misses = 0;
  for (const call of recent) {
    const o = outcome(call);
    if (o === "talked") break;
    if (o === "his") misses += 1;
  }
  return misses;
}

/** Don't ask for a new call within this long of the last request (startCall may still be running). */
export const REQUEST_COOLDOWN_MS = 3 * 60_000;

/**
 * A poll_error inside the open-call window: we lost track of the call (e.g. a 404 before the
 * inbound backstop attached the real id), but he may still be talking. Don't dial over it.
 */
function lostRecently(recent: LoopCall[], now: number): boolean {
  return recent.some((c) => c.status === "poll_error" && now - c._creationTime < OPEN_CALL_WINDOW_MS);
}

export type LoopDecision =
  | { action: "off" }
  | { action: "skip"; reason: "not_signed_up" | "never_called" | "call_open" | "paused" | "requested" }
  | { action: "wait"; dueAt: number }
  | { action: "call"; dueAt: number };

/**
 * Should the loop call him now? `recent` = his latest calls, newest first (take ~10, so three
 * his-side misses can still be found between our-side failures). `loopRequestedAt` is the
 * (staggered) time the last loop start was scheduled for; it may be in the future.
 */
export function loopDecision(
  elder: { stage?: string; loopRequestedAt?: number },
  recent: LoopCall[],
  now: number,
  intervalMinutes: number | null,
): LoopDecision {
  if (intervalMinutes === null) return { action: "off" };
  if (elder.stage !== "onboarding" && elder.stage !== "active") return { action: "skip", reason: "not_signed_up" };
  const latest = recent[0];
  // The first call is always his choice ("Call me now") or started by hand.
  if (!latest) return { action: "skip", reason: "never_called" };
  if (hasOpenCall(recent, now) || lostRecently(recent, now)) return { action: "skip", reason: "call_open" };
  if (missedInARow(recent) >= MAX_FAILED_IN_A_ROW) return { action: "skip", reason: "paused" };
  const intervalMs = intervalMinutes * 60_000;
  const dueAt = Math.max(...recent.map(callEndedAt)) + intervalMs;
  if (now < dueAt) return { action: "wait", dueAt };
  // A start that never wrote a row (agent missing, refused) retries once per interval, not every minute.
  if (elder.loopRequestedAt && now < elder.loopRequestedAt + Math.max(REQUEST_COOLDOWN_MS, intervalMs)) {
    return { action: "skip", reason: "requested" };
  }
  return { action: "call", dueAt };
}

export type LoopEnv = {
  CALL_INTERVAL_MINUTES?: string;
  CALL_LOOP?: string; // "all" = loop everyone; otherwise only CALL_ALLOWLIST numbers
  CALL_ALLOWLIST?: string;
  AUTO_POST?: string;
  LINKEDAPI_TOKEN?: string;
  LINKEDAPI_ID_TOKEN?: string;
};

/**
 * The loop's interval, or off. Off while real posting is live (same check as pipeline.ts) and
 * the interval is under a day, so fast iteration can never post to LinkedIn every few minutes.
 */
export function loopInterval(env: LoopEnv): { minutes: number | null; blocked?: "posting_live" } {
  const minutes = parseIntervalMinutes(env.CALL_INTERVAL_MINUTES);
  if (minutes === null) return { minutes: null };
  const postingLive = parseAutoPost(env.AUTO_POST) && Boolean(env.LINKEDAPI_TOKEN && env.LINKEDAPI_ID_TOKEN);
  if (postingLive && minutes < 24 * 60) return { minutes: null, blocked: "posting_live" };
  return { minutes };
}

/** Does the loop handle this number? (Then the weekly schedule leaves him alone.) */
export function loopCovers(env: LoopEnv, phone: string): boolean {
  if (loopInterval(env).minutes === null) return false;
  return env.CALL_LOOP === "all" || publicCallAllowed("on", env.CALL_ALLOWLIST, phone);
}
