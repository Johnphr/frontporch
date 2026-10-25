// Undo (lib/undo.ts, lib/blueskyDelete.ts): fake fetch, in-memory rows; no network.
import { test } from "node:test";
import assert from "node:assert/strict";

import type { FetchFn } from "../convex/lib/blueskyClient.ts";
import { blueskyDeleteOrder, deleteBlueskyThread } from "../convex/lib/blueskyDelete.ts";
import { TAKE_DOWN_LINE, KEEP_UP_LINE, TODAY_LINE } from "../convex/lib/prompts/principles.ts";
import { canClaimReply, callLanguageOf } from "../convex/lib/threadReplies.ts";
import {
  HOLD_REASON,
  STALE_REMOVE_MS,
  STUCK_NOTE,
  claimPatch,
  deleteRedditThing,
  detectTakeDown,
  finishPatch,
  ownsClaim,
  pickLatestPost,
  planPostRemoval,
  postRemovalPatch,
  postUndoInfo,
  publicationStep,
  redditCommentFullname,
  replyDeleteTarget,
  replyStep,
  retryDelay,
  runRemoval,
  summaryLine,
  undoCommand,
  type Entry,
  type LatestCandidate,
  type PubRow,
  deleteCopy,
  noIdsNote,
  pubHasCopy,
} from "../convex/lib/undo.ts";
import { NOW } from "./helpers.ts";

const LOGIN = { service: "https://bsky.social", identifier: "walter.bsky.social", password: "app-pass" };
const REDDIT = { clientId: "cid", clientSecret: "csecret", username: "walter", password: "rpass", userAgent: "web:test:v1" };
const ROOT = "at://did:plc:him/app.bsky.feed.post/root";
const R2 = "at://did:plc:him/app.bsky.feed.post/two";
const R3 = "at://did:plc:him/app.bsky.feed.post/three";

type Reply = { status: number; json?: unknown } | "throw";

/** Fake fetch: a handler per url piece; records every call (url + parsed JSON body). */
function fakeFetch(handlers: Record<string, (body: any) => Reply>) {
  const calls: Array<{ url: string; body?: any; raw?: string; headers?: Record<string, string> }> = [];
  const fetchFn: FetchFn = async (url, init) => {
    let body: any;
    try {
      body = init?.body ? JSON.parse(init.body) : undefined;
    } catch {
      body = undefined;
    }
    calls.push({ url, body, raw: init?.body, headers: init?.headers });
    const key = Object.keys(handlers).find((k) => url.includes(k));
    if (!key) throw new Error(`unexpected request ${url}`);
    const out = handlers[key](body);
    if (out === "throw") throw new Error("The operation was aborted");
    return { ok: out.status >= 200 && out.status < 300, status: out.status, json: async () => out.json ?? {} };
  };
  return { fetchFn, calls, deletes: () => calls.filter((c) => c.url.includes("deleteRecord")).map((c) => c.body.rkey) };
}

const SESSION = () => ({ status: 200, json: { accessJwt: "acc", refreshJwt: "ref", did: "did:plc:him", handle: "walter.bsky.social" } });

// ---------- status transitions ----------

test("publication steps: never-posted -> removed, posted -> delete, posting left alone, linkedin manual", () => {
  for (const status of ["pending", "failed", "skipped"]) assert.deepEqual(publicationStep({ platform: "bluesky", status }, NOW), { kind: "mark_removed" });
  assert.deepEqual(publicationStep({ platform: "bluesky", status: "posted" }, NOW), { kind: "delete", previous: "posted" });
  assert.deepEqual(publicationStep({ platform: "reddit", status: "maybe_posted" }, NOW), { kind: "delete", previous: "maybe_posted" });
  assert.equal(publicationStep({ platform: "bluesky", status: "posting", claimedAt: NOW }, NOW).kind, "wait");
  assert.equal(publicationStep({ platform: "bluesky", status: "removed" }, NOW).kind, "already_removed");
  assert.equal(publicationStep({ platform: "linkedin", status: "posted" }, NOW).kind, "manual");
  assert.equal(publicationStep({ platform: "linkedin", status: "pending" }, NOW).kind, "mark_removed");
});

test("removing: a fresh claim waits, a stale (crashed) one is retaken as maybe_posted", () => {
  assert.equal(publicationStep({ platform: "bluesky", status: "removing", claimedAt: NOW - 60_000 }, NOW).kind, "wait");
  assert.deepEqual(publicationStep({ platform: "bluesky", status: "removing", claimedAt: NOW - STALE_REMOVE_MS - 1 }, NOW), {
    kind: "delete",
    previous: "maybe_posted",
  });
});

