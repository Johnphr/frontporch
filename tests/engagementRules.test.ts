import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BANK_REFRESH_DEBOUNCE_MS,
  canonicalBlueskyPostUrl,
  cleanComments,
  engagementChanged,
  feedbackWindowStart,
  linkedinEngagementOn,
  nextSnapshot,
  LINKEDIN_AFTER_BLUESKY_MS,
  feedbackVisible,
  planDailyEngagement,
  platformOf,
  shouldRefreshBank,
} from "../convex/lib/engagementRules.ts";
import { canonicalLinkedInPostUrl } from "../convex/lib/linkedinUrl.ts";

test("cleanComments trims, drops empty text, dedupes, fills a missing author", () => {
  assert.deepEqual(
    cleanComments([
      { author: " Ana ", text: " Great story! " },
      { author: "ana", text: "great   story!" },
      { author: "", text: "How did you price bread?" },
      { author: "Bo", text: "   " },
    ]),
    [
      { author: "Ana", text: "Great story!" },
      { author: "Someone", text: "How did you price bread?" },
    ],
  );
});

test("engagementChanged: new posts with activity, reaction changes, comment changes", () => {
  const snap = { reactions: 12, comments: [{ author: "Ana", text: "Great story!" }] };
  assert.equal(engagementChanged(null, { reactions: 0, comments: [] }), false, "new post, nothing yet");
  assert.equal(engagementChanged(null, { reactions: 3, comments: [] }), true);
  assert.equal(engagementChanged(snap, { ...snap }), false);
  assert.equal(engagementChanged(snap, { ...snap, reactions: 13 }), true);
  assert.equal(
    engagementChanged(snap, { reactions: 12, comments: [...snap.comments, { author: "Bo", text: "Tell more!" }] }),
    true,
  );
  assert.equal(engagementChanged(snap, { reactions: 12, comments: [{ author: "ana", text: "great  story!" }] }), false);
  const two = { reactions: 1, comments: [{ author: "A", text: "x" }, { author: "B", text: "y" }] };
  assert.equal(engagementChanged(two, { reactions: 1, comments: [two.comments[1], two.comments[0]] }), false, "order");
});

test("shouldRefreshBank: at most once per debounce window", () => {
  const now = Date.parse("2026-10-24T12:00:00Z");
  assert.equal(shouldRefreshBank(undefined, now), true);
  assert.equal(shouldRefreshBank(now - 5 * 60 * 1000, now), false);
  assert.equal(shouldRefreshBank(now - BANK_REFRESH_DEBOUNCE_MS, now), true);
});

test("engagement and posts rows meet on the canonical URL", () => {
  const scraped = "https://www.linkedin.com/posts/walter_bakery-activity-7380000000000000001-AbCd?utm_source=x";
  const published = "https://www.linkedin.com/feed/update/urn:li:activity:7380000000000000001/";
  assert.equal(canonicalLinkedInPostUrl(scraped), canonicalLinkedInPostUrl(published));
});

test("nextSnapshot: counts-only source keeps stored comments and compares reactions only", () => {
  const prev = { reactions: 12, comments: [{ author: "Ana", text: "How did you price bread?" }] };
  // backup Actor: no comments, same reactions -> nothing changed, comments kept
  assert.deepEqual(nextSnapshot(prev, { reactions: 12, comments: [] }, false), { comments: prev.comments, changed: false });
  // backup Actor: reactions moved -> changed, comments still kept
  assert.deepEqual(nextSnapshot(prev, { reactions: 15, comments: [] }, false), { comments: prev.comments, changed: true });
  // new post from the backup: changed only if it has reactions
  assert.deepEqual(nextSnapshot(null, { reactions: 0, comments: [] }, false), { comments: [], changed: false });
  assert.deepEqual(nextSnapshot(null, { reactions: 3, comments: [] }, false), { comments: [], changed: true });
});

test("nextSnapshot: full source replaces comments and uses the normal change rule", () => {
  const prev = { reactions: 12, comments: [{ author: "Ana", text: "How did you price bread?" }] };
  const next = { reactions: 12, comments: [] };
  assert.deepEqual(nextSnapshot(prev, next), { comments: [], changed: true });
  assert.deepEqual(nextSnapshot(prev, prev, true), { comments: prev.comments, changed: false });
});

