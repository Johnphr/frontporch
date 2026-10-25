// Bluesky HTTP calls (XRPC) through his PDS (BLUESKY_SERVICE, default https://bsky.social).
// app.bsky.* calls are proxied by the PDS to the AppView, so searchPosts works with his session
// (the public AppView refuses unauthenticated search). `fetchFn` is passed in for tests.
// Never log tokens, passwords or post bodies; errors carry HTTP statuses only.
//
// Sessions: createSession is rate-limited per account (30 / 5 min, 300 / day), so a session is
// reused through a SessionCache (in memory only: tokens are never stored in the database) and
// renewed with refreshSession before falling back to a new login.

import { POST_COLLECTION, blueskyItemsFromSearch, searchPostsQuery, type StrongRef } from "./bluesky.ts";
import type { ListedPost } from "./blueskyThread.ts";

export type FetchFn = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export const DEFAULT_SERVICE = "https://bsky.social";

export type BlueskySession = {
  service: string;
  accessJwt: string;
  refreshJwt?: string;
  did: string;
  handle: string;
  /** ms epoch when the access token was issued (for reuse decisions) */
  obtainedAt?: number;
};

/** An HTTP error from Bluesky: the status and the XRPC error name only, never the body text. */
export class BlueskyHttpError extends Error {
  status: number;
  xrpcError?: string;
  constructor(what: string, status: number, xrpcError?: string) {
    super(`Bluesky ${what} HTTP ${status}${xrpcError ? ` (${xrpcError})` : ""}`);
    this.name = "BlueskyHttpError";
    this.status = status;
    if (xrpcError) this.xrpcError = xrpcError;
  }
}

export async function httpError(what: string, res: { status: number; json(): Promise<unknown> }): Promise<BlueskyHttpError> {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  const name = typeof body?.error === "string" && /^[A-Za-z]{1,40}$/.test(body.error) ? body.error : undefined;
  return new BlueskyHttpError(what, res.status, name);
}

/** The access token expired or was refused (the request did nothing): renew and retry once. */
export function isAuthError(error: unknown): boolean {
  if (!(error instanceof BlueskyHttpError)) return false;
  if (error.status === 401) return true;
  return error.status === 400 && (error.xrpcError === "ExpiredToken" || error.xrpcError === "InvalidToken");
}

export function blueskyService(value: string | undefined): string {
  const s = (value ?? "").trim().replace(/\/+$/, "");
  return /^https:\/\//.test(s) ? s : DEFAULT_SERVICE;
}

export async function createSession(
  fetchFn: FetchFn,
  creds: { service: string; identifier: string; password: string },
): Promise<BlueskySession> {
  const res = await fetchFn(`${creds.service}/xrpc/com.atproto.server.createSession`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: creds.identifier, password: creds.password }),
  });
  if (!res.ok) throw await httpError("login", res);
  return sessionFrom(await res.json(), creds.service, creds.identifier);
}

function sessionFrom(json: unknown, service: string, fallbackHandle: string): BlueskySession {
  const j = (json ?? {}) as { accessJwt?: unknown; refreshJwt?: unknown; did?: unknown; handle?: unknown };
  if (typeof j.accessJwt !== "string" || typeof j.did !== "string") throw new Error("Bluesky login returned no session");
  return {
    service,
    accessJwt: j.accessJwt,
    ...(typeof j.refreshJwt === "string" ? { refreshJwt: j.refreshJwt } : {}),
    did: j.did,
    handle: typeof j.handle === "string" ? j.handle : fallbackHandle,
    obtainedAt: Date.now(),
  };
}

/** New access token from the refresh token (doesn't count against the login rate limit). */
export async function refreshSession(fetchFn: FetchFn, s: BlueskySession): Promise<BlueskySession> {
  if (!s.refreshJwt) throw new Error("Bluesky session has no refresh token");
  const res = await fetchFn(`${s.service}/xrpc/com.atproto.server.refreshSession`, {
    method: "POST",
    headers: { Authorization: `Bearer ${s.refreshJwt}` },
  });
  if (!res.ok) throw await httpError("refresh", res);
  return sessionFrom(await res.json(), s.service, s.handle);
}

