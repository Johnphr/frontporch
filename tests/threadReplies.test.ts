// Run: node --test tests/   (Node 22.18+ / 24 strips TypeScript types natively)
import { test } from "node:test";
import assert from "node:assert/strict";

import { graphemeCount } from "../convex/lib/bluesky.ts";
import {
  BLUESKY_DISCLOSURE,
  REPLY_DISCLOSURE,
  STALE_CLAIM_MS,
  audienceIdForCall,
  canClaimReply,
  discoursePostUrl,
  discourseTopicId,
  draftStatus,
  finalReplyText,
  parseRedditComment,
  platformOf,
  redditPostingOn,
  redditThingId,
  replyBody,
  replyLanguage,
  replyMode,
  stripDisclosure,
} from "../convex/lib/threadReplies.ts";
import { renderRepliesSection } from "../convex/lib/postsPage.ts";

const BANK = { _id: "qb1", source: "audience", sourceRef: "aq1" };

test("audienceIdForCall: only an audience bank row used by this plan", () => {
  assert.equal(audienceIdForCall({ bankId: "qb1" }, BANK), "aq1");
  assert.equal(audienceIdForCall({ bankId: "qb1" }, { ...BANK, source: "open_thread" }), null, "not an online question");
  assert.equal(audienceIdForCall({ bankId: "other" }, BANK), null, "row isn't the plan's");
  assert.equal(audienceIdForCall({}, BANK), null, "no bankId (fallback question)");
  assert.equal(audienceIdForCall(undefined, null), null);
  assert.equal(audienceIdForCall({ bankId: "qb1" }, { _id: "qb1", source: "audience" }), null, "no sourceRef");
});

test("platformOf: by source, then by link", () => {
  assert.equal(platformOf("bluesky", ""), "bluesky");
  assert.equal(platformOf("discourse", ""), "discourse");
  assert.equal(platformOf("reddit", ""), "reddit");
  assert.equal(platformOf("quora", ""), "quora");
  assert.equal(platformOf("stackexchange", ""), "stackexchange");
  assert.equal(platformOf(undefined, "https://www.reddit.com/r/Baking/comments/abc123/x/"), "reddit");
  assert.equal(platformOf(undefined, "https://bsky.app/profile/a/post/b"), "bluesky");
  assert.equal(platformOf(undefined, "https://cooking.stackexchange.com/questions/1"), "stackexchange");
  assert.equal(platformOf(undefined, "https://forum.example.com/t/x/1"), "other");
});

const ENV = {
  blueskyHandle: "walter.bsky.social",
  blueskyPassword: "app-pass",
  discourseUrl: "https://forum.example.com",
  discourseKey: "key",
  redditPosting: "on",
  redditClientId: "id",
  redditClientSecret: "secret",
  redditUsername: "walter",
  redditPassword: "pw",
};

test("replyMode: Bluesky + Discourse auto, Reddit gated, Quora manual, Stack Exchange skipped", () => {
  assert.equal(replyMode("bluesky", "https://bsky.app/profile/a/post/b", ENV).mode, "auto");
  assert.equal(replyMode("bluesky", "", { ...ENV, blueskyPassword: undefined }).mode, "manual");
  assert.equal(replyMode("discourse", "https://forum.example.com/t/cakes/42", ENV).mode, "auto");
  assert.equal(replyMode("discourse", "https://other-forum.org/t/cakes/42", ENV).mode, "manual", "key is for another forum");
  assert.equal(replyMode("discourse", "https://forum.example.com/latest", ENV).mode, "manual", "no topic id");
  assert.equal(replyMode("discourse", "https://forum.example.com/t/cakes/42", { ...ENV, discourseKey: undefined }).mode, "manual");
  assert.equal(replyMode("reddit", "", ENV).mode, "auto");
  assert.equal(replyMode("reddit", "", { ...ENV, redditPosting: undefined }).mode, "manual", "off by default");
  assert.equal(replyMode("reddit", "", { ...ENV, redditPassword: undefined }).mode, "manual", "missing creds");
  assert.equal(replyMode("quora", "", ENV).mode, "manual");
  assert.equal(replyMode("stackexchange", "", ENV).mode, "skipped");
  assert.equal(replyMode("other", "", ENV).mode, "manual");
  assert.equal(redditPostingOn("ON"), true);
  assert.equal(redditPostingOn("off"), false);
  assert.equal(redditPostingOn(undefined), false);
});

test("discourseTopicId", () => {
  assert.equal(discourseTopicId("https://forum.example.com/t/pricing-cakes/42"), 42);
  assert.equal(discourseTopicId("https://forum.example.com/t/pricing-cakes/42/7"), 42);
  assert.equal(discourseTopicId("https://forum.example.com/t/42"), 42);
  assert.equal(discourseTopicId("https://forum.example.com/t/topic/42/"), 42);
  assert.equal(discourseTopicId("https://forum.example.com/c/baking"), undefined);
  assert.equal(discourseTopicId("not a url"), undefined);
});

test("redditThingId", () => {
  assert.equal(redditThingId("https://www.reddit.com/r/Baking/comments/1abcde/how_do_i/"), "t3_1abcde");
  assert.equal(redditThingId("https://old.reddit.com/r/Baking/comments/XYZ12/"), "t3_xyz12");
  assert.equal(redditThingId("https://redd.it/1abcde"), "t3_1abcde");
  assert.equal(redditThingId("https://www.reddit.com/r/Baking/"), undefined);
  assert.equal(redditThingId("https://evil.com/comments/1abcde/"), undefined, "only reddit hosts");
});

