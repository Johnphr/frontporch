// Undo: taking a post (and its thread replies) back down. Pure rules, no Convex imports;
// unit-tested in tests/undo.test.ts. convex/undo.ts wires them to the database.
//
// Order of work for one post:
//   1. posts.removedAt (+ reason, status "removed") first, so publishing never sends it again.
//   2. each postPublications row:
//        has a live copy (Bluesky / Threads / X records, Reddit fullname), whatever its status ("failed"
//        included: a thread that stopped halfway)
//                                    -> claim as `removing`, delete on the platform, then removed
//                                       (on failure: back to its status + short error)
//        pending / failed / skipped, no copy -> removed (it never went out)
//        posting (in flight)         -> left alone; publish re-checks removedAt and calls us again.
//                                       Stale (> 15 min, crashed): deleted as maybe_posted if it
//                                       has a copy, else "manual" (check his profile by hand)
//        removing (another run)      -> left alone, unless that claim is stale (crashed run)
//        removed                     -> nothing to do (running twice is safe)
//        linkedin                    -> no delete through LinkedAPI: "manual" once it went out
//        threads, x                  -> deleted by the ids in records; went out (or may have)
//                                       with no ids saved -> "manual"
//   After a manual removal: undo:markRemovedByHand.
// Never log post text, reply text, tokens or passwords.

import type { DeleteOutcome } from "./blueskyDelete.ts";
import type { FetchFn } from "./blueskyClient.ts";
import { recoverThreadRecords, type ListedPost } from "./blueskyThread.ts";
import type { RedditLogin } from "./logins.ts";
import { KEEP_UP_LINE, TAKE_DOWN_LINE, TODAY_LINE } from "./prompts/principles.ts";
import { redditToken } from "./replyPosting.ts";

export type Platform = "bluesky" | "reddit" | "linkedin" | "threads" | "x";

/** A claim older than this is assumed crashed and can be retaken. */
export const STALE_REMOVE_MS = 15 * 60_000;

/** "Take down that last post" looks this far back. */
export const LATEST_WINDOW_MS = 14 * 86_400_000;

export const DEFAULT_REASON = "take-down request";
export const CALL_REASON = "he asked on the call";
/** This call's own post, stopped because of a take-down on the same call. */
export const HOLD_REASON = "held: he asked on this call";
export const HOLD_UNSURE_REASON = "held: he may have asked to take a post down (check with him)";

// ---------- one row: what to do ----------

/** What a failed delete puts the row back to. */
export type RestoreStatus = "posted" | "maybe_posted" | "failed" | "pending" | "skipped" | "draft" | "needs_review";

export type Step =
  | { kind: "already_removed" }
  | { kind: "mark_removed" } // never went out
  | { kind: "wait"; reason: string } // in flight; someone calls us again
  | { kind: "manual"; note?: string } // no delete here: a person removes it by hand
  | { kind: "delete"; previous: RestoreStatus };

const NEVER_POSTED_PUB = ["pending", "failed", "skipped"];
const NEVER_POSTED_REPLY = ["draft", "needs_review", "failed"];

export const STUCK_NOTE = "Stuck while posting, with no post id saved: check his profile and remove it by hand.";

function stepFor(
  row: { status: string; claimedAt?: number },
  now: number,
  neverPosted: string[],
  canDelete: boolean, // we have a delete for this platform
  hasCopy: boolean, // ids of something that went out (Bluesky records, Reddit fullname, reply uri)
): Step {
  const s = row.status;
  const stale = row.claimedAt === undefined || now - row.claimedAt > STALE_REMOVE_MS;
  if (s === "removed") return { kind: "already_removed" };
  if (neverPosted.includes(s)) {
    // A thread that stopped halfway is "failed", but some of it is live.
    if (hasCopy) return canDelete ? { kind: "delete", previous: s as RestoreStatus } : { kind: "manual" };
    return { kind: "mark_removed" };
  }
  if (s === "posting") {
    if (!stale) return { kind: "wait", reason: "still being posted; it's taken down once that finishes" };
    if (hasCopy && canDelete) return { kind: "delete", previous: "maybe_posted" };
    return { kind: "manual", note: STUCK_NOTE };
  }
  if (s === "removing") {
    if (!stale) return { kind: "wait", reason: "already being taken down" };
    // A crashed undo run: we don't know if it went, so treat it as "maybe posted".
    return canDelete ? { kind: "delete", previous: "maybe_posted" } : { kind: "manual" };
  }
  if (s === "posted" || s === "maybe_posted") return canDelete ? { kind: "delete", previous: s } : { kind: "manual" };
  return { kind: "wait", reason: `unknown status ${s}` };
}

/** Platforms whose rows keep every post id in records (and that we can delete by them). */
const RECORD_PLATFORMS = new Set(["bluesky", "threads", "x"]);

/** Does this row hold ids of something that went out? */
export function pubHasCopy(row: { platform: string; records?: unknown[]; externalId?: string }): boolean {
  if (RECORD_PLATFORMS.has(row.platform)) return Boolean(row.records?.length);
  if (row.platform === "reddit") return isRedditFullname(row.externalId);
  return false;
}

/** One delete per platform (undo.ts fills these in with his logins). */
export type PlatformDeletes = {
  bluesky(uris: string[]): Promise<DeleteOutcome>;
  threads(ids: string[]): Promise<DeleteOutcome>;
  x(ids: string[]): Promise<DeleteOutcome>;
  reddit(fullname: string | undefined): Promise<DeleteOutcome>;
};