test("patches: claim, success, failure back to the previous status", () => {
  assert.deepEqual(claimPatch({ kind: "mark_removed" }, NOW), { status: "removed", removedAt: NOW, claimedAt: undefined });
  assert.deepEqual(claimPatch({ kind: "delete", previous: "posted" }, NOW), { status: "removing", claimedAt: NOW });
  assert.equal(claimPatch({ kind: "wait", reason: "x" }, NOW), null);
  assert.deepEqual(finishPatch("posted", { ok: true, deleted: 2, alreadyGone: 0 }, NOW), { status: "removed", removedAt: NOW, claimedAt: undefined, error: undefined });
  const failed = finishPatch("maybe_posted", { ok: false, error: "Bluesky delete HTTP 500" }, NOW);
  assert.equal(failed.status, "maybe_posted");
  assert.equal(failed.claimedAt, undefined);
  assert.match(String(failed.error), /HTTP 500/);
});

test("post patch: removedAt + reason set once, status removed", () => {
  assert.deepEqual(postRemovalPatch({}, "he asked on the call", NOW), { removedAt: NOW, removedReason: "he asked on the call", status: "removed" });
  assert.deepEqual(postRemovalPatch({ removedAt: 5, removedReason: "family request" }, "again", NOW), { removedAt: 5, removedReason: "family request", status: "removed" });
  assert.equal(postRemovalPatch({}, "  ", NOW).removedReason, "take-down request");
});

// ---------- Bluesky ----------

test("bluesky: deletes replies first, root last, with his did as repo", async () => {
  const f = fakeFetch({ createSession: SESSION, deleteRecord: () => ({ status: 200 }) });
  const out = await deleteBlueskyThread(f.fetchFn, new Map(), LOGIN, [ROOT, R2, R3]);
  assert.deepEqual(out, { ok: true, deleted: 3, alreadyGone: 0 });
  assert.deepEqual(f.deletes(), ["three", "two", "root"]);
  const first = f.calls.find((c) => c.url.includes("deleteRecord"))!;
  assert.deepEqual(first.body, { repo: "did:plc:him", collection: "app.bsky.feed.post", rkey: "three" });
  assert.deepEqual(blueskyDeleteOrder([ROOT, R2, R2, ""]), [R2, ROOT]);
});

test("bluesky: an already-gone record counts as deleted", async () => {
  const f = fakeFetch({
    createSession: SESSION,
    deleteRecord: (b) => (b.rkey === "two" ? { status: 400, json: { error: "RecordNotFound" } } : b.rkey === "three" ? { status: 404 } : { status: 200 }),
  });
  assert.deepEqual(await deleteBlueskyThread(f.fetchFn, new Map(), LOGIN, [ROOT, R2, R3]), { ok: true, deleted: 1, alreadyGone: 2 });
});

test("bluesky: a failure stops, keeps the root up, and says why (status only)", async () => {
  const f = fakeFetch({ createSession: SESSION, deleteRecord: (b) => (b.rkey === "two" ? { status: 500 } : { status: 200 }) });
  const out = await deleteBlueskyThread(f.fetchFn, new Map(), LOGIN, [ROOT, R2, R3]);
  assert.equal(out.ok, false);
  assert.match((out as { error: string }).error, /HTTP 500/);
  assert.deepEqual(f.deletes(), ["three", "two"], "root never deleted before its replies");
});

test("bluesky: never deletes a record from someone else's repo; no login = clear failure", async () => {
  const f = fakeFetch({ createSession: SESSION, deleteRecord: () => ({ status: 200 }) });
  const out = await deleteBlueskyThread(f.fetchFn, new Map(), LOGIN, ["at://did:plc:someoneelse/app.bsky.feed.post/x"]);
  assert.equal(out.ok, false);
  assert.equal(f.deletes().length, 0);
  assert.deepEqual(await deleteBlueskyThread(f.fetchFn, new Map(), null, [ROOT]), { ok: false, error: "His Bluesky account isn't connected." });
});

test("bluesky: an expired token is renewed and the delete retried", async () => {
  let n = 0;
  const f = fakeFetch({ createSession: SESSION, refreshSession: SESSION, deleteRecord: () => (n++ === 0 ? { status: 400, json: { error: "ExpiredToken" } } : { status: 200 }) });
  assert.equal((await deleteBlueskyThread(f.fetchFn, new Map(), LOGIN, [ROOT])).ok, true);
});

// ---------- Reddit ----------

test("reddit: POST /api/del with the fullname and a bearer token", async () => {
  const f = fakeFetch({ access_token: () => ({ status: 200, json: { access_token: "tok" } }), "api/del": () => ({ status: 200, json: {} }) });
  assert.equal((await deleteRedditThing(f.fetchFn, REDDIT, "t3_abc123")).ok, true);
  const del = f.calls.find((c) => c.url === "https://oauth.reddit.com/api/del")!;
  assert.equal(del.raw, "id=t3_abc123");
  assert.equal(del.headers?.Authorization, "bearer tok");
});

