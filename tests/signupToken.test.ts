// Run: npm test
// register: sign-up token, phone sign-in (signIn) + weekly-call defaults (lib/signupRules.ts).
import { test } from "node:test";
import assert from "node:assert/strict";

import { dueActions } from "../convex/lib/schedule.ts";
import {
  DEFAULT_CALL_HOUR,
  SIGNIN_TRIES,
  SIGNIN_WINDOW_MS,
  cronMayCall,
  defaultCallSlot,
  isIanaZone,
  newElderFields,
  newSignupToken,
  normalizePhone,
  recordSignInAttempt,
  sameTokenHash,
  signInDecision,
  signInRateLimit,
  signupTimezone,
  signupTokenHash,
  tokenMatches,
  zoneFromPhone,
} from "../convex/lib/signupRules.ts";
import { NOW } from "./helpers.ts"; // 2026-10-24 12:00 UTC, a Saturday

// ---------- timezone + weekly slot ----------

test("timezone: the browser's zone when it's real, else from the phone's country", () => {
  assert.equal(signupTimezone("America/Chicago", "+14155550123"), "America/Chicago");
  assert.equal(signupTimezone(" Europe/Madrid ", "+14155550123"), "Europe/Madrid");
  assert.equal(signupTimezone("UTC", "+14155550123"), "UTC");
  assert.equal(signupTimezone(undefined, "+525512345678"), "America/Mexico_City");
  assert.equal(signupTimezone("Mars/Olympus_Mons", "+34612345678"), "Europe/Madrid");
  assert.equal(signupTimezone("", "+14155550123"), "America/Los_Angeles");
  assert.equal(zoneFromPhone("+447700900123"), "America/Los_Angeles");
  for (const bad of ["Not a zone", "+05:00", "EST5EDT/../x", "America/" + "x".repeat(80), "<script>"]) {
    assert.equal(isIanaZone(bad), false, bad);
  }
});

test("default slot: the day after sign-up in his zone, at 10", () => {
  assert.deepEqual(defaultCallSlot(NOW, "America/Los_Angeles"), { callDay: "sunday", callHour: DEFAULT_CALL_HOUR });
  // 12:00 UTC Saturday is already Sunday morning in Kiritimati (UTC+14)
  assert.deepEqual(defaultCallSlot(NOW, "Pacific/Kiritimati"), { callDay: "monday", callHour: 10 });
  // Saturday wraps to Sunday
  assert.equal(defaultCallSlot(Date.parse("2026-10-31T18:00:00Z"), "America/Los_Angeles").callDay, "sunday");
});

test("default slot: signing up just before 10 never rings the same day", () => {
  const nineFiftyFive = Date.parse("2026-10-24T16:55:00Z"); // Saturday 9:55 PDT
  const row = newElderFields({ name: "W", phone: "+14155550123", language: "en", timeZone: "America/Los_Angeles" }, nineFiftyFive, "ab".repeat(32));
  for (let h = 0; h < 20; h++) {
    assert.equal(dueActions(row, nineFiftyFive + h * 3_600_000).call, undefined, `hour +${h}`);
  }
  assert.ok(dueActions(row, Date.parse("2026-10-25T17:00:00Z")).call, "Sunday 10:00 PDT");
});

test("cronMayCall: website sign-ups in onboarding need PUBLIC_CALLS; others always", () => {
  const phone = "+14155550123";
  const signup = { stage: "onboarding", phone, signupTokenHash: "ab".repeat(32) };
  assert.equal(cronMayCall(signup, {}), false, "off by default");
  assert.equal(cronMayCall(signup, { PUBLIC_CALLS: "on" }), false, "on, not on the list");
  assert.equal(cronMayCall(signup, { PUBLIC_CALLS: "on", CALL_ALLOWLIST: phone }), true);
  assert.equal(cronMayCall(signup, { PUBLIC_CALLS: "off", CALL_ALLOWLIST: phone }), false);
  assert.equal(cronMayCall(signup, { PUBLIC_CALLS: "all" }), true);
  assert.equal(cronMayCall({ stage: "onboarding", phone }, {}), true, "seeded / hand-made elder");
  assert.equal(cronMayCall({ ...signup, stage: "active" }, {}), true, "past onboarding");
});

test("newElderFields: onboarding row with timezone, callDay, callHour and only the token hash", () => {
  const row = newElderFields({ name: "Javier", phone: "+525512345678", language: "es", timeZone: "bogus" }, NOW, "ab".repeat(32));
  assert.deepEqual(row, {
    name: "Javier",
    phone: "+525512345678",
    language: "es-MX",
    stage: "onboarding",
    expertise: [],
    timezone: "America/Mexico_City",
    callDay: "sunday",
    callHour: 10,
    signupTokenHash: "ab".repeat(32),
  });
  // schedule.tick can now schedule him (it skipped rows without these fields).
  assert.equal(dueActions({ stage: "active", ...row }, NOW).skipReason, undefined);
  assert.match(dueActions({ stage: "active", name: "x" } as never, NOW).skipReason ?? "", /not set/);
});