/** Route one copy to its platform's delete: records' ids for Bluesky / Threads / X, the fullname for Reddit. */
export function deleteCopy(e: { platform: Platform; uris?: string[]; externalId?: string }, d: PlatformDeletes): Promise<DeleteOutcome> {
  switch (e.platform) {
    case "bluesky":
      return d.bluesky(e.uris ?? []);
    case "threads":
      return d.threads(e.uris ?? []);
    case "x":
      return d.x(e.uris ?? []);
    case "reddit":
      return d.reddit(e.externalId);
    default:
      return Promise.resolve({ ok: false, error: `No delete for ${e.platform}.` });
  }
}

/** Threads / X: it went out (or may have) but the row has no post ids to delete by. */
export function noIdsNote(platform: string): string {
  const name = platform === "x" ? "X" : platform === "threads" ? "Threads" : platform;
  return `No ${name} post ids saved: check his ${name} profile, remove it by hand, then run undo:markRemovedByHand.`;
}

/**
 * One postPublications row. Bluesky and Reddit: deleted by their ids. Threads and X: deleted
 * by the ids in records; without them it's manual (we can't tell what went out). LinkedIn: a
 * row that never went out is removed, else manual. Unknown platforms: manual.
 */
export function publicationStep(
  row: { platform: string; status: string; claimedAt?: number; records?: unknown[]; externalId?: string },
  now: number,
): Step {
  if (row.platform === "linkedin") return stepFor(row, now, NEVER_POSTED_PUB, false, false);
  if (row.platform === "threads" || row.platform === "x") {
    const hasCopy = pubHasCopy(row);
    const step = stepFor(row, now, NEVER_POSTED_PUB, hasCopy, hasCopy);
    return step.kind === "manual" && !step.note ? { kind: "manual", note: noIdsNote(row.platform) } : step;
  }
  if (row.platform !== "bluesky" && row.platform !== "reddit") {
    if (row.status === "removed") return { kind: "already_removed" };
    return { kind: "manual", note: `No delete for ${row.platform} yet: remove it by hand, then run undo:markRemovedByHand.` };
  }
  return stepFor(row, now, NEVER_POSTED_PUB, true, pubHasCopy(row));
}

/** Where to delete a thread reply: its Bluesky uri (or "find his reply under threadRef"), or its Reddit fullname. */
export type ReplyTarget =
  | { platform: "bluesky"; uri: string }
  | { platform: "bluesky"; findUnder: string } // older rows without postedUri
  | { platform: "reddit"; fullname: string };

export function replyDeleteTarget(reply: { platform: string; postedUri?: string; postedUrl?: string; threadRef?: string }): ReplyTarget | null {
  if (reply.platform === "bluesky") {
    if (reply.postedUri) return { platform: "bluesky", uri: reply.postedUri };
    if (reply.threadRef) return { platform: "bluesky", findUnder: reply.threadRef };
    return null;
  }
  if (reply.platform === "reddit") {
    const fullname = redditCommentFullname(reply.postedUrl);
    return fullname ? { platform: "reddit", fullname } : null;
  }
  return null;
}

/** One threadReplies row. Without a delete target (unknown Reddit comment id) it's manual. */
export function replyStep(
  reply: { platform: string; status: string; claimedAt?: number; postedUri?: string; postedUrl?: string; threadRef?: string },
  now: number,
): Step {
  const target = replyDeleteTarget(reply);
  const hasCopy = Boolean(reply.postedUri) || (target !== null && "fullname" in target);
  return stepFor(reply, now, NEVER_POSTED_REPLY, target !== null, hasCopy);
}

// ---------- patches ----------

/** posts patch: keeps the first removedAt and reason (a second request changes nothing). */
export function postRemovalPatch(post: { removedAt?: number; removedReason?: string }, reason: string | undefined, now: number) {
  return {
    removedAt: post.removedAt ?? now,
    removedReason: post.removedReason ?? cleanReason(reason),
    status: "removed",
  };
}

/** Short, single-line reason (it's shown on /posts). */
export function cleanReason(reason: string | undefined): string {
  const r = (reason ?? "").replace(/\s+/g, " ").trim();
  return r ? r.slice(0, 120) : DEFAULT_REASON;
}

export const MANUAL_NOTE = "No delete through LinkedAPI: remove it by hand, then run undo:markRemovedByHand.";
export const MANUAL_REPLY_NOTE = "No id to delete it by: remove it by hand on the thread.";

/** Row patch at claim time (null = leave the row as it is). */
export function claimPatch(step: Step, now: number, manualNote = MANUAL_NOTE): Record<string, unknown> | null {
  switch (step.kind) {
    case "mark_removed":
      return { status: "removed", removedAt: now, claimedAt: undefined };
    case "delete":
      return { status: "removing", claimedAt: now };
    case "manual":
      return { error: step.note ?? manualNote };
    default:
      return null;
  }
}

/** A delete's outcome; `manual`: we couldn't find what to delete, a person checks (not retried). */
export type RemoveOutcome = DeleteOutcome | { ok: false; error: string; manual: true };

/** Row patch after the platform delete. */
export function finishPatch(previous: RestoreStatus, outcome: RemoveOutcome, now: number): Record<string, unknown> {
  if (outcome.ok) return { status: "removed", removedAt: now, claimedAt: undefined, error: undefined };
  if ("manual" in outcome) return { status: previous, claimedAt: undefined, error: outcome.error.slice(0, 200) };
  return { status: previous, claimedAt: undefined, error: `Take-down failed: ${outcome.error}`.slice(0, 200) };
}

