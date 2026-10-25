// Undo: taking a post (and its thread replies) back down. Pure rules, no Convex imports;
// unit-tested in tests/undo.test.ts. convex/undo.ts wires them to the database.
//
// Order of work for one post:
//   1. posts.removedAt (+ reason, status "removed") first, so publishing never sends it again.
//   2. each postPublications row:
//        pending / failed / skipped  -> removed (it never went out)
//        posted / maybe_posted       -> claim as `removing`, delete on the platform, then removed
//                                       (on failure: back to the previous status + short error)
//        posting (in flight)         -> left alone; publish re-checks removedAt and calls us again
//        removing (another run)      -> left alone, unless that claim is stale (crashed run)
//        removed                     -> nothing to do (running twice is safe)
//        linkedin                    -> no delete API through LinkedAPI: "manual" (a person
//                                       removes it by hand, then runs undo:markRemovedByHand)
// Never log post text, reply text, tokens or passwords.

import type { DeleteOutcome } from "./blueskyDelete.ts";
import type { FetchFn } from "./blueskyClient.ts";
import type { RedditLogin } from "./logins.ts";
import { redditToken } from "./replyPosting.ts";

export type Platform = "bluesky" | "reddit" | "linkedin";

/** A claim older than this is assumed crashed and can be retaken. */
export const STALE_REMOVE_MS = 15 * 60_000;

/** "Take down that last post" looks this far back. */
export const LATEST_WINDOW_MS = 14 * 86_400_000;

export const DEFAULT_REASON = "take-down request";
export const CALL_REASON = "he asked on the call";

// ---------- one row: what to do ----------

export type Step =
  | { kind: "already_removed" }
  | { kind: "mark_removed" } // never went out
  | { kind: "wait"; reason: string } // in flight; someone calls us again
  | { kind: "manual" } // no delete API: a person removes it by hand
  | { kind: "delete"; previous: "posted" | "maybe_posted" };

const NEVER_POSTED_PUB = ["pending", "failed", "skipped"];
const NEVER_POSTED_REPLY = ["draft", "needs_review", "failed"];

function stepFor(
  row: { status: string; claimedAt?: number },
  now: number,
  neverPosted: string[],
  canDelete: boolean,
): Step {
  const s = row.status;
  if (s === "removed") return { kind: "already_removed" };
  if (neverPosted.includes(s)) return { kind: "mark_removed" };
  if (s === "posting") return { kind: "wait", reason: "still being posted; it's taken down once that finishes" };
  if (s === "removing") {
    const fresh = row.claimedAt !== undefined && now - row.claimedAt <= STALE_REMOVE_MS;
    if (fresh) return { kind: "wait", reason: "already being taken down" };
    // A crashed undo run: we don't know if it went, so treat it as "maybe posted".
    return canDelete ? { kind: "delete", previous: "maybe_posted" } : { kind: "manual" };
  }
  if (s === "posted" || s === "maybe_posted") return canDelete ? { kind: "delete", previous: s } : { kind: "manual" };
  return { kind: "wait", reason: `unknown status ${s}` };
}

/** One postPublications row. LinkedIn has no delete, so it's always manual once it went out. */
export function publicationStep(row: { platform: string; status: string; claimedAt?: number }, now: number): Step {
  return stepFor(row, now, NEVER_POSTED_PUB, row.platform === "bluesky" || row.platform === "reddit");
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
  return stepFor(reply, now, NEVER_POSTED_REPLY, replyDeleteTarget(reply) !== null);
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
      return { error: manualNote };
    default:
      return null;
  }
}

/** Row patch after the platform delete. */
export function finishPatch(previous: "posted" | "maybe_posted", outcome: DeleteOutcome, now: number): Record<string, unknown> {
  if (outcome.ok) return { status: "removed", removedAt: now, claimedAt: undefined, error: undefined };
  return { status: previous, claimedAt: undefined, error: `Take-down failed: ${outcome.error}`.slice(0, 200) };
}

