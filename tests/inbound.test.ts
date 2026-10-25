// Run: npm test   (Node 22.18+ strips TypeScript types natively)
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildAgentConfig, templateVariables } from "../convex/lib/cartesia.ts";
import { buildCallPlan, toPromptVariables } from "../convex/lib/planner.ts";
import {
  LOOKUP_PATH,
  LOOKUP_TOOL_NAME,
  backstopDecision,
  buildLookupTool,
  callerCandidates,
  callPath,
  clampResponse,
  inboundHost,
  inboundHostProblem,
  inboundPlanToMark,
  inboundSyncMode,
  isE164,
  knownCallerResponse,
  lookupErrorResponse,
  lookupLogLine,
  lookupOutcome,
  lookupReuseDecision,
  lookupUrl,
  matchBackstopRow,
  normalizePhone,
  parseLookupRequest,
  pickLiveCallForCaller,
  unknownCallerResponse,
  sameSecret,
  verifyBearer,
  verifyLiveCall,
} from "../convex/lib/inbound.ts";
import { getCharacter } from "../convex/lib/characters.ts";
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
  // Withheld / anonymous caller ids are not numbers.
  assert.equal(normalizePhone("anonymous"), "");
  assert.equal(normalizePhone("Restricted"), "");
});

test("normalizePhone: every way Cartesia may write the caller matches the sign-up's E.164", () => {
  const stored = "+14155550123"; // what sign-up stores (lib/signupRules isE164)
  for (const sent of ["+14155550123", "14155550123", "4155550123", "+1 415-555-0123", "(415) 555-0123", "tel:+14155550123", "sip:+14155550123@carrier.example", "+1 (415) 555 0123 "]) {
    assert.equal(normalizePhone(sent), stored, sent);
  }
  // Both sides normalized: a dashboard-typed stored number still equals the caller id.
  assert.equal(normalizePhone("+1 (415) 555-0123"), normalizePhone("14155550123"));
  // Non-US numbers only match with their country code.
  assert.equal(normalizePhone("tel:+528112345678"), "+528112345678");
  assert.notEqual(normalizePhone("8112345678"), "+528112345678");
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

test("parseLookupRequest: a usable caller number; the conversation id is optional", () => {
  assert.deepEqual(parseLookupRequest({ caller_id: "+14155550123", conversation_id: "call_abc123" }), {
    ok: true,
    callerId: "+14155550123",
    conversationId: "call_abc123",
  });
  // Cartesia's id format isn't documented: any printable, no-space id up to 128 chars is kept.
  assert.deepEqual(parseLookupRequest({ caller_id: "4155550123", conversation_id: "conv:01HX.9-z" }), {
    ok: true,
    callerId: "+14155550123",
    conversationId: "conv:01HX.9-z",
  });
  // No conversation id (or an odd one): still a lookup; the call is verified by listing live calls.
  assert.deepEqual(parseLookupRequest({ caller_id: "+14155550123" }), { ok: true, callerId: "+14155550123" });
  for (const conv of ["has space", "x".repeat(129), "ñ", "", 42]) {
    assert.deepEqual(parseLookupRequest({ caller_id: "+14155550123", conversation_id: conv }), { ok: true, callerId: "+14155550123" });
  }
  // A withheld number is "unknown" (polite goodbye), never a 400.
  assert.deepEqual(parseLookupRequest({ caller_id: "", conversation_id: "call_abc123" }), { ok: false, reason: "no_caller_id" });
  assert.deepEqual(parseLookupRequest({ caller_id: "anonymous" }), { ok: false, reason: "no_caller_id" });
  // Not the tool's body at all.
  assert.deepEqual(parseLookupRequest({ conversation_id: "call_abc123" }), { ok: false, reason: "bad_body" });
  assert.deepEqual(parseLookupRequest({ caller_id: 4155550123 }), { ok: false, reason: "bad_body" });
  assert.deepEqual(parseLookupRequest(null), { ok: false, reason: "bad_body" });
  assert.deepEqual(parseLookupRequest([]), { ok: false, reason: "bad_body" });
});

test("inboundHost: CARTESIA_INBOUND_HOST picks the call-in voice; else the language default", () => {
  assert.equal(inboundHost({}).id, "daniel");
  assert.equal(inboundHost({ CARTESIA_INBOUND_HOST: "oscar" }).id, "oscar");
  assert.equal(inboundHost({ CARTESIA_INBOUND_HOST: " Victoria " }).id, "victoria");
  assert.equal(inboundHost({ CARTESIA_INBOUND_HOST: "diana" }).language, "es"); // diana implies Spanish
  assert.equal(inboundHost({ CARTESIA_INBOUND_LANGUAGE: "es" }).id, "diana");
  assert.equal(inboundHost({ CARTESIA_INBOUND_HOST: "oscar", CARTESIA_INBOUND_LANGUAGE: "es" }).id, "oscar"); // host wins
  assert.equal(inboundHost({ CARTESIA_INBOUND_HOST: "pip" }).id, "daniel"); // unknown: default at call time...
  assert.match(inboundHostProblem({ CARTESIA_INBOUND_HOST: "pip" })!, /Unknown CARTESIA_INBOUND_HOST "pip"/); // ...but sync refuses
  assert.equal(inboundHostProblem({ CARTESIA_INBOUND_HOST: "oscar" }), undefined);
  assert.equal(inboundHostProblem({}), undefined);
});

test("lookupLogLine / lookupOutcome: one line, outcome + reason, nothing else", () => {
  assert.equal(lookupOutcome(knownCallerResponse({ kind: "story", lang: "en", character: { name: "Oscar" }, variables: {} })), "known");
  assert.equal(lookupOutcome(unknownCallerResponse()), "unknown");
  assert.equal(lookupOutcome(lookupErrorResponse()), "error");
  assert.equal(lookupOutcome({}), "error");
  assert.equal(lookupLogLine("known", "story"), "inbound-lookup: known story");
  assert.equal(lookupLogLine("error", "not_verified:not_found"), "inbound-lookup: error not_verified:not_found");
  assert.equal(lookupLogLine("unknown"), "inbound-lookup: unknown");
  // A reason can never smuggle a number or a secret into the log.
  assert.equal(lookupLogLine("error", "+1 (415) 555-0123"), "inbound-lookup: error");
  assert.equal(lookupLogLine("error", "Bearer=s3cr3t!"), "inbound-lookup: error bearerscrt");
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
    assert.deepEqual(Object.keys(res).sort(), ["call_kind", "caller_known", "first_name", "his_host", "language", "speak_as"]);
    assert.equal(res.first_name, "");
    assert.equal(res.speak_as, "Daniel"); // the default call-in host
  }
  assert.equal(unknownCallerResponse().caller_known, "no");
  assert.equal(lookupErrorResponse().caller_known, "error");
  // The call-in host's own name and language, whoever it is.
  const diana = getCharacter("diana")!;
  assert.equal(unknownCallerResponse(diana).speak_as, "Diana");
  assert.equal(unknownCallerResponse(diana).language, "es");
  assert.equal(lookupErrorResponse(getCharacter("oscar")!).speak_as, "Oscar");
});

test("knownCallerResponse: language + the outbound call's variables, all strings; speak_as is the line's host", () => {
  const daniel = getCharacter("daniel")!;
  const vars = buildOnboardingVariables({ name: "Walter Smith" }, "", "en");
  const res = knownCallerResponse({ kind: "onboarding", lang: "en", character: daniel, variables: vars });
  assert.equal(res.caller_known, "yes");
  assert.equal(res.call_kind, "onboarding");
  assert.equal(res.speak_as, "Daniel");
  assert.equal(res.his_host, "Daniel");
  assert.equal(res.same_host, "yes");
  assert.equal("persona" in res, false); // the persona is baked into the inbound prompt (one host per line)
  // the same variables the character agents get: first_name, goal, context
  assert.equal(res.first_name, "Walter");
  assert.ok(res.goal.length > 20);
  assert.equal(res.context, "none");
  for (const value of Object.values(res)) assert.equal(typeof value, "string");

  const es = knownCallerResponse({
    kind: "story",
    lang: "es",
    character: getCharacter("diana")!,
    host: getCharacter("diana")!,
    variables: { first_name: "Juan", goal: "Una buena historia.", context: "<question>\n¿Cómo empezó?\n</question>" },
  });
  assert.equal(es.speak_as, "Diana");
  assert.equal(es.same_host, "yes");
  assert.equal(es.language, "es");
  assert.match(es.context, /¿Cómo empezó\?/);
});

test("knownCallerResponse: his host is someone else -> the line's host speaks as itself, as his colleague", () => {
  // Tonight's case: he picked Oscar, the line answers as Daniel. Never "I'm Oscar" in Daniel's voice.
  const res = knownCallerResponse({
    kind: "story",
    lang: "en",
    character: getCharacter("oscar")!,
    host: getCharacter("daniel")!,
    variables: { first_name: "Walter", goal: "One story.", context: "none" },
  });
  assert.equal(res.speak_as, "Daniel");
  assert.equal(res.his_host, "Oscar");
  assert.equal(res.same_host, "no");
  assert.equal(res.first_name, "Walter");
  // Set CARTESIA_INBOUND_HOST to his host and it's the same host again.
  const same = knownCallerResponse({ kind: "story", lang: "en", character: getCharacter("oscar")!, host: inboundHost({ CARTESIA_INBOUND_HOST: "oscar" }), variables: {} });
  assert.equal(same.speak_as, "Oscar");
  assert.equal(same.same_host, "yes");
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
  // Only caller_id is required: a required variable Cartesia can't fill skips the request entirely.
  assert.deepEqual(tool.api_schema.request_body_schema.required, ["caller_id"]);
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
  for (const host of [undefined, getCharacter("oscar")!, getCharacter("diana")!]) {
    const p = inboundAgent(host);
    const vars = (s: string) => [...s.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)].map((m) => m[1]);
    assert.deepEqual(vars(p.greeting), []); // placeholder defaults never apply on real calls
    assert.deepEqual(vars(p.instructions).filter((n) => !n.startsWith("system__")), []);
    assert.match(p.instructions, new RegExp(`FIRST, before you say anything else: call the ${LOOKUP_TOOL_NAME} tool`));
    assert.match(p.instructions, /caller_known is "no"/);
    assert.match(p.greeting, /Hola/); // bilingual first words
    assert.match(p.greeting, /Memoria/);
    assert.match(p.greeting, /pull up your notes/); // covers the lookup's wait
  }
});