export const BLUESKY_NOT_FOUND_NOTE =
  "May have gone out with no Bluesky post ids saved, and it isn't in his recent posts: check his profile, remove it by hand, then run undo:markRemovedByHand.";

/**
 * A Bluesky row that went out (or may have) with no records saved: look in his repo for the
 * thread (lib/blueskyThread.recoverThreadRecords, only posts made after `since` = the row's
 * creation), and delete what's there. Nothing found -> manual (check his profile).
 */
export async function deleteUnsavedBluesky(
  d: { list(): Promise<ListedPost[]>; remove(uris: string[]): Promise<DeleteOutcome> },
  texts: string[] | undefined,
  since: number | undefined,
): Promise<RemoveOutcome> {
  if (!texts?.length) return { ok: false, error: BLUESKY_NOT_FOUND_NOTE, manual: true };
  let listed: ListedPost[];
  try {
    listed = await d.list();
  } catch {
    return { ok: false, error: "Couldn't read his Bluesky posts to look for it." };
  }
  const found = recoverThreadRecords(listed, texts, [], since);
  if (!found.length) return { ok: false, error: BLUESKY_NOT_FOUND_NOTE, manual: true };
  return d.remove(found.map((r) => r.uri));
}

/** Needs the repo lookup above: a Bluesky delete with no post ids. */
export function needsBlueskyLookup(e: { platform: string; step: Step; uris?: string[] }): boolean {
  return e.platform === "bluesky" && e.step.kind === "delete" && !e.uris?.length;
}

/** A finish only applies to the claim this run made (a stale claim may have been retaken). */
export function ownsClaim(row: { status: string; claimedAt?: number }, claimedAt: number | undefined): boolean {
  return row.status === "removing" && claimedAt !== undefined && row.claimedAt === claimedAt;
}

// ---------- the run ----------

/** What the claim mutation hands the action, per platform row. */
export type Entry = {
  id: string; // postPublications id ("" for a legacy LinkedIn link without a row)
  platform: Platform;
  url?: string;
  step: Step;
  uris?: string[]; // Bluesky / Threads / X: every post of the thread, root first
  externalId?: string; // Reddit fullname
  claimedAt?: number; // delete steps: the claim this run made
  since?: number; // Bluesky delete with no ids: the row's creation (look in his repo after it)
};

/** removed: taken down (now or earlier); cleared: never went out, marked removed. */
export type RemovalResult = { removed: string[]; cleared: string[]; failed: string[]; manual: string[]; waiting: string[] };

export const EMPTY_RESULT: RemovalResult = { removed: [], cleared: [], failed: [], manual: [], waiting: [] };

export function mergeResults(a: RemovalResult, b: RemovalResult): RemovalResult {
  return {
    removed: [...a.removed, ...b.removed],
    cleared: [...(a.cleared ?? []), ...(b.cleared ?? [])],
    failed: [...a.failed, ...b.failed],
    manual: [...a.manual, ...b.manual],
    waiting: [...a.waiting, ...b.waiting],
  };
}

/** An already-removed row: did something of it go out (ids, or a LinkedIn link)? */
function wentOutBefore(e: Entry): boolean {
  return Boolean(e.uris?.length || e.externalId || (e.platform === "linkedin" && e.url));
}

function label(e: { platform: string; url?: string }): string {
  return e.url ? `${e.platform} ${e.url}` : e.platform;
}

export type RunDeps = {
  /** Delete on the platform (only called for "delete" entries). */
  remove(entry: Entry): Promise<RemoveOutcome>;
  /** Record the outcome on the row. */
  finish(entry: Entry & { step: { kind: "delete"; previous: RestoreStatus } }, outcome: RemoveOutcome): Promise<void>;
};

/**
 * Delete what was claimed and sort every row into the result:
 *   removed  taken down (now or earlier)
 *   cleared  never went out: marked removed, nothing to delete
 *   failed   the platform delete failed; the row is back to its previous status
 *   manual   a person has to remove it by hand (LinkedIn, no id to delete by, or not found)
 *   waiting  in flight; removed when that finishes
 */
export async function runRemoval(entries: Entry[], deps: RunDeps): Promise<RemovalResult> {
  const out: RemovalResult = { removed: [], cleared: [], failed: [], manual: [], waiting: [] };
  for (const e of entries) {
    const step = e.step;
    if (step.kind === "mark_removed") out.cleared.push(label(e));
    else if (step.kind === "already_removed") (wentOutBefore(e) ? out.removed : out.cleared).push(label(e));
    else if (step.kind === "manual") out.manual.push(label(e));
    else if (step.kind === "wait") out.waiting.push(`${label(e)} (${step.reason})`);
    else {
      let outcome: RemoveOutcome;
      try {
        outcome = await deps.remove(e);
      } catch {
        outcome = { ok: false, error: "Unexpected error while deleting." };
      }
      await deps.finish({ ...e, step }, outcome);
      if (outcome.ok) out.removed.push(label(e));
      else if ("manual" in outcome) out.manual.push(label(e));
      else out.failed.push(`${label(e)}: ${outcome.error}`);
    }
  }
  return out;
}

/** removePost runs at most this many times in all for one request. */
export const MAX_REMOVE_TRIES = 3;
/** Wait before try 2 and try 3 (the last is past the 15-min stale window). */
export const RETRY_DELAYS_MS = [60_000, 16 * 60_000];