test("reddit: refusals and missing pieces fail without a delete call", async () => {
  const f = fakeFetch({ access_token: () => ({ status: 401 }), "api/del": () => ({ status: 200 }) });
  assert.deepEqual(await deleteRedditThing(f.fetchFn, REDDIT, "t3_abc123"), { ok: false, error: "Reddit token HTTP 401" });
  assert.equal((await deleteRedditThing(f.fetchFn, null, "t3_abc123")).ok, false);
  assert.equal((await deleteRedditThing(f.fetchFn, REDDIT, "garbage")).ok, false);
  const g = fakeFetch({ access_token: () => ({ status: 200, json: { access_token: "tok" } }), "api/del": () => ({ status: 403 }) });
  assert.deepEqual(await deleteRedditThing(g.fetchFn, REDDIT, "t1_xyz9"), { ok: false, error: "Reddit delete HTTP 403" });
});

test("reddit: comment fullname from its permalink", () => {
  assert.equal(redditCommentFullname("https://www.reddit.com/r/Baking/comments/1abcde/how_to_price/kx9z2/"), "t1_kx9z2");
  assert.equal(redditCommentFullname("https://www.reddit.com/r/Baking/comments/1abcde/how_to_price/"), undefined);
  assert.equal(redditCommentFullname("https://evil.example/r/a/comments/1abcde/x/kx9z2/"), undefined);
});

// ---------- the whole run: in-memory rows, applied the way undo.ts applies them ----------

function store(rows: PubRow[], post: { removedAt?: number; removedReason?: string; linkedinUrl?: string } = {}) {
  const db = { post: { ...post } as Record<string, unknown>, rows: new Map(rows.map((r) => [r._id, { ...r } as Record<string, unknown>])) };
  const deleted: string[] = [];
  const run = async (now: number, platform: (e: Entry) => Promise<{ ok: true; deleted: number; alreadyGone: number } | { ok: false; error: string }>) => {
    const plan = planPostRemoval(db.post as never, [...db.rows.values()] as never, "he asked on the call", now);
    Object.assign(db.post, plan.postPatch);
    for (const { id, patch } of plan.rowPatches) Object.assign(db.rows.get(id)!, patch);
    return runRemoval(plan.entries, {
      remove: async (e) => {
        deleted.push(e.id);
        return platform(e);
      },
      finish: async (e, outcome) => {
        const row = db.rows.get(e.id)!;
        if (row.status === "removing") Object.assign(row, finishPatch(e.step.previous, outcome, now));
      },
    });
  };
  return { db, run, deleted };
}

const OK = async () => ({ ok: true as const, deleted: 1, alreadyGone: 0 });

test("removePost: every platform sorted into removed / manual / waiting, post marked first", async () => {
  const s = store([
    { _id: "bs", platform: "bluesky", status: "posted", url: "https://bsky.app/p/1", records: [{ uri: ROOT, cid: "c" }] },
    { _id: "rd", platform: "reddit", status: "pending" },
    { _id: "li", platform: "linkedin", status: "posted", url: "https://www.linkedin.com/feed/update/urn:li:activity:1" },
    { _id: "fl", platform: "reddit", status: "posting", claimedAt: NOW },
  ]);
  const r = await s.run(NOW, OK);
  assert.equal(s.db.post.status, "removed");
  assert.equal(s.db.post.removedAt, NOW);
  assert.deepEqual(r.removed, ["bluesky https://bsky.app/p/1", "reddit"]);
  assert.deepEqual(r.manual, ["linkedin https://www.linkedin.com/feed/update/urn:li:activity:1"]);
  assert.equal(r.failed.length, 0);
  assert.equal(r.waiting.length, 1);
  assert.deepEqual(s.deleted, ["bs"], "only the posted Bluesky copy hits the platform");
  assert.equal(s.db.rows.get("fl")!.status, "posting", "in-flight row left alone");
  assert.equal(s.db.rows.get("li")!.status, "posted");
  assert.match(String(s.db.rows.get("li")!.error), /by hand/);
  assert.equal(summaryLine(r), "2 removed, 1 to remove by hand, 1 waiting");
});

test("removePost: running twice is safe (no second platform delete)", async () => {
  const s = store([{ _id: "bs", platform: "bluesky", status: "posted", records: [{ uri: ROOT, cid: "c" }] }]);
  await s.run(NOW, OK);
  const again = await s.run(NOW + 1000, OK);
  assert.deepEqual(again.removed, ["bluesky"]);
  assert.deepEqual(s.deleted, ["bs"]);
  assert.equal(s.db.post.removedAt, NOW, "first removedAt kept");
});

