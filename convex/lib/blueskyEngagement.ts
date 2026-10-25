// Reader engagement on his Bluesky threads, from app.bsky.feed.getPostThread.
//
//   parseThread       pure: likes + reposts on the ROOT post, replies by OTHERS (oldest first, capped)
//   fetchPostThread   one getPostThread call (public AppView by default, or his PDS with a session)
//   threadEngagement  root thread, plus any of his records the root read didn't reach (long threads)
//   toUpsertArgs      result -> engagement.upsert args
//   publicationsToScrape  which postPublications rows to read (posted, not removed, recent)
//
// Replies he hid (threadgate hiddenReplies) and replies carrying moderation labels are skipped.
// No Convex imports: unit-tested with Node. Errors carry HTTP statuses only, never tokens.

import { BlueskyHttpError, type FetchFn } from "./blueskyClient.ts";

/** Public AppView: getPostThread works here without a login. */
export const PUBLIC_APPVIEW = "https://public.api.bsky.app";
export const THREAD_DEPTH = 6;
export const MAX_REPLIES = 20;
export const MAX_REPLY_CHARS = 500;
export const MAX_AUTHOR_CHARS = 80;
/** Only threads he posted in this window are re-read every day. */
export const SCRAPE_WINDOW_DAYS = 30;
/** Extra getPostThread calls for long threads whose tail the root read didn't reach. */
export const MAX_EXTRA_READS = 3;
/** Labels (on the reply or its author) that keep a reply out of the bank. */
export const MODERATION_LABELS = new Set([
  "!hide",
  "!warn",
  "spam",
  "porn",
  "sexual",
  "nudity",
  "graphic-media",
  "gore",
  "rude",
  "intolerant",
  "threat",
]);

export type Reply = { author: string; text: string };

export type ThreadEngagement = {
  /** likes on the root post only (summing every post counts one reader many times) */
  likes: number;
  /** reposts of the root post */
  reposts: number;
  replies: Reply[];
  /** replies by others seen, before the cap */
  repliesSeen: number;
  /** uris of his posts found in the thread */
  ownUris: string[];
};

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);
const str = (x: unknown): string => (typeof x === "string" ? x : "");
const count = (x: unknown): number => (typeof x === "number" && Number.isFinite(x) && x > 0 ? Math.floor(x) : 0);

function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** The repo (his did) in an at:// uri: at://did:plc:abc/app.bsky.feed.post/rkey -> did:plc:abc. */
export function repoOf(uri: string): string {
  const m = /^at:\/\/([^/]+)\//.exec(uri.trim());
  return m ? m[1] : "";
}

/** bsky.app link for an at:// post uri ("" if it isn't one). */
export function webUrlFor(uri: string): string {
  const m = /^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/?#]+)$/.exec(uri.trim());
  return m ? `https://bsky.app/profile/${m[1]}/post/${m[2]}` : "";
}

function authorLabel(author: Obj): string {
  const handle = str(author.handle).trim();
  const name = str(author.displayName).trim();
  if (name && handle) return clip(`${name} (@${handle})`, MAX_AUTHOR_CHARS);
  return clip(name || (handle ? `@${handle}` : "Someone"), MAX_AUTHOR_CHARS);
}

/** A real post node (not blocked / not found / deleted). */
function postOf(node: unknown): Obj | undefined {
  if (!isObj(node)) return undefined;
  const type = str(node.$type);
  if (type && type !== "app.bsky.feed.defs#threadViewPost") return undefined;
  if (node.blocked === true || node.notFound === true) return undefined;
  return isObj(node.post) && typeof node.post.uri === "string" ? node.post : undefined;
}

/** Reply uris he hid on this thread (threadgate record). */
export function hiddenRepliesOf(json: unknown): Set<string> {
  const gate = isObj(json) && isObj(json.threadgate) ? json.threadgate : undefined;
  const list = gate && isObj(gate.record) ? gate.record.hiddenReplies : undefined;
  return new Set(Array.isArray(list) ? list.filter((u): u is string => typeof u === "string") : []);
}