/** When to run removePost again (ms), or null: nothing failed or waiting, or out of tries. `attempt` starts at 1. */
export function retryDelay(result: RemovalResult, attempt: number): number | null {
  if (!result.failed.length && !result.waiting.length) return null;
  if (attempt >= MAX_REMOVE_TRIES) return null;
  return RETRY_DELAYS_MS[Math.min(Math.max(attempt, 1), RETRY_DELAYS_MS.length) - 1];
}

/** A post that was published to LinkedIn before postPublications existed: manual, with its link. */
export function legacyLinkedinEntry(post: { linkedinUrl?: string }, rows: Array<{ platform: string }>): Entry | null {
  if (!post.linkedinUrl || rows.some((r) => r.platform === "linkedin")) return null;
  return { id: "", platform: "linkedin", url: post.linkedinUrl, step: { kind: "manual" } };
}

export type PubRow = {
  _id: string;
  platform: Platform;
  status: string;
  url?: string;
  records?: Array<{ uri: string; cid: string }>;
  externalId?: string;
  claimedAt?: number;
  _creationTime?: number;
};

/**
 * The claim transaction for one post (undo.claimPostRemoval applies it): the post patch,
 * each row's patch, and the entries the action works through.
 */
export function planPostRemoval(
  post: { removedAt?: number; removedReason?: string; linkedinUrl?: string },
  rows: PubRow[],
  reason: string | undefined,
  now: number,
): { postPatch: ReturnType<typeof postRemovalPatch>; rowPatches: Array<{ id: string; patch: Record<string, unknown> }>; entries: Entry[] } {
  const rowPatches: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const entries: Entry[] = [];
  for (const row of rows) {
    const step = publicationStep(row, now);
    const patch = claimPatch(step, now);
    if (patch) rowPatches.push({ id: row._id, patch });
    const entry: Entry = {
      id: row._id,
      platform: row.platform,
      ...(row.url ? { url: row.url } : {}),
      step,
      ...(row.records?.length ? { uris: row.records.map((r) => r.uri) } : {}),
      ...(row.externalId ? { externalId: row.externalId } : {}),
      ...(step.kind === "delete" ? { claimedAt: now } : {}),
    };
    if (needsBlueskyLookup(entry) && row._creationTime !== undefined) entry.since = row._creationTime;
    entries.push(entry);
  }
  const legacy = legacyLinkedinEntry(post, rows);
  if (legacy) entries.push(legacy);
  return { postPatch: postRemovalPatch(post, reason, now), rowPatches, entries };
}

/** One line for logs and the command's output (no post text). */
export function summaryLine(r: RemovalResult): string {
  const cleared = r.cleared ?? [];
  if (!r.removed.length && !cleared.length && !r.failed.length && !r.manual.length && !r.waiting.length) return "nothing to remove";
  const parts = [
    r.removed.length ? `${r.removed.length} removed` : "",
    cleared.length ? `${cleared.length} never went out` : "",
    r.failed.length ? `${r.failed.length} failed` : "",
    r.manual.length ? `${r.manual.length} to remove by hand` : "",
    r.waiting.length ? `${r.waiting.length} waiting` : "",
  ];
  return parts.filter(Boolean).join(", ");
}

// ---------- Reddit ----------

/** Reddit comment fullname (t1_<id>) from its permalink: /r/<sub>/comments/<post>/<slug>/<comment>/ */
export function redditCommentFullname(url: string | undefined): string | undefined {
  let u: URL;
  try {
    u = new URL(url ?? "");
  } catch {
    return undefined;
  }
  if (!/(^|\.)reddit\.com$/.test(u.host.toLowerCase())) return undefined;
  const m = /\/comments\/[a-z0-9]{2,12}\/[^/]*\/([a-z0-9]{2,12})\/?$/i.exec(u.pathname);
  return m ? `t1_${m[1].toLowerCase()}` : undefined;
}

/** A Reddit fullname we may delete: a post (t3_) or a comment (t1_). */
export function isRedditFullname(id: string | undefined): id is string {
  return typeof id === "string" && /^t[13]_[a-z0-9]{2,12}$/i.test(id);
}

/**
 * POST https://oauth.reddit.com/api/del (id = fullname). Reddit answers 200 even when it's
 * already deleted, so running twice is fine.
 */
export async function deleteRedditThing(fetchFn: FetchFn, login: RedditLogin | null, fullname: string | undefined): Promise<DeleteOutcome> {
  if (!login) return { ok: false, error: "Reddit posting is off or his Reddit login isn't set." };
  if (!isRedditFullname(fullname)) return { ok: false, error: "No Reddit id saved for it." };
  const got = await redditToken(fetchFn, login);
  if (!got.ok) return { ok: false, error: got.error };
  let res: Awaited<ReturnType<FetchFn>>;
  try {
    res = await fetchFn("https://oauth.reddit.com/api/del", {
      method: "POST",
      headers: { Authorization: `bearer ${got.token}`, "Content-Type": "application/x-www-form-urlencoded", "User-Agent": login.userAgent },
      body: new URLSearchParams({ id: fullname }).toString(),
    });
  } catch {
    return { ok: false, error: "Network error or timeout reaching Reddit." };
  }
  if (!res.ok) return { ok: false, error: `Reddit delete HTTP ${res.status}` };
  return { ok: true, deleted: 1, alreadyGone: 0 };
}

// ---------- which post is "that last post" ----------

