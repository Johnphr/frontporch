// Posting a thread reply: the HTTP side, with `fetchFn` passed in so tests can drive it
// (tests/replyPosting.test.ts). convex/threadReplies.ts only wires these to the database.
//
// Every outcome says whether something may have gone out:
//   posted        it's on the thread (url when known)
//   failed        nothing was posted (login, lookups, or the platform refused it): safe to retry
//   maybe_posted  the post request went out and we don't know if it landed: check first
// Never log or return tokens, passwords or the reply text.

import { postWebUrl, replyRefFor } from "./bluesky.ts";
import {
  BlueskyHttpError,
  createReply,
  findOwnReply,
  getPost,
  withSession,
  type BlueskySession,
  type FetchFn,
  type SessionCache,
} from "./blueskyClient.ts";
import { isBlueskyLoginRefused, type BlueskyLogin, type RedditLogin } from "./logins.ts";
import { parseRedditComment, redditThingId, writeFailureStatus } from "./threadReplies.ts";

export type PostOutcome =
  | { status: "posted"; url?: string; uri?: string; alreadyThere?: boolean } // uri: Bluesky at:// of his reply
  | { status: "failed" | "maybe_posted"; error: string; loginRefused?: boolean }; // loginRefused: Bluesky refused his app password

const failed = (error: string): PostOutcome => ({ status: "failed", error });

const CHECK_THREAD = "check the thread before retrying";

function lookupError(error: unknown): string {
  if (error instanceof BlueskyHttpError) return error.message;
  if (error instanceof Error && /^Bluesky /.test(error.message)) return error.message;
  return "Network error or timeout reaching Bluesky.";
}

/**
 * His reply on Bluesky, threaded under the question post (`threadRef`, an at:// uri).
 * If he already replied under it (an earlier run that timed out), that reply counts as posted.
 */
export async function postBlueskyReply(
  fetchFn: FetchFn,
  cache: SessionCache,
  login: BlueskyLogin | null,
  a: { threadRef?: string; text: string; lang: string },
): Promise<PostOutcome> {
  if (!login) return failed("His Bluesky account isn't connected.");
  const parentUri = a.threadRef;
  if (!parentUri) return failed("No Bluesky post uri to reply under.");

  // Everything before the write: a failure here means nothing was posted.
  const prepare = (session: BlueskySession) =>
    findOwnReply(fetchFn, session, parentUri).then(async (existing) =>
      existing ? { session, existing, question: undefined } : { session, existing: undefined, question: await getPost(fetchFn, session, parentUri) },
    );
  let ready: Awaited<ReturnType<typeof prepare>>;
  try {
    ready = await withSession(fetchFn, cache, login, prepare);
  } catch (error) {
    // Refused login (revoked app password): the caller marks his account invalid.
    return isBlueskyLoginRefused(error) ? { status: "failed", error: lookupError(error), loginRefused: true } : failed(lookupError(error));
  }
  const { session } = ready;
  if (ready.existing) return { status: "posted", url: postWebUrl(ready.existing.uri, session.handle), uri: ready.existing.uri, alreadyThere: true };
  if (!ready.question) return failed("The Bluesky post is gone (deleted or hidden).");
  const reply = replyRefFor(ready.question);
  if (!reply) return failed("Couldn't read the Bluesky post to reply under.");

  try {
    const created = await createReply(fetchFn, session, { text: a.text, langs: [a.lang === "es" ? "es" : "en"], reply });
    return { status: "posted", url: postWebUrl(created.uri, session.handle), uri: created.uri };
  } catch (error) {
    const httpStatus = error instanceof BlueskyHttpError ? error.status : undefined;
    const status = writeFailureStatus(httpStatus);
    const what = httpStatus !== undefined ? lookupError(error) : "Network error, timeout or unreadable answer while posting to Bluesky";
    return { status, error: status === "maybe_posted" ? `${what}: ${CHECK_THREAD}.` : what };
  }
}

