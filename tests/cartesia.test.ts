// Run: npm test   (Node 22.18+ strips TypeScript types natively)
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_MODEL,
  FAST_POLL_INTERVAL_MS,
  MAX_POLL_ATTEMPTS,
  MAX_POLL_MS,
  POLL_INTERVAL_MS,
  parseEndTime,
  buildAgentConfig,
  buildOutboundCallBody,
  isCallFinished,
  classifyHttp,
  clip,
  isNoConversation,
  nextPollDelayMs,
  normalizeTranscript,
  parseOutboundResponse,
  planPollUpdate,
  shouldGiveUp,
  startFailureStatus,
  templateVariables,
  unknownRoles,
} from "../convex/lib/cartesia.ts";
import { fixture } from "./helpers.ts";

type CallFixture = { status: string; end_time: string; end_reason: string; transcript: unknown };
const call = fixture<CallFixture>("cartesia_call_onboarding.json");

test("normalizeTranscript maps roles, drops tool/system/empty turns, merges same-speaker turns", () => {
  assert.deepEqual(normalizeTranscript(call.transcript), [
    {
      role: "pip",
      text: "Hi Walter, this is Pip, an AI assistant from Front Porch. Tell me about your very first job.",
    },
    { role: "elder", text: "Well, I started at Boeing in 1968, riveting wing panels on the 747 line." },
    { role: "pip", text: "What did that teach you?" },
    {
      role: "elder",
      text: "That you check your own work twice, because somebody's going to fly on it. My foreman, Eddie, would run his thumb over every rivet.",
    },
  ]);
});

test("unknownRoles lists only role names Pip doesn't map (for logging, no text)", () => {
  assert.deepEqual(unknownRoles(call.transcript), ["moderator"]);
  assert.deepEqual(unknownRoles([{ role: "user", text: "x" }]), []);
});

test("normalizeTranscript survives junk input", () => {
  assert.deepEqual(normalizeTranscript(null), []);
  assert.deepEqual(normalizeTranscript("nope"), []);
  assert.deepEqual(normalizeTranscript([null, 3, { role: "user" }, { text: "no role" }]), []);
  assert.deepEqual(normalizeTranscript([{ role: "Customer", text: "hi" }]), [{ role: "elder", text: "hi" }]);
});

test("isCallFinished: terminal status, end_time or end_reason; unknown status alone keeps polling", () => {
  assert.equal(isCallFinished(call), true);
  assert.equal(isCallFinished({ status: "created" }), false);
  assert.equal(isCallFinished({ status: "started" }), false);
  assert.equal(isCallFinished({ status: "something_new" }), false);
  assert.equal(isCallFinished({ status: "started", end_reason: "user_hangup" }), true);
  assert.equal(isCallFinished({ status: "started", end_time: "2026-10-24T17:12:30Z" }), true);
  assert.equal(isCallFinished({ status: "failed" }), true);
  assert.equal(isCallFinished({ status: "started", error_message: "carrier rejected" }), true);
  assert.equal(isCallFinished(null), false);
});

test("isNoConversation: voicemail-like end reasons or no words from him", () => {
  const turns = normalizeTranscript(call.transcript);
  assert.equal(isNoConversation("agent_hangup", turns), false);
  assert.equal(isNoConversation("voicemail", turns), true);
  assert.equal(isNoConversation("no_answer", turns), true);
  assert.equal(isNoConversation("Busy", turns), true);
  assert.equal(isNoConversation("agent_hangup", [{ role: "pip", text: "Hello? Hello?" }]), true);
  // A voicemail greeting is transcribed as him: too few words is not a conversation.
  const greeting = [{ role: "elder" as const, text: "Hi, you've reached Walter. Leave a message after the tone." }];
  assert.equal(isNoConversation("agent_hangup", greeting), true);
  assert.equal(isNoConversation(undefined, []), true);
});

test("shouldGiveUp at the poll limit, or MAX_POLL_MS after the first poll", () => {
  assert.equal(shouldGiveUp(MAX_POLL_ATTEMPTS - 1), false);
  assert.equal(shouldGiveUp(MAX_POLL_ATTEMPTS), true);
  const t0 = 1_000_000;
  assert.equal(shouldGiveUp(200, t0, t0 + MAX_POLL_MS - 1), false);
  assert.equal(shouldGiveUp(200, t0, t0 + MAX_POLL_MS), true);
  // attempts reset to 0 (a re-opened row) never times out on an old clock
  assert.equal(shouldGiveUp(0, t0, t0 + 3 * MAX_POLL_MS), false);
  // older rows without pollStartedAt: the attempt cap only
  assert.equal(shouldGiveUp(500), false);
});