// ---------- session reuse ----------

/** Access tokens from bsky.social last about 2 hours; reuse one for at most this long. */
export const SESSION_REUSE_MS = 60 * 60_000;

export type BlueskyLoginCreds = { service: string; identifier: string; password: string };
export type SessionCache = Map<string, BlueskySession>;

/** Module-level cache: lives as long as the Convex isolate does (best effort, memory only). */
const SHARED_CACHE: SessionCache = new Map();
export function sharedSessionCache(): SessionCache {
  return SHARED_CACHE;
}

function cacheKey(creds: BlueskyLoginCreds): string {
  return `${creds.service}|${creds.identifier.trim().toLowerCase()}`;
}

/**
 * A usable session: the cached one while it's fresh, else refreshed from its refresh token,
 * else a new login. `force` skips the cached access token (Bluesky refused it).
 */
export async function getSession(
  fetchFn: FetchFn,
  cache: SessionCache,
  creds: BlueskyLoginCreds,
  opts: { now?: number; force?: boolean } = {},
): Promise<BlueskySession> {
  const now = opts.now ?? Date.now();
  const key = cacheKey(creds);
  const cached = cache.get(key);
  if (cached && !opts.force && cached.obtainedAt !== undefined && now - cached.obtainedAt < SESSION_REUSE_MS) return cached;
  if (cached?.refreshJwt) {
    try {
      const refreshed = await refreshSession(fetchFn, cached);
      cache.set(key, refreshed);
      return refreshed;
    } catch {
      cache.delete(key); // refresh token expired or revoked: log in again
    }
  }
  const fresh = await createSession(fetchFn, creds);
  cache.set(key, fresh);
  return fresh;
}

/**
 * Run `fn` with a session; if Bluesky refuses the token (expired / invalid), get a new one and
 * run `fn` once more. Safe because an auth error means the request was rejected untouched.
 */
export async function withSession<T>(
  fetchFn: FetchFn,
  cache: SessionCache,
  creds: BlueskyLoginCreds,
  fn: (s: BlueskySession) => Promise<T>,
): Promise<T> {
  const session = await getSession(fetchFn, cache, creds);
  try {
    return await fn(session);
  } catch (error) {
    if (!isAuthError(error)) throw error;
    return fn(await getSession(fetchFn, cache, creds, { force: true }));
  }
}

function auth(s: BlueskySession): Record<string, string> {
  return { Authorization: `Bearer ${s.accessJwt}` };
}

/** Recent posts for one keyword, as raw audience-question items. */
export async function searchPosts(
  fetchFn: FetchFn,
  s: BlueskySession,
  keyword: string,
  opts: { limit?: number; lang?: string; since?: string } = {},
): Promise<Record<string, unknown>[]> {
  const res = await fetchFn(`${s.service}/xrpc/app.bsky.feed.searchPosts?${searchPostsQuery(keyword, opts)}`, { headers: auth(s) });
  if (!res.ok) throw await httpError("search", res);
  return blueskyItemsFromSearch(await res.json());
}

/** One post's current view (cid + record.reply), or undefined if it's gone. */
export async function getPost(fetchFn: FetchFn, s: BlueskySession, uri: string): Promise<unknown | undefined> {
  const res = await fetchFn(`${s.service}/xrpc/app.bsky.feed.getPosts?uris=${encodeURIComponent(uri)}`, { headers: auth(s) });
  if (!res.ok) throw await httpError("getPosts", res);
  const posts = ((await res.json()) as { posts?: unknown } | null)?.posts;
  return Array.isArray(posts) && posts.length ? posts[0] : undefined;
}

/**
 * His reply directly under `parentUri`, if he already answered it (so a retry after an unclear
 * failure doesn't post twice). Reads the parent's direct replies (getPostThread, depth 1).
 */