/** Does a post or its author carry a moderation label? Negated labels (neg: true) don't count. */
export function hasModerationLabel(post: Obj): boolean {
  const author = isObj(post.author) ? post.author : {};
  const labels = [post.labels, author.labels].flatMap((l) => (Array.isArray(l) ? l : []));
  return labels.some((l) => isObj(l) && l.neg !== true && MODERATION_LABELS.has(str(l.val).toLowerCase()));
}

/** When a reply was posted (indexedAt, else createdAt); unknown sorts last. */
function postedAtMs(post: Obj): number {
  const record = isObj(post.record) ? post.record : {};
  for (const raw of [post.indexedAt, record.createdAt]) {
    const ms = Date.parse(str(raw));
    if (Number.isFinite(ms)) return ms;
  }
  return Number.POSITIVE_INFINITY;
}

type TimedReply = Reply & { at: number };
type Walk = { likes: number; reposts: number; replies: TimedReply[]; ownUris: string[] };

/**
 * One getPostThread response, breadth first. Likes/reposts come from the requested post only
 * (if it's his). Blocked, deleted, hidden or labelled nodes are skipped with everything under them.
 */
function walkThread(json: unknown, ownerDid: string, seen: Set<string>, hidden: Set<string>): Walk {
  const out: Walk = { likes: 0, reposts: 0, replies: [], ownUris: [] };
  const isHim = (author: Obj) => !!ownerDid && (author.did === ownerDid || author.handle === ownerDid);
  const queue: unknown[] = [isObj(json) ? json.thread : undefined];
  let top = true;
  while (queue.length) {
    const node = queue.shift();
    const post = postOf(node);
    const atTop = top;
    top = false;
    if (!post) continue;
    const uri = str(post.uri);
    if (seen.has(uri)) continue;
    seen.add(uri);
    const author = isObj(post.author) ? post.author : {};
    if (isHim(author)) {
      if (atTop) {
        out.likes = count(post.likeCount);
        out.reposts = count(post.repostCount);
      }
      out.ownUris.push(uri);
    } else {
      if (hidden.has(uri) || hasModerationLabel(post)) continue; // and its replies
      const text = clip(str(isObj(post.record) ? post.record.text : ""), MAX_REPLY_CHARS);
      if (text) out.replies.push({ author: authorLabel(author), text, at: postedAtMs(post) });
    }
    const replies = isObj(node) ? node.replies : undefined;
    if (Array.isArray(replies)) queue.push(...replies);
  }
  return out;
}

/** Counts from the first (root) read; replies from all reads, oldest first (stable), capped. */
function finish(walks: Walk[], maxReplies: number): ThreadEngagement {
  const all = walks.flatMap((w) => w.replies);
  const sorted = all.map((r, i) => ({ r, i })).sort((a, b) => a.r.at - b.r.at || a.i - b.i);
  return {
    likes: walks[0]?.likes ?? 0,
    reposts: walks[0]?.reposts ?? 0,
    replies: sorted.slice(0, maxReplies).map(({ r }) => ({ author: r.author, text: r.text })),
    repliesSeen: all.length,
    ownUris: walks.flatMap((w) => w.ownUris),
  };
}

/**
 * Parse one getPostThread response. `ownerDid` is him (the repo of the root uri).
 * `skip` = uris already counted by an earlier read; `hidden` = extra hidden reply uris.
 * Parents above the requested post are ignored.
 */
export function parseThread(
  json: unknown,
  ownerDid: string,
  opts: { maxReplies?: number; skip?: Set<string>; hidden?: Set<string> } = {},
): ThreadEngagement {
  const hidden = new Set([...(opts.hidden ?? []), ...hiddenRepliesOf(json)]);
  return finish([walkThread(json, ownerDid, new Set(opts.skip ?? []), hidden)], opts.maxReplies ?? MAX_REPLIES);
}

// ---------- fetching ----------

/** The post was deleted (or never existed): getPostThread says NotFound. */
export function isNotFound(error: unknown): boolean {
  return error instanceof BlueskyHttpError && (error.status === 404 || error.xrpcError === "NotFound");
}

export type ThreadSource = { service: string; accessJwt?: string };

