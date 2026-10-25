// Repeating-call loop + the sign-up page's call status. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";

import { BLOCKED_WARNING, blockedWarning, callEndedAt, loopDecision, missedInARow, parseIntervalMinutes, REQUEST_COOLDOWN_MS } from "../convex/lib/callLoop.ts";
import { callState, LIVE_STATES } from "../convex/lib/callStatus.ts";
import { NOW } from "./helpers.ts";

const MIN = 60_000;
const active = { stage: "active" };
const done = (endedMinAgo: number) => ({ status: "done", _creationTime: NOW - (endedMinAgo + 10) * MIN, endedAt: NOW - endedMinAgo * MIN });

test("parseIntervalMinutes: positive minutes, else off; capped at 30 days", () => {
  assert.equal(parseIntervalMinutes("5"), 5);
  assert.equal(parseIntervalMinutes(" 0.5 "), 0.5);
  for (const off of [undefined, "", "0", "-3", "abc", "NaN"]) assert.equal(parseIntervalMinutes(off), null, String(off));
  assert.equal(parseIntervalMinutes("999999"), 30 * 24 * 60);
});

test("loop: off without an interval; never calls someone who never had a call", () => {
  assert.deepEqual(loopDecision(active, [done(60)], NOW, null), { action: "off" });
  assert.deepEqual(loopDecision(active, [], NOW, 5), { action: "skip", reason: "never_called" });
  assert.deepEqual(loopDecision({}, [done(60)], NOW, 5), { action: "skip", reason: "not_signed_up" });
  assert.deepEqual(loopDecision({ stage: "archived" }, [done(60)], NOW, 5), { action: "skip", reason: "not_signed_up" }, "started over");
});

test("loop: the interval starts when the call ENDS; an open call makes it wait", () => {
  // ended 3 min ago, interval 5 -> wait until 2 more minutes
  assert.deepEqual(loopDecision(active, [done(3)], NOW, 5), { action: "wait", dueAt: NOW + 2 * MIN });
  assert.deepEqual(loopDecision(active, [done(5)], NOW, 5), { action: "call", dueAt: NOW });
  // still talking (started 40 min ago, longer than the interval): wait, never call over it
  const talking = { status: "in_progress", _creationTime: NOW - 40 * MIN };
  assert.deepEqual(loopDecision(active, [talking, done(60)], NOW, 5), { action: "skip", reason: "call_open" });
  // over, still being written up: wait
  const writingUp = { status: "ended", _creationTime: NOW - 20 * MIN, endedAt: NOW - 10 * MIN };
  assert.deepEqual(loopDecision(active, [writingUp], NOW, 5), { action: "skip", reason: "call_open" });
  // lost track of a recent call (poll 404): he may still be talking, wait out the open window
  const lost = { status: "poll_error", _creationTime: NOW - 30 * MIN, endedAt: NOW - 29 * MIN };
  assert.deepEqual(loopDecision(active, [lost], NOW, 5), { action: "skip", reason: "call_open" });
  assert.equal(loopDecision(active, [{ ...lost, _creationTime: NOW - 91 * MIN }], NOW, 5).action, "call");
  // an older row that ended later (re-attached inbound call) sets the clock
  assert.deepEqual(loopDecision(active, [done(30), done(2)], NOW, 5), { action: "wait", dueAt: NOW + 3 * MIN });
});