test("removePost: a failed delete goes back to its status, listed in failed; a retry finishes it", async () => {
  const s = store([{ _id: "bs", platform: "bluesky", status: "maybe_posted", records: [{ uri: ROOT, cid: "c" }] }]);
  const first = await s.run(NOW, async () => ({ ok: false, error: "Bluesky delete HTTP 502" }));
  assert.deepEqual(first.failed, ["bluesky: Bluesky delete HTTP 502"]);
  assert.equal(s.db.rows.get("bs")!.status, "maybe_posted");
  const second = await s.run(NOW + 1000, OK);
  assert.deepEqual(second.removed, ["bluesky"]);
  assert.equal(s.db.rows.get("bs")!.status, "removed");
});

test("removePost: once the in-flight post finishes, the next call removes it", async () => {
  const s = store([{ _id: "bs", platform: "bluesky", status: "posting", claimedAt: NOW }]);
  assert.equal((await s.run(NOW, OK)).waiting.length, 1);
  Object.assign(s.db.rows.get("bs")!, { status: "posted", records: [{ uri: ROOT, cid: "c" }], claimedAt: undefined }); // publish finished
  assert.deepEqual((await s.run(NOW + 5000, OK)).removed, ["bluesky"]);
  assert.deepEqual(s.deleted, ["bs"]);
});

test("removePost: an older post with only posts.linkedinUrl is manual", async () => {
  const s = store([], { linkedinUrl: "https://www.linkedin.com/feed/update/urn:li:activity:9" });
  assert.deepEqual((await s.run(NOW, OK)).manual, ["linkedin https://www.linkedin.com/feed/update/urn:li:activity:9"]);
});

test("runRemoval: a throwing platform call is a failure, never a crash", async () => {
  const r = await runRemoval([{ id: "x", platform: "bluesky", step: { kind: "delete", previous: "posted" }, uris: [ROOT] }], {
    remove: async () => {
      throw new Error("boom");
    },
    finish: async () => {},
  });
  assert.equal(r.failed.length, 1);
  assert.equal(summaryLine({ removed: [], failed: [], manual: [], waiting: [] }), "nothing to remove");
});

// ---------- replies ----------

test("reply steps: drafts never post, posted ones are deleted by uri or fullname, unknown id is manual", () => {
  assert.equal(replyStep({ platform: "bluesky", status: "draft" }, NOW).kind, "mark_removed");
  assert.equal(replyStep({ platform: "bluesky", status: "needs_review" }, NOW).kind, "mark_removed");
  assert.equal(replyStep({ platform: "bluesky", status: "posting", claimedAt: NOW }, NOW).kind, "wait");
  assert.equal(replyStep({ platform: "bluesky", status: "posted", postedUri: R2 }, NOW).kind, "delete");
  assert.deepEqual(replyDeleteTarget({ platform: "bluesky", postedUri: R2 }), { platform: "bluesky", uri: R2 });
  assert.deepEqual(replyDeleteTarget({ platform: "bluesky", threadRef: ROOT }), { platform: "bluesky", findUnder: ROOT });
  const url = "https://www.reddit.com/r/Baking/comments/1abcde/how_to_price/kx9z2/";
  assert.deepEqual(replyDeleteTarget({ platform: "reddit", postedUrl: url }), { platform: "reddit", fullname: "t1_kx9z2" });
  assert.equal(replyStep({ platform: "reddit", status: "posted" }, NOW).kind, "manual");
});

test("replies are never posted once taken down (the reply or its call's post), even with approve", () => {
  for (const status of ["draft", "failed", "needs_review", "maybe_posted"]) {
    assert.equal(canClaimReply({ status, removed: true }, NOW, true).ok, false);
  }
  assert.equal(canClaimReply({ status: "removed" }, NOW, true).ok, false);
  assert.equal(canClaimReply({ status: "removing" }, NOW, true).ok, false);
  assert.equal(canClaimReply({ status: "draft" }, NOW, false).ok, true, "untouched drafts still post");
});

test("reply language: the call's character language, else elders.language", () => {
  assert.equal(callLanguageOf({ characterId: "diana", language: "en-US" }), "es");
  assert.equal(callLanguageOf({ characterId: "daniel", language: "es-MX" }), "en");
  assert.equal(callLanguageOf({ language: "es-MX" }), "es");
  assert.equal(callLanguageOf(null), "en");
});

// ---------- which post is "that last post" ----------