// ---------- the run ----------

/** What the claim mutation hands the action, per platform row. */
export type Entry = {
  id: string; // postPublications id ("" for a legacy LinkedIn link without a row)
  platform: Platform;
  url?: string;
  step: Step;
  uris?: string[]; // Bluesky: every post of the thread, root first
  externalId?: string; // Reddit fullname
};

export type RemovalResult = { removed: string[]; failed: string[]; manual: string[]; waiting: string[] };

function label(e: { platform: string; url?: string }): string {
  return e.url ? `${e.platform} ${e.url}` : e.platform;
}

export type RunDeps = {
  /** Delete on the platform (only called for "delete" entries). */
  remove(entry: Entry): Promise<DeleteOutcome>;
  /** Record the outcome on the row. */
  finish(entry: Entry & { step: { kind: "delete"; previous: "posted" | "maybe_posted" } }, outcome: DeleteOutcome): Promise<void>;
};

/**
 * Delete what was claimed and sort every row into the result:
 *   removed  gone (now, earlier, or never went out)
 *   failed   the platform delete failed; the row is back to its previous status
 *   manual   a person has to remove it by hand (LinkedIn, or no id to delete by)
 *   waiting  in flight; removed when that finishes
 */
export async function runRemoval(entries: Entry[], deps: RunDeps): Promise<RemovalResult> {
  const out: RemovalResult = { removed: [], failed: [], manual: [], waiting: [] };
  for (const e of entries) {
    const step = e.step;
    if (step.kind === "already_removed" || step.kind === "mark_removed") out.removed.push(label(e));
    else if (step.kind === "manual") out.manual.push(label(e));
    else if (step.kind === "wait") out.waiting.push(`${label(e)} (${step.reason})`);
    else {
      let outcome: DeleteOutcome;
      try {
        outcome = await deps.remove(e);
      } catch {
        outcome = { ok: false, error: "Unexpected error while deleting." };
      }
      await deps.finish({ ...e, step }, outcome);
      if (outcome.ok) out.removed.push(label(e));
      else out.failed.push(`${label(e)}: ${outcome.error}`);
    }
  }
  return out;
}

/** A post that was published to LinkedIn before postPublications existed: manual, with its link. */
export function legacyLinkedinEntry(post: { linkedinUrl?: string }, rows: Array<{ platform: string }>): Entry | null {
  if (!post.linkedinUrl || rows.some((r) => r.platform === "linkedin")) return null;
  return { id: "", platform: "linkedin", url: post.linkedinUrl, step: { kind: "manual" } };
}

/** One line for logs and the command's output (no post text). */
export function summaryLine(r: RemovalResult): string {
  if (!r.removed.length && !r.failed.length && !r.manual.length && !r.waiting.length) return "nothing to remove";
  const parts = [
    r.removed.length ? `${r.removed.length} removed` : "",
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
  publications: Array<{ status: string; postedAt?: number }>;
};

const WENT_OUT = new Set(["posted", "maybe_posted", "posting", "removing"]);

/** When it went out (newest publication), or undefined if it never did. */
export function publishedAt(c: LatestCandidate): number | undefined {
  let at: number | undefined;
  for (const p of c.publications) {
    const wentOut = WENT_OUT.has(p.status) || (p.status === "removed" && p.postedAt !== undefined);
    if (wentOut) at = Math.max(at ?? 0, p.postedAt ?? c.createdAt);
  }
  // Older posts published straight to LinkedIn have no publication rows.
  if (at === undefined && !c.publications.length && c.linkedinUrl && (c.status === "published" || c.status === "removed")) at = c.createdAt;
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
// The phone path (pipeline.ts): after a call, a clear take-down request runs removeLatest.
//   clear      he asks, in a request ("can you take that post down?", "borre la publicación")
//   confirmed  he said something like it ("take it down", or "post" in a story) AND Pip
//              committed to it in one of its next two turns ("I'll have it taken down")
// "We had to take the post down" (a fence post, in a story) is neither. A request turned down
// in the same breath ("don't take it down") or later ("leave it up") doesn't count.

export type TranscriptTurn = { role: string; text: string };

function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[’‘]/g, "'");
}

