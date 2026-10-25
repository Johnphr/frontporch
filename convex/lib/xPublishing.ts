// Story posts on X, the HTTP side (fetchFn passed in; tests/xPublishing.test.ts uses fakes).
// Same outcomes as lib/storyPublishing.ts (lib/postFlow.PlatformOutcome):
//   posted        on his profile; records = every post id, root first ({ uri: <post id>, cid: "" });
//                 url = https://x.com/<username>/status/<root id>
//   failed        nothing new went out, safe to retry. A thread that stopped halfway keeps its
//                 records (a retry continues it), EXCEPT a refused self-reply: see below.
//   maybe_posted  the request went out and we don't know if it landed (timeout, 5xx)
//
// Gates (all off by default; X charges per post): X_POSTING=on posts at all; X_THREAD=off posts
// one post instead of a self-thread.
// Replies: since 2026-02-23 the API refuses a reply unless the author mentioned or quoted us.
// Self-replies (our threads) are reported as untouched but X's docs don't say. If X refuses
// one, we stop, keep what's posted and say so (the AI note is in post 1, so a partial thread
// still has it). We never reply to, mention or quote anyone else.
// Never log or return tokens or post text.

import type { PlatformOutcome, ThreadRecord } from "./postFlow.ts";
import { isSwitchOn } from "./postFlow.ts";
import { writeFailureStatus } from "./threadReplies.ts";
import type { XLogin } from "./xLogin.ts";
import { X_API, type FetchFn } from "./xOAuth.ts";
import { singleXPost, splitXThread } from "./xText.ts";
import type { ThreadSplit } from "./blueskyThread.ts";

const CHECK_PROFILE = "check his X profile before retrying";

export type XMode = "thread" | "single";

/** X_POSTING=on: may we post to X at all? (Off by default: every post costs money.) */
export function xPostingOn(env: Record<string, string | undefined>): boolean {
  return isSwitchOn(env.X_POSTING);
}

/** X_THREAD=off -> one post; anything else -> a self-thread. */
export function xMode(env: Record<string, string | undefined>): XMode {
  return ["off", "false", "0", "no"].includes((env.X_THREAD ?? "").trim().toLowerCase()) ? "single" : "thread";
}

/** The posts for this story in this mode. */
export function xStoryTexts(raw: string, lang: string | undefined, mode: XMode): ThreadSplit {
  return mode === "single" ? singleXPost(raw, lang) : splitXThread(raw, lang);
}

export function xPostUrl(username: string, id: string): string | undefined {
  return /^\w{1,15}$/.test(username) && /^\d+$/.test(id) ? `https://x.com/${username}/status/${id}` : undefined;
}

type XErrorBody = { title?: unknown; detail?: unknown; type?: unknown; errors?: { message?: unknown; code?: unknown }[] };