const DAY = 86_400_000;
const cand = (id: string, callId: string, pubs: LatestCandidate["publications"], createdAt = NOW - DAY): LatestCandidate => ({
  postId: id,
  callId,
  createdAt,
  status: "published",
  publications: pubs,
});

test("removeLatest picks the newest post that went out, within 14 days", () => {
  const list = [
    cand("old", "c1", [{ status: "posted", postedAt: NOW - 8 * DAY }]),
    cand("new", "c2", [{ status: "posted", postedAt: NOW - 1 * DAY }, { status: "failed" }]),
    cand("never", "c3", [{ status: "failed" }, { status: "pending" }], NOW - 1000),
    cand("ancient", "c0", [{ status: "posted", postedAt: NOW - 20 * DAY }]),
  ];
  assert.equal(pickLatestPost(list, NOW)?.postId, "new");
  assert.equal(pickLatestPost([list[3]], NOW), null, "older than 14 days");
  assert.equal(pickLatestPost([list[2]], NOW), null, "never went out");
});

test("removeLatest from a call: never that call's post, never a post newer than the call", () => {
  const list = [
    cand("lastWeek", "c1", [{ status: "posted", postedAt: NOW - 7 * DAY }]),
    cand("thisCall", "c2", [{ status: "posting" }], NOW - 1000),
    cand("later", "c3", [{ status: "posted", postedAt: NOW - 1000 }]),
  ];
  assert.equal(pickLatestPost(list, NOW, { askedOn: { callId: "c2", endedAt: NOW - 2 * DAY } })?.postId, "lastWeek");
});

test("removeLatest: an already-removed newest post is picked again (never reaches back to an older one)", () => {
  const list = [
    cand("older", "c1", [{ status: "posted", postedAt: NOW - 5 * DAY }]),
    cand("removed", "c2", [{ status: "removed", postedAt: NOW - DAY }]),
  ];
  assert.equal(pickLatestPost(list, NOW)?.postId, "removed");
  assert.equal(pickLatestPost([cand("m", "c4", [{ status: "maybe_posted" }])], NOW)?.postId, "m");
});

// ---------- /posts helper ----------

test("postUndoInfo: undo command while it's up; status once taken down", () => {
  assert.equal(undoCommand("p1"), `npx convex run undo:removePost '{"postId":"p1"}'`);
  const up = postUndoInfo({ _id: "p1" }, [{ platform: "bluesky", status: "posted" }]);
  assert.equal(up.command, undoCommand("p1"));
  assert.match(up.status, /^Up/);
  const removedAt = Date.parse("2026-10-20T15:30:00Z");
  const down = postUndoInfo({ _id: "p1", removedAt, removedReason: "he asked on the call" }, [{ platform: "bluesky", status: "removed" }]);
  assert.deepEqual(down, { status: "Taken down 2026-10-20 15:30 UTC (he asked on the call)." });
  const partial = postUndoInfo({ _id: "p1", removedAt }, [
    { platform: "bluesky", status: "removed" },
    { platform: "linkedin", status: "posted", url: "https://www.linkedin.com/x" },
  ]);
  assert.match(partial.status, /linkedin: remove by hand https:\/\/www\.linkedin\.com\/x/);
  assert.equal(partial.command, undoCommand("p1"));
});

test("prompts: every character and the inbound agent carry the take-down rule", async () => {
  const { characterAgent } = await import("../convex/lib/prompts/agent.ts");
  const { inboundAgent } = await import("../convex/lib/prompts/inbound.ts");
  const { CHARACTERS } = await import("../convex/lib/characters.ts");
  for (const c of CHARACTERS) {
    const text = characterAgent(c).instructions;
    assert.ok(text.includes(TAKE_DOWN_LINE[c.language]), c.id);
    assert.match(text, /never argue/);
  }
  const inbound = inboundAgent().instructions;
  assert.ok(inbound.includes(TAKE_DOWN_LINE.en) && inbound.includes(TAKE_DOWN_LINE.es));
  assert.match(inbound, /never take anything down for an unknown caller/);
});

// ---------- review fixes: rows that went out partly, stale rows, retries, claims ----------

