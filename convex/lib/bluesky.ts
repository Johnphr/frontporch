// Bluesky (AT Protocol) pure helpers: unit-tested in tests/bluesky.test.ts.
// Shapes follow the official lexicons (github.com/bluesky-social/atproto, packages/api/lexicons):
//   app.bsky.feed.searchPosts  (q, sort, since, lang, limit, cursor) -> { posts: PostView[] }
//                              "may require authentication": the public AppView answers 403,
//                              so we search through his PDS with a session token
//   app.bsky.feed.getPosts     (uris[] max 25) -> { posts: PostView[] }
//   app.bsky.feed.post         record { text (max 300 graphemes), createdAt, langs?, reply? }
//                              reply = { root: strongRef, parent: strongRef }, strongRef = {uri, cid}
//   com.atproto.server.createSession  { identifier, password } -> { accessJwt, did, handle }
//   com.atproto.repo.createRecord     { repo, collection, record } -> { uri, cid }

import { cleanText } from "./text.ts";

export const POST_COLLECTION = "app.bsky.feed.post";
export const MAX_POST_GRAPHEMES = 300;

export type StrongRef = { uri: string; cid: string };

/** Grapheme count (what Bluesky limits). Falls back to code points, which never undercounts. */
export function graphemeCount(text: string): number {
  const Seg = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: string }) => { segment(s: string): Iterable<unknown> } }).Segmenter;
  if (Seg) {
    let n = 0;
    for (const _ of new Seg(undefined, { granularity: "grapheme" }).segment(text)) n += 1;
    return n;
  }
  return Array.from(text).length;
}

function graphemes(text: string): string[] {
  const Seg = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: string }) => { segment(s: string): Iterable<{ segment: string }> } }).Segmenter;
  if (Seg) return Array.from(new Seg(undefined, { granularity: "grapheme" }).segment(text), (s) => s.segment);
  return Array.from(text);
}

/** Cut to `max` graphemes on a word boundary (never splits a grapheme), adding "…" when cut. */
export function clampGraphemes(text: string, max: number): string {
  const t = text.trim();
  if (graphemeCount(t) <= max) return t;
  if (max <= 1) return graphemes(t).slice(0, Math.max(0, max)).join("");
  const head = graphemes(t).slice(0, max - 1).join("");
  const cut = head.replace(/\s+\S*$/, "").replace(/[\s,;:.\-–—]+$/, "");
  return `${cut.length >= head.length * 0.5 ? cut : head.trimEnd()}…`;
}

/** at://<did-or-handle>/app.bsky.feed.post/<rkey> -> { repo, rkey } */
export function parseAtUri(uri: string | undefined): { repo: string; collection: string; rkey: string } | undefined {
  const m = /^at:\/\/([^/]+)\/([^/]+)\/([^/?#]+)$/.exec((uri ?? "").trim());
  return m ? { repo: m[1], collection: m[2], rkey: m[3] } : undefined;
}

/** Web link for a post: https://bsky.app/profile/<handle or did>/post/<rkey> */
export function postWebUrl(uri: string, handle?: string): string | undefined {
  const at = parseAtUri(uri);
  if (!at || at.collection !== POST_COLLECTION) return undefined;
  return `https://bsky.app/profile/${encodeURIComponent(handle || at.repo)}/post/${encodeURIComponent(at.rkey)}`;
}

type PostView = {
  uri?: unknown;
  cid?: unknown;
  author?: { handle?: unknown; did?: unknown };
  record?: { text?: unknown; createdAt?: unknown; langs?: unknown; reply?: { root?: unknown; parent?: unknown } };
  replyCount?: unknown;
  likeCount?: unknown;
  repostCount?: unknown;
  indexedAt?: unknown;
};

function strongRef(x: unknown): StrongRef | undefined {
  const r = (x ?? {}) as { uri?: unknown; cid?: unknown };
  return typeof r.uri === "string" && r.uri && typeof r.cid === "string" && r.cid ? { uri: r.uri, cid: r.cid } : undefined;
}

/**
 * searchPosts PostView -> a raw audience-question item for lib/questionSources.normalize
 * (fields: title, body, url, id, community, score, answers, postedAt, atUri). Null when unusable.
 * The whole post text is the question (Bluesky posts have no title).
 */
export function blueskyItem(post: unknown): Record<string, unknown> | null {
  const p = (post ?? {}) as PostView;
  const uri = typeof p.uri === "string" ? p.uri : "";
  const text = cleanText(p.record?.text);
  const handle = typeof p.author?.handle === "string" ? p.author.handle : "";
  const url = postWebUrl(uri, handle);
  if (!uri || !text || !url) return null;
  const likes = typeof p.likeCount === "number" ? p.likeCount : 0;
  const reposts = typeof p.repostCount === "number" ? p.repostCount : 0;
  const createdAt = typeof p.record?.createdAt === "string" ? p.record.createdAt : typeof p.indexedAt === "string" ? p.indexedAt : undefined;
  return {
    title: text,
    url,
    id: uri,
    atUri: uri,
    community: "Bluesky",
    score: likes + reposts,
    ...(typeof p.replyCount === "number" ? { answers: p.replyCount } : {}),
    ...(createdAt ? { postedAt: createdAt } : {}),
  };
}

/** searchPosts JSON -> raw items (unusable posts dropped). */
export function blueskyItemsFromSearch(json: unknown): Record<string, unknown>[] {
  const posts = (json as { posts?: unknown } | null)?.posts;
  return Array.isArray(posts) ? posts.map(blueskyItem).filter((x): x is Record<string, unknown> => x !== null) : [];
}

/**
 * The reply ref for answering `question` (a getPosts PostView): parent = the question post;
 * root = its own reply.root if it is itself a reply, else the question post.
 */
export function replyRefFor(question: unknown): { root: StrongRef; parent: StrongRef } | undefined {
  const p = (question ?? {}) as PostView;
  const parent = strongRef({ uri: p.uri, cid: p.cid });
  if (!parent) return undefined;
  const root = strongRef(p.record?.reply?.root) ?? parent;
  return { root, parent };
}

/** searchPosts query string for one keyword: newest posts that read like questions. */
export function searchPostsQuery(keyword: string, opts: { limit?: number; lang?: string; since?: string } = {}): string {
  const params = new URLSearchParams({ q: keyword, sort: "latest", limit: String(Math.min(100, Math.max(1, opts.limit ?? 25))) });
  if (opts.lang) params.set("lang", opts.lang);
  if (opts.since) params.set("since", opts.since);
  return params.toString();
}