// ---------- token ----------

test("token: 32 random bytes as base64url, different every time", () => {
  const a = newSignupToken();
  const b = newSignupToken();
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, b);
  assert.equal(Buffer.from(a, "base64url").length, 32);
});

test("token: stored as SHA-256 hex, and only the right token matches", async () => {
  const token = newSignupToken();
  const hash = await signupTokenHash(token);
  assert.match(hash ?? "", /^[0-9a-f]{64}$/);
  assert.ok(!hash!.includes(token));
  assert.equal(await tokenMatches({ signupTokenHash: hash }, token), true);
  assert.equal(await tokenMatches({ signupTokenHash: hash }, newSignupToken()), false);
  assert.equal(await tokenMatches({}, token), false, "a row from before tokens never matches");
  assert.equal(await tokenMatches(null, token), false);
  assert.equal(await signupTokenHash(""), undefined);
  assert.equal(await signupTokenHash(hash!), undefined, "the hash itself isn't a token");
  assert.equal(await tokenMatches({ signupTokenHash: hash }, ""), false);
});

test("sameTokenHash: equal only for the same non-empty value", () => {
  const h = "0f".repeat(32);
  assert.equal(sameTokenHash(h, h), true);
  assert.equal(sameTokenHash(h, "0e" + h.slice(2)), false);
  assert.equal(sameTokenHash(h, h.slice(1)), false);
  assert.equal(sameTokenHash(undefined, h), false);
  assert.equal(sameTokenHash("", ""), false);
});

// ---------- sign in (signup.signIn): phone number only ----------

test("newElderFields: only the token hash is stored (no family code)", () => {
  const input = { name: "W", phone: "+14155550123", language: "en" as const };
  const fields = newElderFields(input, NOW, "ab".repeat(32));
  assert.equal(fields.signupTokenHash, "ab".repeat(32));
  assert.equal("familyCodeHash" in fields, false);
});

test("signInRateLimit: 5 sign-ins in 15 minutes lock the phone; old ones fall off", () => {
  const MIN = 60_000;
  const four = [1, 2, 3, 4].map((m) => NOW - m * MIN);
  assert.deepEqual(signInRateLimit([], NOW), { ok: true });
  assert.deepEqual(signInRateLimit(four, NOW), { ok: true });
  assert.deepEqual(signInRateLimit([...four, NOW - 14 * MIN], NOW), { ok: false, reason: "too_many_tries" });
  assert.deepEqual(signInRateLimit([...four, NOW - SIGNIN_WINDOW_MS], NOW), { ok: true }, "exactly 15 min ago has dropped off");
  assert.equal(SIGNIN_TRIES, 5);
  // recordSignInAttempt keeps only what the limit looks at, newest last, at most 5
  const kept = recordSignInAttempt([NOW - 20 * MIN, ...four], NOW);
  assert.deepEqual(kept, [...four, NOW]);
  assert.equal(recordSignInAttempt([...four, NOW - 5 * MIN, NOW - 6 * MIN], NOW).length, 5);
});

test("signInDecision: a live row signs in; unknown or archived is not_found; the limit wins", () => {
  assert.deepEqual(signInDecision({ stage: "onboarding" }, [], NOW), { ok: true });
  assert.deepEqual(signInDecision({ stage: "active" }, [], NOW), { ok: true });
  assert.deepEqual(signInDecision(null, [], NOW), { ok: false, reason: "not_found" });
  assert.deepEqual(signInDecision({ stage: "archived" }, [], NOW), { ok: false, reason: "not_found" });
  const five = [1, 2, 3, 4, 5].map((m) => NOW - m * 60_000);
  assert.deepEqual(signInDecision({ stage: "active" }, five, NOW), { ok: false, reason: "too_many_tries" });
  assert.deepEqual(signInDecision(null, five, NOW), { ok: false, reason: "too_many_tries" });
});

test("archived rows (old start-overs): the schedule skips them", () => {
  assert.match(dueActions({ stage: "archived", timezone: "America/Los_Angeles", callDay: "sunday", callHour: 10 }, NOW).skipReason ?? "", /not onboarding or active/);
  assert.equal(cronMayCall({ stage: "archived", phone: "+14155550123" }, { PUBLIC_CALLS: "all" }), true, "cronMayCall isn't the gate: runTick skips by stage first");
});
