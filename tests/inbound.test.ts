// Run: npm test   (Node 22.18+ strips TypeScript types natively)
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildAgentConfig } from "../convex/lib/cartesia.ts";
import {
  LOOKUP_PATH,
  LOOKUP_TOOL_NAME,
  backstopDecision,
  buildLookupTool,
  callerCandidates,
  callPath,
  clampResponse,
  inboundPlanToMark,
  inboundSyncMode,
  isE164,
  knownCallerResponse,
  lookupErrorResponse,
  lookupReuseDecision,
  lookupUrl,
  matchBackstopRow,
  normalizePhone,
  parseLookupRequest,
  pickLiveCallForCaller,
  unknownCallerResponse,
  verifyBearer,
  verifyLiveCall,
} from "../convex/lib/inbound.ts";
import { buildOnboardingVariables } from "../convex/lib/onboarding.ts";
import { inboundAgent } from "../convex/lib/prompts/inbound.ts";

test("normalizePhone: E.164 from the usual ways a number is written", () => {
  assert.equal(normalizePhone("+14155550123"), "+14155550123");
  assert.equal(normalizePhone("+1 (415) 555-0123"), "+14155550123");
  assert.equal(normalizePhone("4155550123"), "+14155550123");
  assert.equal(normalizePhone("14155550123"), "+14155550123");
  assert.equal(normalizePhone("0052 81 1234 5678"), "+528112345678");
  assert.equal(normalizePhone("+52 81 1234 5678"), "+528112345678");
  assert.equal(normalizePhone(""), "");
  assert.equal(normalizePhone("12345"), "");
  assert.equal(normalizePhone("8112345678901"), ""); // no + and not a US number: ambiguous
  assert.equal(normalizePhone(undefined), "");
  assert.equal(normalizePhone("+0123456789"), "");
});

test("callerCandidates: both telephony fields, from first, normalized and deduped", () => {
  assert.deepEqual(callerCandidates({ from: "+14155550100", to: "+1 415 555 0123", direction: "inbound" }), [
    "+14155550100",
    "+14155550123",
  ]);
  assert.deepEqual(callerCandidates({ from: "+14155550123", to: "+14155550123" }), ["+14155550123"]);
  assert.deepEqual(callerCandidates(null), []);
  assert.deepEqual(callerCandidates({ to: "nope" }), []);
});

test("verifyBearer: only the exact secret passes", () => {
  assert.equal(verifyBearer("Bearer s3cret-value", "s3cret-value"), true);
  assert.equal(verifyBearer("bearer s3cret-value", "s3cret-value"), true);
  assert.equal(verifyBearer("Bearer s3cret-valuX", "s3cret-value"), false);
  assert.equal(verifyBearer("Bearer s3cret", "s3cret-value"), false);
  assert.equal(verifyBearer("s3cret-value", "s3cret-value"), false);
  assert.equal(verifyBearer(null, "s3cret-value"), false);
  assert.equal(verifyBearer("Bearer anything", undefined), false); // no secret configured
  assert.equal(verifyBearer("Bearer ", ""), false);
});

test("parseLookupRequest: needs a usable caller number AND a printable conversation id", () => {
  assert.deepEqual(parseLookupRequest({ caller_id: "+14155550123", conversation_id: "call_abc123" }), {
    callerId: "+14155550123",
    conversationId: "call_abc123",
  });
  // Cartesia's id format isn't documented: any printable, no-space id up to 128 chars is kept.
  assert.deepEqual(parseLookupRequest({ caller_id: "4155550123", conversation_id: "conv:01HX.9-z" }), {
    callerId: "+14155550123",
    conversationId: "conv:01HX.9-z",
  });
  assert.equal(parseLookupRequest({ caller_id: "+14155550123" }), null); // can't be verified
  assert.equal(parseLookupRequest({ caller_id: "+14155550123", conversation_id: "has space" }), null);
  assert.equal(parseLookupRequest({ caller_id: "+14155550123", conversation_id: "x".repeat(129) }), null);
  assert.equal(parseLookupRequest({ caller_id: "+14155550123", conversation_id: "ñ" }), null);
  assert.equal(parseLookupRequest({ caller_id: "", conversation_id: "call_abc123" }), null);
  assert.equal(parseLookupRequest({ conversation_id: "call_abc123" }), null);
  assert.equal(parseLookupRequest(null), null);
  assert.equal(parseLookupRequest([]), null);
});

