// Run: npm test
// His page (convex/account.ts via lib/accountPage.ts): the sign-up token check on every
// function, and the posts list built from postPublications + engagement. Fakes only.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  checkedElder,
  profileView,
  publishedPosts,
  scheduleChange,
  type EngagementForPage,
  type PostForPage,
  type PublicationForPage,
} from "../convex/lib/accountPage.ts";
import { newSignupToken, signupTokenHash } from "../convex/lib/signupRules.ts";
import { NOW } from "./helpers.ts";

async function signedUp() {
  const token = newSignupToken();
  const hash = (await signupTokenHash(token))!;
  const elder = {
    name: "Walter",
    language: "es-MX",
    callDay: "tuesday",
    callHour: 11,
    timezone: "America/Chicago",
    phone: "+14155550123",
    signupTokenHash: hash,
  };
  return { token, hash, elder };
}

// ---------- token checks ----------

test("token: only the hash of his own token opens his page", async () => {
  const { hash, elder } = await signedUp();
  const other = (await signupTokenHash(newSignupToken()))!;
  assert.equal(checkedElder(elder, hash), elder);
  assert.equal(checkedElder(elder, other), null, "someone else's token");
  assert.equal(checkedElder(elder, ""), null, "malformed token hashes to ''");
  assert.equal(checkedElder(null, hash), null, "unknown elder");
  assert.equal(checkedElder({ ...elder, signupTokenHash: undefined }, hash), null, "seeded elder has no token");
  assert.equal(await signupTokenHash("not a token"), undefined);
});

test("getProfile: wrong token or unknown elder -> null; never the phone", async () => {
  const { hash, elder } = await signedUp();
  assert.deepEqual(profileView(elder, hash), {
    name: "Walter",
    characterId: "juanito",
    callDay: "tuesday",
    callHour: 11,
    timezone: "America/Chicago",
  });
  assert.equal(profileView(elder, (await signupTokenHash(newSignupToken()))!), null);
  assert.equal(profileView(null, hash), null);
  assert.ok(!("phone" in profileView(elder, hash)!));
  // No slot yet: the fields are left out.
  assert.deepEqual(profileView({ name: "Ann", signupTokenHash: hash }, hash), { name: "Ann", characterId: "pip" });
});

test("setSchedule: needs a valid slot and his token", async () => {
  const { hash, elder } = await signedUp();
  assert.deepEqual(scheduleChange(elder, hash, "Friday", 9, "America/Chicago"), {
    ok: true,
    slot: { callDay: "friday", callHour: 9, timezone: "America/Chicago" },
  });
  assert.deepEqual(scheduleChange(elder, "f".repeat(64), "friday", 9, "America/Chicago"), { ok: false, error: "not_found" });
  assert.deepEqual(scheduleChange(null, hash, "friday", 9, "America/Chicago"), { ok: false, error: "not_found" });
  assert.deepEqual(scheduleChange(elder, hash, "someday", 9, "America/Chicago"), { ok: false, error: "invalid" });
  assert.deepEqual(scheduleChange(elder, hash, "friday", 24, "America/Chicago"), { ok: false, error: "invalid" });
});

// ---------- posts list ----------

const post = (id: string, extra: Partial<PostForPage> = {}): PostForPage => ({
  id,
  text: `  Story ${id}  `,
  status: "published",
  createdAt: NOW - 86_400_000,
  ...extra,
});
const pub = (postId: string, platform: PublicationForPage["platform"], extra: Partial<PublicationForPage> = {}): PublicationForPage => ({
  postId,
  platform,
  status: "posted",
  url: `https://${platform}.example/${postId}`,
  postedAt: NOW,
  ...extra,
});
const eng = (extra: Partial<EngagementForPage> & { linkedinUrl: string }): EngagementForPage => ({ reactions: 0, comments: 0, ...extra });

