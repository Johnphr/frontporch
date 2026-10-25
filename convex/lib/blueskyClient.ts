// Bluesky HTTP calls (XRPC) through his PDS (BLUESKY_SERVICE, default https://bsky.social).
// app.bsky.* calls are proxied by the PDS to the AppView, so searchPosts works with his session
// (the public AppView refuses unauthenticated search). `fetchFn` is passed in for tests.
// Never log tokens, passwords or post bodies; errors carry HTTP statuses only.

import { POST_COLLECTION, blueskyItemsFromSearch, searchPostsQuery, type StrongRef } from "./bluesky.ts";

export type FetchFn = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export const DEFAULT_SERVICE = "https://bsky.social";

export type BlueskySession = { service: string; accessJwt: string; did: string; handle: string };

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
  if (!res.ok) throw new Error(`Bluesky login HTTP ${res.status}`);
  const j = (await res.json()) as { accessJwt?: unknown; did?: unknown; handle?: unknown };
  if (typeof j.accessJwt !== "string" || typeof j.did !== "string") throw new Error("Bluesky login returned no session");
  return { service: creds.service, accessJwt: j.accessJwt, did: j.did, handle: typeof j.handle === "string" ? j.handle : creds.identifier };
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
  if (!res.ok) throw new Error(`Bluesky search HTTP ${res.status}`);
  return blueskyItemsFromSearch(await res.json());
}

/** One post's current view (cid + record.reply), or undefined if it's gone. */
export async function getPost(fetchFn: FetchFn, s: BlueskySession, uri: string): Promise<unknown | undefined> {
  const res = await fetchFn(`${s.service}/xrpc/app.bsky.feed.getPosts?uris=${encodeURIComponent(uri)}`, { headers: auth(s) });
  if (!res.ok) throw new Error(`Bluesky getPosts HTTP ${res.status}`);
  const posts = ((await res.json()) as { posts?: unknown } | null)?.posts;
  return Array.isArray(posts) && posts.length ? posts[0] : undefined;
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
  if (!res.ok) throw new Error(`Bluesky post HTTP ${res.status}`);
  const j = (await res.json()) as { uri?: unknown; cid?: unknown };
  if (typeof j.uri !== "string") throw new Error("Bluesky returned no post uri");
  return { uri: j.uri, ...(typeof j.cid === "string" ? { cid: j.cid } : {}) };
}