const FILLER_EN = "(?:(?:the|that|this|my|last|latest|previous|recent|newest|other|week'?s?|new)\s+){0,4}";
const NOUN_EN = "(?:post|posts|story|stories|one (?:about|you|from|we|i|with))";
const FILLER_ES = "(?:(?:la|el|las|los|esa|ese|esta|este|mi|mis|ultima|ultimo|pasada|pasado|de|que|semana|nueva)\s+){0,4}";
const NOUN_ES = "(?:publicacion|publicaciones|post|posts|historia|historias)";
const VERB_ES = "(?:quit|baj|borr|elimin|retir)[a-z]*";

/** Requests naming the post. Each match's verb is where the framing check looks back from. */
const STRICT = [
  new RegExp(`\b(?:take|pull)\s+(?:down|off)\s+${FILLER_EN}${NOUN_EN}\b`, "g"),
  new RegExp(`\b(?:take|pull)\s+${FILLER_EN}${NOUN_EN}\s+(?:down|off)\b`, "g"),
  new RegExp(`\b(?:delete|remove|unpost|unpublish|erase)\s+${FILLER_EN}${NOUN_EN}\b`, "g"),
  new RegExp(`\b${VERB_ES}\s+${FILLER_ES}${NOUN_ES}\b`, "g"),
  /\bdar de baja\s+(?:la|esa|mi)\s+(?:publicacion|historia)\b/g,
];

/** Said as a wish, no lead-in needed: "I'd like that post taken down", "I don't want that story up". */
const WISH = [
  new RegExp(`\b(?:want|like|need|rather have)\s+${FILLER_EN}${NOUN_EN}\s+(?:(?:taken|pulled|brought)\s+(?:down|off)|deleted|removed)\b`, "g"),
  new RegExp(`\b(?:don'?t|do not) want\s+${FILLER_EN}${NOUN_EN}\s+(?:up|online|out there|on there|on the internet)\b`, "g"),
  new RegExp(`\bya no quiero\s+${FILLER_ES}${NOUN_ES}\b`, "g"),
];

/** Any take-down wording at all: counts only when Pip commits to it right after. */
const VAGUE = [
  /\b(?:take|pull)\b[^.?!]{0,30}\b(?:down|off)\b/g,
  /\b(?:delete|remove|erase|unpost)\b/g,
  new RegExp(`\b${VERB_ES}\b`, "g"),
  /\bdar de baja\b/g,
];

/** Words before the verb that make it a request (or nothing at all: an imperative). */
const LEAD_IN = /^(?:(?:oh|um|uh|well|so|and|yes|yeah|ok|okay|actually|hey|listen|also|but|now|pip|juanito|oiga|mire|bueno|pues|ah|eh|y|tambien|oye|este|si|ahora)\b[\s,]*)*/;
const FRAMING_EN =
  /^(?:(?:please|can you|could you|would you|will you|you can|just|go ahead and|let's|i want you to|i want them to|i need you to|i'd like you to|i would like you to|i want to|i'd like to|i would like to|i'd rather you|have them|can we|could we|we should|you should|i think we should|get them to)\s*,?\s*)+$/;
const FRAMING_ES =
  /^(?:(?:por favor|puede|podria|pudiera|quiero que|me gustaria que|quisiera que|necesito que|le pido que|favor de|me hace el favor de|hagame el favor de|haga el favor de|que|me|se|la|lo|usted|ustedes)\s*,?\s*)+$/;

