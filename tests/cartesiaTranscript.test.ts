// Run: node --test "tests/**/*.test.ts"
import { test } from "node:test";
import assert from "node:assert/strict";

import { cartesiaCallOutcome, normalizeCartesiaTranscript } from "../convex/lib/cartesiaTranscript.ts";
import { isNearSilentCall, isNoConversation } from "../convex/lib/planner.ts";
import { fixture } from "./helpers.ts";

const call = fixture<Record<string, unknown>>("cartesia_call.json");

test("normalizeCartesiaTranscript maps roles, drops system/empty/tool-only items, joins same-speaker turns", () => {
  assert.deepEqual(normalizeCartesiaTranscript(call.transcript), [
    { role: "pip", text: "Hi Walter, it's Pip. Tell me about the winter the big oven broke down." },
    { role: "elder", text: "Oh, that winter. It was 1978, two days before the Hendricks wedding order." },
    { role: "pip", text: "Mm, go on." },
    { role: "elder", text: "Eddie and I rebuilt the burner overnight with parts from the hardware store on 5th." },
  ]);
});

test("normalizeCartesiaTranscript accepts the whole call, sorts by start time, tolerates junk", () => {
  assert.deepEqual(normalizeCartesiaTranscript(call), normalizeCartesiaTranscript(call.transcript));
  assert.deepEqual(
    normalizeCartesiaTranscript([
      { role: "user", text: "second", start_timestamp: 5 },
      { role: "assistant", text: "first", start_timestamp: 1 },
      { role: "Customer", text: "third", start_timestamp: 9 },
    ]),
    [
      { role: "pip", text: "first" },
      { role: "elder", text: "second third" },
    ],
  );
  assert.deepEqual(normalizeCartesiaTranscript(null), []);
  assert.deepEqual(normalizeCartesiaTranscript([null, 3, { role: "tool", text: "x" }]), []);
});

test("cartesiaCallOutcome reads status, end_reason, summary and turns", () => {
  const out = cartesiaCallOutcome(call);
  assert.equal(out.finished, true);
  assert.equal(out.status, "completed");
  assert.equal(out.endReason, "client_hangup");
  assert.match(out.summary ?? "", /oven failed/);
  assert.equal(out.turns.length, 4);

  assert.equal(cartesiaCallOutcome({ status: "started", transcript: [] }).finished, false);
  const failed = cartesiaCallOutcome({ status: "failed", end_reason: null, error_message: "SIP 503" });
  assert.equal(failed.finished, true);
  assert.equal(failed.endReason, "error: SIP 503");
  assert.equal(cartesiaCallOutcome(undefined).finished, false);
});

test("Cartesia end reasons: dial failures are no conversation, hang-ups and timeouts are real", () => {
  for (const reason of ["voicemail_detected", "dial_no_answer", "dial_busy", "dial_failed", "dial_timeout", "concurrency_limit", "config_error"]) {
    assert.equal(isNoConversation(reason), true, reason);
  }
  for (const reason of ["agent_hangup", "client_hangup", "client_disconnected", "max_duration", "call_inactivity", "client_inactivity", "api_cancelled", "agent_error", "network_error", "error"]) {
    assert.equal(isNoConversation(reason), false, reason);
  }
  // A long call that ended on inactivity still gets processed if he talked enough.
  const turns = cartesiaCallOutcome({ ...call, end_reason: "client_inactivity" }).turns;
  assert.equal(isNearSilentCall(turns, 20), false);
});
