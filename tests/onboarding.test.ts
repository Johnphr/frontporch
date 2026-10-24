// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  OPEN_CALL_WINDOW_MS,
  STALE_PROCESSING_MS,
  buildOnboardingVariables,
  canClaimProcessing,
  firstName,
  hasOpenCall,
  isProfileUsable,
  mergeProfile,
  normalizeProfile,
  planNextCall,
} from "../convex/lib/onboarding.ts";
import { ONBOARDING_GREETING, ONBOARDING_INSTRUCTIONS } from "../convex/lib/prompts/onboarding.ts";
import { NOW } from "./helpers.ts";

test("planNextCall: onboarding until he is active with a usable profile", () => {
  assert.deepEqual(planNextCall({}), { kind: "onboarding" });
  assert.deepEqual(planNextCall({ stage: "onboarding", profile: { industry: "aerospace" } }), { kind: "onboarding" });
  assert.deepEqual(planNextCall({ stage: "active", profile: {} }), { kind: "onboarding" });
  assert.deepEqual(planNextCall({ stage: "active", profile: { specialty: "riveting" } }), { kind: "story" });
});

test("firstName and buildOnboardingVariables", () => {
  assert.equal(firstName("  Walter  J. Smith "), "Walter");
  assert.equal(firstName(""), "friend");
  assert.deepEqual(buildOnboardingVariables({ name: "Walter Smith" }, undefined), {
    first_name: "Walter",
    known_background: "none",
  });
  assert.deepEqual(buildOnboardingVariables({ name: "Walter" }, "Boeing, 1968-2004"), {
    first_name: "Walter",
    known_background: "Boeing, 1968-2004",
  });
});

test("prompt placeholders match the variables we send, and the greeting discloses AI + notes", () => {
  const sent = Object.keys(buildOnboardingVariables({ name: "W" }, "x"));
  const used = new Set(
    [...`${ONBOARDING_INSTRUCTIONS}\n${ONBOARDING_GREETING}`.matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)].map(
      (m) => m[1],
    ),
  );
  assert.deepEqual([...used].sort(), [...sent].sort());
  assert.match(ONBOARDING_GREETING, /\bAI\b/);
  assert.match(ONBOARDING_GREETING, /notes/i);
});

test("normalizeProfile: junk -> empty, trims, dedupes, caps lengths and counts", () => {
  assert.deepEqual(normalizeProfile(null), {});
  assert.deepEqual(normalizeProfile("nope"), {});
  const p = normalizeProfile({
    industry: "  Aerospace ",
    specialty: 42,
    careerSummary: "x".repeat(5000),
    topics: ["747", " 747 ", "", 9, "quality"],
    storySeeds: Array.from({ length: 30 }, (_, i) => `seed ${i}`),
    topicsToAvoid: "not an array",
  });
  assert.equal(p.industry, "Aerospace");
  assert.equal(p.specialty, undefined);
  assert.equal(p.careerSummary?.length, 1200);
  assert.deepEqual(p.topics, ["747", "quality"]);
  assert.equal(p.storySeeds?.length, 12);
  assert.equal(p.topicsToAvoid, undefined);
});

test("mergeProfile keeps old facts, prefers new scalars, unions lists", () => {
  const merged = mergeProfile(
    { industry: "Aerospace", careerSummary: "old", storySeeds: ["Eddie's thumb test"], topics: ["747"] },
    { careerSummary: "new", storySeeds: ["eddie's thumb test", "the 1973 strike"], specialty: "quality" },
  );
  assert.deepEqual(merged, {
    industry: "Aerospace",
    specialty: "quality",
    careerSummary: "new",
    topics: ["747"],
    storySeeds: ["Eddie's thumb test", "the 1973 strike"],
  });
  assert.deepEqual(mergeProfile(undefined, {}), {});
});

test("isProfileUsable needs industry or specialty", () => {
  assert.equal(isProfileUsable(undefined), false);
  assert.equal(isProfileUsable({ careerSummary: "x", storySeeds: ["y"] }), false);
  assert.equal(isProfileUsable({ industry: "aerospace" }), true);
  assert.equal(isProfileUsable({ specialty: "riveting" }), true);
});

test("canClaimProcessing: once, unless a claim went stale", () => {
  assert.deepEqual(canClaimProcessing({}, NOW), { ok: true });
  assert.equal(canClaimProcessing({ processedAt: NOW - 1 }, NOW).ok, false);
  assert.equal(canClaimProcessing({ processingAt: NOW - 1000 }, NOW).ok, false);
  assert.deepEqual(canClaimProcessing({ processingAt: NOW - STALE_PROCESSING_MS - 1 }, NOW), { ok: true });
});

test("hasOpenCall: queued / in_progress calls from the last hour block a new one", () => {
  assert.equal(hasOpenCall([], NOW), false);
  assert.equal(hasOpenCall([{ status: "in_progress", _creationTime: NOW - 5 * 60_000 }], NOW), true);
  assert.equal(hasOpenCall([{ status: "queued", _creationTime: NOW - 1000 }], NOW), true);
  assert.equal(hasOpenCall([{ status: "ended", _creationTime: NOW - 1000 }], NOW), false);
  assert.equal(hasOpenCall([{ status: "in_progress", _creationTime: NOW - OPEN_CALL_WINDOW_MS - 1 }], NOW), false);
});