test("feedbackWindowStart: days back from now, 14 by default", () => {
  const now = Date.parse("2026-10-25T00:00:00Z");
  const day = 24 * 60 * 60 * 1000;
  assert.equal(feedbackWindowStart(now, 7), now - 7 * day);
  assert.equal(feedbackWindowStart(now), now - 14 * day);
  assert.equal(feedbackWindowStart(now, -3), now - 14 * day);
  assert.equal(feedbackWindowStart(now, Number.NaN), now - 14 * day);
  assert.equal(feedbackWindowStart(now, 0), now);
});

// ---------- platforms + daily schedule ----------

test("canonicalBlueskyPostUrl drops query/hash/trailing slash and never rewrites to LinkedIn", () => {
  const url = "https://bsky.app/profile/walt.bsky.social/post/3lroot";
  assert.equal(canonicalBlueskyPostUrl(" https://BSKY.app/profile/walt.bsky.social/post/3lroot/?ref=x#top "), url);
  assert.equal(canonicalBlueskyPostUrl(url), url);
  assert.equal(canonicalBlueskyPostUrl(""), "");
  assert.equal(canonicalBlueskyPostUrl(undefined), "");
  assert.ok(!canonicalBlueskyPostUrl(url).includes("linkedin"));
});

test("platformOf: rows from before Bluesky are LinkedIn", () => {
  assert.equal(platformOf({}), "linkedin");
  assert.equal(platformOf(null), "linkedin");
  assert.equal(platformOf({ platform: "bluesky" }), "bluesky");
  assert.equal(platformOf({ platform: "linkedin" }), "linkedin");
});

test("linkedinEngagementOn: only when LINKEDIN_POSTING is on", () => {
  assert.equal(linkedinEngagementOn({}), false);
  assert.equal(linkedinEngagementOn({ LINKEDIN_POSTING: "off" }), false);
  assert.equal(linkedinEngagementOn({ LINKEDIN_POSTING: "" }), false);
  for (const on of ["on", " ON ", "true", "1", "yes"]) assert.equal(linkedinEngagementOn({ LINKEDIN_POSTING: on }), true, on);
});

test("planDailyEngagement: Bluesky for every active elder; LinkedIn only behind the gate", () => {
  const elders = [
    { _id: "a", stage: "active", linkedinUrl: "https://www.linkedin.com/in/a" },
    { _id: "b", stage: "onboarding", linkedinUrl: "https://www.linkedin.com/in/b" },
    { _id: "c", stage: "active" },
    { _id: "d" },
    { _id: "e", stage: "active", linkedinUrl: "https://www.linkedin.com/in/e" },
  ];
  assert.deepEqual(planDailyEngagement(elders, false, 30_000), [
    { kind: "bluesky", elderId: "a", delayMs: 0 },
    { kind: "bluesky", elderId: "c", delayMs: 30_000 },
    { kind: "bluesky", elderId: "e", delayMs: 60_000 },
  ]);
  const on = planDailyEngagement(elders, true, 30_000).filter((j) => j.kind === "linkedin");
  // After the 3 Bluesky runs (90 s) plus 12 minutes, so the refresh debounce has passed.
  assert.equal(LINKEDIN_AFTER_BLUESKY_MS, 12 * 60_000);
  assert.deepEqual(on, [
    { kind: "linkedin", elderId: "a", delayMs: 90_000 + 12 * 60_000 },
    { kind: "linkedin", elderId: "e", delayMs: 120_000 + 12 * 60_000 },
  ]);
  assert.equal(planDailyEngagement(elders, true, 30_000).length, 5);
  // Each elder's LinkedIn run is past the debounce window after his Bluesky run.
  const all = planDailyEngagement(elders, true, 30_000);
  for (const li of on) {
    const bs = all.find((j) => j.kind === "bluesky" && j.elderId === li.elderId)!;
    assert.ok(li.delayMs - bs.delayMs >= LINKEDIN_AFTER_BLUESKY_MS);
  }
});

test("feedbackVisible: a post deleted on its platform or taken down stays out of recentFeedback", () => {
  assert.equal(feedbackVisible({}, null), true);
  assert.equal(feedbackVisible({}, {}), true);
  assert.equal(feedbackVisible({ goneAt: 1 }, null), false, "he deleted the thread in the app");
  assert.equal(feedbackVisible({}, { removedAt: 1 }), false, "taken down by undo");
});

test("LinkedIn canonicalization is unchanged for LinkedIn rows", () => {
  assert.equal(
    canonicalLinkedInPostUrl("https://www.linkedin.com/posts/walt_bread-activity-7123456789012345678-abcd?utm=x"),
    "https://www.linkedin.com/feed/update/urn:li:activity:7123456789012345678",
  );
});
