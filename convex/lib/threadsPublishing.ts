// Story posts on Threads, the HTTP side (fetch passed in; tests/threadsPublishing.test.ts).
// Same outcome shape as lib/storyPublishing.postBlueskyStory (lib/postFlow.PlatformOutcome):
//   posted        on his profile; records = every post of the thread (root first), url = post 1's permalink
//   failed        nothing new went out: safe to retry. A thread that stopped halfway keeps its
//                 records, and a retry continues it.
//   maybe_posted  a publish request went out and we don't know if it landed: check first
// records: { uri: Threads media id, cid: "" } (the shape postPublications.records has).
//
// One post = create a TEXT container (POST /me/threads, reply_to_id = the previous post) ->
// wait until its status is FINISHED (Meta suggests up to ~30 s) -> POST /me/threads_publish.
// Never log or return tokens or post text.

import { splitBlueskyThread, type ThreadSplit } from "./blueskyThread.ts";
import type { FetchFn } from "./blueskyClient.ts";
import type { PlatformOutcome, ThreadRecord } from "./postFlow.ts";
import {
  ThreadsHttpError,
  containerStatus,
  createTextContainer,
  deleteMedia,
  getPaged,
  getPermalink,
  isObj,
  isThreadsAuthError,
  isThreadsGone,
  publishContainer,
  str,
  type ThreadsAuth,
} from "./threadsClient.ts";
import { writeFailureStatus } from "./threadReplies.ts";

export const THREADS_MAX_CHARS = 500;
export const THREADS_MIN_POSTS = 2;
export const THREADS_MAX_POSTS = 5;

const CHECK_PROFILE = "check his Threads profile before retrying";

// ---------- the split ----------

const EMOJI = /[\p{Extended_Pictographic}\p{Regional_Indicator}‍️\u{1f3fb}-\u{1f3ff}]/u;

