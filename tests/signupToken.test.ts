// Run: npm test
// register: sign-up token + weekly-call defaults (lib/signupRules.ts).
import { test } from "node:test";
import assert from "node:assert/strict";

import { dueActions } from "../convex/lib/schedule.ts";
import {
  DEFAULT_CALL_HOUR,
  defaultCallSlot,
  isIanaZone,
  newElderFields,
  newSignupToken,
  sameTokenHash,
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

test("default slot: the sign-up weekday in his zone, at 10", () => {
  assert.deepEqual(defaultCallSlot(NOW, "America/Los_Angeles"), { callDay: "saturday", callHour: DEFAULT_CALL_HOUR });
  // 12:00 UTC Saturday is already Sunday morning in Kiritimati (UTC+14)
  assert.deepEqual(defaultCallSlot(NOW, "Pacific/Kiritimati"), { callDay: "sunday", callHour: 10 });
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
    callDay: "saturday",
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