test("a half-posted thread (failed, but with records) is deleted, not just marked removed", async () => {
  assert.deepEqual(publicationStep({ platform: "bluesky", status: "failed", records: [{ uri: ROOT }] }, NOW), { kind: "delete", previous: "failed" });
  assert.deepEqual(publicationStep({ platform: "reddit", status: "failed", externalId: "t3_abc123" }, NOW), { kind: "delete", previous: "failed" });
  assert.deepEqual(publicationStep({ platform: "bluesky", status: "failed" }, NOW), { kind: "mark_removed" });
  const s = store([{ _id: "bs", platform: "bluesky", status: "failed", records: [{ uri: ROOT, cid: "c" }, { uri: R2, cid: "c2" }] }]);
  let uris: string[] = [];
  const r = await s.run(NOW, async (e) => {
    uris = e.uris ?? [];
    return { ok: true, deleted: 2, alreadyGone: 0 };
  });
  assert.deepEqual(s.deleted, ["bs"]);
  assert.deepEqual(uris, [ROOT, R2]);
  assert.equal(s.db.rows.get("bs")!.status, "removed");
  assert.deepEqual(r.removed, ["bluesky"]);
  // A failed delete puts it back to "failed", records kept, so a retry deletes it.
  const t = store([{ _id: "bs", platform: "bluesky", status: "failed", records: [{ uri: ROOT, cid: "c" }] }]);
  await t.run(NOW, async () => ({ ok: false, error: "Bluesky delete HTTP 500" }));
  assert.equal(t.db.rows.get("bs")!.status, "failed");
});

test("a stale posting row (> 15 min) is deleted when it has records, else listed as manual", () => {
  const old = NOW - STALE_REMOVE_MS - 1;
  assert.equal(publicationStep({ platform: "bluesky", status: "posting", claimedAt: NOW - 60_000, records: [{ uri: ROOT }] }, NOW).kind, "wait");
  assert.deepEqual(publicationStep({ platform: "bluesky", status: "posting", claimedAt: old, records: [{ uri: ROOT }] }, NOW), { kind: "delete", previous: "maybe_posted" });
  assert.deepEqual(publicationStep({ platform: "bluesky", status: "posting", claimedAt: old }, NOW), { kind: "manual", note: STUCK_NOTE });
  assert.deepEqual(claimPatch({ kind: "manual", note: STUCK_NOTE }, NOW), { error: STUCK_NOTE });
});

test("Threads / X rows with records are deleted; without ids they're manual or simply removed", () => {
  const records = [{ uri: "p1", cid: "" }, { uri: "p2", cid: "" }];
  const old = NOW - STALE_REMOVE_MS - 1;
  for (const platform of ["threads", "x"]) {
    // something went out: delete it by its ids, whatever the status
    for (const status of ["posted", "maybe_posted", "failed"]) {
      assert.deepEqual(publicationStep({ platform, status, records }, NOW), { kind: "delete", previous: status }, `${platform} ${status}`);
    }
    assert.deepEqual(publicationStep({ platform, status: "posting", claimedAt: old, records }, NOW), { kind: "delete", previous: "maybe_posted" });
    assert.equal(publicationStep({ platform, status: "posting", claimedAt: NOW - 1000, records }, NOW).kind, "wait");
    // never went out
    for (const status of ["pending", "failed", "skipped"]) {
      assert.equal(publicationStep({ platform, status }, NOW).kind, "mark_removed", `${platform} ${status}`);
    }
    // went out (or may have) with no ids: a person checks
    for (const status of ["posted", "maybe_posted"]) {
      const step = publicationStep({ platform, status }, NOW);
      assert.equal(step.kind, "manual");
      assert.equal(step.kind === "manual" && step.note, noIdsNote(platform));
    }
    assert.equal(publicationStep({ platform, status: "posting", claimedAt: old }, NOW).kind, "manual");
    assert.equal(publicationStep({ platform, status: "removed" }, NOW).kind, "already_removed");
    assert.equal(pubHasCopy({ platform, records }), true);
  }
  assert.match(noIdsNote("x"), /X profile/);
  const plan = planPostRemoval({}, [{ _id: "th", platform: "threads", status: "posted", records }], undefined, NOW);
  assert.deepEqual(plan.entries[0].uris, ["p1", "p2"]);
  assert.equal(plan.entries[0].claimedAt, NOW);
});

test("deleteCopy: each platform gets its own delete, with the row's ids", async () => {
  const calls: string[] = [];
  const ok = { ok: true as const, deleted: 1, alreadyGone: 0 };
  const deletes = {
    bluesky: async (uris: string[]) => (calls.push(`bluesky:${uris.join(",")}`), ok),
    threads: async (ids: string[]) => (calls.push(`threads:${ids.join(",")}`), ok),
    x: async (ids: string[]) => (calls.push(`x:${ids.join(",")}`), ok),
    reddit: async (fullname: string | undefined) => (calls.push(`reddit:${fullname}`), ok),
  };
  await deleteCopy({ platform: "bluesky", uris: [ROOT] }, deletes);
  await deleteCopy({ platform: "threads", uris: ["p1", "p2"] }, deletes);
  await deleteCopy({ platform: "x", uris: ["100", "101"], externalId: "100" }, deletes);
  await deleteCopy({ platform: "reddit", externalId: "t3_abc" }, deletes);
  assert.deepEqual(calls, [`bluesky:${ROOT}`, "threads:p1,p2", "x:100,101", "reddit:t3_abc"]);
  const linkedin = await deleteCopy({ platform: "linkedin" }, deletes);
  assert.equal(linkedin.ok, false);
  assert.equal(calls.length, 4);
});