export function postThreadUrl(service: string, uri: string, depth = THREAD_DEPTH): string {
  return `${service.replace(/\/+$/, "")}/xrpc/app.bsky.feed.getPostThread?uri=${encodeURIComponent(uri)}&depth=${depth}&parentHeight=0`;
}

/** One getPostThread call. Public AppView unless a session (his PDS + token) is given. */
export async function fetchPostThread(fetchFn: FetchFn, uri: string, source: ThreadSource = { service: PUBLIC_APPVIEW }): Promise<unknown> {
  const headers: Record<string, string> = source.accessJwt ? { Authorization: `Bearer ${source.accessJwt}` } : {};
  const res = await fetchFn(postThreadUrl(source.service, uri), { headers });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
    const name = typeof body?.error === "string" && /^[A-Za-z]{1,40}$/.test(body.error) ? body.error : undefined;
    throw new BlueskyHttpError("getPostThread", res.status, name);
  }
  return res.json();
}

/**
 * Engagement on one published thread. Reads from the root; if some of his `records` sit
 * deeper than THREAD_DEPTH, reads from the first unseen one too (at most MAX_EXTRA_READS).
 * Throws BlueskyHttpError (isNotFound when the root is gone).
 */
export async function threadEngagement(
  fetchFn: FetchFn,
  records: { uri: string }[],
  source?: ThreadSource,
): Promise<ThreadEngagement> {
  const rootUri = records[0]?.uri ?? "";
  const owner = repoOf(rootUri);
  if (!owner) throw new Error("Bluesky publication has no root at:// uri");
  const seen = new Set<string>(); // every uri read so far (his posts and replies)
  const rootJson = await fetchPostThread(fetchFn, rootUri, source);
  const hidden = hiddenRepliesOf(rootJson); // the gate lives on the root
  const walks = [walkThread(rootJson, owner, seen, hidden)];
  if (walks[0].ownUris.length === 0) throw new BlueskyHttpError("getPostThread", 404, "NotFound"); // root came back blocked/not found
  for (let extra = 0; extra < MAX_EXTRA_READS; extra++) {
    const next = records.find((r) => !seen.has(r.uri));
    if (!next) break;
    let more: Walk;
    try {
      const json = await fetchPostThread(fetchFn, next.uri, source);
      more = walkThread(json, owner, seen, new Set([...hidden, ...hiddenRepliesOf(json)]));
    } catch {
      break; // the tail is extra: keep what the root read found
    }
    if (more.ownUris.length === 0) break;
    walks.push(more);
  }
  return finish(walks, MAX_REPLIES);
}

// ---------- mapping ----------

export type BlueskyPublication = {
  _id: string;
  postId: string;
  status: string;
  url?: string;
  records?: { uri: string; cid: string }[];
  postedAt?: number;
  removedAt?: number;
  _creationTime: number;
};

/** Posted, not taken down, has a root record, and posted in the last `days`. Newest first. */
export function publicationsToScrape<T extends BlueskyPublication>(rows: T[], nowMs: number, days = SCRAPE_WINDOW_DAYS): T[] {
  const since = nowMs - days * 86_400_000;
  return rows
    .filter((r) => r.status === "posted" && r.removedAt === undefined && !!r.records?.[0]?.uri)
    .filter((r) => (r.postedAt ?? r._creationTime) >= since)
    .sort((a, b) => (b.postedAt ?? b._creationTime) - (a.postedAt ?? a._creationTime));
}

/** The web link we key engagement rows on: the stored url, else built from the root uri. */
export function publicationUrl(pub: BlueskyPublication): string {
  return (pub.url ?? "").trim() || webUrlFor(pub.records?.[0]?.uri ?? "");
}

export type UpsertArgs = {
  elderId: string;
  linkedinUrl: string;
  platform: "bluesky";
  postId: string;
  reactions: number;
  comments: Reply[];
};

/** engagement.upsert args: reactions = likes + reposts on the root post, comments = replies by others. */
export function toUpsertArgs(elderId: string, pub: BlueskyPublication, e: ThreadEngagement): UpsertArgs {
  return {
    elderId,
    linkedinUrl: publicationUrl(pub),
    platform: "bluesky",
    postId: pub.postId,
    reactions: e.likes + e.reposts,
    comments: e.replies,
  };
}
