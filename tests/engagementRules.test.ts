import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BANK_REFRESH_DELAY_MS,
  BANK_REFRESH_GAP_MS,
  RECENT_POST_WINDOW_MS,
  canonicalBlueskyPostUrl,
  canonicalEngagementUrl,
  cleanComments,
  engagementChanged,
  feedbackWindowStart,
  linkedinEngagementOn,
  nextSnapshot,
  LINKEDIN_AFTER_BLUESKY_MS,
  feedbackVisible,
  planBankRefresh,
  planDailyEngagement,
  planRecentEngagement,
  platformOf,
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

test("planBankRefresh: a minute after a change, at least the gap after the last one, never dropped", () => {
  const now = Date.parse("2026-10-24T12:00:00Z");
  const MIN = 60_000;
  assert.deepEqual(planBankRefresh(undefined, now), { schedule: true, runAt: now + BANK_REFRESH_DELAY_MS });
  assert.equal(BANK_REFRESH_DELAY_MS, MIN);
  // One is still pending: it hasn't started, so it reads this change too.
  assert.deepEqual(planBankRefresh(now + 30_000, now), { schedule: false });
  // The last one ran 2 min ago: a trailing one at the end of the gap (the old 10-min debounce dropped it).
  assert.deepEqual(planBankRefresh(now - 2 * MIN, now), { schedule: true, runAt: now - 2 * MIN + BANK_REFRESH_GAP_MS });
  // Long ago: just the delay.
  assert.deepEqual(planBankRefresh(now - 60 * MIN, now), { schedule: true, runAt: now + MIN });
  // Running right now (started this instant): the next one waits the gap.
  assert.deepEqual(planBankRefresh(now, now), { schedule: true, runAt: now + BANK_REFRESH_GAP_MS });
});

test("planBankRefresh: a reply found by the 5-min cron is in the bank within ~7 minutes", () => {
  const MIN = 60_000;
  const posted = Date.parse("2026-10-24T12:00:00Z");
  // Cron runs every 5 min; a like was found on the previous run and refreshed the bank then.
  const previousRun = posted + 5 * MIN;
  const first = planBankRefresh(undefined, previousRun);
  assert.ok(first.schedule);
  // The reply comes right after that cron run, so the next run (5 min later) finds it.
  const reply = previousRun + 1000;
  const found = previousRun + 5 * MIN;
  const second = planBankRefresh(first.runAt, found);
  assert.ok(second.schedule);
  assert.equal(second.runAt, found + BANK_REFRESH_DELAY_MS, "the gap is shorter than the cron interval: no extra wait");
  // + about a minute for the refresh itself (feedback summary + question planning).
  assert.ok(second.runAt + MIN - reply <= 7 * MIN);
  assert.ok(BANK_REFRESH_GAP_MS < 5 * MIN);
});

