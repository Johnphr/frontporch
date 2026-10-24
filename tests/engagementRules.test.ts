import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BANK_REFRESH_DEBOUNCE_MS,
  cleanComments,
  engagementChanged,
  feedbackWindowStart,
  nextSnapshot,
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
