// Run: node --test "tests/**/*.test.ts"   (Node 22.18+ / 24 strips TypeScript types natively)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { hasElderSpeech, labelledTranscript } from "../convex/lib/linkedinPost.ts";
import {
  GENERIC_GUARD_ISSUE,
  STALE_CLAIM_MS,
  STALE_POLL_MS,
  buildGuardContext,
  canClaim,
  classifyStart,
  guardDecision,
  normalizeJudgeResult,
  parseWorkflowResult,
  shouldRestartPolling,
} from "../convex/lib/postFlow.ts";
import { canonicalLinkedInPostUrl } from "../convex/lib/linkedinUrl.ts";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/sample_transcript.json", import.meta.url), "utf8"),
);
const NOW = 1_800_000_000_000;

// ---------- guard ----------

test("guard holds the post only when it fails in enforce mode", () => {
  assert.equal(guardDecision({ pass: false, mode: "enforce" }), "hold");
  assert.equal(guardDecision({ pass: false, mode: "warn" }), "post");
  assert.equal(guardDecision({ pass: true, mode: "off" }), "post");
  assert.equal(guardDecision({ pass: true, mode: "enforce" }), "post");
});

test("judge result: pass needs zero issues; a fail always has a reason", () => {
  assert.deepEqual(normalizeJudgeResult({ pass: true, issues: [], summary: "ok" }), {
    pass: true,
    issues: [],
    summary: "ok",
  });
  assert.equal(normalizeJudgeResult({ pass: true, issues: ["made up a date"] }).pass, false);
  assert.deepEqual(normalizeJudgeResult({ pass: false, issues: [] }).issues, [GENERIC_GUARD_ISSUE]);
  assert.deepEqual(normalizeJudgeResult({ pass: false, issues: ["  ", 3] }).issues, [GENERIC_GUARD_ISSUE]);
  assert.equal(normalizeJudgeResult(null).pass, false);
});

test("the judge sees the whole conversation, labelled", () => {
  const t = labelledTranscript(fixture.turns);
  assert.ok(t.startsWith("PIP: Last time you mentioned your first job at the bakery."));
  assert.ok(t.includes("ELDER: Oh, we started at four."));
  assert.equal(
    labelledTranscript([
      { role: "assistant", text: "You ran the bakery 30 years, right?" },
      { role: "user", text: "Yes." },
    ]),
    "PIP: You ran the bakery 30 years, right?\nELDER: Yes.",
  );
  assert.equal(hasElderSpeech([{ role: "pip", text: "Hello?" }]), false);
  assert.equal(hasElderSpeech(fixture.turns), true);
});

test("guard background includes profile and call summary when present", () => {
  const ctx = buildGuardContext({
    profile: { industry: "Aerospace", specialty: "Quality engineering", topicsToAvoid: ["divorce"] },
    summary: "Talked about the bakery and his first team.",
    extra: ["Ran a bakery on 5th street in the 60s"],
  });
  assert.ok(ctx.includes("industry: Aerospace"));
  assert.ok(ctx.includes("topicsToAvoid: divorce"));
  assert.ok(ctx.includes("Summary of this call:\nTalked about the bakery"));
  assert.ok(ctx.includes("- Ran a bakery on 5th street in the 60s"));
  assert.equal(buildGuardContext({}), "");
});

// ---------- claiming ----------

test("claim: a fresh post can be taken; a published or already-sent one cannot", () => {
  assert.equal(canClaim({ status: "pending" }, NOW, false).ok, true);
  assert.equal(canClaim({ status: "published" }, NOW, false).ok, false);
  assert.equal(canClaim({ status: "pending", workflowId: "w1" }, NOW, false).ok, false);
});

test("claim: a second run while one is posting is refused, until the claim goes stale", () => {
  assert.equal(canClaim({ status: "posting", claimedAt: NOW - 60_000 }, NOW, false).ok, false);
  assert.equal(canClaim({ status: "posting", claimedAt: NOW - STALE_CLAIM_MS - 1 }, NOW, false).ok, true);
  assert.equal(
    canClaim({ status: "posting", claimedAt: NOW - STALE_CLAIM_MS - 1, workflowId: "w" }, NOW, false).ok,
    false,
  );
});