export async function findOwnReply(
  fetchFn: FetchFn,
  s: BlueskySession,
  parentUri: string,
): Promise<{ uri: string } | undefined> {
  const res = await fetchFn(
    `${s.service}/xrpc/app.bsky.feed.getPostThread?uri=${encodeURIComponent(parentUri)}&depth=1&parentHeight=0`,
    { headers: auth(s) },
  );
  if (!res.ok) throw await httpError("getPostThread", res);
  return ownReplyIn(await res.json(), s.did);
}

/** Pure: the first direct reply in a getPostThread response written by `did`. */
export function ownReplyIn(json: unknown, did: string): { uri: string } | undefined {
  const replies = ((json ?? {}) as { thread?: { replies?: unknown } }).thread?.replies;
  if (!Array.isArray(replies)) return undefined;
  for (const r of replies) {
    const post = (r as { post?: { uri?: unknown; author?: { did?: unknown } } } | null)?.post;
    if (post && post.author?.did === did && typeof post.uri === "string") return { uri: post.uri };
  }
  return undefined;
}

/** Create his reply post. Returns the new post's uri. */
export async function createReply(
  fetchFn: FetchFn,
  s: BlueskySession,
  a: { text: string; langs: string[]; reply: { root: StrongRef; parent: StrongRef }; now?: Date },
): Promise<{ uri: string; cid?: string }> {
  const record = {
    $type: POST_COLLECTION,
    text: a.text,
    createdAt: (a.now ?? new Date()).toISOString(),
    langs: a.langs.slice(0, 3),
    reply: a.reply,
  };
  const res = await fetchFn(`${s.service}/xrpc/com.atproto.repo.createRecord`, {
    method: "POST",
    headers: { ...auth(s), "Content-Type": "application/json" },
    body: JSON.stringify({ repo: s.did, collection: POST_COLLECTION, record }),
  });
  if (!res.ok) throw await httpError("post", res);
  const j = (await res.json()) as { uri?: unknown; cid?: unknown };
  if (typeof j.uri !== "string") throw new Error("Bluesky returned no post uri");
  return { uri: j.uri, ...(typeof j.cid === "string" ? { cid: j.cid } : {}) };
}

// ---------- story threads ----------

/** createRecord answered 2xx but without a usable uri + cid: the post may exist. */
export class BlueskyNoRecordError extends Error {
  status: number;
  constructor(status: number) {
    super(`Bluesky post HTTP ${status} returned no uri/cid`);
    this.name = "BlueskyNoRecordError";
    this.status = status;
  }
}

/** One post (optionally a reply). Returns its strong ref (uri + cid), needed to reply to it. */
export async function createPost(
  fetchFn: FetchFn,
  s: BlueskySession,
  a: { text: string; langs: string[]; reply?: { root: StrongRef; parent: StrongRef }; facets?: unknown[]; now?: Date },
): Promise<StrongRef> {
  const record = {
    $type: POST_COLLECTION,
    text: a.text,
    createdAt: (a.now ?? new Date()).toISOString(),
    langs: a.langs.slice(0, 3),
    ...(a.facets?.length ? { facets: a.facets } : {}),
    ...(a.reply ? { reply: a.reply } : {}),
  };
  const res = await fetchFn(`${s.service}/xrpc/com.atproto.repo.createRecord`, {
    method: "POST",
    headers: { ...auth(s), "Content-Type": "application/json" },
    body: JSON.stringify({ repo: s.did, collection: POST_COLLECTION, record }),
  });
  if (!res.ok) throw await httpError("post", res);
  const j = (await res.json().catch(() => null)) as { uri?: unknown; cid?: unknown } | null;
  if (typeof j?.uri !== "string" || !j.uri || typeof j.cid !== "string" || !j.cid) throw new BlueskyNoRecordError(res.status);
  return { uri: j.uri, cid: j.cid };
}

/**
 * How a thread run ended. `records` is every post that exists, root first, also on failure,
 * so a retry continues the thread instead of posting it twice.
 *   sent: the failing request was a createRecord (it may have landed unless the status says
 *   it was refused); false = it failed before posting (login), nothing new went out.
 */