test("loop: pauses after 3 his-side misses in a row; our-side failures don't count or reset", () => {
  const row = (status: string, minAgo: number, endReason?: string) => ({ status, endReason, _creationTime: NOW - minAgo * MIN, endedAt: NOW - minAgo * MIN });
  const miss = (minAgo: number) => row("no_conversation", minAgo, "dial_no_answer");
  assert.deepEqual(loopDecision(active, [miss(10), miss(20), miss(30)], NOW, 5), { action: "skip", reason: "paused" });
  assert.equal(loopDecision(active, [miss(10), miss(20)], NOW, 5).action, "call");
  assert.equal(loopDecision(active, [miss(10), done(20), miss(30)], NOW, 5).action, "call");
  // our side (planning failed, line limit) is skipped: still 3 of his
  const ours = [miss(10), row("failed", 15), row("no_conversation", 18, "concurrency_limit"), miss(20), miss(30)];
  assert.equal(missedInARow(ours), 3);
  // dialled but status lost counts
  assert.equal(missedInARow([row("poll_error", 5), row("poll_timeout", 9), row("start_unknown", 200), done(300)]), 3);
  // he called in and the line's host handed off to his host's callback: not a miss
  assert.equal(missedInARow([miss(5), row("no_conversation", 6, "handoff"), miss(20)]), 2);
});

test("loop: a recent request blocks a second one; old rows fall back to lastPolledAt", () => {
  const recentAsk = { ...active, loopRequestedAt: NOW - (REQUEST_COOLDOWN_MS - 1000) };
  assert.deepEqual(loopDecision(recentAsk, [done(10)], NOW, 5), { action: "skip", reason: "requested" });
  assert.equal(callEndedAt({ status: "done", _creationTime: 1, lastPolledAt: 7 }), 7);
  assert.equal(callEndedAt({ status: "failed", _creationTime: 3 }), 3);
  // staggered stamp in the future still blocks; a failed start retries once per interval (here 10 min)
  const staggered = { ...active, loopRequestedAt: NOW + 60_000 };
  assert.deepEqual(loopDecision(staggered, [done(30)], NOW, 10), { action: "skip", reason: "requested" });
  assert.equal(loopDecision({ ...active, loopRequestedAt: NOW - 11 * MIN }, [done(30)], NOW, 10).action, "call");
});

test("callState: our statuses + Cartesia's documented end reasons -> friendly states", () => {
  assert.equal(callState(null, NOW), "none");
  assert.equal(callState({ status: "queued", _creationTime: NOW }, NOW), "dialing");
  assert.equal(callState({ status: "in_progress", liveStatus: "created", _creationTime: NOW }, NOW), "dialing");
  assert.equal(callState({ status: "in_progress", liveStatus: "started", _creationTime: NOW }, NOW), "in_call");
  assert.equal(callState({ status: "ended", _creationTime: NOW }, NOW), "wrapping_up");
  assert.equal(callState({ status: "ended", endReason: "voicemail_detected", _creationTime: NOW }, NOW), "voicemail");
  assert.equal(callState({ status: "done", _creationTime: NOW }, NOW), "done");
  assert.equal(callState({ status: "process_failed", _creationTime: NOW }, NOW), "done");
  const reasons: [string, string][] = [
    ["dial_no_answer", "no_answer"],
    ["dial_timeout", "no_answer"],
    ["dial_busy", "busy"],
    ["voicemail_detected", "voicemail"],
    ["dial_failed", "unreachable"],
    ["concurrency_limit", "busy_lines"],
    ["config_error", "trouble"],
    ["client_hangup", "ended_early"],
    ["call_inactivity", "ended_early"],
  ];
  for (const [endReason, state] of reasons) assert.equal(callState({ status: "no_conversation", endReason, _creationTime: NOW }, NOW), state, endReason);
  assert.equal(callState({ status: "failed", _creationTime: NOW }, NOW), "start_failed");
  assert.equal(callState({ status: "start_unknown", _creationTime: NOW }, NOW), "unsure");
  assert.equal(callState({ status: "poll_timeout", _creationTime: NOW }, NOW), "trouble");
  assert.ok(LIVE_STATES.has("in_call") && !LIVE_STATES.has("no_answer"));
  // a row stuck open past the 90-min window is trouble, not "still calling"
  assert.equal(callState({ status: "in_progress", _creationTime: NOW - 91 * MIN }, NOW), "trouble");
});

