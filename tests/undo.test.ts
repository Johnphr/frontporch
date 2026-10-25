// Undo (lib/undo.ts, lib/blueskyDelete.ts): fake fetch, in-memory rows; no network.
import { test } from "node:test";
import assert from "node:assert/strict";

import type { FetchFn } from "../convex/lib/blueskyClient.ts";
import { blueskyDeleteOrder, deleteBlueskyThread } from "../convex/lib/blueskyDelete.ts";
import { TAKE_DOWN_LINE, KEEP_UP_LINE } from "../convex/lib/prompts/principles.ts";
import { canClaimReply, callLanguageOf } from "../convex/lib/threadReplies.ts";
import {
  STALE_REMOVE_MS,
  claimPatch,
  deleteRedditThing,
  detectTakeDown,
  finishPatch,
  pickLatestPost,
  planPostRemoval,
  postRemovalPatch,
  postUndoInfo,
  publicationStep,
  redditCommentFullname,
  replyDeleteTarget,
  replyStep,
  runRemoval,
  summaryLine,
  undoCommand,
  type Entry,
  type LatestCandidate,
  type PubRow,
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
  assert.equal(callLanguageOf({ characterId: "juanito", language: "en-US" }), "es");
  assert.equal(callLanguageOf({ characterId: "pip", language: "es-MX" }), "en");
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

// ---------- the phone: spotting a take-down request ----------

const pip = (text: string) => ({ role: "pip", text });
const him = (text: string) => ({ role: "elder", text });

test("transcript: a clear request is enough", () => {
  for (const text of [
    "Pip, please take down that last post.",
    "Oh, and can you take my story about the bridge down?",
    "Could you delete the post from last week",
    "I'd like that post taken down.",
    "I don't want that story up anymore.",
    "Juanito, ¿puede borrar la publicación de la semana pasada?",
    "Por favor quite esa publicación.",
    "Ya no quiero esa publicación.",
  ]) {
    assert.deepEqual(detectTakeDown([pip("How are you?"), him(text)]), { asked: true, how: "clear" }, text);
  }
});

test("transcript: a vague request counts once Pip commits to it", () => {
  const en = [him("That thing you put up last week, take it down."), pip("The one about the bridge job?"), him("Yes."), pip(`Of course. I'll have it taken down right after our call.`)];
  assert.deepEqual(detectTakeDown(en), { asked: true, how: "confirmed" });
  const es = [him("Lo que subieron, ¿me lo puede quitar?"), pip("Claro que sí. La quitamos en cuanto colguemos.")];
  assert.equal(detectTakeDown(es).asked, true);
  assert.equal(detectTakeDown([him("Take it down."), pip("Oh? Tell me more.")]).asked, false, "no commitment, no take-down");
});

test("transcript: stories, refusals and second thoughts don't count", () => {
  assert.equal(detectTakeDown([him("We had to take the post down before the concrete set."), pip("Wow, what happened next?")]).asked, false);
  assert.equal(detectTakeDown([him("In '72 we had to remove the posts from the old fence."), pip("Mm, go on.")]).asked, false);
  assert.equal(detectTakeDown([him("My grandson said don't take that post down, he loved it.")]).asked, false);
  assert.equal(detectTakeDown([him("No la borre, por favor, me gustó la publicación.")]).asked, false);
  const changed = [him("Please take down that last post."), pip(TAKE_DOWN_LINE.en.replace(/"/g, "")), him("Actually, never mind, leave it up."), pip(KEEP_UP_LINE.en.replace(/"/g, ""))];
  assert.equal(detectTakeDown(changed).asked, false);
  const viaPip = [him("Can you take down the post?"), pip("Of course."), him("Hmm."), pip("No problem, I'll leave it up.")];
  assert.equal(detectTakeDown(viaPip).asked, false);
  assert.equal(detectTakeDown([]).asked, false);
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

test("transcript: the prompt's own lines (both languages) are what detection listens for", () => {
  const vague = { en: "Take it down, would you?", es: "Quítela, por favor." } as const;
  const clear = { en: "Please take down that last post.", es: "Por favor borre la última publicación." } as const;
  for (const lang of ["en", "es"] as const) {
    const line = (l: string) => l.replace(/"/g, "");
    assert.equal(detectTakeDown([him(vague[lang]), pip(line(TAKE_DOWN_LINE[lang]))]).asked, true, lang);
    assert.equal(detectTakeDown([him(clear[lang]), pip(line(TAKE_DOWN_LINE[lang])), him("..."), pip(line(KEEP_UP_LINE[lang]))]).asked, false, lang);
  }
  assert.equal(detectTakeDown([him("¿No me borra la publicación de la semana pasada?")]).asked, true, "polite Spanish question");
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
