// Story posts, the HTTP side (fetchFn passed in; tests/storyPublishing.test.ts drives it with fakes).
// publish.ts only wires these to the database. Outcomes (lib/postFlow.PlatformOutcome):
//   posted        it's on his profile (url; Bluesky: every post of the thread in records)
//   failed        nothing new went out (refused, or failed before posting): safe to retry.
//                 A Bluesky thread that stopped halfway keeps its records: a retry continues it.
//   maybe_posted  the post request went out and we don't know if it landed: check first
// Never log or return tokens, passwords or post text.

import { postWebUrl, type StrongRef } from "./bluesky.ts";
import { BlueskyHttpError, createThread, listOwnPosts, loginRefusedMessage, withSession, type FetchFn, type SessionCache } from "./blueskyClient.ts";
import { cleanStoryBody, hashtagFacets, recoverThreadRecords } from "./blueskyThread.ts";
import { disclosureFor, truncate } from "./linkedinPost.ts";
import type { BlueskyLogin, RedditLogin } from "./logins.ts";
import type { PlatformOutcome } from "./postFlow.ts";
import { redditToken } from "./replyPosting.ts";
import { writeFailureStatus } from "./threadReplies.ts";

const CHECK_PROFILE = "check his profile before retrying";

// ---------- Bluesky: the thread ----------

/**
 * Post the thread (lib/blueskyThread.splitBlueskyThread made `texts`). `done` = posts an earlier
 * run made. `recover`: an earlier attempt may have posted more than we know (maybe_posted, a
 * crashed run), so first look in his repo for the next posts and continue after them.
 */
export async function postBlueskyStory(
  fetchFn: FetchFn,
  cache: SessionCache,
  login: BlueskyLogin | null,
  a: { texts: string[]; langs: string[]; done?: StrongRef[]; recover?: boolean; now?: () => number },
): Promise<PlatformOutcome> {
  if (!login) return { status: "failed", error: "His Bluesky account isn't connected." };
  let done = a.done ?? [];
  if (a.recover) {
    try {
      const listed = await withSession(fetchFn, cache, login, (s) => listOwnPosts(fetchFn, s, 50));
      done = recoverThreadRecords(listed, a.texts, done);
    } catch (error) {
      // Still unclear what the earlier attempt posted, so it stays maybe_posted.
      const login = error instanceof BlueskyHttpError && /^Bluesky (login|refresh) /.test(error.message) && error.status < 500;
      return {
        status: "maybe_posted",
        error: login
          ? `${loginRefusedMessage(error)}; couldn't look for the earlier attempt, ${CHECK_PROFILE}.`
          : `Couldn't read his Bluesky posts to find the earlier attempt; ${CHECK_PROFILE}.`,
        ...(done.length ? { records: done } : {}),
      };
    }
  }
  const out = await createThread(fetchFn, cache, login, {
    texts: a.texts,
    langs: a.langs,
    done,
    facetsFor: hashtagFacets,
    ...(a.now ? { now: a.now } : {}),
  });
  const url = out.records.length ? postWebUrl(out.records[0].uri, out.handle) : undefined;
  if (out.ok) return { status: "posted", records: out.records, ...(url ? { url } : {}) };
  const status = out.sent ? writeFailureStatus(out.httpStatus) : "failed";
  const partial = out.records.length ? ` Posted ${out.records.length} of ${a.texts.length}; a retry continues the thread.` : "";
  return {
    status,
    error: status === "maybe_posted" ? `${out.error}: ${CHECK_PROFILE}.${partial}` : `${out.error}.${partial}`,
    ...(out.records.length ? { records: out.records } : {}),
    ...(url ? { url } : {}),
  };
}

// ---------- Reddit: a self post on his own profile (u/<name>) ----------

export const REDDIT_TITLE_MAX = 300;

/**
 * Title = the hook (first paragraph, on one line, at most 300 characters); text = the rest of
 * the story + the disclosure line. A cut title keeps the whole story in the text.
 * Lines starting with "#" are escaped so a hashtag line isn't a markdown heading.
 */
export function redditStoryParts(raw: string, lang: string | undefined): { title: string; text: string } {
  const body = cleanStoryBody(raw);
  const paragraphs = body.split(/\n{2,}/);
  const hook = (paragraphs[0] ?? "").replace(/\s*\n\s*/g, " ").trim();
  const title = truncate(hook, REDDIT_TITLE_MAX);
  const rest = title === hook ? paragraphs.slice(1).join("\n\n") : body;
  const text = [rest.trim(), disclosureFor(lang === "es" ? "es" : "en")].filter(Boolean).join("\n\n");
  return { title, text: text.replace(/^#/gm, "\\#") };
}

/** /api/submit (api_type=json) -> the post's link and fullname, or Reddit's error codes. */
export function parseRedditSubmit(json: unknown): { url?: string; name?: string; errors: string[] } {
  const inner = ((json ?? {}) as { json?: { errors?: unknown; data?: { url?: unknown; name?: unknown } } }).json ?? {};
  const errors = Array.isArray(inner.errors)
    ? inner.errors.map((e) => (Array.isArray(e) ? String(e[0]) : String(e))).filter(Boolean)
    : [];
  const url = inner.data?.url;
  const name = inner.data?.name;
  return {
    ...(typeof url === "string" && /^https:\/\//.test(url) ? { url } : {}),
    ...(typeof name === "string" && name ? { name } : {}),
    errors,
  };
}

/** Submit the story to his profile: POST /api/submit with sr=u_<username>, kind=self. */
export async function submitRedditStory(
  fetchFn: FetchFn,
  login: RedditLogin | null,
  a: { title: string; text: string },
): Promise<PlatformOutcome> {
  if (!login) return { status: "failed", error: "Reddit posting is off or his Reddit login isn't set." };
  if (!a.title.trim()) return { status: "failed", error: "The post has no title line." };
  const auth = await redditToken(fetchFn, login);
  if (!auth.ok) return { status: "failed", error: auth.error };

  let res: Awaited<ReturnType<FetchFn>>;
  try {
    res = await fetchFn("https://oauth.reddit.com/api/submit", {
      method: "POST",
      headers: { Authorization: `bearer ${auth.token}`, "Content-Type": "application/x-www-form-urlencoded", "User-Agent": login.userAgent },
      body: new URLSearchParams({
        api_type: "json",
        sr: `u_${login.username}`,
        kind: "self",
        title: a.title,
        text: a.text,
        sendreplies: "true",
      }).toString(),
    });
  } catch {
    return { status: "maybe_posted", error: `Network error or timeout while posting to Reddit: ${CHECK_PROFILE}.` };
  }
  if (!res.ok) {
    const status = writeFailureStatus(res.status);
    return { status, error: status === "maybe_posted" ? `Reddit HTTP ${res.status}: ${CHECK_PROFILE}.` : `Reddit HTTP ${res.status}` };
  }
  const parsed = parseRedditSubmit(await res.json().catch(() => null));
  if (parsed.errors.length) return { status: "failed", error: `Reddit: ${parsed.errors.join(", ")}` }; // refused (RATELIMIT...)
  if (!parsed.url && !parsed.name) return { status: "maybe_posted", error: `Reddit answered without a post link: ${CHECK_PROFILE}.` };
  return { status: "posted", ...(parsed.url ? { url: parsed.url } : {}), ...(parsed.name ? { externalId: parsed.name } : {}) };
}
