// How readers reacted to his X posts: pure reading + parsing (fetchFn passed in;
// tests/xEngagement.test.ts). xEngagement.ts runs it daily and calls engagement:upsert.
//
//   metrics   GET /2/tweets?ids=<root ids, up to 100>&tweet.fields=public_metrics
//             reactions = likes + retweets + quotes on the root post
//   replies   only with X_READ_REPLIES=on, and only for posts from the last 7 days (recent
//             search's window): GET /2/tweets/search/recent?query=conversation_id:<root> -from:<him>
//             at most 10, his own left out. Read only: we never answer them from X.
// X bills every post (and user) it returns: ~$0.005 per post read on pay-per-use, so the
// whole thing is behind X_READ_FEEDBACK=on and we count the reads.

import { isSwitchOn } from "./postFlow.ts";
import { X_API, type FetchFn } from "./xOAuth.ts";
import { xPostUrl } from "./xPublishing.ts";

export const X_WINDOW_DAYS = 30;
export const X_SEARCH_DAYS = 7;
export const X_MAX_REPLIES = 10;
export const X_MAX_IDS = 100;
const MAX_REPLY_CHARS = 500;

export const xFeedbackOn = (env: Record<string, string | undefined>) => isSwitchOn(env.X_READ_FEEDBACK);
export const xRepliesOn = (env: Record<string, string | undefined>) => isSwitchOn(env.X_READ_REPLIES);

export type XPublication = {
  _id: string;
  postId: string;
  status: string;
  _creationTime: number;
  url?: string;
  records?: { uri: string; cid: string }[];
  postedAt?: number;
  removedAt?: number;
};

export type XMetrics = { likes: number; retweets: number; quotes: number; replies: number };
export type XReply = { author: string; text: string };

const rootId = (p: XPublication) => p.records?.[0]?.uri ?? "";
const postedAt = (p: XPublication) => p.postedAt ?? p._creationTime;

/** Posted, not removed, a numeric root id, from the last 30 days; newest first. */
export function xPublicationsToRead<T extends XPublication>(rows: T[], nowMs: number, days = X_WINDOW_DAYS): T[] {
  const since = nowMs - days * 86_400_000;
  return rows
    .filter((r) => r.status === "posted" && r.removedAt === undefined && /^\d+$/.test(rootId(r)) && postedAt(r) >= since)
    .sort((a, b) => postedAt(b) - postedAt(a));
}

/** The link we key engagement rows on. */
export function xPublicationUrl(pub: XPublication, username: string): string {
  return (pub.url ?? "").trim() || xPostUrl(username, rootId(pub)) || "";
}

export function metricsUrl(ids: string[]): string {
  return `${X_API}/tweets?ids=${ids.join(",")}&tweet.fields=public_metrics`;
}

const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

/** /2/tweets?ids=... -> metrics per id, ids X says are gone, and how many posts it returned. */
export function parseMetrics(json: unknown): { metrics: Map<string, XMetrics>; gone: Set<string>; returned: number } {
  const body = (json ?? {}) as { data?: unknown; errors?: unknown };
  const metrics = new Map<string, XMetrics>();
  const data = Array.isArray(body.data) ? body.data : [];
  for (const t of data as { id?: unknown; public_metrics?: Record<string, unknown> }[]) {
    if (typeof t?.id !== "string") continue;
    const m = t.public_metrics ?? {};
    metrics.set(t.id, { likes: count(m.like_count), retweets: count(m.retweet_count), quotes: count(m.quote_count), replies: count(m.reply_count) });
  }
  const gone = new Set<string>();
  for (const e of (Array.isArray(body.errors) ? body.errors : []) as { resource_id?: unknown; value?: unknown; title?: unknown; type?: unknown }[]) {
    const id = typeof e?.resource_id === "string" ? e.resource_id : typeof e?.value === "string" ? e.value : "";
    if (id && /not found|resource-not-found/i.test(`${e.title ?? ""} ${e.type ?? ""}`)) gone.add(id);
  }
  return { metrics, gone, returned: data.length };
}

export const reactionsOf = (m: XMetrics) => m.likes + m.retweets + m.quotes;

/** Recent search for replies to his post by others (query built here, ids only). */
export function searchUrl(root: string, ownUserId: string): string {
  const q = new URLSearchParams({
    query: `conversation_id:${root} -from:${ownUserId} -is:retweet`,
    max_results: String(X_MAX_REPLIES),
    "tweet.fields": "author_id,conversation_id",
    expansions: "author_id",
    "user.fields": "username",
  });
  return `${X_API}/tweets/search/recent?${q.toString()}`;
}