test("finish applies only to this run's claim", () => {
  assert.equal(ownsClaim({ status: "removing", claimedAt: NOW }, NOW), true);
  assert.equal(ownsClaim({ status: "removing", claimedAt: NOW + 5 }, NOW), false, "retaken by another run");
  assert.equal(ownsClaim({ status: "removed", claimedAt: NOW }, NOW), false);
  assert.equal(ownsClaim({ status: "removing", claimedAt: NOW }, undefined), false);
  const plan = planPostRemoval({}, [{ _id: "bs", platform: "bluesky", status: "posted", records: [{ uri: ROOT, cid: "c" }] }], "x", NOW);
  assert.equal(plan.entries[0].claimedAt, NOW);
});

test("retries: failed or waiting runs again with backoff, 3 tries in all", () => {
  const done = { removed: ["bluesky"], failed: [], manual: ["linkedin"], waiting: [] };
  assert.equal(retryDelay(done, 1), null, "nothing left to retry (manual isn't retried)");
  const failed = { ...done, failed: ["bluesky: HTTP 500"] };
  assert.equal(retryDelay(failed, 1), 60_000);
  assert.ok(retryDelay(failed, 2)! > STALE_REMOVE_MS, "the last try is past the stale window");
  assert.equal(retryDelay(failed, 3), null);
  assert.equal(retryDelay({ ...done, waiting: ["bluesky (in flight)"] }, 1), 60_000);
});

test("removeLatest: a removed post counts at its creation time; a post held on its own call doesn't", () => {
  const removedByFamily = { ...cand("fam", "c2", [{ status: "removed" }], NOW - DAY), removedAt: NOW - DAY / 2, removedReason: "family request" };
  const older = cand("older", "c1", [{ status: "posted", postedAt: NOW - 5 * DAY }]);
  assert.equal(pickLatestPost([older, removedByFamily], NOW)?.postId, "fam");
  const held = { ...cand("held", "c3", [{ status: "removed" }], NOW - DAY), removedAt: NOW - DAY, removedReason: HOLD_REASON };
  assert.equal(pickLatestPost([older, held], NOW)?.postId, "older", "never went out: not 'that last post'");
  // A half-posted thread (failed with records) went out.
  const partial = cand("partial", "c4", [{ status: "failed", hasCopy: true }], NOW - 2 * DAY);
  assert.equal(pickLatestPost([older, partial], NOW)?.postId, "partial");
});

test("bluesky: only post records are deleted (collection checked)", async () => {
  const f = fakeFetch({ createSession: SESSION, deleteRecord: () => ({ status: 200 }) });
  const out = await deleteBlueskyThread(f.fetchFn, new Map(), LOGIN, ["at://did:plc:him/app.bsky.actor.profile/self"]);
  assert.equal(out.ok, false);
  assert.equal(f.deletes().length, 0);
});

// ---------- the phone: spotting a take-down ----------