/** Threads' count: one per character, but emoji count as their UTF-8 bytes (Meta's docs). */
export function threadsTextLength(text: string): number {
  let n = 0;
  for (const ch of text) {
    if (!EMOJI.test(ch)) {
      n += 1;
      continue;
    }
    const cp = ch.codePointAt(0) ?? 0;
    n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return n;
}

/**
 * The story as a Threads thread: hook first, the AI disclosure (lib/linkedinPost.disclosureFor,
 * via the Bluesky splitter) at the end of the last post, 2-5 posts of at most 500 characters.
 * Emoji-heavy text is re-split with a smaller limit until every post fits Meta's count.
 */
export function splitThreadsThread(raw: string, lang: string | undefined): ThreadSplit {
  let last: ThreadSplit = { ok: false, reason: "The post is empty." };
  for (let limit = THREADS_MAX_CHARS; limit >= 300; limit -= 25) {
    const split = splitBlueskyThread(raw, lang, { limit, minPosts: THREADS_MIN_POSTS, maxPosts: THREADS_MAX_POSTS });
    if (!split.ok) return limit === THREADS_MAX_CHARS ? split : last;
    if (split.posts.every((p) => threadsTextLength(p) <= THREADS_MAX_CHARS)) return split;
    last = { ok: false, reason: "Too many emoji to fit Threads' 500-character posts." };
  }
  return last;
}

// ---------- posting ----------

export type ThreadsStoryOptions = {
  texts: string[];
  /** Posts an earlier run made (root first). */
  done?: ThreadRecord[];
  /** An earlier attempt may have posted more than we know: look in his profile first. */
  recover?: boolean;
  sleep?: (ms: number) => Promise<void>;
  /** Longest wait for a container to be ready (default 30 s). */
  maxWaitMs?: number;
  pollMs?: number;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Wait for FINISHED. ERROR / EXPIRED -> an error text. Still not ready after maxWait: try publishing anyway. */
async function waitReady(fetchFn: FetchFn, auth: ThreadsAuth, id: string, o: ThreadsStoryOptions): Promise<string | null> {
  const sleep = o.sleep ?? defaultSleep;
  const maxWait = o.maxWaitMs ?? 30_000;
  const step = o.pollMs ?? 3_000;
  for (let waited = 0; ; waited += step) {
    try {
      const s = await containerStatus(fetchFn, auth, id);
      if (s.status === "FINISHED") return null;
      if (s.status === "ERROR" || s.status === "EXPIRED") return `Threads couldn't prepare the post (${s.status}${s.errorMessage ? `: ${s.errorMessage}` : ""})`;
    } catch (error) {
      if (isThreadsAuthError(error)) return (error as Error).message;
      // A status read failing isn't fatal: keep waiting, then try to publish.
    }
    if (waited >= maxWait) return null;
    await sleep(step);
  }
}

function failure(status: "failed" | "maybe_posted", error: string, records: ThreadRecord[], total: number, url?: string): PlatformOutcome {
  const partial = records.length ? ` Posted ${records.length} of ${total}; a retry continues the thread.` : "";
  return {
    status,
    error: status === "maybe_posted" ? `${error}: ${CHECK_PROFILE}.${partial}` : `${error}.${partial}`,
    ...(records.length ? { records } : {}),
    ...(url ? { url } : {}),
  };
}

async function permalinkOf(fetchFn: FetchFn, auth: ThreadsAuth, records: ThreadRecord[]): Promise<string | undefined> {
  if (!records.length) return undefined;
  try {
    return (await getPermalink(fetchFn, auth, records[0].uri)) || undefined;
  } catch {
    return undefined;
  }
}

/** Post the thread (splitThreadsThread made `texts`): post 1, then each next post as a reply to the previous one. */
export async function postThreadsStory(fetchFn: FetchFn, login: ThreadsAuth | null, a: ThreadsStoryOptions): Promise<PlatformOutcome> {
  if (!login) return { status: "failed", error: "His Threads account isn't connected." };
  if (!a.texts.length) return { status: "failed", error: "Nothing to post." };
  let done = [...(a.done ?? [])];
  if (a.recover) {
    try {
      done = await recoverThreadsRecords(fetchFn, login, a.texts, done);
    } catch {
      return {
        status: "maybe_posted",
        error: `Couldn't read his Threads posts to find the earlier attempt; ${CHECK_PROFILE}.`,
        ...(done.length ? { records: done } : {}),
      };
    }
  }

  for (let i = done.length; i < a.texts.length; i++) {
    let container: string;
    try {
      container = await createTextContainer(fetchFn, login, a.texts[i], i > 0 ? { replyToId: done[i - 1].uri } : {});
    } catch (error) {
      // No container, nothing published.
      return failure("failed", error instanceof Error ? error.message : "Threads create failed", done, a.texts.length, await permalinkOf(fetchFn, login, done));
    }
    const notReady = await waitReady(fetchFn, login, container, a);
    if (notReady) return failure("failed", notReady, done, a.texts.length, await permalinkOf(fetchFn, login, done));
    let id: string;
    try {
      id = await publishContainer(fetchFn, login, container);
    } catch (error) {
      const status = error instanceof ThreadsHttpError ? writeFailureStatus(error.status || undefined) : "maybe_posted";
      return failure(status, error instanceof Error ? error.message : "Threads publish failed", done, a.texts.length, await permalinkOf(fetchFn, login, done));
    }
    if (!id) return failure("maybe_posted", "Threads answered without a post id", done, a.texts.length, await permalinkOf(fetchFn, login, done));
    done.push({ uri: id, cid: "" });
  }
  const url = await permalinkOf(fetchFn, login, done);
  return { status: "posted", records: done, ...(url ? { url } : {}) };
}

// ---------- finding a thread an earlier run already posted ----------

export type ListedThreadsPost = { id: string; text: string; repliedTo?: string; isReply: boolean };

const same = (a: string, b: string) => a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();

/** /me/threads or /me/replies `data` -> plain posts. */
export function parseListedPosts(items: unknown[]): ListedThreadsPost[] {
  const out: ListedThreadsPost[] = [];
  for (const item of items) {
    if (!isObj(item)) continue;
    const id = str(item.id);
    if (!id) continue;
    const repliedTo = isObj(item.replied_to) ? str(item.replied_to.id) : "";
    out.push({ id, text: str(item.text), isReply: item.is_reply === true || Boolean(repliedTo), ...(repliedTo ? { repliedTo } : {}) });
  }
  return out;
}

/**
 * Extend `known` (the thread so far, root first) with his posts already there: same text, and
 * (after the root) replying to the previous post. Stops at the first gap.
 */
export function matchThreadsRecords(listed: ListedThreadsPost[], texts: string[], known: ThreadRecord[]): ThreadRecord[] {
  const out = [...known];
  for (let i = out.length; i < texts.length; i++) {
    const parent = i > 0 ? out[i - 1].uri : undefined;
    const match = listed.find((p) => same(p.text, texts[i]) && (parent ? p.repliedTo === parent : !p.isReply));
    if (!match) break;
    out.push({ uri: match.id, cid: "" });
  }
  return out;
}

async function recoverThreadsRecords(fetchFn: FetchFn, auth: ThreadsAuth, texts: string[], known: ThreadRecord[]): Promise<ThreadRecord[]> {
  const listed: ListedThreadsPost[] = [];
  if (!known.length) {
    listed.push(...parseListedPosts(await getPaged(fetchFn, auth, "list posts", "/me/threads", { fields: "id,text,is_reply", limit: "25" }, 1)));
  }
  if (texts.length > 1) {
    listed.push(...parseListedPosts(await getPaged(fetchFn, auth, "list replies", "/me/replies", { fields: "id,text,is_reply,replied_to", limit: "50" }, 1)));
  }
  return matchThreadsRecords(listed, texts, known);
}

// ---------- undo ----------

export type ThreadsDeleteOutcome = { ok: true; deleted: number; alreadyGone: number } | { ok: false; error: string };

/** Delete his posts (undo): the last reply first, the root last. Already gone counts as deleted. */
export async function deleteThreadsPosts(fetchFn: FetchFn, login: ThreadsAuth | null, ids: string[]): Promise<ThreadsDeleteOutcome> {
  if (!login) return { ok: false, error: "His Threads account isn't connected." };
  const order = [...new Set(ids.map((i) => (i ?? "").trim()).filter(Boolean))].reverse();
  let deleted = 0;
  let alreadyGone = 0;
  for (const id of order) {
    try {
      await deleteMedia(fetchFn, login, id);
      deleted += 1;
    } catch (error) {
      if (isThreadsGone(error)) {
        alreadyGone += 1;
        continue;
      }
      const done = deleted + alreadyGone;
      return { ok: false, error: `${error instanceof Error ? error.message : "Threads delete failed"} (${done} of ${order.length} removed)` };
    }
  }
  return { ok: true, deleted, alreadyGone };
}
