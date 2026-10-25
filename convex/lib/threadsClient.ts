// Threads Graph API calls (graph.threads.com/v1.0), fetch passed in. Used by
// lib/threadsPublishing.ts, lib/threadsEngagement.ts and lib/threadsQuestions.ts.
// Errors carry the step, the HTTP status and Meta's numeric error code only: never the token
// (it travels in the body / query, which we never put in a message) or post text.

import type { FetchFn } from "./blueskyClient.ts";
import { THREADS_API } from "./oauthPlatforms.ts";

export type ThreadsAuth = { accessToken: string; userId: string };

export class ThreadsHttpError extends Error {
  readonly step: string;
  readonly status: number; // 0 = no response (network, timeout)
  readonly code?: number; // Meta error code (190 = bad token, 100 = bad parameter / missing object)
  readonly subcode?: number;
  constructor(step: string, status: number, code?: number, subcode?: number) {
    super(`Threads ${step} ${status ? `HTTP ${status}` : "network error"}${code !== undefined ? ` (code ${code}${subcode !== undefined ? `/${subcode}` : ""})` : ""}`);
    this.name = "ThreadsHttpError";
    this.step = step;
    this.status = status;
    this.code = code;
    this.subcode = subcode;
  }
}

type Obj = Record<string, unknown>;
export const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);
export const str = (x: unknown): string => (typeof x === "string" ? x : typeof x === "number" && Number.isFinite(x) ? String(x) : "");
const num = (x: unknown): number | undefined => (typeof x === "number" && Number.isFinite(x) ? x : undefined);

function errorOf(step: string, status: number, json: unknown): ThreadsHttpError {
  const e = isObj(json) && isObj(json.error) ? json.error : {};
  return new ThreadsHttpError(step, status, num(e.code), num(e.error_subcode));
}

/** One Graph call. GET/DELETE: params in the query; POST: params form-encoded in the body. */
export async function threadsCall(
  fetchFn: FetchFn,
  step: string,
  method: "GET" | "POST" | "DELETE",
  path: string,
  params: Record<string, string>,
  token: string,
): Promise<Obj> {
  const all = new URLSearchParams({ ...params, access_token: token });
  const url = method === "POST" ? `${THREADS_API}${path}` : `${THREADS_API}${path}?${all.toString()}`;
  let res: Awaited<ReturnType<FetchFn>>;
  try {
    res = await fetchFn(
      url,
      method === "POST"
        ? { method, headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: all.toString() }
        : { method },
    );
  } catch {
    throw new ThreadsHttpError(step, 0);
  }
  const json = await res.json().catch(() => null);
  if (!res.ok) throw errorOf(step, res.status, json);
  if (isObj(json) && isObj(json.error)) throw errorOf(step, res.status, json);
  return isObj(json) ? json : {};
}

/** The object is gone (deleted, or never was): 404, or code 100 with subcode 33. */
export function isThreadsGone(error: unknown): boolean {
  if (!(error instanceof ThreadsHttpError)) return false;
  return error.status === 404 || (error.code === 100 && error.subcode === 33);
}

/** Meta refused the token (190) or said unauthorized. */
export function isThreadsAuthError(error: unknown): boolean {
  return error instanceof ThreadsHttpError && (error.code === 190 || error.status === 401);
}

// ---------- posting ----------

export type ContainerOptions = { replyToId?: string; quotePostId?: string };

/** POST /me/threads (media_type=TEXT) -> the container id. */
export async function createTextContainer(fetchFn: FetchFn, auth: ThreadsAuth, text: string, o: ContainerOptions = {}): Promise<string> {
  const json = await threadsCall(
    fetchFn,
    "create",
    "POST",
    "/me/threads",
    { media_type: "TEXT", text, ...(o.replyToId ? { reply_to_id: o.replyToId } : {}), ...(o.quotePostId ? { quote_post_id: o.quotePostId } : {}) },
    auth.accessToken,
  );
  const id = str(json.id);
  if (!id) throw new ThreadsHttpError("create", 200);
  return id;
}

/** GET /{container}?fields=status,error_message -> FINISHED | IN_PROGRESS | ERROR | EXPIRED | PUBLISHED. */
export async function containerStatus(fetchFn: FetchFn, auth: ThreadsAuth, containerId: string): Promise<{ status: string; errorMessage?: string }> {
  const json = await threadsCall(fetchFn, "status", "GET", `/${encodeURIComponent(containerId)}`, { fields: "status,error_message" }, auth.accessToken);
  const errorMessage = str(json.error_message);
  return { status: str(json.status).toUpperCase(), ...(errorMessage ? { errorMessage: errorMessage.slice(0, 80) } : {}) };
}

/** POST /me/threads_publish (creation_id) -> the published post's media id. */
export async function publishContainer(fetchFn: FetchFn, auth: ThreadsAuth, containerId: string): Promise<string> {
  const json = await threadsCall(fetchFn, "publish", "POST", "/me/threads_publish", { creation_id: containerId }, auth.accessToken);
  return str(json.id);
}

/** GET /{media}?fields=permalink -> the public link ("" if Meta omits it). */
export async function getPermalink(fetchFn: FetchFn, auth: ThreadsAuth, mediaId: string): Promise<string> {
  const json = await threadsCall(fetchFn, "permalink", "GET", `/${encodeURIComponent(mediaId)}`, { fields: "permalink" }, auth.accessToken);
  const link = str(json.permalink);
  return /^https:\/\//.test(link) ? link : "";
}

/** DELETE /{media} (threads_delete). */
export async function deleteMedia(fetchFn: FetchFn, auth: ThreadsAuth, mediaId: string): Promise<void> {
  const json = await threadsCall(fetchFn, "delete", "DELETE", `/${encodeURIComponent(mediaId)}`, {}, auth.accessToken);
  if (json.success === false) throw new ThreadsHttpError("delete", 200);
}

/** GET with cursor paging: up to `maxPages` pages of `data`. */
export async function getPaged(
  fetchFn: FetchFn,
  auth: ThreadsAuth,
  step: string,
  path: string,
  params: Record<string, string>,
  maxPages: number,
): Promise<unknown[]> {
  const out: unknown[] = [];
  let after = "";
  for (let page = 0; page < maxPages; page++) {
    const json = await threadsCall(fetchFn, step, "GET", path, { ...params, ...(after ? { after } : {}) }, auth.accessToken);
    if (Array.isArray(json.data)) out.push(...json.data);
    const paging = isObj(json.paging) ? json.paging : {};
    const cursors = isObj(paging.cursors) ? paging.cursors : {};
    after = str(cursors.after);
    const full = Array.isArray(json.data) && json.data.length >= Number(params.limit || 25);
    // Meta's docs show cursors but not always `next`: a full page with a cursor means "maybe more".
    if (!after || !Array.isArray(json.data) || json.data.length === 0 || (!paging.next && !full)) break;
  }
  return out;
}