/** A Reddit access token (script app, password grant). Also used by undo (lib/undo.ts). */
export async function redditToken(fetchFn: FetchFn, login: RedditLogin): Promise<{ ok: true; token: string } | { ok: false; error: string }> {
  const basic = btoa(`${login.clientId}:${login.clientSecret}`); // default Convex runtime: no Buffer
  let token: unknown;
  try {
    const tokenRes = await fetchFn("https://www.reddit.com/api/v1/access_token", {
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded", "User-Agent": login.userAgent },
      body: new URLSearchParams({ grant_type: "password", username: login.username, password: login.password }).toString(),
    });
    if (!tokenRes.ok) return { ok: false, error: `Reddit token HTTP ${tokenRes.status}` };
    token = ((await tokenRes.json().catch(() => null)) as { access_token?: unknown } | null)?.access_token;
  } catch {
    return { ok: false, error: "Network error or timeout getting a Reddit token." };
  }
  if (typeof token !== "string" || !token) return { ok: false, error: "Reddit returned no access token." };
  return { ok: true, token };
}

/** His comment on the Reddit post (`threadUrl`), through Reddit's API (script app, password grant). */
export async function postRedditReply(
  fetchFn: FetchFn,
  login: RedditLogin | null,
  a: { threadUrl: string; text: string },
): Promise<PostOutcome> {
  if (!login) return failed("Reddit posting is off or his Reddit login isn't set.");
  const thingId = redditThingId(a.threadUrl);
  if (!thingId) return failed("Couldn't find the Reddit post id in the thread link.");
  const got = await redditToken(fetchFn, login);
  if (!got.ok) return failed(got.error);
  const { token } = got;

  let res: Awaited<ReturnType<FetchFn>>;
  try {
    res = await fetchFn("https://oauth.reddit.com/api/comment", {
      method: "POST",
      headers: { Authorization: `bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded", "User-Agent": login.userAgent },
      body: new URLSearchParams({ api_type: "json", thing_id: thingId, text: a.text }).toString(),
    });
  } catch {
    return { status: "maybe_posted", error: `Network error or timeout while posting to Reddit: ${CHECK_THREAD}.` };
  }
  if (!res.ok) {
    const status = writeFailureStatus(res.status);
    return { status, error: status === "maybe_posted" ? `Reddit HTTP ${res.status}: ${CHECK_THREAD}.` : `Reddit HTTP ${res.status}` };
  }
  const parsed = parseRedditComment(await res.json().catch(() => null));
  if (parsed.errors.length) return failed(`Reddit: ${parsed.errors.join(", ")}`); // refused (RATELIMIT, THREAD_LOCKED...)
  return { status: "posted", ...(parsed.url ? { url: parsed.url } : {}) };
}

// ---------- claim -> post -> finish ----------

export type ReplyForPosting = { platform: string; status: string; threadUrl: string; threadRef?: string; text: string; language: string };

export type PostReplyDeps = {
  load(): Promise<ReplyForPosting | null>;
  claim(approve: boolean): Promise<{ ok: boolean; reason?: string }>;
  post(reply: ReplyForPosting): Promise<PostOutcome>;
  finish(outcome: PostOutcome): Promise<void>;
};

/** One posting run: claim it (no double replies), post, record the outcome. */
export async function runPostReply(
  deps: PostReplyDeps,
  approve: boolean,
): Promise<{ status: string; url?: string; reason?: string }> {
  const reply = await deps.load();
  if (!reply) return { status: "failed", reason: "Reply not found." };
  const claim = await deps.claim(approve);
  if (!claim.ok) return { status: reply.status, ...(claim.reason ? { reason: claim.reason } : {}) };
  let outcome: PostOutcome;
  try {
    outcome = await deps.post(reply);
  } catch {
    // post() handles its own errors; reaching here is a bug, and the reply may be out.
    outcome = { status: "maybe_posted", error: `Unexpected error while posting: ${CHECK_THREAD}.` };
  }
  await deps.finish(outcome);
  if (outcome.status === "posted") return { status: "posted", ...(outcome.url ? { url: outcome.url } : {}) };
  return { status: outcome.status, reason: outcome.error };
}
