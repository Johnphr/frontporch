// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";

import { callLanguage } from "../convex/lib/onboarding.ts";
import {
  CALL_COOLDOWN_MS,
  MAX_NAME_CHARS,
  callRateLimit,
  canonicalLinkedInProfileUrl,
  isE164,
  languageTag,
  normalizeName,
  normalizePhone,
} from "../convex/lib/signupRules.ts";
import { NOW } from "./helpers.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;

test("callRateLimit: no calls, or old ones, are fine", () => {
  assert.deepEqual(callRateLimit([], NOW), { ok: true });
  assert.deepEqual(callRateLimit([NOW - 25 * HOUR, NOW - 30 * HOUR, NOW - 48 * HOUR], NOW), { ok: true });
});

test("callRateLimit: 10 min cooldown (exactly 10 min ago is allowed)", () => {
  assert.equal(callRateLimit([NOW - 9 * MIN], NOW).ok, false);
  assert.equal(callRateLimit([NOW - CALL_COOLDOWN_MS + 1], NOW).ok, false);
  assert.equal(callRateLimit([NOW - CALL_COOLDOWN_MS], NOW).ok, true);
  assert.equal(callRateLimit([NOW + MIN], NOW).ok, false, "a clock-skewed future call still blocks");
});

test("callRateLimit: at most 3 in the last 24h", () => {
  const two = [NOW - 1 * HOUR, NOW - 2 * HOUR];
  assert.equal(callRateLimit(two, NOW).ok, true);
  assert.equal(callRateLimit([...two, NOW - 23 * HOUR], NOW).ok, false);
  assert.equal(callRateLimit([...two, NOW - 24 * HOUR], NOW).ok, true, "exactly 24h ago has dropped off");
  const limited = callRateLimit([...two, NOW - 3 * HOUR], NOW);
  assert.equal(limited.ok, false);
  if (!limited.ok) assert.match(limited.message, /tomorrow/);
});

test("phone: E.164 only, common formatting stripped", () => {
  assert.equal(isE164("+14155550123"), true);
  assert.equal(normalizePhone("+1 (415) 555-0123"), "+14155550123");
  assert.equal(normalizePhone(" +52 55.1234.5678 "), "+525512345678");
  for (const bad of ["", "4155550123", "+0123456789", "+12345", "+1234567890123456", "+1415abc0123", "++14155550123"]) {
    assert.equal(normalizePhone(bad), undefined, bad);
  }
});

test("name: trimmed, single-spaced, not empty, capped", () => {
  assert.equal(normalizeName("  Walter \n  Smith "), "Walter Smith");
  assert.equal(normalizeName("   "), undefined);
  assert.equal(normalizeName("x".repeat(MAX_NAME_CHARS)), "x".repeat(MAX_NAME_CHARS));
  assert.equal(normalizeName("x".repeat(MAX_NAME_CHARS + 1)), undefined);
});

test("language: sign-up code -> BCP-47 that callLanguage reads back", () => {
  assert.equal(languageTag("en"), "en-US");
  assert.equal(languageTag("es"), "es-MX");
  for (const lang of ["en", "es"] as const) assert.equal(callLanguage(languageTag(lang)), lang);
});

test("LinkedIn profile URL: canonical form, or undefined", () => {
  const canon = "https://www.linkedin.com/in/walter-baker";
  for (const ok of [
    "https://www.linkedin.com/in/walter-baker/",
    "linkedin.com/in/walter-baker",
    " http://de.linkedin.com/in/walter-baker?utm_source=share#x ",
    "https://linkedin.com/in/walter-baker/details/experience/",
  ]) {
    assert.equal(canonicalLinkedInProfileUrl(ok), canon, ok);
  }
  for (const bad of [
    "",
    "walter-baker",
    "https://evil.com/in/walter-baker",
    "https://linkedin.com.evil.com/in/walter-baker",
    "https://www.linkedin.com/company/boeing",
    "https://www.linkedin.com/in/",
    "javascript://linkedin.com/in/x",
    `https://www.linkedin.com/in/${"a".repeat(400)}`,
  ]) {
    assert.equal(canonicalLinkedInProfileUrl(bad), undefined, bad);
  }
});
