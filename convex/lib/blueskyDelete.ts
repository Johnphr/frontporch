// Deleting his Bluesky posts (undo.ts): com.atproto.repo.deleteRecord through his PDS.
// `fetchFn` is passed in for tests (tests/undo.test.ts). Errors carry HTTP statuses only;
// never log tokens, passwords or post text.
//
//   com.atproto.repo.deleteRecord  { repo, collection, rkey } -> {} (200)
// A record that's already gone counts as deleted (404, or the XRPC error RecordNotFound).

import { POST_COLLECTION, parseAtUri } from "./bluesky.ts";
import { BlueskyHttpError, httpError, withSession, type BlueskySession, type FetchFn, type SessionCache } from "./blueskyClient.ts";
import type { BlueskyLogin } from "./logins.ts";

export type DeleteOutcome = { ok: true; deleted: number; alreadyGone: number } | { ok: false; error: string };

/** Delete order for a thread: replies first (last post first), the root last. Deduped, empty uris dropped. */
export function blueskyDeleteOrder(uris: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of [...uris].reverse()) {
    const uri = (u ?? "").trim();
    if (uri && !seen.has(uri)) {
      seen.add(uri);
      out.push(uri);
    }
  }
  return out;
}

/** Already gone: deleting it again is a success. */
export function isGoneError(error: unknown): boolean {
  if (!(error instanceof BlueskyHttpError)) return false;
  return error.status === 404 || error.xrpcError === "RecordNotFound";
}

/**
 * Delete one post of his. The uri must be a post (app.bsky.feed.post) in his own repo (his
 * session's did): we never delete anything else. Returns "gone" when it was already deleted.
 */
export async function deleteRecord(fetchFn: FetchFn, s: BlueskySession, uri: string): Promise<"deleted" | "gone"> {
  const at = parseAtUri(uri);
  if (!at || at.collection !== POST_COLLECTION) throw new Error("Not an at:// post uri.");
  if (at.repo !== s.did) throw new Error("That post isn't on his Bluesky account.");
  const res = await fetchFn(`${s.service}/xrpc/com.atproto.repo.deleteRecord`, {
    method: "POST",
    headers: { Authorization: `Bearer ${s.accessJwt}`, "Content-Type": "application/json" },
    body: JSON.stringify({ repo: at.repo, collection: at.collection, rkey: at.rkey }),
  });
  if (res.ok) return "deleted";
  const error = await httpError("delete", res);
  if (isGoneError(error)) return "gone";
  throw error;
}

function shortError(error: unknown): string {
  if (error instanceof BlueskyHttpError) return error.message;
  if (error instanceof Error && /^(Bluesky |Not an at|That post)/.test(error.message)) return error.message;
  return "Network error or timeout reaching Bluesky.";
}

/**
 * Delete every post of a thread (records[0] is the root): replies first, root last. Stops at
 * the first failure (the rest stay up, so a retry finishes the job; already-gone ones are fine).
 */
export async function deleteBlueskyThread(
  fetchFn: FetchFn,
  cache: SessionCache,
  login: BlueskyLogin | null,
  uris: string[],
): Promise<DeleteOutcome> {
  if (!login) return { ok: false, error: "His Bluesky account isn't connected." };
  const order = blueskyDeleteOrder(uris);
  if (!order.length) return { ok: false, error: "No Bluesky post uris saved for it: check his profile and delete by hand." };
  let deleted = 0;
  let alreadyGone = 0;
  try {
    for (const uri of order) {
      // withSession retries once on an expired token; deleting twice is harmless anyway.
      const r = await withSession(fetchFn, cache, login, (s) => deleteRecord(fetchFn, s, uri));
      if (r === "deleted") deleted += 1;
      else alreadyGone += 1;
    }
  } catch (error) {
    return { ok: false, error: shortError(error) };
  }
  return { ok: true, deleted, alreadyGone };
}