export type LatestCandidate = {
  postId: string;
  callId: string;
  createdAt: number; // posts._creationTime
  status: string; // posts.status
  linkedinUrl?: string;
  removedAt?: number;
  removedReason?: string;
  // hasCopy: the row holds ids of something that went out (pubHasCopy), whatever its status
  publications: Array<{ status: string; postedAt?: number; hasCopy?: boolean }>;
};

const WENT_OUT = new Set(["posted", "maybe_posted", "posting", "removing"]);

/** This call's own post, held because of a take-down on that call (HOLD_REASON, HOLD_UNSURE_REASON). */
export function isHoldReason(reason: string | undefined): boolean {
  return typeof reason === "string" && reason.startsWith("held:");
}

/** When it went out (newest publication), or undefined if it never did. */
export function publishedAt(c: LatestCandidate): number | undefined {
  let at: number | undefined;
  for (const p of c.publications) {
    const wentOut = WENT_OUT.has(p.status) || p.hasCopy === true || (p.status === "removed" && p.postedAt !== undefined);
    if (wentOut) at = Math.max(at ?? 0, p.postedAt ?? c.createdAt);
  }
  // Older posts published straight to LinkedIn have no publication rows.
  if (at === undefined && !c.publications.length && c.linkedinUrl && (c.status === "published" || c.status === "removed")) at = c.createdAt;
  // A legacy post (no publication rows) already taken down: still counts (at its creation time),
  // so asking again never reaches back to an older post. Not a post held on its own call. With
  // rows, the rows decide: removed rows that never went out don't count.
  if (at === undefined && !c.publications.length && c.removedAt !== undefined && !isHoldReason(c.removedReason)) at = c.createdAt;
  return at;
}

/**
 * The post "take down that last post" means: the newest one that went out, within 14 days.
 * When he asked on a call (`askedOn`): not that call's own post, and nothing that went out
 * after the call ended (a late retry must never reach a newer post). An already-removed post
 * still counts, so asking twice never reaches back to an older one.
 */
export function pickLatestPost(
  candidates: LatestCandidate[],
  now: number,
  opts: { askedOn?: { callId: string; endedAt: number }; windowMs?: number } = {},
): LatestCandidate | null {
  const until = opts.askedOn ? Math.min(now, opts.askedOn.endedAt) : now;
  const since = until - (opts.windowMs ?? LATEST_WINDOW_MS);
  let best: { c: LatestCandidate; at: number } | null = null;
  for (const c of candidates) {
    if (opts.askedOn && c.callId === opts.askedOn.callId) continue;
    const at = publishedAt(c);
    if (at === undefined || at < since || at > until) continue;
    if (!best || at > best.at || (at === best.at && c.createdAt > best.c.createdAt)) best = { c, at };
  }
  return best?.c ?? null;
}

// ---------- "take that post down" in a call transcript ----------
//
// The phone path (pipeline.ts). Only Pip's exact lines (prompts/principles.ts) delete anything:
//   line         Pip said TAKE_DOWN_LINE right after he asked for a take-down (in one of his
//                last two turns): his most recent earlier post comes down; this call's is held
//   today        Pip said TODAY_LINE (anywhere): this call's post is held
//   unconfirmed  nothing is deleted; this call's post is held and the call is flagged for
//                family (calls.takeDown). Either he clearly asked in his own words but Pip said
//                no line, or Pip said TAKE_DOWN_LINE with no ask we could spot right before it.
// Once Pip said TAKE_DOWN_LINE or TODAY_LINE, only Pip's KEEP_UP_LINE cancels it. His own
// retraction ("I changed my mind", "leave it up", "déjela publicada") cancels only an ask Pip
// didn't confirm, and only within his next 2 turns. Stories ("take down the post on the wall"),
// past tense ("borré las historias"), questions about what Pip can do ("can you delete
// posts?"), quotes ("take down that story, he said") and refusals ("no quiero que la quite")
// are not requests.

export type TranscriptTurn = { role: string; text: string };
export type TakeDownHow = "line" | "today" | "unconfirmed";
export type TakeDown = { asked: false } | { asked: true; how: TakeDownHow };

/** Lowercase, no accents. The Spanish past tense of the removal verbs ("borré") is marked first, so it never folds into the imperative ("borre"). */
function fold(text: string): string {
  return text
    .normalize("NFC")
    .toLowerCase()
    .replace(/\b(quit|borr|baj|elimin|retir|saqu|publiqu)é(?!\p{L})/gu, "$1e_past")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[’‘]/g, "'")
    .replace(/[“”«»]/g, '"');
}

/** Only letters, digits and apostrophes, single spaces: for comparing Pip's lines. */
function words(text: string): string {
  return fold(text).replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
}

