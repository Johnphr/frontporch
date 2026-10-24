// Run: node --test "tests/**/*.test.ts"
// Cartesia end_reason values (docs.cartesia.ai, api-reference/agents/calls/get-call)
// against PR #7's lib/cartesia.isNoConversation(endReason, turns). These document the
// current behavior; they don't change it.
import { test } from "node:test";
import assert from "node:assert/strict";

import { isNoConversation, normalizeTranscript, type Turn } from "../convex/lib/cartesia.ts";
import { fixture } from "./helpers.ts";

const call = fixture<{ transcript: unknown[] }>("cartesia_call.json");
const talked: Turn[] = [
  { role: "pip", text: "Tell me about the winter the big oven broke down." },
  {
    role: "elder",
    text:
      "It was 1978, two days before the Hendricks wedding order. Eddie and I rebuilt the burner overnight " +
      "with parts from the hardware store on 5th street, and we still delivered every single loaf on time that morning.",
  },
];

test("normalizeTranscript on the documented Cartesia shape: roles mapped, system/empty/tool-only dropped, same speaker joined", () => {
  assert.deepEqual(normalizeTranscript(call.transcript), [
    { role: "pip", text: "Hi Walter, it's Pip. Tell me about the winter the big oven broke down." },
    { role: "elder", text: "Oh, that winter. It was 1978, two days before the Hendricks wedding order." },
    { role: "pip", text: "Mm, go on." },
    { role: "elder", text: "Eddie and I rebuilt the burner overnight with parts from the hardware store on 5th." },
  ]);
});

test("Cartesia reasons that mean nobody talked: no conversation, even with words in the transcript", () => {
  for (const reason of ["voicemail_detected", "dial_no_answer", "dial_busy"]) {
    assert.equal(isNoConversation(reason, talked), true, reason);
  }
});

test("hang-ups, inactivity and max duration are real conversations when he talked", () => {
  for (const reason of ["agent_hangup", "client_hangup", "client_disconnected", "max_duration", "call_inactivity", "client_inactivity", "api_cancelled"]) {
    assert.equal(isNoConversation(reason, talked), false, reason);
  }
});

test("failed dials have no transcript, so the word threshold marks them no conversation", () => {
  for (const reason of ["dial_failed", "dial_timeout", "concurrency_limit", "config_error", "error"]) {
    assert.equal(isNoConversation(reason, []), true, reason);
  }
});