export type ThreadOutcome =
  | { ok: true; records: StrongRef[]; handle: string }
  | { ok: false; records: StrongRef[]; handle?: string; error: string; sent: boolean; httpStatus?: number };

/**
 * Post a thread: texts[0] is the root, each next post replies with root = the first post and
 * parent = the one before. `done` = posts an earlier run already made (the thread continues
 * after them). Each post goes through withSession, so an expired token is renewed and only
 * that (refused) post is sent again. Never throws.
 */
export async function createThread(
  fetchFn: FetchFn,
  cache: SessionCache,
  creds: BlueskyLoginCreds,
  a: { texts: string[]; langs: string[]; done?: StrongRef[]; facetsFor?: (text: string) => unknown[]; now?: () => number },
): Promise<ThreadOutcome> {
  const records = [...(a.done ?? [])];
  const now = a.now ?? Date.now;
  let handle: string | undefined;
  for (let i = records.length; i < a.texts.length; i++) {
    let createError: unknown;
    try {
      const made = await withSession(fetchFn, cache, creds, async (s) => {
        handle = s.handle;
        try {
          return await createPost(fetchFn, s, {
            text: a.texts[i],
            langs: a.langs,
            ...(i > 0 ? { reply: { root: records[0], parent: records[i - 1] } } : {}),
            ...(a.facetsFor ? { facets: a.facetsFor(a.texts[i]) } : {}),
            now: new Date(now() + i), // strictly increasing, so the thread reads in order
          });
        } catch (error) {
          createError = error;
          throw error;
        }
      });
      records.push(made);
    } catch (error) {
      const sent = error === createError;
      const httpStatus = error instanceof BlueskyHttpError || error instanceof BlueskyNoRecordError ? error.status : undefined;
      const message = !sent && error instanceof BlueskyHttpError && error.status >= 400 && error.status < 500
        ? loginRefusedMessage(error)
        : error instanceof BlueskyHttpError || error instanceof BlueskyNoRecordError
          ? error.message
          : sent
            ? "Network error, timeout or unreadable answer while posting to Bluesky"
            : "Network error or timeout logging in to Bluesky";
      return { ok: false, records, ...(handle ? { handle } : {}), error: message, sent, ...(httpStatus !== undefined ? { httpStatus } : {}) };
    }
  }
  if (!handle) {
    // Everything was already there: still need his handle for the web link.
    try {
      handle = (await getSession(fetchFn, cache, creds)).handle;
    } catch {
      handle = creds.identifier;
    }
  }
  return { ok: true, records, handle };
}

/** "Bluesky login refused: HTTP 401 (AuthenticationRequired)": status + XRPC error name only. */
export function loginRefusedMessage(error: BlueskyHttpError): string {
  return `Bluesky login refused: HTTP ${error.status}${error.xrpcError ? ` (${error.xrpcError})` : ""}`;
}

/** His newest posts (straight from his repo, so the cid is there), for finding an earlier run's thread. */
export async function listOwnPosts(fetchFn: FetchFn, s: BlueskySession, limit = 50): Promise<ListedPost[]> {
  const q = new URLSearchParams({ repo: s.did, collection: POST_COLLECTION, limit: String(Math.min(100, Math.max(1, limit))) });
  const res = await fetchFn(`${s.service}/xrpc/com.atproto.repo.listRecords?${q.toString()}`, { headers: auth(s) });
  if (!res.ok) throw await httpError("listRecords", res);
  const records = ((await res.json()) as { records?: unknown } | null)?.records;
  if (!Array.isArray(records)) return [];
  const out: ListedPost[] = [];
  for (const r of records) {
    const x = (r ?? {}) as { uri?: unknown; cid?: unknown; value?: { text?: unknown; reply?: { parent?: { uri?: unknown } } } };
    if (typeof x.uri !== "string" || typeof x.cid !== "string" || typeof x.value?.text !== "string") continue;
    const parentUri = x.value.reply?.parent?.uri;
    out.push({ uri: x.uri, cid: x.cid, text: x.value.text, ...(typeof parentUri === "string" ? { parentUri } : {}) });
  }
  return out;
}