test("inbound prompt: the agent IS the call-in host (voice, language, persona) and never claims to be another", () => {
  const daniel = inboundAgent(); // default host
  assert.match(daniel.instructions, /^You are Daniel, a phone host from Memoria/);
  assert.ok(daniel.instructions.includes(getCharacter("daniel")!.personality));
  assert.match(daniel.greeting, /^Hi, you've reached Memoria, this is Daniel\./);
  assert.match(daniel.instructions, /speak English unless the caller speaks Spanish/);

  const oscar = inboundAgent(getCharacter("oscar")!);
  assert.match(oscar.instructions, /^You are Oscar, a phone host/);
  assert.ok(oscar.instructions.includes(getCharacter("oscar")!.personality));
  assert.match(oscar.greeting, /this is Oscar\. Hola, habla Oscar/);
  assert.match(oscar.instructions, /You are always Oscar, and only Oscar\. You never claim to be his_host or anyone else/);
  assert.equal(oscar.name, "MEMORIA - inbound (Oscar)");

  const diana = inboundAgent(getCharacter("diana")!);
  assert.match(diana.greeting, /^Hola, habla Diana, de Memoria\./); // her language first
  assert.match(diana.instructions, /speak Spanish unless the caller speaks English/);
});

test("inbound prompt: after caller_known yes it greets by name, says whose colleague it is, recalls, shares feedback, asks the question", () => {
  const text = inboundAgent(getCharacter("daniel")!).instructions;
  // Reads every field the lookup sends (lib/inbound knownCallerResponse).
  for (const field of ["caller_known", "speak_as", "his_host", "same_host", "language", "call_kind", "first_name", "goal", "context"]) {
    assert.match(text, new RegExp(`^- ${field}:`, "m"), field);
  }
  const shape = text.slice(text.indexOf('Shape of the call (caller_known "yes")'));
  const step = (n: number) => shape.slice(shape.indexOf(`\n${n}. `), shape.indexOf(`\n${n + 1}. `));
  assert.match(step(1), /Greet them warmly by first_name and thank them for calling in/);
  assert.match(step(1), /If same_host is "no", say once, right here, that you're Daniel, his_host's colleague at Memoria/);
  assert.match(step(1), /If same_host is "yes", just carry on as yourself/);
  assert.match(step(2), /<memories>.*"Last time you told me about\.\.\."/);
  assert.match(step(3), /If there's <feedback>, share it in one warm sentence/);
  assert.match(step(4), /the question in <question>/);
  assert.match(step(4), /call_kind "onboarding"/);
  assert.match(text, /never claim to be his_host/);
  // Unknown and error paths still end the call politely, revealing nothing.
  assert.match(text, /caller_known is "no": you don't recognize this number/);
  assert.match(text, /never confirm or deny whether a particular person is a member/);
  assert.match(text, /caller_known is "error" or the tool fails: apologize/);
});

test("inbound story lookup: today's feedback line, the reader's question and memories reach the agent", () => {
  // What handleLookup sends for an active elder: conversation.planNextCall's variables.
  const plan = buildCallPlan({
    kind: "story",
    bank: [{ _id: "bank1", question: "A reader asked: how did you price bread back then?", topicKey: "price-bread" }],
    memories: [{ kind: "person", name: "Eddie", text: "His first hire at the bakery." }],
    feedbackLine: "A reader asked how you priced bread back then.",
  });
  assert.equal(plan.bankId, "bank1"); // marked used after the call (inboundPlanToMark)
  const vars = templateVariables(toPromptVariables(plan, { name: "Walter Smith" }));
  const res = knownCallerResponse({ kind: "story", lang: "en", character: getCharacter("daniel")!, variables: vars });
  assert.equal(res.call_kind, "story");
  assert.match(res.context, /<feedback>\nA reader asked how you priced bread back then\.\n<\/feedback>/);
  assert.match(res.context, /<question>\nA reader asked: how did you price bread back then\?\n<\/question>/);
  assert.match(res.context, /<memories>[\s\S]*Eddie/);
  // The inbound prompt knows the tags and shares the feedback first.
  const p = inboundAgent();
  assert.match(p.instructions, /<feedback> \(what readers said about a recent post\)/);
  assert.match(p.instructions, /If there's <feedback>, share it in one warm sentence/);
});

test("buildAgentConfig attaches tools by id only when given", () => {
  const base = { name: "a", instructions: "b", initialMessage: "c" };
  assert.equal("tools" in buildAgentConfig(base).config, false);
  assert.deepEqual(buildAgentConfig({ ...base, tools: ["agent_tool_1"] }).config.tools, [{ id: "agent_tool_1" }]);
});

test("sameSecret: exact match only, nothing configured = false", () => {
  assert.equal(sameSecret("k-123", "k-123"), true);
  assert.equal(sameSecret("k-124", "k-123"), false);
  assert.equal(sameSecret("k-12", "k-123"), false);
  assert.equal(sameSecret("", ""), false);
  assert.equal(sameSecret(null, "k"), false);
  assert.equal(sameSecret("k", undefined), false);
});