test("callPath encodes the id, so an odd id can't change the URL path", () => {
  assert.equal(callPath("call_1"), "/agents/calls/call_1");
  assert.equal(callPath("../../agents"), "/agents/calls/..%2F..%2Fagents");
  assert.equal(callPath("a?b#c"), "/agents/calls/a%3Fb%23c");
});

test("isE164 is the same rule elders.seed enforces; normalizePhone matches dashboard formats", () => {
  assert.equal(isE164("+14155550123"), true);
  assert.equal(isE164("+1234567"), true); // 7 digits: the seed accepts it, so lookups must too
  assert.equal(normalizePhone("+1234567"), "+1234567");
  assert.equal(isE164("+123456"), false);
  assert.equal(isE164("+1 415 555 0123"), false);
  for (const typed of ["+1 (415) 555-0123", "+1-415-555-0123", "(415) 555-0123", "415.555.0123", " +14155550123 "]) {
    assert.equal(normalizePhone(typed), "+14155550123", typed);
  }
});

test("verifyLiveCall: only a live call on our inbound agent from this caller passes", () => {
  const want = { agentId: "agent_in", callerId: "+14155550123" };
  const call = {
    id: "call_1",
    agent_id: "agent_in",
    status: "started",
    telephony_params: { from: "+14155550123", to: "+15550009999", direction: "inbound" },
  };
  assert.deepEqual(verifyLiveCall(call, want), { ok: true, callId: "call_1" });
  assert.deepEqual(verifyLiveCall({ ...call, telephony_params: { to: "+1 415 555 0123" } }, want), {
    ok: true,
    callId: "call_1",
  }); // docs disagree on from/to: either side counts
  assert.equal(verifyLiveCall({ ...call, agent_id: "agent_story" }, want).ok, false);
  assert.deepEqual(verifyLiveCall({ ...call, agent_id: "agent_story" }, want), { ok: false, reason: "agent_mismatch" });
  assert.deepEqual(verifyLiveCall({ ...call, status: "completed" }, want), { ok: false, reason: "not_live" });
  assert.deepEqual(verifyLiveCall({ ...call, status: "failed" }, want), { ok: false, reason: "not_live" });
  assert.deepEqual(verifyLiveCall({ ...call, telephony_params: { from: "+15550001111" } }, want), {
    ok: false,
    reason: "caller_mismatch",
  });
  assert.deepEqual(verifyLiveCall(null, want), { ok: false, reason: "bad_response" });
  assert.deepEqual(verifyLiveCall({ ...call, id: "" }, want), { ok: false, reason: "bad_response" });
  assert.equal(verifyLiveCall(call, { ...want, agentId: "" }).ok, false); // not configured = fail closed
});

test("pickLiveCallForCaller: the single live call from this caller, else nothing", () => {
  const want = { agentId: "agent_in", callerId: "+14155550123" };
  const live = (id: string, from = "+14155550123", status = "started") => ({
    id,
    agent_id: "agent_in",
    status,
    telephony_params: { from },
  });
  assert.equal(pickLiveCallForCaller([live("a", "+15550001111"), live("b")], want), "b");
  assert.equal(pickLiveCallForCaller([live("a"), live("b")], want), undefined); // ambiguous
  assert.equal(pickLiveCallForCaller([live("a", undefined, "completed")], want), undefined);
  assert.equal(pickLiveCallForCaller(undefined, want), undefined);
});

test("unknown and error answers reveal nothing and share the known-caller field names", () => {
  for (const res of [unknownCallerResponse(), lookupErrorResponse()]) {
    assert.deepEqual(Object.keys(res).sort(), ["call_kind", "caller_known", "first_name", "language", "speak_as"]);
    assert.equal(res.first_name, "");
  }
  assert.equal(unknownCallerResponse().caller_known, "no");
  assert.equal(lookupErrorResponse().caller_known, "error");
});

