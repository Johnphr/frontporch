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
  draftStatus,
  finalReplyText,
  parseRedditComment,
  platformOf,
  redditPostingOn,
  redditThingId,
  replyBody,
  replyLanguage,
  replyMode,
  replyTarget,
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

test("platformOf: only Bluesky and Reddit; every other source is null", () => {
  assert.equal(platformOf("bluesky", ""), "bluesky");
  assert.equal(platformOf("reddit", ""), "reddit");
  assert.equal(platformOf("discourse", "https://forum.example.com/t/x/1"), null);
  assert.equal(platformOf("quora", "https://www.quora.com/q"), null);
  assert.equal(platformOf("stackexchange", ""), null);
  assert.equal(platformOf(undefined, "https://www.reddit.com/r/Baking/comments/abc123/x/"), "reddit");
  assert.equal(platformOf(undefined, "https://bsky.app/profile/a/post/b"), "bluesky");
  assert.equal(platformOf(undefined, "https://cooking.stackexchange.com/questions/1"), null);
  assert.equal(platformOf(undefined, "https://forum.example.com/t/x/1"), null);
});

const ENV = {
  blueskyHandle: "walter.bsky.social",
  blueskyPassword: "app-pass",
  redditPosting: "on",
  redditClientId: "id",
  redditClientSecret: "secret",
  redditUsername: "walter",
  redditPassword: "pw",
};

test("replyMode: Bluesky auto with his login, Reddit only when switched on, nothing else", () => {
  assert.equal(replyMode("bluesky", ENV).mode, "auto");
  assert.equal(replyMode("bluesky", { ...ENV, blueskyPassword: undefined }).mode, "none");
  assert.equal(replyMode("reddit", ENV).mode, "auto");
  assert.equal(replyMode("reddit", { ...ENV, redditPosting: undefined }).mode, "none", "off by default");
  assert.equal(replyMode("reddit", { ...ENV, redditPassword: undefined }).mode, "none", "missing creds");
  assert.equal(replyMode(null, ENV).mode, "none");
  assert.equal(redditPostingOn("ON"), true);
  assert.equal(redditPostingOn("off"), false);
  assert.equal(redditPostingOn(undefined), false);
});

test("replyTarget: no reply (no row) for other sources or platforms that aren't set up", () => {
  assert.deepEqual(replyTarget({ source: "bluesky", url: "https://bsky.app/profile/a/post/b", atUri: "at://did:plc:x/app.bsky.feed.post/b" }, ENV), {
    ok: true,
    platform: "bluesky",
  });
  assert.deepEqual(replyTarget({ source: "reddit", url: "https://www.reddit.com/r/Baking/comments/1abcde/x/" }, ENV), {
    ok: true,
    platform: "reddit",
  });
  for (const source of ["discourse", "quora", "stackexchange"]) {
    assert.equal(replyTarget({ source, url: "https://example.com/t/x/1" }, ENV).ok, false, source);
  }
  assert.equal(replyTarget({ source: "reddit", url: "https://www.reddit.com/r/x/comments/1a/" }, { ...ENV, redditPosting: "off" }).ok, false, "Reddit off");
  assert.equal(replyTarget({ source: "bluesky", url: "https://bsky.app/profile/a/post/b" }, ENV).ok, false, "no at:// uri");
  assert.equal(
    replyTarget({ source: "bluesky", url: "https://bsky.app/profile/a/post/b", atUri: "at://x" }, { ...ENV, blueskyHandle: undefined }).ok,
    false,
    "no Bluesky login",
  );
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
  const es = finalReplyText("Empiece con precios bajos.\n\nEscrito con ayuda de IA.", "es", "reddit");
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
  assert.equal(draftStatus({ pass: true, mode: "enforce" }), "draft");
  assert.equal(draftStatus({ pass: false, mode: "enforce" }), "needs_review");
  assert.equal(draftStatus({ pass: false, mode: "warn" }), "draft");
  assert.equal(draftStatus(null), "draft");
  const now = 1_000_000_000;
  assert.equal(canClaimReply({ status: "draft" }, now, false).ok, true);
  assert.equal(canClaimReply({ status: "failed" }, now, false).ok, true);
  assert.equal(canClaimReply({ status: "needs_review" }, now, false).ok, false);
  assert.equal(canClaimReply({ status: "needs_review" }, now, true).ok, true);
  assert.equal(canClaimReply({ status: "posting", claimedAt: now - 1000 }, now, false).ok, false);
  assert.equal(canClaimReply({ status: "posting", claimedAt: now - STALE_CLAIM_MS - 1 }, now, false).ok, false, "a crashed run may have posted");
  assert.equal(canClaimReply({ status: "posting", claimedAt: now - STALE_CLAIM_MS - 1 }, now, true).ok, true);
  assert.equal(canClaimReply({ status: "maybe_posted" }, now, false).ok, false, "unclear: a person checks first");
  assert.equal(canClaimReply({ status: "maybe_posted" }, now, true).ok, true);
  assert.equal(canClaimReply({ status: "posted" }, now, true).ok, false);
});

test("platform responses", () => {
  assert.deepEqual(parseRedditComment({ json: { errors: [], data: { things: [{ data: { permalink: "/r/Baking/comments/1/x/c1/" } }] } } }), {
    url: "https://www.reddit.com/r/Baking/comments/1/x/c1/",
    errors: [],
  });
  assert.deepEqual(parseRedditComment({ json: { errors: [["RATELIMIT", "slow down", "ratelimit"]] } }).errors, ["RATELIMIT"]);
  assert.equal(replyLanguage("es-MX"), "es");
  assert.equal(replyLanguage("fr"), "en");
});

test("review page section: copy + open thread only for held replies, safe links only", () => {
  const html = renderRepliesSection([
    { id: "r1", createdAt: 0, platform: "reddit", status: "needs_review", threadUrl: "https://www.reddit.com/r/x/comments/1a/", threadTitle: "How <b>?", text: "Answer", guardSummary: "unsupported claim" },
    { id: "r2", createdAt: 0, platform: "bluesky", status: "posted", threadUrl: "javascript:alert(1)", threadTitle: "t", text: "x", postedUrl: "https://bsky.app/profile/a/post/b" },
    { id: "r3", createdAt: 0, platform: "bluesky", status: "draft", threadUrl: "https://bsky.app/profile/a/post/c", threadTitle: "t", text: "y" },
  ]);
  assert.match(html, /data-copy="reply-text-r1"/);
  assert.ok(!html.includes('data-copy="reply-text-r2"'), "no copy button once posted");
  assert.ok(!html.includes('data-copy="reply-text-r3"'), "no copy button for a reply that auto-posts");
  assert.match(html, /How &lt;b&gt;\?/);
  assert.ok(!html.includes("javascript:alert"), "non-http links aren't rendered");
  assert.match(html, /See the reply/);
  assert.equal(renderRepliesSection([]), "");
});