/** Search results -> replies by others (his own dropped), at most 10, plus resources returned. */
export function parseReplies(json: unknown, ownUserId: string, cap = X_MAX_REPLIES): { replies: XReply[]; returned: number } {
  const body = (json ?? {}) as { data?: unknown; includes?: { users?: unknown } };
  const data = (Array.isArray(body.data) ? body.data : []) as { text?: unknown; author_id?: unknown }[];
  const users = (Array.isArray(body.includes?.users) ? body.includes!.users : []) as { id?: unknown; username?: unknown }[];
  const names = new Map(users.filter((u) => typeof u?.id === "string" && typeof u.username === "string").map((u) => [u.id as string, u.username as string]));
  const replies: XReply[] = [];
  for (const t of data) {
    if (replies.length >= cap) break;
    if (typeof t?.text !== "string" || t.author_id === ownUserId) continue;
    // Drop the leading @handles X adds to replies.
    const text = t.text.replace(/^(?:@\w{1,15}\s+)+/, "").trim().slice(0, MAX_REPLY_CHARS);
    if (!text) continue;
    const name = typeof t.author_id === "string" ? names.get(t.author_id) : undefined;
    replies.push({ author: name ? `@${name}` : "an X reader", text });
  }
  return { replies, returned: data.length + users.length };
}

export type XEngagementItem = { pub: XPublication; url: string; reactions: number; comments: XReply[]; commentsKnown: boolean };

export type XReadResult = { items: XEngagementItem[]; reads: number; gone: number; errors: string[] };

/**
 * Read metrics (and, if `replies`, reply texts) for these publications with his login.
 * Errors carry HTTP statuses only.
 */
export async function readXEngagement(
  fetchFn: FetchFn,
  login: { accessToken: string; userId: string; username: string },
  pubs: XPublication[],
  opts: { replies: boolean; now: number },
): Promise<XReadResult> {
  const out: XReadResult = { items: [], reads: 0, gone: 0, errors: [] };
  const auth = { Authorization: `Bearer ${login.accessToken}` };
  const metrics = new Map<string, XMetrics>();
  const gone = new Set<string>();
  const ids = [...new Set(pubs.map(rootId))];
  for (let i = 0; i < ids.length; i += X_MAX_IDS) {
    const chunk = ids.slice(i, i + X_MAX_IDS);
    try {
      const res = await fetchFn(metricsUrl(chunk), { method: "GET", headers: auth });
      if (!res.ok) {
        out.errors.push(`X metrics HTTP ${res.status}`);
        continue;
      }
      const parsed = parseMetrics(await res.json().catch(() => null));
      out.reads += parsed.returned;
      for (const [id, m] of parsed.metrics) metrics.set(id, m);
      for (const id of parsed.gone) gone.add(id);
    } catch {
      out.errors.push("X metrics: network error or timeout");
    }
  }

  const searchSince = opts.now - X_SEARCH_DAYS * 86_400_000;
  for (const pub of pubs) {
    const id = rootId(pub);
    if (gone.has(id)) {
      out.gone += 1;
      continue;
    }
    const m = metrics.get(id);
    if (!m) continue; // the metrics read failed: try again tomorrow
    const url = xPublicationUrl(pub, login.username);
    if (!url) {
      out.errors.push(`${pub._id}: no post link`);
      continue;
    }
    let comments: XReply[] = [];
    let commentsKnown = false;
    // Search only when there may be replies by others, inside recent search's 7-day window.
    // A thread always may: the root's reply_count includes his own post 2, and misses replies
    // to later posts.
    const maybeReplies = m.replies > 0 || (pub.records?.length ?? 0) > 1;
    if (opts.replies && maybeReplies && postedAt(pub) >= searchSince) {
      try {
        const res = await fetchFn(searchUrl(id, login.userId), { method: "GET", headers: auth });
        if (res.ok) {
          const parsed = parseReplies(await res.json().catch(() => null), login.userId);
          out.reads += parsed.returned;
          comments = parsed.replies;
          commentsKnown = true;
        } else out.errors.push(`X search HTTP ${res.status}`);
      } catch {
        out.errors.push("X search: network error or timeout");
      }
    } else if (opts.replies && !maybeReplies) {
      commentsKnown = true; // a single post nobody replied to: no read needed
    }
    out.items.push({ pub, url, reactions: reactionsOf(m), comments, commentsKnown });
  }
  return out;
}