const pip = (text: string) => ({ role: "pip", text });
const him = (text: string) => ({ role: "elder", text });
const said = (l: string) => l.replace(/"/g, "");

test("transcript: Pip's exact take-down line right after he asks is the trigger (both languages)", () => {
  assert.deepEqual(detectTakeDown([him("Can you take that post down?"), pip(said(TAKE_DOWN_LINE.en))]), { asked: true, how: "line" });
  assert.deepEqual(detectTakeDown([him("¿Puede borrar la publicación?"), pip(said(TAKE_DOWN_LINE.es))]), { asked: true, how: "line" });
  // Vague wording is fine once Pip said the line; Pip may drop "Of course." or say more.
  const more = "I'll have your most recent post taken down right after our call! Now, where were we?";
  assert.deepEqual(detectTakeDown([him("That thing you put up last week, take it down."), pip(more)]), { asked: true, how: "line" });
  assert.deepEqual(detectTakeDown([him("Quítela, por favor."), pip(said(TAKE_DOWN_LINE.es))]), { asked: true, how: "line" });
  assert.deepEqual(detectTakeDown([him("¿No me borra la publicación de la semana pasada?"), pip(said(TAKE_DOWN_LINE.es))]), { asked: true, how: "line" });
  // One turn of his in between ("yes") is still right after.
  assert.equal(detectTakeDown([him("Take it down, would you?"), pip("Your most recent one?"), him("Yes."), pip(said(TAKE_DOWN_LINE.en))]).asked, true);
});

test("transcript: Pip's line doesn't count without a request right before it", () => {
  assert.equal(detectTakeDown([him("We talked about the bridge."), pip(said(TAKE_DOWN_LINE.en))]).asked, false);
  const farBack = [him("Delete it."), pip("Mm."), him("Anyway."), pip("Go on."), him("The bridge."), pip(said(TAKE_DOWN_LINE.en))];
  assert.equal(detectTakeDown(farBack).asked, false, "too far back");
  // The old loose path: vague wording + any commitment from Pip is no longer enough.
  assert.equal(detectTakeDown([him("We had to pull the old shingles off."), pip("Well, we're all done for today.")]).asked, false);
  assert.equal(detectTakeDown([him("That thing you put up last week, take it down."), pip("Of course, I'll take care of it.")]).asked, false);
});

test("transcript: these are not requests (review examples)", () => {
  for (const text of [
    "Borré las historias clínicas viejas.",
    "Bajé la historia del periódico al archivo.",
    "Retiramos el post de la cerca.",
    "No quiero que quite la publicación.",
    "Take down that story, he said.",
    "Can you delete posts?",
    "Take down the post on the wall.",
    "We had to take the post down before the concrete set.",
    "In '72 we had to remove the posts from the old fence.",
    "My grandson said don't take that post down, he loved it.",
    "No la borre, por favor, me gustó la publicación.",
    "We had to pull the old shingles off.",
    "It was quite a day.",
  ]) {
    assert.deepEqual(detectTakeDown([pip("How are you?"), him(text), pip("Mm, go on.")]), { asked: false }, text);
  }
});

test("transcript: a clear request in his words, without Pip's line, only holds (nothing deleted)", () => {
  for (const text of [
    "Pip, please take down that last post.",
    "Oh, and can you take my story about the bridge down?",
    "Could you delete the post from last week",
    "I'd like that post taken down.",
    "I don't want that story up anymore.",
    "Please delete that story, I shouldn't have told you.",
    "Juanito, ¿puede borrar la publicación de la semana pasada?",
    "Por favor quite esa publicación.",
    "Ya no quiero esa publicación.",
  ]) {
    assert.deepEqual(detectTakeDown([pip("How are you?"), him(text), pip("Mm.")]), { asked: true, how: "unconfirmed" }, text);
  }
});

test("transcript: today's story only: Pip's today line holds this call's post", () => {
  assert.deepEqual(detectTakeDown([him("Please don't post that, I shouldn't have told you."), pip(said(TODAY_LINE.en))]), { asked: true, how: "today" });
  assert.deepEqual(detectTakeDown([him("Por favor no la publique."), pip(said(TODAY_LINE.es))]), { asked: true, how: "today" });
});

test("transcript: second thoughts cancel (his words or Pip's keep-up line)", () => {
  const asked = [him("Please take down that last post."), pip(said(TAKE_DOWN_LINE.en))];
  for (const text of ["Actually I changed my mind.", "No, keep it.", "Leave it up, please.", "Never mind.", "Cambié de opinión.", "Mejor déjela.", "No la quite."]) {
    assert.equal(detectTakeDown([...asked, him(text)]).asked, false, text);
  }
  assert.equal(detectTakeDown([...asked, him("Hmm."), pip(said(KEEP_UP_LINE.en))]).asked, false);
  const es = [him("Por favor borre la última publicación."), pip(said(TAKE_DOWN_LINE.es)), him("..."), pip(said(KEEP_UP_LINE.es))];
  assert.equal(detectTakeDown(es).asked, false);
  assert.equal(detectTakeDown([him("Can you take down the post?"), pip("Of course."), him("Hmm."), pip(said(KEEP_UP_LINE.en))]).asked, false);
  // Asking again after a change of mind counts again.
  const again = [...asked, him("Never mind."), pip("Okay."), him("No, really, take that post down."), pip(said(TAKE_DOWN_LINE.en))];
  assert.deepEqual(detectTakeDown(again), { asked: true, how: "line" });
  assert.equal(detectTakeDown([]).asked, false);
});

test("prompts: one strict take-down rule, no 'which one' question", async () => {
  const { characterAgent } = await import("../convex/lib/prompts/agent.ts");
  const { CHARACTERS } = await import("../convex/lib/characters.ts");
  for (const c of CHARACTERS) {
    const text = characterAgent(c).instructions;
    assert.ok(text.includes(TODAY_LINE[c.language]) && text.includes(KEEP_UP_LINE[c.language]), c.id);
    assert.match(text, /don't ask which one/);
    assert.match(text, /most recent post/);
    assert.match(text, /Say it once, and only right after they clearly asked/);
    assert.doesNotMatch(text, /The one about the bridge job/);
  }
});