/** The part of a line that must appear in Pip's turn: its last sentence ("Of course." may be dropped). */
function lineKey(line: string): string {
  const sentences = line.replace(/"/g, "").split(/(?<=[.!?])\s+/).filter((x) => x.trim());
  return words(sentences[sentences.length - 1] ?? line);
}
const keysOf = (lines: Record<string, string>) => Object.values(lines).map(lineKey);
const TAKE_DOWN_KEYS = keysOf(TAKE_DOWN_LINE);
const TODAY_KEYS = keysOf(TODAY_LINE);
const KEEP_UP_KEYS = keysOf(KEEP_UP_LINE);

function saysLine(pipText: string, lineKeys: string[]): boolean {
  const said = ` ${words(pipText)} `;
  return lineKeys.some((k) => said.includes(` ${k} `));
}

const re = (source: string) => new RegExp(source, "g");

// English: a request names one post ("that post", "my story about..."), never a bare "posts".
const DET_EN = String.raw`(?:(?:the|that|this|my|last|latest|previous|recent|most recent|newest|other|last week's|last weeks|today's|todays|new)\s+){1,4}`;
const NOUN_EN = String.raw`(?:post|story)`;
// Spanish: usted imperative / subjunctive or infinitive (+ pronouns); never "borré" or "retiramos".
const VERB_ES = String.raw`(?:(?:quit|borr|baj|elimin|retir)(?:e|en|ar)|saqu(?:e|en)|sacar)(?:me|se|nos)?(?:la|lo|las|los)?`;
const DET_ES = String.raw`(?:(?:la|el|esa|ese|esta|este|mi|su|ultima|ultimo|nueva)\s+){1,3}`;
// "historia" is also history or records: only with a sign it's the one we posted.
const NOUN_ES = String.raw`(?:publicacion|post|historia(?=\s+(?:que\s+(?:me\s+|le\s+)?(?:subi|subio|subieron|public|pus|compart)|de\s+la\s+semana\s+pasada|de\s+hoy)))`;

/** Requests naming the post (need a request lead-in, or none: an imperative). */
const CLEAR = [
  re(String.raw`\b(?:take|pull)\s+(?:down|off)\s+${DET_EN}${NOUN_EN}\b`),
  re(String.raw`\b(?:take|pull)\s+${DET_EN}${NOUN_EN}\s+(?:down|off)\b`),
  re(String.raw`\b(?:take|pull)\s+${DET_EN}${NOUN_EN}\s+about\b[^.?!,]{0,40}?\s(?:down|off)\b`),
  re(String.raw`\b(?:delete|remove|unpost|unpublish|erase)\s+${DET_EN}${NOUN_EN}\b`),
  re(String.raw`\bget rid of\s+${DET_EN}${NOUN_EN}\b`),
  re(String.raw`\b${VERB_ES}\s+${DET_ES}${NOUN_ES}\b`),
  re(String.raw`\bdar de baja\s+${DET_ES}${NOUN_ES}\b`),
];

/** Said as a wish (no lead-in needed): "I'd like that post taken down", "ya no quiero esa publicación". */
const WISH = [
  re(String.raw`\b(?:want|like|need|rather have)\s+${DET_EN}${NOUN_EN}\s+(?:(?:taken|pulled|brought)\s+(?:down|off)|deleted|removed|gone|down)\b`),
  re(String.raw`\b(?:don't|do not) want\s+${DET_EN}${NOUN_EN}\s+(?:up|online|out there|on the internet)\b`),
  re(String.raw`\bya no quiero\s+${DET_ES}${NOUN_ES}\b`),
];

/** Any take-down wording at all: enough for Pip's line to count right after it. */
const VAGUE = [
  /\b(?:take|pull|bring)\b[^.?!]{0,30}?\b(?:down|off)\b/g,
  /\b(?:delete|remove|erase|unpost|unpublish)\b/g,
  /\b(?:don't|do not) (?:post|put up|share|publish) (?:it|that|this|today's story|the story|that story)\b/g,
  /\b(?:don't|do not) put (?:it|that|this|today's story|the story|that story) (?:up|online|out there|on the internet|on (?:bluesky|threads|x|facebook|social media))\b/g,
  /\b(?:rather|prefer) (?:you |we |they )?(?:not|didn't|did not|don't) (?:post|put up|share|publish)\b/g,
  /\bget rid of (?:it|that|that one|this|this one)(?=\s*[,.!?]|\s*$|\s+(?:please|for me|now)\b)/g,
  /\b(?:don't|do not) want (?:it|that|that one|this|the post|that post|the story|that story|today's story) (?:up|online|out there|posted|on the internet)\b/g,
  // Spanish verb + a pronoun, article or end of phrase (so English "quite a day" isn't one)
  re(String.raw`\b${VERB_ES}(?=\s+(?:la|el|esa|ese|esta|este|mi|su|eso|por favor)\b|\s*[,.!?]|\s*$)`),
  // "¿Me borra la publicación?": the present tense, as a polite ask
  /\b(?:quit|borr|baj|elimin|retir)a\s+(?:la|el|esa|ese|mi|su)\s+(?:publicacion|post|historia)\b/g,
  /\bdar de baja\b/g,
  /\bno (?:(?:la|lo|me)\s+)?(?:publique|publiquen|suba|suban|ponga|pongan|comparta|compartan)\b/g,
  /\bno quiero que (?:(?:la|lo|me)\s+)?(?:publique|publiquen|suba|suban|ponga|pongan|comparta|compartan)\b/g,
  /\bya no (?:la|lo) quiero\b/g,
];

/** He changed his mind. Clear phrases only: bare "keep it", "never mind" or "déjelo" are not. */
const RETRACT = [
  /\b(?:i|i've|i have) changed my mind\b/g,
  /\bleave (?:it|that|that one|the post|that post|the story|it all) (?:up|online|posted)\b/g,
  /\bkeep (?:the|that|my) (?:post|story) up\b/g,
  /\bdon't (?:take|pull) (?:it|that|that one|the post|that post) (?:down|off)\b/g,
  /\bdon't (?:delete|remove) (?:it|that|that one|the post|that post)\b/g,
  /\bcambie de (?:opinion|idea|parecer)\b/g,
  /\b(?:dejela|dejala|dejelo|dejalo|dejenla|dejenlo) (?:publicad[ao]|puest[ao]|arriba|en internet)\b/g,
  /\bno (?:la|lo|las|los) (?:quite|quiten|borre|borren|baje|bajen|retire|retiren|elimine|eliminen)\b/g,
];

/** Words before the verb that are just talk (or nothing at all: an imperative). */
const LEAD_IN = /^(?:(?:oh|um|uh|well|so|and|yes|yeah|ok|okay|actually|hey|listen|also|but|now|pip|juanito|oiga|mire|bueno|pues|ah|eh|y|tambien|oye|si|ahora)\b[\s,]*)*/;
const FRAMING_EN =
  /^(?:(?:please|can you|could you|would you|will you|you can|just|go ahead and|let's|i want you to|i want them to|i need you to|i'd like you to|i would like you to|i want to|i'd like to|i would like to|i'd rather you|have them|can we|could we|we should|you should|i think we should|get them to)\s*,?\s*)+$/;
const FRAMING_ES =
  /^(?:(?:por favor|(?:me |nos |le )?(?:la |lo |las |los )?(?:puede|podria|pudiera|quiere|quisiera)(?: usted)?|quiero que|quisiera que|me gustaria que|necesito que|le pido que|favor de|(?:me )?(?:hace|haga|hagame) el favor de|usted)\s*,?\s*)*(?:(?:me|se|le|nos)\s+)?(?:(?:la|lo|las|los)\s+)?$/;

/** The sentence the match sits in, up to the match. */
function clauseBefore(before: string): string {
  return (before.split(/[.!?;—–]|\s-\s/).pop() ?? "").replace(/[¿¡]/g, " ");
}

/** Is the text before the verb (same sentence) a request lead-in? */
function framed(before: string): boolean {
  const rest = clauseBefore(before).trimStart().replace(LEAD_IN, "").trim();
  return rest === "" || FRAMING_EN.test(`${rest} `) || FRAMING_ES.test(`${rest} `);
}

/** "Don't take it down", "no quiero que la quite", "never delete that post" (but "¿no me la borra?" is a polite ask). */
function negated(before: string): boolean {
  const raw = before.split(/[.!?;—–]|\s-\s/).pop() ?? "";
  if (/¿\s*no\s+(?:(?:me|nos|le|se|la|lo|las|los)\s+){0,2}$/.test(raw)) return false;
  const clause = clauseBefore(before);
  return (
    /\b(?:don't|do not|never|wouldn't|won't|shouldn't|didn't|no need to|not)\s+(?:[\w']+\s+){0,3}$/.test(clause) ||
    /(?:^|\s)(?:no|nunca|jamas)\s+(?:[\w']+\s+){0,3}$/.test(clause)
  );
}

/** Someone else's words: inside quotes, "..., he said", or "my boss said, ...". */
function reported(before: string, after: string): boolean {
  if ((before.match(/"/g) ?? []).length % 2 === 1) return true;
  const sentenceAfter = after.split(/[.!?]/)[0] ?? "";
  // ", he said" / ", my boss told me" (not ", I shouldn't have told you": that's his own aside)
  if (/,\s*(?:he|she|they|someone|somebody|(?:my|his|her|our|their|the)\s+\w+|[a-z]+)\s+(?:said|says|told (?:me|him|her|us|them)|tells (?:me|him|her|us|them)|yelled|shouted|goes)\b/.test(sentenceAfter)) return true;
  if (/,\s*(?:\w+\s+)?(?:me\s+|le\s+|nos\s+)?(?:dijo|dice|decia|grito)\b/.test(sentenceAfter)) return true;
  return /\b(?:said|says|told (?:me|him|her|us|them)|yelled|shouted|dijo|dice|decia|grito)\s*,?\s*$/.test(clauseBefore(before));
}

// After the post: only words that keep it about the online post ("the post on the wall" is not).
const TAIL_OK_EN =
  /^(?:\s*(?:please|for me|right now|right away|now|today|anymore|again|too|as well|already|then|if you (?:can|could)|when you can|online|up|down|off))*\s*(?:$|about\b|from (?:last|this|the other|the last|yesterday|earlier|before|a few|bluesky|reddit|the internet|my (?:page|account|profile)|online|social media)\b|(?:that |which )?(?:you|we|they|pip|juanito|front porch|y'all) (?:put|posted|wrote|shared|made|did|sent)\b|on (?:bluesky|reddit|the internet|line|my (?:page|account|profile)|social media|facebook)\b)/;
const TAIL_OK_ES =
  /^(?:\s*(?:por favor|ahora|ya|hoy|tambien|si puede|cuando pueda|mas reciente))*\s*(?:$|de (?:la semana pasada|la otra vez|la ultima vez|ayer|hoy|antier|bluesky|internet|reddit)\b|que\b|sobre\b|acerca\b|en (?:internet|bluesky|reddit|linea)\b)/;

function tailOk(after: string): boolean {
  const clause = (after.split(/[,.!?;]/)[0] ?? "").replace(/[¿¡"]/g, " ");
  return TAIL_OK_EN.test(clause) || TAIL_OK_ES.test(clause);
}

/** Last position of a usable match (-1 = none). */
function lastHit(text: string, patterns: RegExp[], usable: (before: string, after: string) => boolean): number {
  let at = -1;
  for (const p of patterns) {
    const r = new RegExp(p.source, "g");
    let m: RegExpExecArray | null;
    while ((m = r.exec(text))) {
      if (usable(text.slice(0, m.index), text.slice(m.index + m[0].length))) at = Math.max(at, m.index);
      if (m[0].length === 0) r.lastIndex += 1;
    }
  }
  return at;
}

/** One of his turns: where he asks (any wording / clear wording) and where he takes it back (-1 = not in it). */
export function readElderTurn(raw: string): { ask: number; clear: number; retract: number } {
  const text = fold(raw);
  const usable = (before: string, after: string) => !negated(before) && !reported(before, after);
  const clear = Math.max(
    lastHit(text, CLEAR, (b, a) => usable(b, a) && framed(b) && tailOk(a)),
    lastHit(text, WISH, (b, a) => !negated(b) && !reported(b, a) && tailOk(a)),
  );
  const ask = Math.max(clear, lastHit(text, VAGUE, usable));
  // Not someone else's words ("déjalo, mijo", he said).
  const retract = lastHit(text, RETRACT, (b, a) => !reported(b, a));
  return { ask, clear, retract };
}

/**
 * Did he ask, on this call, to take a post down? See the rules above. Reads his turns and
 * Pip's; returns no text.
 */
export function detectTakeDown(turns: TranscriptTurn[]): TakeDown {
  let line = false; // Pip's take-down line right after he asked
  let lineAlone = false; // Pip's take-down line with no ask right before it: hold only
  let today = false; // Pip's today line
  let clear = false; // a clear ask in his own words, not confirmed
  let elderTurns = 0;
  let askedOnTurn = -10; // his turn number with the latest ask still standing
  let clearOnTurn = -10; // ... and with the latest clear one
  for (const t of turns) {
    if (t.role === "elder") {
      elderTurns += 1;
      const r = readElderTurn(t.text);
      if (r.ask >= 0) askedOnTurn = elderTurns;
      if (r.clear >= 0) {
        clear = true;
        clearOnTurn = elderTurns;
      }
      // His own retraction: only an ask Pip didn't confirm, and only a recent one.
      // Pip's lines stay (only his KEEP_UP_LINE cancels them).
      if (r.retract >= 0 && r.retract > r.ask) {
        if (elderTurns - askedOnTurn <= RETRACT_TURNS) askedOnTurn = -10;
        if (elderTurns - clearOnTurn <= RETRACT_TURNS) {
          clear = false;
          clearOnTurn = -10;
        }
      }
      continue;
    }
    if (t.role !== "pip") continue;
    if (saysLine(t.text, KEEP_UP_KEYS)) {
      line = lineAlone = today = clear = false;
      askedOnTurn = clearOnTurn = -10;
      continue;
    }
    if (saysLine(t.text, TAKE_DOWN_KEYS)) {
      // It deletes only right after he asked (one of his last two turns); otherwise it holds.
      if (elderTurns - askedOnTurn <= 1) line = true;
      else lineAlone = true;
    } else if (saysLine(t.text, TODAY_KEYS)) {
      today = true; // holding today's post is harmless
    }
  }
  if (line) return { asked: true, how: "line" };
  if (today) return { asked: true, how: "today" };
  if (clear || lineAlone) return { asked: true, how: "unconfirmed" };
  return { asked: false };
}

/** His retraction cancels an unconfirmed ask up to this many of his turns later (0 = same turn). */
const RETRACT_TURNS = 2;

/** The note on calls.takeDown, for family (no words from the call). */
export function takeDownNote(how: TakeDownHow): string {
  if (how === "line") return "He asked to take down his most recent post and Pip confirmed: it's being taken down. This call's post is held.";
  if (how === "today") return "He asked not to post today's story: this call's post is held.";
  return "He may have asked to take a post down, but it wasn't clear, so nothing was deleted. This call's post is held. Check with him; undo:removePost takes any post down.";
}

/** The reason on this call's own post when it's held. */
export function holdReason(how: TakeDownHow): string {
  return how === "unconfirmed" ? HOLD_UNSURE_REASON : HOLD_REASON;
}

// ---------- /posts review page ----------

/** The command a family member or admin runs to take a post down. */
export function undoCommand(postId: string): string {
  return `npx convex run undo:removePost '${JSON.stringify({ postId })}'`;
}

/**
 * For the /posts page: one status line about take-downs, and the undo command (none once
 * everything is down). No post text.
 */
export function postUndoInfo(
  post: { _id: string; removedAt?: number; removedReason?: string },
  publications: Array<{ platform: string; status: string; url?: string; error?: string }>,
): { status: string; command?: string } {
  if (post.removedAt === undefined) {
    const live = publications.filter((p) => WENT_OUT.has(p.status) || p.status === "pending");
    return { status: live.length ? "Up. To take it down:" : "Not posted. To make sure it never goes out:", command: undoCommand(post._id) };
  }
  const when = new Date(post.removedAt).toISOString().slice(0, 16).replace("T", " ");
  const reason = post.removedReason ? ` (${post.removedReason})` : "";
  const left = publications.filter((p) => p.status !== "removed");
  if (!left.length) return { status: `Taken down ${when} UTC${reason}.` };
  const pending = left.map((p) => (p.platform === "linkedin" && p.url ? `linkedin: remove by hand ${p.url}` : `${p.platform}: ${p.status}`));
  return { status: `Take-down requested ${when} UTC${reason}; still up: ${pending.join("; ")}. Retry:`, command: undoCommand(post._id) };
}