/** A short, safe label for X's error (no free text beyond a short title). */
function errorLabel(body: XErrorBody | null): string {
  const title = typeof body?.title === "string" && /^[\w .,:'-]{1,60}$/.test(body.title) ? body.title : "";
  const code = body?.errors?.find((e) => typeof e?.code === "number")?.code;
  return [title, code !== undefined ? `code ${code}` : ""].filter(Boolean).join(", ");
}

/** X refused this because of who may reply (the Feb 2026 rule, or the root's reply settings). */
export function isReplyRestricted(status: number, body: XErrorBody | null): boolean {
  if (status !== 403) return false;
  const text = [body?.title, body?.detail, body?.type, ...(body?.errors ?? []).map((e) => e?.message)]
    .filter((s): s is string => typeof s === "string")
    .join(" ");
  const codes = (body?.errors ?? []).map((e) => e?.code);
  return /repl(y|ies|ying)|summon|conversation/i.test(text) || codes.includes(385) || codes.includes(433);
}

const isDuplicate = (status: number, body: XErrorBody | null) =>
  status === 403 && (/duplicate/i.test(String(body?.detail ?? "")) || (body?.errors ?? []).some((e) => e?.code === 187));

/**
 * Post the story (xStoryTexts made `texts`). `done` = posts an earlier run made: the thread
 * continues after the last one.
 */
export async function postXStory(
  fetchFn: FetchFn,
  login: XLogin | null,
  a: { texts: string[]; done?: ThreadRecord[] },
): Promise<PlatformOutcome> {
  if (!login) return { status: "failed", error: "His X account isn't connected." };
  if (!a.texts.length) return { status: "failed", error: "Nothing to post." };
  const records: ThreadRecord[] = [...(a.done ?? [])].slice(0, a.texts.length);
  const n = a.texts.length;
  const keep = () => {
    const url = records.length ? xPostUrl(login.username, records[0].uri) : undefined;
    return { ...(records.length ? { records: [...records] } : {}), ...(url ? { url } : {}) };
  };
  const partial = () => (records.length ? ` Posted ${records.length} of ${n}.` : "");

  for (let i = records.length; i < n; i++) {
    const parent = i > 0 ? records[i - 1].uri : undefined;
    let res: Awaited<ReturnType<FetchFn>>;
    try {
      res = await fetchFn(`${X_API}/tweets`, {
        method: "POST",
        headers: { Authorization: `Bearer ${login.accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ text: a.texts[i], ...(parent ? { reply: { in_reply_to_tweet_id: parent } } : {}) }),
      });
    } catch {
      return { status: "maybe_posted", error: `Network error or timeout while posting to X: ${CHECK_PROFILE}.${partial()}`, ...keep() };
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as XErrorBody | null;
      const label = errorLabel(body);
      const http = `X HTTP ${res.status}${label ? ` (${label})` : ""}`;
      if (parent && isReplyRestricted(res.status, body)) {
        return {
          status: "failed",
          error:
            `X refused the self-reply (reply restriction): ${http}. Posted ${records.length} of ${n} (the first post carries the AI note). ` +
            "Retrying won't help: switch to one post (X_THREAD=off), or take the partial thread down (undo).",
          ...keep(),
        };
      }
      if (isDuplicate(res.status, body)) {
        return { status: "maybe_posted", error: `${http}: X says this post already exists; ${CHECK_PROFILE}.${partial()}`, ...keep() };
      }
      if (res.status === 401) return { status: "failed", error: `X refused his login (${http}); he may need to connect X again.${partial()}`, ...keep() };
      const status = writeFailureStatus(res.status);
      return {
        status,
        error: status === "maybe_posted" ? `${http}: ${CHECK_PROFILE}.${partial()}` : `${http}.${partial()}${records.length ? " A retry continues the thread." : ""}`,
        ...keep(),
      };
    }
    const id = ((await res.json().catch(() => null)) as { data?: { id?: unknown } } | null)?.data?.id;
    if (typeof id !== "string" || !/^\d+$/.test(id)) {
      return { status: "maybe_posted", error: `X answered without a post id: ${CHECK_PROFILE}.${partial()}`, ...keep() };
    }
    records.push({ uri: id, cid: "" });
  }
  const url = xPostUrl(login.username, records[0].uri);
  return { status: "posted", records, externalId: records[0].uri, ...(url ? { url } : {}) };
}

// ---------- undo ----------

// Same shape as lib/blueskyDelete.DeleteOutcome.
export type XDeleteOutcome = { ok: true; deleted: number; alreadyGone: number } | { ok: false; error: string };

/** Delete his posts (last first, root last). Already gone (404) counts as deleted. */
export async function deleteXPosts(fetchFn: FetchFn, login: XLogin | null, ids: string[]): Promise<XDeleteOutcome> {
  if (!login) return { ok: false, error: "His X account isn't connected." };
  const order = [...new Set(ids.map((i) => (i ?? "").trim()).filter(Boolean))].reverse();
  if (order.some((id) => !/^\d+$/.test(id))) return { ok: false, error: "Not an X post id." };
  let deleted = 0;
  let alreadyGone = 0;
  for (const id of order) {
    let res: Awaited<ReturnType<FetchFn>>;
    try {
      res = await fetchFn(`${X_API}/tweets/${id}`, { method: "DELETE", headers: { Authorization: `Bearer ${login.accessToken}` } });
    } catch {
      return { ok: false, error: `Network error or timeout deleting on X (${deleted} of ${order.length} deleted).` };
    }
    if (res.status === 404) {
      alreadyGone += 1;
      continue;
    }
    if (!res.ok) {
      const label = errorLabel((await res.json().catch(() => null)) as XErrorBody | null);
      return { ok: false, error: `X delete HTTP ${res.status}${label ? ` (${label})` : ""} (${deleted + alreadyGone} of ${order.length} done).` };
    }
    deleted += 1;
  }
  return { ok: true, deleted, alreadyGone };
}