test("retryAllowedAt / retryOffer: same limits as requestCall (10 min apart, 3 a day)", async () => {
  const { retryAllowedAt, retryOffer } = await import("../convex/lib/callStatus.ts");
  assert.equal(retryAllowedAt([NOW - 4 * MIN], NOW), NOW + 6 * MIN); // 10-min gap
  assert.equal(retryAllowedAt([NOW - 30 * MIN, NOW - 60 * MIN, NOW - 90 * MIN], NOW), NOW - 90 * MIN + 24 * 60 * MIN); // 3 today
  assert.equal(retryAllowedAt([NOW - 30 * MIN], NOW), NOW);
  const base = { createdAt: NOW - 5 * MIN, onboarding: true, callsOn: true, now: NOW };
  assert.deepEqual(retryOffer("no_answer", { ...base, callTimes: [NOW - 30 * MIN] }), { canRetry: true });
  assert.deepEqual(retryOffer("no_answer", { ...base, callTimes: [NOW - 4 * MIN] }), { canRetry: false, retryAt: NOW + 6 * MIN });
  assert.deepEqual(retryOffer("in_call", { ...base, callTimes: [] }), { canRetry: false });
  assert.deepEqual(retryOffer("done", { ...base, callTimes: [] }), { canRetry: false });
  assert.deepEqual(retryOffer("unsure", { ...base, callTimes: [] }), { canRetry: false, retryAt: NOW + 85 * MIN });
  assert.deepEqual(retryOffer("unsure", { ...base, onboarding: false, callTimes: [] }), { canRetry: false });
  assert.deepEqual(retryOffer("unsure", { ...base, createdAt: NOW - 100 * MIN, callTimes: [NOW - 100 * MIN] }), { canRetry: true });
  assert.deepEqual(retryOffer("no_answer", { ...base, onboarding: false, callTimes: [] }), { canRetry: false });
  assert.deepEqual(retryOffer("no_answer", { ...base, callsOn: false, callTimes: [] }), { canRetry: false });
});

test("loopInterval / loopCovers: off unless AUTO_POST=off (short interval); allowlist unless CALL_LOOP=all", async () => {
  const { loopCovers, loopInterval } = await import("../convex/lib/callLoop.ts");
  assert.deepEqual(loopInterval({ CALL_INTERVAL_MINUTES: "5", AUTO_POST: "off" }), { minutes: 5 });
  assert.deepEqual(loopInterval({}), { minutes: null });
  // AUTO_POST on (the default) may post on any platform: no fast loop, whatever keys are set.
  const live = { CALL_INTERVAL_MINUTES: "5" };
  assert.deepEqual(loopInterval(live), { minutes: null, blocked: "posting_live" });
  assert.deepEqual(loopInterval({ ...live, AUTO_POST: "off" }), { minutes: 5 });
  assert.deepEqual(loopInterval({ ...live, CALL_INTERVAL_MINUTES: "10080" }), { minutes: 10080 });
  const env = { CALL_INTERVAL_MINUTES: "5", AUTO_POST: "off", CALL_ALLOWLIST: "+14155550123, +5215512345678" };
  assert.equal(loopCovers(env, "+14155550123"), true);
  assert.equal(loopCovers(env, "+14155550999"), false);
  assert.equal(loopCovers({ ...env, CALL_LOOP: "all" }, "+14155550999"), true);
  assert.equal(loopCovers({ CALL_ALLOWLIST: "+14155550123" }, "+14155550123"), false); // loop off
});

test("blockedWarning: once an hour (minute 0) while blocked, fixed text naming AUTO_POST=off", () => {
  const top = Date.UTC(2026, 9, 24, 15, 0, 20);
  assert.equal(blockedWarning("posting_live", top), BLOCKED_WARNING);
  assert.ok(BLOCKED_WARNING.includes("AUTO_POST=off"));
  assert.equal(blockedWarning("posting_live", top + 60_000), null, "minute 1: quiet");
  assert.equal(blockedWarning(undefined, top), null, "loop simply off: nothing to warn about");
});