/** Is the text before the verb (same sentence) a request lead-in? */
function framed(before: string): boolean {
  const sentence = (before.split(/[.!?;:—–]|\s-\s/).pop() ?? "").replace(/[¿¡"]/g, " ");
  const rest = sentence.trimStart().replace(LEAD_IN, "").trim();
  return rest === "" || FRAMING_EN.test(`${rest} `) || FRAMING_ES.test(`${rest} `);
}

/** "Don't take it down", "no la quite" (but "¿no me la quita?" is a polite request). */
function negated(before: string): boolean {
  if (/\b(?:don'?t|do not|never|wouldn'?t|no need to|not)\s+(?:\w+\s+){0,2}$/.test(before)) return true;
  return /(?:^|[^¿\w])\s*(?:no|nunca)\s+(?:me\s+|le\s+)?(?:la\s+|lo\s+|las\s+|los\s+|se\s+)?$/.test(before);
}

/** Pip committing to it (the prompt's line: "I'll have it taken down right after our call"). */
const CONFIRM = [
  /\b(?:i'll|i will|we'll|we will|i'm going to|we're going to|i can|i'll make sure|consider it)\b[^.?!]{0,40}\b(?:taken down|take (?:it|that|that one) down|removed|deleted|done)\b/,
  /\b(?:la|lo|las|los) (?:quitamos|bajamos|borramos|retiramos|eliminamos|quito|bajo|borro|retiro|elimino)\b/,
  /\b(?:voy a|vamos a|van a)\s+(?:quitar|bajar|borrar|retirar|eliminar)(?:la|lo|las|los)\b/,
  /\bse (?:quite|baje|borre|retire|elimine)\b/,
];

/** Pip's line when he changes his mind ("No problem, I'll leave it up."). */
const PIP_KEEP_UP = [/i'll leave it up/, /la dejamos/];

/** He changed his mind later in the call. */
const RETRACT = [
  /\b(?:leave|keep) (?:it|that|that one|the post|that post|the story) up\b/,
  /\bdon'?t (?:take|pull) (?:it|that|that one|the post|that post) (?:down|off)\b/,
  /\bdon'?t (?:delete|remove) (?:it|that|that one|the post|that post)\b/,
  /\bnever ?mind,? (?:about )?(?:the|that) (?:post|story)\b/,
  /\bnever ?mind,? (?:leave|keep) it\b/,
  /\bno (?:la|lo|las|los) (?:quite|quiten|borre|borren|baje|bajen|retire|elimine)\b/,
  /\bmejor (?:dejela|dejala|dejelo|dejalo)\b/,
  /\b(?:dejela|dejala) (?:asi|ahi|puesta|arriba)\b/,
];

type Hit = { framed: boolean };

function hits(text: string, patterns: RegExp[]): Hit[] {
  const out: Hit[] = [];
  for (const p of patterns) {
    const re = new RegExp(p.source, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const before = text.slice(0, m.index);
      if (!negated(before)) out.push({ framed: framed(before) });
    }
  }
  return out;
}

function pipConfirmsAfter(turns: TranscriptTurn[], i: number): boolean {
  const next = turns.slice(i + 1).filter((t) => t.role === "pip").slice(0, 2);
  return next.some((t) => CONFIRM.some((r) => r.test(fold(t.text))));
}

/**
 * Did he ask, on this call, to take a post down? See the rules above. Reads his turns and
 * Pip's; returns no text.
 */
export function detectTakeDown(turns: TranscriptTurn[]): { asked: boolean; how?: "clear" | "confirmed" } {
  let asked: "clear" | "confirmed" | undefined;
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    if (t.role !== "elder") {
      if (asked && t.role === "pip" && PIP_KEEP_UP.some((r) => r.test(fold(t.text)))) asked = undefined;
      continue;
    }
    const text = fold(t.text);
    if (RETRACT.some((r) => r.test(text))) {
      asked = undefined;
      continue;
    }
    if (hits(text, STRICT).some((h) => h.framed) || hits(text, WISH).length) {
      asked = "clear";
      continue;
    }
    if (hits(text, VAGUE).length && pipConfirmsAfter(turns, i)) asked = "confirmed";
  }
  return asked ? { asked: true, how: asked } : { asked: false };
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