test("finalReplyText: our disclosure exactly once, in his language", () => {
  const en = finalReplyText("Start low and raise prices.\n\nWritten with the help of AI.", "en", "reddit");
  assert.equal(en, `Start low and raise prices.\n\n${REPLY_DISCLOSURE.en}`);
  assert.equal(en.split(REPLY_DISCLOSURE.en).length, 2);
  const again = finalReplyText(en, "en", "reddit");
  assert.equal(again, en, "idempotent");
  const es = finalReplyText("Empiece con precios bajos.\n\nEscrito con ayuda de IA.", "es", "discourse");
  assert.equal(es, `Empiece con precios bajos.\n\n${REPLY_DISCLOSURE.es}`);
  assert.equal(replyBody(es), "Empiece con precios bajos.");
  assert.equal(stripDisclosure("Keep this line about AI tools at the plant.\n\nAnother paragraph."), "Keep this line about AI tools at the plant.\n\nAnother paragraph.");
});

test("finalReplyText: Bluesky fits 300 graphemes including the disclosure", () => {
  const long = `${"I learned to price by the hour and the ingredients, never by guesswork. ".repeat(10)}`;
  for (const lang of ["en", "es"] as const) {
    const text = finalReplyText(long, lang, "bluesky");
    assert.ok(graphemeCount(text) <= 300, `${lang}: ${graphemeCount(text)} graphemes`);
    assert.ok(text.endsWith(BLUESKY_DISCLOSURE[lang]));
    assert.equal(text.split(BLUESKY_DISCLOSURE[lang]).length, 2);
  }
  const short = finalReplyText("Charge for your time.", "en", "bluesky");
  assert.equal(short, `Charge for your time.\n\n${BLUESKY_DISCLOSURE.en}`);
  assert.equal(finalReplyText(short, "en", "bluesky"), short, "idempotent on Bluesky too");
});

test("finalReplyText clamps to the platform limit", () => {
  const huge = "word ".repeat(5000);
  const text = finalReplyText(huge, "en", "reddit");
  assert.ok(text.length <= 10_000);
  assert.ok(text.endsWith(REPLY_DISCLOSURE.en));
});

test("draftStatus + canClaimReply", () => {
  assert.equal(draftStatus("auto", { pass: true, mode: "enforce" }), "draft");
  assert.equal(draftStatus("auto", { pass: false, mode: "enforce" }), "needs_review");
  assert.equal(draftStatus("auto", { pass: false, mode: "warn" }), "draft");
  assert.equal(draftStatus("manual", { pass: true, mode: "enforce" }), "manual");
  assert.equal(draftStatus("manual", { pass: false, mode: "enforce" }), "needs_review");
  assert.equal(draftStatus("skipped", null), "skipped");
  const now = 1_000_000_000;
  assert.equal(canClaimReply({ status: "draft" }, now, false).ok, true);
  assert.equal(canClaimReply({ status: "failed" }, now, false).ok, true);
  assert.equal(canClaimReply({ status: "needs_review" }, now, false).ok, false);
  assert.equal(canClaimReply({ status: "needs_review" }, now, true).ok, true);
  assert.equal(canClaimReply({ status: "posting", claimedAt: now - 1000 }, now, false).ok, false);
  assert.equal(canClaimReply({ status: "posting", claimedAt: now - STALE_CLAIM_MS - 1 }, now, false).ok, true);
  assert.equal(canClaimReply({ status: "posted" }, now, true).ok, false);
  assert.equal(canClaimReply({ status: "manual" }, now, true).ok, false);
  assert.equal(canClaimReply({ status: "skipped" }, now, true).ok, false);
});

test("platform responses", () => {
  assert.equal(
    discoursePostUrl("https://forum.example.com/", { topic_id: 42, topic_slug: "cakes", post_number: 3 }, 42),
    "https://forum.example.com/t/cakes/42/3",
  );
  assert.equal(discoursePostUrl("https://forum.example.com", null, 42), "https://forum.example.com/t/topic/42");
  assert.deepEqual(parseRedditComment({ json: { errors: [], data: { things: [{ data: { permalink: "/r/Baking/comments/1/x/c1/" } }] } } }), {
    url: "https://www.reddit.com/r/Baking/comments/1/x/c1/",
    errors: [],
  });
  assert.deepEqual(parseRedditComment({ json: { errors: [["RATELIMIT", "slow down", "ratelimit"]] } }).errors, ["RATELIMIT"]);
  assert.equal(replyLanguage("es-MX"), "es");
  assert.equal(replyLanguage("fr"), "en");
});

test("review page section: copy button for manual replies, safe links only", () => {
  const html = renderRepliesSection([
    { id: "r1", createdAt: 0, platform: "quora", status: "manual", threadUrl: "https://www.quora.com/q", threadTitle: "How <b>?", text: "Answer", reason: "post by hand" },
    { id: "r2", createdAt: 0, platform: "bluesky", status: "posted", threadUrl: "javascript:alert(1)", threadTitle: "t", text: "x", postedUrl: "https://bsky.app/profile/a/post/b" },
  ]);
  assert.match(html, /data-copy="reply-text-r1"/);
  assert.match(html, /How &lt;b&gt;\?/);
  assert.ok(!html.includes("javascript:alert"), "non-http links aren't rendered");
  assert.match(html, /See the reply/);
  assert.equal(renderRepliesSection([]), "");
});