test("knownCallerResponse: persona + language + the outbound call's variables, all strings", () => {
  const vars = buildOnboardingVariables({ name: "Walter Smith" }, "", "en");
  const res = knownCallerResponse({ kind: "onboarding", lang: "en", variables: vars });
  assert.equal(res.caller_known, "yes");
  assert.equal(res.call_kind, "onboarding");
  assert.equal(res.speak_as, "Pip");
  assert.equal(res.first_name, "Walter");
  assert.equal(res.known_background, "none");
  for (const value of Object.values(res)) assert.equal(typeof value, "string");

  const es = knownCallerResponse({
    kind: "story",
    lang: "es",
    variables: { first_name: "Juan", profile: "none", memories: "none", feedback: "none", question: "¿Cómo empezó?" },
  });
  assert.equal(es.speak_as, "Juanito");
  assert.equal(es.language, "es");
  assert.equal(es.question, "¿Cómo empezó?");
});

test("clampResponse keeps the answer under Cartesia's tool-result cap", () => {
  const big = { caller_known: "yes", memories: "x".repeat(40_000), first_name: "Walter" };
  const out = clampResponse(big, 15_000);
  assert.ok(new TextEncoder().encode(JSON.stringify(out)).length <= 15_000);
  assert.equal(out.first_name, "Walter");
  assert.equal(out.caller_known, "yes");
});

test("buildLookupTool: webhook tool filled from system variables, bearer secret, assignments", () => {
  const tool = buildLookupTool({ url: "https://happy-otter-1.convex.site/cartesia/inbound-lookup", secret: "s3cret" });
  assert.equal(tool.type, "webhook");
  assert.equal(tool.name, LOOKUP_TOOL_NAME);
  assert.equal(tool.api_schema.method, "POST");
  assert.equal(tool.api_schema.url, "https://happy-otter-1.convex.site/cartesia/inbound-lookup");
  assert.equal(tool.api_schema.request_body_schema.properties.caller_id.dynamic_variable, "system__caller_id");
  assert.equal(tool.api_schema.request_body_schema.properties.conversation_id.dynamic_variable, "system__conversation_id");
  assert.deepEqual(tool.api_schema.authentication, { mode: "bearer", token: { type: "secret", secret_value: "s3cret" } });
  assert.ok(["auto", "force", "off"].includes(tool.pre_tool_speech));
  assert.ok(tool.response_timeout_secs > 0 && tool.response_timeout_secs <= 120);
  assert.ok(tool.assignments.some((a) => a.dynamic_variable === "caller_known"));
});

test("lookupUrl needs an HTTPS site URL", () => {
  assert.equal(lookupUrl("https://happy-otter-1.convex.site/"), `https://happy-otter-1.convex.site${LOOKUP_PATH}`);
  assert.throws(() => lookupUrl(undefined), /INBOUND_SITE_URL/);
  assert.throws(() => lookupUrl("http://127.0.0.1:3211"), /HTTPS/);
});

test("lookupReuseDecision: a repeated lookup gets the first answer back, never a new plan", () => {
  assert.deepEqual(lookupReuseDecision(null), { action: "insert" });
  assert.deepEqual(lookupReuseDecision({ _id: "calls:1" }), { action: "reuse" }); // backstop-made row
  const first = { caller_known: "yes", call_kind: "story", question: "Tell me about the oven." };
  assert.deepEqual(lookupReuseDecision({ _id: "calls:1", inboundLookup: first }), { action: "cached", response: first });
  assert.deepEqual(lookupReuseDecision({ _id: "calls:1", inboundLookup: ["x"] }), { action: "reuse" });
});

test("matchBackstopRow: id match, same-elder row near the start, no duplicates", () => {
  const open = [{ _id: "calls:9", elderId: "e1", createdAt: 1_000_000 }];
  assert.deepEqual(matchBackstopRow({ id: "c1", elderId: "e1", startMs: 1_000_000 }, { idHasRow: true, openInbound: open }), {
    kind: "has_row",
  });
  assert.deepEqual(
    matchBackstopRow({ id: "c1", elderId: "e1", startMs: 1_000_000 + 60_000 }, { idHasRow: false, openInbound: open }),
    { kind: "attach", rowId: "calls:9" },
  );
  assert.deepEqual(
    matchBackstopRow({ id: "c1", elderId: "e1", startMs: 1_000_000 + 60 * 60_000 }, { idHasRow: false, openInbound: open }),
    { kind: "insert" },
  ); // too far apart: a different call
  assert.deepEqual(matchBackstopRow({ id: "c1", elderId: "e2", startMs: 1_000_000 }, { idHasRow: false, openInbound: open }), {
    kind: "insert",
  }); // another elder's row is never reused
  const two = [...open, { _id: "calls:10", elderId: "e1", createdAt: 1_000_000 + 30_000 }];
  assert.deepEqual(matchBackstopRow({ id: "c1", elderId: "e1", startMs: 1_000_000 }, { idHasRow: false, openInbound: two }), {
    kind: "insert",
  }); // ambiguous: don't guess
});