test("posts: a link per platform it went out on, counts summed across platforms", () => {
  const [p] = publishedPosts(
    [post("p1")],
    [pub("p1", "x"), pub("p1", "bluesky", { postedAt: NOW - 60_000 }), pub("p1", "threads")],
    [
      eng({ postId: "p1", linkedinUrl: "https://bluesky.example/p1", reactions: 3, comments: 1 }),
      eng({ postId: "p1", linkedinUrl: "https://threads.example/p1", reactions: 2, comments: 2 }),
      eng({ postId: "p2", linkedinUrl: "https://bluesky.example/p2", reactions: 50, comments: 9 }),
    ],
  );
  assert.deepEqual(p, {
    id: "p1",
    text: "Story p1",
    postedAt: NOW - 60_000, // the first platform it reached
    reactions: 5,
    comments: 3,
    links: [
      { platform: "bluesky", url: "https://bluesky.example/p1" },
      { platform: "threads", url: "https://threads.example/p1" },
      { platform: "x", url: "https://x.example/p1" },
    ],
  });
});

test("posts: removed, held, failed and not-yet-posted posts never show", () => {
  const list = publishedPosts(
    [
      post("removed", { removedAt: NOW }),
      post("held", { status: "needs_review" }),
      post("pending", { status: "posting" }),
      post("failed", { status: "failed" }),
      post("ok"),
    ],
    [
      pub("removed", "bluesky"),
      pub("pending", "bluesky", { status: "posting", url: undefined }),
      pub("failed", "threads", { status: "failed" }), // half-posted thread: kept for retry, not shown
      pub("failed", "x", { status: "maybe_posted" }),
      pub("ok", "bluesky"),
      pub("ok", "threads", { status: "removed" }),
      pub("ok", "x", { status: "skipped", url: undefined }),
    ],
    [],
  );
  assert.deepEqual(
    list.map((p) => [p.id, p.links.map((l) => l.platform)]),
    [["ok", ["bluesky"]]],
  );
});

test("posts: gone platform posts don't count; links must be https", () => {
  const [p] = publishedPosts(
    [post("p1")],
    [pub("p1", "bluesky"), pub("p1", "x", { url: "javascript:alert(1)" })],
    [eng({ postId: "p1", linkedinUrl: "https://bluesky.example/p1", reactions: 4, comments: 1, goneAt: NOW })],
  );
  assert.deepEqual(p.links, [{ platform: "bluesky", url: "https://bluesky.example/p1" }]);
  assert.equal(p.reactions, 0);
  assert.equal(p.comments, 0);
});

test("posts: an older LinkedIn-only post shows with its link and url-matched counts", () => {
  const url = "https://www.linkedin.com/feed/update/urn:li:activity:1";
  const [p] = publishedPosts(
    [post("old", { linkedinUrl: url, approvedAt: NOW - 5000 })],
    [],
    [eng({ linkedinUrl: url, reactions: 7, comments: 2 })],
  );
  assert.deepEqual(p.links, [{ platform: "linkedin", url }]);
  assert.equal(p.linkedinUrl, url);
  assert.equal(p.postedAt, NOW - 5000);
  assert.equal(p.reactions, 7);
  assert.equal(p.comments, 2);
  // A LinkedIn url on a post that only went out elsewhere doesn't add a second link.
  const [q] = publishedPosts([post("new", { linkedinUrl: url })], [pub("new", "bluesky")], []);
  assert.deepEqual(q.links.map((l) => l.platform), ["bluesky"]);
});

test("posts: newest first, at most max", () => {
  const posts = ["a", "b", "c"].map((id) => post(id));
  const pubs = [pub("a", "bluesky", { postedAt: 1 }), pub("b", "bluesky", { postedAt: 3 }), pub("c", "bluesky", { postedAt: 2 })];
  assert.deepEqual(publishedPosts(posts, pubs, []).map((p) => p.id), ["b", "c", "a"]);
  assert.deepEqual(publishedPosts(posts, pubs, [], 2).map((p) => p.id), ["b", "c"]);
  assert.deepEqual(publishedPosts([], [], []), []);
});