test("claim: needs_review only via approve; maybe-posted failures only via approve", () => {
  assert.equal(canClaim({ status: "needs_review" }, NOW, false).ok, false);
  assert.equal(canClaim({ status: "needs_review" }, NOW, true).ok, true);
  assert.equal(canClaim({ status: "failed" }, NOW, false).ok, true);
  assert.equal(canClaim({ status: "failed", maybePosted: true }, NOW, false).ok, false);
  assert.equal(canClaim({ status: "failed", maybePosted: true }, NOW, true).ok, true);
  assert.equal(canClaim({ status: "weird" }, NOW, true).ok, false);
});

test("polling restarts only for sent posts nobody is checking on", () => {
  assert.equal(shouldRestartPolling({ status: "pending", workflowId: "w", lastPolledAt: NOW - 60_000 }, NOW), false);
  assert.equal(
    shouldRestartPolling({ status: "pending", workflowId: "w", lastPolledAt: NOW - STALE_POLL_MS - 1 }, NOW),
    true,
  );
  assert.equal(shouldRestartPolling({ status: "needs_attention", workflowId: "w" }, NOW), true);
  assert.equal(shouldRestartPolling({ status: "pending" }, NOW), false);
  assert.equal(shouldRestartPolling({ status: "published", workflowId: "w" }, NOW), false);
});

// ---------- LinkedAPI responses ----------

test("starting a workflow: started / rejected / uncertain", () => {
  assert.deepEqual(classifyStart(200, { success: true, result: { workflowId: "w1" } }), {
    kind: "started",
    workflowId: "w1",
    pendingReason: null,
  });
  assert.equal(
    classifyStart(200, { success: true, result: { workflowId: "w1", pendingReason: "queued" } }).kind,
    "started",
  );
  assert.equal(classifyStart(401, { error: { message: "bad token" } }).kind, "rejected");
  assert.equal(classifyStart(200, { success: false, error: { message: "nope" } }).kind, "rejected");
  // No answer, a server error or no workflow id: it may have been accepted.
  assert.equal(classifyStart(0, null, "This operation was aborted").kind, "uncertain");
  assert.equal(classifyStart(502, null).kind, "uncertain");
  assert.equal(classifyStart(200, { success: true, result: {} }).kind, "uncertain");
});

test("workflow result parsing", () => {
  const url = "https://www.linkedin.com/feed/update/urn:li:activity:7300000000000000001/";
  assert.deepEqual(
    parseWorkflowResult({
      workflowStatus: "completed",
      completion: { actionType: "st.createPost", success: true, data: { postUrl: url } },
    }),
    { kind: "published", url },
  );
  assert.deepEqual(
    parseWorkflowResult({
      workflowStatus: "completed",
      completion: [{ actionType: "st.createPost", success: true, data: {} }],
    }),
    { kind: "published", url: undefined },
  );
  assert.equal(
    parseWorkflowResult({
      workflowStatus: "completed",
      completion: { success: false, error: { type: "x", message: "y" } },
    }).kind,
    "failed",
  );
  assert.deepEqual(parseWorkflowResult({ workflowStatus: "failed", failure: { reason: "r", message: "m" } }), {
    kind: "failed",
    error: "r: m",
  });
  assert.deepEqual(parseWorkflowResult({ workflowStatus: "pending", pendingReason: "outsideWorkingHours" }), {
    kind: "waiting",
    pendingReason: "outsideWorkingHours",
  });
  assert.equal(parseWorkflowResult({ workflowStatus: "running" }).kind, "waiting");
});

test("the saved post URL is canonical, so scraped engagement matches it", () => {
  const fromLinkedApi = "https://www.linkedin.com/feed/update/urn:li:activity:7300000000000000001/";
  const fromScraper =
    "https://www.linkedin.com/posts/jane-doe_bakery-activity-7300000000000000001-AbCd?utm_source=share";
  assert.equal(canonicalLinkedInPostUrl(fromLinkedApi), canonicalLinkedInPostUrl(fromScraper));
  assert.equal(
    canonicalLinkedInPostUrl(fromLinkedApi),
    "https://www.linkedin.com/feed/update/urn:li:activity:7300000000000000001",
  );
});
