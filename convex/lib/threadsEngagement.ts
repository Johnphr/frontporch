// Reader engagement on his Threads threads (like lib/blueskyEngagement.ts).
//
//   parseInsights        /{root}/insights -> likes + reposts on the ROOT post (not summed across the thread)
//   parseConversation    /{root}/conversation (every depth) -> replies by OTHERS: not his own,
//                        not hidden; capped at 20 x 500 characters
//   readThreadsEngagement  both calls for one publication (fetch passed in)
//   toThreadsUpsertArgs  -> engagement.upsert args (the permalink goes in linkedinUrl, like Bluesky)
// Needs threads_manage_insights + threads_read_replies. No Convex imports: tests/threadsEngagement.test.ts.

import type { FetchFn } from "./blueskyClient.ts";
import { publicationsToScrape, type BlueskyPublication } from "./blueskyEngagement.ts";
import { getPaged, isObj, str, threadsCall, type ThreadsAuth } from "./threadsClient.ts";

export const MAX_REPLIES = 20;
export const MAX_REPLY_CHARS = 500;
export const MAX_AUTHOR_CHARS = 80;
const CONVERSATION_PAGES = 3;

export type Reply = { author: string; text: string };
export type ThreadsEngagement = { likes: number; reposts: number; replies: Reply[]; repliesSeen: number };

/** Hidden by him or by Threads: never read to him. */
const HIDDEN = new Set(["HIDDEN", "COVERED", "BLOCKED", "RESTRICTED"]);

const count = (x: unknown): number => (typeof x === "number" && Number.isFinite(x) && x > 0 ? Math.floor(x) : 0);

function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** { data: [{ name, values: [{ value }] }] } (or total_value.value) -> one number per metric. */
export function parseInsights(json: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  const data = isObj(json) && Array.isArray(json.data) ? json.data : [];
  for (const m of data) {
    if (!isObj(m)) continue;
    const name = str(m.name);
    if (!name) continue;
    const first = Array.isArray(m.values) && isObj(m.values[0]) ? m.values[0].value : undefined;
    const total = isObj(m.total_value) ? m.total_value.value : undefined;
    out[name] = count(first ?? total);
  }
  return out;
}

/**
 * Replies by others, oldest first as given. Skips his own (is_reply_owned_by_me, his
 * username, or one of his thread's ids), hidden ones, empty text and duplicates.
 */
export function parseConversation(items: unknown[], own: { ids: string[]; username?: string }): { replies: Reply[]; seen: number } {
  const ownIds = new Set(own.ids);
  const me = (own.username ?? "").toLowerCase();
  const seenIds = new Set<string>();
  const replies: Reply[] = [];
  let seen = 0;
  for (const item of items) {
    if (!isObj(item)) continue;
    const id = str(item.id);
    if (!id || ownIds.has(id) || seenIds.has(id)) continue;
    seenIds.add(id);
    if (item.is_reply_owned_by_me === true) continue;
    const username = str(item.username).trim();
    if (me && username.toLowerCase() === me) continue;
    if (HIDDEN.has(str(item.hide_status).toUpperCase())) continue;
    const text = clip(str(item.text), MAX_REPLY_CHARS);
    if (!text) continue;
    seen += 1;
    if (replies.length < MAX_REPLIES) replies.push({ author: username ? clip(`@${username}`, MAX_AUTHOR_CHARS) : "Someone", text });
  }
  return { replies, seen };
}

/** Insights + the conversation for one thread (root = records[0]). Throws ThreadsHttpError on a failed call. */
export async function readThreadsEngagement(
  fetchFn: FetchFn,
  auth: ThreadsAuth & { username?: string },
  records: { uri: string }[],
): Promise<ThreadsEngagement> {
  const root = records[0]?.uri;
  if (!root) return { likes: 0, reposts: 0, replies: [], repliesSeen: 0 };
  const insights = parseInsights(
    await threadsCall(fetchFn, "insights", "GET", `/${encodeURIComponent(root)}/insights`, { metric: "likes,reposts" }, auth.accessToken),
  );
  const items = await getPaged(
    fetchFn,
    auth,
    "conversation",
    `/${encodeURIComponent(root)}/conversation`,
    { fields: "id,text,username,timestamp,is_reply_owned_by_me,hide_status", reverse: "false", limit: "50" },
    CONVERSATION_PAGES,
  );
  const { replies, seen } = parseConversation(items, { ids: records.map((r) => r.uri), ...(auth.username ? { username: auth.username } : {}) });
  return { likes: insights.likes ?? 0, reposts: insights.reposts ?? 0, replies, repliesSeen: seen };
}

// ---------- mapping ----------

export type ThreadsPublication = BlueskyPublication; // same postPublications fields

/** Posted, not taken down, has a root id, posted in the last 30 days. Newest first. */
export function threadsPublicationsToScrape<T extends ThreadsPublication>(rows: T[], nowMs: number): T[] {
  return publicationsToScrape(rows, nowMs);
}

export type ThreadsUpsertArgs = {
  elderId: string;
  linkedinUrl: string;
  platform: "threads";
  postId: string;
  reactions: number;
  comments: Reply[];
};

/** engagement.upsert args: reactions = likes + reposts on the root, comments = replies by others. */
export function toThreadsUpsertArgs(elderId: string, pub: ThreadsPublication, e: ThreadsEngagement): ThreadsUpsertArgs {
  return {
    elderId,
    linkedinUrl: (pub.url ?? "").trim(),
    platform: "threads",
    postId: pub.postId,
    reactions: e.likes + e.reposts,
    comments: e.replies,
  };
}