test("classifyHttp: auth/not-found stop, rate limit / server / network retry", () => {
  assert.equal(classifyHttp(200), "ok");
  assert.equal(classifyHttp(201), "ok");
  for (const s of [400, 401, 403, 404, 422]) assert.equal(classifyHttp(s), "fatal", String(s));
  for (const s of [0, 408, 429, 500, 502, 503]) assert.equal(classifyHttp(s), "retry", String(s));
});

test("clip keeps stored error text short", () => {
  assert.equal(clip("a".repeat(500)).length, 300);
  assert.equal(clip("short"), "short");
});

test("nextPollDelayMs: every 15 s, every 3 s with FAST_POST, 3x after a Cartesia error", () => {
  assert.equal(nextPollDelayMs(0), 15_000);
  assert.equal(nextPollDelayMs(100), 15_000);
  assert.equal(nextPollDelayMs(0, { fast: true }), 3_000);
  assert.equal(nextPollDelayMs(400, { fast: true }), 3_000);
  assert.equal(nextPollDelayMs(5, { retry: true }), 45_000);
  assert.equal(nextPollDelayMs(5, { fast: true, retry: true }), 9_000);
});

test("poll caps: a 25-min call at 3 s is ~500 polls, and no chain runs past ~70 min", () => {
  const polls25 = (25 * 60_000) / nextPollDelayMs(0, { fast: true });
  assert.ok(polls25 <= 500 && polls25 < MAX_POLL_ATTEMPTS);
  // fast: the attempt cap ends it within ~70 min even without pollStartedAt
  assert.ok((MAX_POLL_ATTEMPTS * FAST_POLL_INTERVAL_MS) / 60_000 <= 71);
  // normal: the time cap ends it (the attempt cap would take hours)
  assert.ok(MAX_POLL_MS / POLL_INTERVAL_MS < MAX_POLL_ATTEMPTS);
  assert.ok(MAX_POLL_MS >= 60 * 60_000 && MAX_POLL_MS <= 70 * 60_000);
});

test("planPollUpdate: fast mode schedules the next poll in 3 s; the first poll starts the clock", () => {
  const first = planPollUpdate({ status: "in_progress", pollAttempts: 0, pollStartedAt: 5 }, 0, { kind: "pending" }, 100, { fast: true });
  assert.equal(first?.delayMs, 3_000);
  assert.equal(first?.patch.pollStartedAt, 100); // reset on a fresh chain
  const later = planPollUpdate({ status: "in_progress", pollAttempts: 7, pollStartedAt: 100 }, 7, { kind: "pending" }, 200, { fast: true });
  assert.equal(later?.patch.pollStartedAt, undefined); // kept
  const retry = planPollUpdate({ status: "in_progress", pollAttempts: 7, pollStartedAt: 100 }, 7, { kind: "pending", retry: true }, 200);
  assert.equal(retry?.delayMs, 45_000);
  const turns = [{ role: "elder" as const, text: "hi" }];
  const done = planPollUpdate({ status: "in_progress", pollAttempts: 7, pollStartedAt: 100 }, 7, { kind: "finished", transcript: turns, hungUpAt: 150 }, 200, { fast: true });
  assert.equal(done?.patch.hungUpAt, 150);
  assert.equal(done?.patch.endedAt, 200);
  assert.equal(done?.next, "process");
  assert.equal(done?.delayMs, 0);
});

test("parseEndTime: Cartesia's ISO end time, or nothing when missing or far off our clock", () => {
  const now = Date.parse("2026-10-24T16:00:00Z");
  assert.equal(parseEndTime("2026-10-24T15:59:58Z", now), now - 2_000);
  assert.equal(parseEndTime(undefined, now), undefined);
  assert.equal(parseEndTime("nope", now), undefined);
  assert.equal(parseEndTime("2026-10-24T18:00:00Z", now), undefined);
  assert.equal(parseEndTime("2026-10-23T10:00:00Z", now), undefined);
});

test("templateVariables: snake_case-safe names, trimmed strings, empty -> 'none'", () => {
  assert.deepEqual(templateVariables({ first_name: "  Walter ", known_background: "" }), {
    first_name: "Walter",
    known_background: "none",
  });
  assert.throws(() => templateVariables({ "first-name": "x" }), /variable name/);
  assert.throws(() => templateVariables({ "1st": "x" }), /variable name/);
});