test("inboundPlanToMark: inbound question used only after a real conversation", () => {
  const call = { direction: "inbound", plan: { bankId: "qb_1" } };
  assert.equal(inboundPlanToMark(call, "done"), "qb_1");
  assert.equal(inboundPlanToMark(call, "process_failed"), "qb_1"); // he did talk; a retry is fine
  assert.equal(inboundPlanToMark(call, "no_conversation"), null); // hang-up / voicemail: keep it queued
  assert.equal(inboundPlanToMark({ direction: "outbound", plan: { bankId: "qb_1" } }, "done"), null); // marked at ring time
  assert.equal(inboundPlanToMark({ plan: { bankId: "qb_1" } }, "done"), null); // missing = outbound
  assert.equal(inboundPlanToMark({ direction: "inbound" }, "done"), null);
  assert.equal(inboundPlanToMark(null, "done"), null);
});

test("inboundSyncMode: plain sync never creates a lookup tool", () => {
  assert.equal(inboundSyncMode(true), "create");
  assert.equal(inboundSyncMode(false, "agent_1", "tool_1"), "update");
  assert.equal(inboundSyncMode(false, "agent_1"), "skip"); // tool id missing: don't POST a new tool
  assert.equal(inboundSyncMode(false, undefined, "tool_1"), "skip");
  assert.equal(inboundSyncMode(false), "skip");
});

test("backstopDecision: only finished inbound calls from elders that have no row", () => {
  const done = { id: "call_1", status: "completed", telephony_params: { direction: "inbound" } };
  assert.deepEqual(backstopDecision(done, { hasRow: false, elderPhone: "+14155550123" }), { ingest: true });
  assert.equal(backstopDecision(done, { hasRow: true, elderPhone: "+14155550123" }).ingest, false);
  assert.equal(backstopDecision(done, { hasRow: false }).ingest, false); // unknown caller
  assert.equal(
    backstopDecision({ ...done, status: "started" }, { hasRow: false, elderPhone: "+14155550123" }).ingest,
    false,
  );
  assert.equal(
    backstopDecision({ ...done, telephony_params: { direction: "outbound" } }, { hasRow: false, elderPhone: "+1" }).ingest,
    false,
  );
  assert.equal(backstopDecision({ status: "completed" }, { hasRow: false, elderPhone: "+14155550123" }).ingest, false);
  // ended but status not yet updated: end_time counts as finished
  assert.equal(
    backstopDecision({ id: "c", status: "started", end_time: "2026-10-25T10:00:00Z" }, { hasRow: false, elderPhone: "+1" })
      .ingest,
    true,
  );
});

test("inbound prompt: greeting and instructions use no custom {{variables}}; tool comes first", () => {
  const p = inboundAgent();
  const vars = (s: string) => [...s.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)].map((m) => m[1]);
  assert.deepEqual(vars(p.greeting), []); // placeholder defaults never apply on real calls
  assert.deepEqual(vars(p.instructions).filter((n) => !n.startsWith("system__")), []);
  assert.match(p.instructions, new RegExp(`call the ${LOOKUP_TOOL_NAME} tool`));
  assert.match(p.instructions, /caller_known is "no"/);
  assert.match(p.greeting, /Hola/); // bilingual first words
});

test("buildAgentConfig attaches tools by id only when given", () => {
  const base = { name: "a", instructions: "b", initialMessage: "c" };
  assert.equal("tools" in buildAgentConfig(base).config, false);
  assert.deepEqual(buildAgentConfig({ ...base, tools: ["agent_tool_1"] }).config.tools, [{ id: "agent_tool_1" }]);
});