test("planRecentEngagement: Bluesky + Threads posts from the last 48h, one run per elder and platform, staggered", () => {
  const now = Date.parse("2026-10-24T12:00:00Z");
  const H = 3_600_000;
  const pubs = [
    { elderId: "a", platform: "bluesky", status: "posted", postedAt: now - 1 * H },
    { elderId: "a", platform: "bluesky", status: "posted", postedAt: now - 2 * H }, // same elder: one run
    { elderId: "a", platform: "threads", status: "posted", postedAt: now - 3 * H },
    { elderId: "b", platform: "x", status: "posted", postedAt: now - 1 * H }, // never X (reads cost money)
    { elderId: "c", platform: "linkedin", status: "posted", postedAt: now - 1 * H },
    { elderId: "d", platform: "bluesky", status: "posted", postedAt: now - 1 * H, removedAt: now }, // taken down
    { elderId: "e", platform: "bluesky", status: "removed", postedAt: now - 1 * H },
    { elderId: "f", platform: "bluesky", status: "posted", postedAt: now - 49 * H }, // too old: daily job
    { elderId: "g", platform: "bluesky", status: "posted" }, // no postedAt
    { elderId: "h", platform: "bluesky", status: "posted", postedAt: now - 47 * H },
  ];
  assert.deepEqual(planRecentEngagement(pubs, now, 10_000), [
    { kind: "bluesky", elderId: "a", delayMs: 0 },
    { kind: "threads", elderId: "a", delayMs: 10_000 },
    { kind: "bluesky", elderId: "h", delayMs: 20_000 },
  ]);
  assert.deepEqual(planRecentEngagement([], now, 10_000), []);
  assert.equal(RECENT_POST_WINDOW_MS, 48 * H);
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
  assert.deepEqual(planDailyEngagement(elders, false, 30_000).filter((j) => j.kind === "bluesky"), [
    { kind: "bluesky", elderId: "a", delayMs: 0 },
    { kind: "bluesky", elderId: "c", delayMs: 30_000 },
    { kind: "bluesky", elderId: "e", delayMs: 60_000 },
  ]);
  const on = planDailyEngagement(elders, true, 30_000).filter((j) => j.kind === "linkedin");
  // After the 3 Bluesky runs (90 s) plus 12 minutes.
  assert.equal(LINKEDIN_AFTER_BLUESKY_MS, 12 * 60_000);
  assert.deepEqual(on, [
    { kind: "linkedin", elderId: "a", delayMs: 90_000 + 12 * 60_000 },
    { kind: "linkedin", elderId: "e", delayMs: 120_000 + 12 * 60_000 },
  ]);
  assert.equal(planDailyEngagement(elders, true, 30_000).length, 8, "3 Bluesky + 3 Threads + 2 LinkedIn");
  // Each elder's LinkedIn run is well after his Bluesky run.
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

test("planDailyEngagement: Threads for every active elder, a little after his Bluesky run; X only when on", () => {
  const elders = [
    { _id: "a", stage: "active", linkedinUrl: "https://www.linkedin.com/in/a" },
    { _id: "b", stage: "onboarding" },
    { _id: "c", stage: "active" },
  ];
  const off = planDailyEngagement(elders, false, 30_000);
  assert.deepEqual(off.filter((j) => j.kind === "threads"), [
    { kind: "threads", elderId: "a", delayMs: 10_000 },
    { kind: "threads", elderId: "c", delayMs: 40_000 },
  ]);
  assert.equal(off.some((j) => j.kind === "x"), false, "X_READ_FEEDBACK off");
  const on = planDailyEngagement(elders, true, 30_000, true);
  assert.deepEqual(on.filter((j) => j.kind === "x"), [
    { kind: "x", elderId: "a", delayMs: 20_000 },
    { kind: "x", elderId: "c", delayMs: 50_000 },
  ]);
  // LinkedIn still starts after the whole batch (Threads and X included).
  const li = on.filter((j) => j.kind === "linkedin");
  assert.deepEqual(li, [{ kind: "linkedin", elderId: "a", delayMs: 60_000 + LINKEDIN_AFTER_BLUESKY_MS }]);
  for (const j of on.filter((j) => j.kind !== "linkedin")) assert.ok(li[0].delayMs - j.delayMs >= LINKEDIN_AFTER_BLUESKY_MS);
});

test("canonicalEngagementUrl: only LinkedIn links get the LinkedIn cleanup", () => {
  const threads = "https://www.threads.com/@walter/post/DAbc123";
  const x = "https://x.com/grandpa_joe/status/1234567890";
  assert.equal(canonicalEngagementUrl("threads", ` ${threads}/?xmt=abc#top `), threads);
  assert.equal(canonicalEngagementUrl("x", `${x}?s=20`), x);
  assert.equal(canonicalEngagementUrl("bluesky", "https://BSKY.app/profile/w.bsky.social/post/3l/"), "https://bsky.app/profile/w.bsky.social/post/3l");
  const li = "https://www.linkedin.com/feed/update/urn:li:activity:7000000000000000000/?utm_source=x";
  assert.equal(canonicalEngagementUrl("linkedin", li), canonicalLinkedInPostUrl(li));
  for (const p of ["threads", "x"] as const) assert.ok(!canonicalEngagementUrl(p, threads).includes("linkedin"));
  assert.equal(canonicalEngagementUrl("x", ""), "");
  assert.equal(platformOf({ platform: "threads" }), "threads");
  assert.equal(platformOf({ platform: "x" }), "x");
});