test("buildAgentConfig: instructions, greeting, model default, optional voice, end_call tool", () => {
  const body = buildAgentConfig({ name: "Pip", instructions: "Be kind.", initialMessage: "Hi {{first_name}}" });
  assert.equal(body.name, "Pip");
  assert.equal(body.config.instructions, "Be kind.");
  assert.equal(body.config.initial_message, "Hi {{first_name}}");
  assert.deepEqual(body.config.model, { id: DEFAULT_MODEL });
  assert.deepEqual(body.config.language, { primary: "en" });
  assert.equal("audio" in body.config, false);
  assert.ok(body.config.system_tools.end_call.description);
  // Silence is thinking (conversation guide rule 4): check in late, hang up only after a long quiet.
  assert.ok(body.config.turn.inactivity_check_in_secs >= 20);
  assert.ok(body.config.turn.inactivity_end_call_secs >= 90);
  assert.deepEqual(body.config.dynamic_variable_placeholders, {});

  const withDefaults = buildAgentConfig({
    name: "Pip",
    instructions: "x",
    initialMessage: "y",
    placeholders: { first_name: "there" },
  });
  assert.deepEqual(withDefaults.config.dynamic_variable_placeholders, { first_name: "there" });

  const voiced = buildAgentConfig({ name: "Pip", instructions: "x", initialMessage: "y", voiceId: "v1", model: "m1" });
  assert.deepEqual(voiced.config.audio, { output: { voice_id: "v1" } });
  assert.deepEqual(voiced.config.model, { id: "m1" });
});

test("buildOutboundCallBody: one call with variables", () => {
  assert.deepEqual(
    buildOutboundCallBody({
      agentId: "agent_1",
      fromNumberId: "ap_1",
      toNumber: "+15555550123",
      variables: { first_name: "Walter" },
    }),
    {
      agent_id: "agent_1",
      from_number_id: "ap_1",
      ringing_timeout_seconds: 60,
      outbound_calls: [{ to_number: "+15555550123", dynamic_variables: { first_name: "Walter" } }],
    },
  );
});

test("parseOutboundResponse: call id, a clear per-call refusal, or an unclear answer", () => {
  assert.deepEqual(parseOutboundResponse({ calls: [{ number: "+1", agent_call_id: "ac_1" }] }), { callId: "ac_1" });
  // A per-call error means Cartesia refused it: nothing rang. Its text is not stored (may echo the number).
  assert.deepEqual(parseOutboundResponse({ calls: [{ number: "+1", error: "Invalid number +1" }] }), {
    error: "Cartesia refused the call",
    placed: "no",
  });
  // 2xx without a call id or an error: the phone may be ringing.
  assert.deepEqual(parseOutboundResponse({ calls: [] }), { error: "Cartesia returned no call id", placed: "unknown" });
  assert.deepEqual(parseOutboundResponse(null), { error: "Cartesia returned no call id", placed: "unknown" });
});

test("startFailureStatus: only a clear 4xx means nothing rang", () => {
  for (const s of [400, 401, 403, 404, 422, 429]) assert.equal(startFailureStatus(s), "failed", String(s));
  for (const s of [0, 408, 500, 502, 503]) assert.equal(startFailureStatus(s), "start_unknown", String(s));
});

test("planPollUpdate: only the chain that saw the current attempt count may write", () => {
  const live = { status: "in_progress", pollAttempts: 3 };
  assert.equal(planPollUpdate({ status: "ended", pollAttempts: 3 }, 3, { kind: "pending" }, 1), null);
  assert.equal(planPollUpdate({ status: "done", pollAttempts: 3 }, 3, { kind: "timeout" }, 1), null);
  assert.equal(planPollUpdate(live, 2, { kind: "pending" }, 1), null); // a duplicate, stale chain stops

  assert.deepEqual(planPollUpdate({ ...live, pollStartedAt: 1 }, 3, { kind: "pending" }, 1000), {
    patch: { pollAttempts: 4, lastPolledAt: 1000 },
    next: "poll",
    delayMs: 15_000,
  });
  // Cartesia's live status is kept only when it's a documented one
  assert.equal(planPollUpdate(live, 3, { kind: "pending", liveStatus: "started" }, 1)?.patch.liveStatus, "started");
  assert.equal(planPollUpdate(live, 3, { kind: "pending", liveStatus: "<weird>" }, 1)?.patch.liveStatus, undefined);
  assert.deepEqual(planPollUpdate({ status: "in_progress" }, 0, { kind: "fatal", error: "Cartesia HTTP 404" }, 5), {
    patch: { pollAttempts: 1, lastPolledAt: 5, pollStartedAt: 5, status: "poll_error", error: "Cartesia HTTP 404", endedAt: 5 },
    next: null,
    delayMs: 0,
  });
  const timeout = planPollUpdate(live, 3, { kind: "timeout" }, 5);
  assert.equal(timeout?.patch.status, "poll_timeout");
  assert.equal(timeout?.next, null);

  const turns = [{ role: "elder" as const, text: "hi" }];
  assert.deepEqual(planPollUpdate({ ...live, pollStartedAt: 1 }, 3, { kind: "finished", transcript: turns, endReason: "agent_hangup" }, 9), {
    patch: { pollAttempts: 4, lastPolledAt: 9, status: "ended", transcript: turns, endReason: "agent_hangup", endedAt: 9 },
    next: "process",
    delayMs: 0,
  });
});
