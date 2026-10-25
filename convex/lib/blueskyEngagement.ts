// Reader engagement on his Bluesky threads, from app.bsky.feed.getPostThread.
//
//   parseThread       pure: likes + reposts on HIS posts, replies by OTHERS (capped)
//   fetchPostThread   one getPostThread call (public AppView by default, or his PDS with a session)
//   threadEngagement  root thread, plus any of his records the root read didn't reach (long threads)
//   toUpsertArgs      result -> engagement.upsert args
//   publicationsToScrape  which postPublications rows to read (posted, not removed, recent)
//
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

export type Reply = { author: string; text: string };

export type ThreadEngagement = {
  likes: number;
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

/**
 * Walk a getPostThread response (breadth first, so direct replies come before nested ones).
 * `ownerDid` is him (the repo of the root uri). `skip` = uris already counted by an earlier read.
 * Parents above the requested post are ignored.
 */
export function parseThread(
  json: unknown,
  ownerDid: string,
  opts: { maxReplies?: number; skip?: Set<string> } = {},
): ThreadEngagement {
  const maxReplies = opts.maxReplies ?? MAX_REPLIES;
  const seen = new Set(opts.skip ?? []);
  const out: ThreadEngagement = { likes: 0, reposts: 0, replies: [], repliesSeen: 0, ownUris: [] };
  const root = isObj(json) ? json.thread : undefined;
  const queue: unknown[] = [root];
  while (queue.length) {
    const node = queue.shift();
    const post = postOf(node);
    if (!post) continue; // blocked, deleted or not found: skip it and everything under it
    const uri = str(post.uri);
    if (seen.has(uri)) continue;
    seen.add(uri);
    const author = isObj(post.author) ? post.author : {};
    const isHim = !!ownerDid && (author.did === ownerDid || author.handle === ownerDid);
    if (isHim) {
      out.likes += count(post.likeCount);
      out.reposts += count(post.repostCount);
      out.ownUris.push(uri);
    } else {
      const text = clip(str(isObj(post.record) ? post.record.text : ""), MAX_REPLY_CHARS);
      if (text) {
        out.repliesSeen += 1;
        if (out.replies.length < maxReplies) out.replies.push({ author: authorLabel(author), text });
      }
    }
    const replies = isObj(node) ? node.replies : undefined;
    if (Array.isArray(replies)) queue.push(...replies);
  }
  return out;
}

/** Add a later read (a long thread's tail) to the first one, respecting the reply cap. */
export function mergeEngagement(a: ThreadEngagement, b: ThreadEngagement, maxReplies = MAX_REPLIES): ThreadEngagement {
  return {
    likes: a.likes + b.likes,
    reposts: a.reposts + b.reposts,
    replies: [...a.replies, ...b.replies].slice(0, maxReplies),
    repliesSeen: a.repliesSeen + b.repliesSeen,
    ownUris: [...a.ownUris, ...b.ownUris],
  };
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
  let result = parseThread(await fetchPostThread(fetchFn, rootUri, source), owner);
  if (result.ownUris.length === 0) throw new BlueskyHttpError("getPostThread", 404, "NotFound"); // root came back blocked/not found
  for (let extra = 0; extra < MAX_EXTRA_READS; extra++) {
    const seen = new Set(result.ownUris);
    const next = records.find((r) => !seen.has(r.uri));
    if (!next) break;
    let more: ThreadEngagement;
    try {
      more = parseThread(await fetchPostThread(fetchFn, next.uri, source), owner, { skip: seen });
    } catch {
      break; // the tail is extra: keep what the root read found
    }
    if (more.ownUris.length === 0) break;
    result = mergeEngagement(result, more);
  }
  return result;
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

/** engagement.upsert args: reactions = likes + reposts on his posts, comments = replies by others. */
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
