// Threads keyword search: real questions strangers ask, and his answer as a QUOTE post of the
// question (quote_post_id; only needs threads_content_publish). OFF unless THREADS_KEYWORD_SEARCH=on:
// searching other people's posts needs threads_keyword_search, which needs Meta app review
// (before review a search only returns his own posts). Pure, fetch passed in:
// tests/threadsQuestions.test.ts. Actions: convex/threadsQuestions.ts.

import type { FetchFn } from "./blueskyClient.ts";
import { truncate } from "./linkedinPost.ts";
import { threadsKeywordSearchOn } from "./oauthPlatforms.ts";
import { fingerprint, looksLikeQuestion, needsProfessional, priority, type AudienceQuestion } from "./questionSources.ts";
import { getPermalink, isObj, str, threadsCall, type ThreadsAuth } from "./threadsClient.ts";
import { REPLY_DISCLOSURE, stripDisclosure, type ReplyLanguage } from "./threadReplies.ts";
import { THREADS_MAX_CHARS, publishOnePost, threadsTextLength, type WaitOptions } from "./threadsPublishing.ts";

export { threadsKeywordSearchOn };

export const SEARCH_LIMIT = 25;
export const MAX_AGE_DAYS = 14;
const MAX_KEYWORDS = 3;

/** An audienceQuestions-shaped row plus the Threads media id we need to quote it. */
export type ThreadsQuestion = AudienceQuestion & { threadsId: string };

/** GET /keyword_search params: recent text posts for one keyword. */
export function keywordSearchParams(q: string, nowMs: number): Record<string, string> {
  return {
    q: q.slice(0, 100),
    search_type: "RECENT",
    media_type: "TEXT",
    since: String(Math.floor((nowMs - MAX_AGE_DAYS * 86_400_000) / 1000)),
    limit: String(SEARCH_LIMIT),
    fields: "id,text,permalink,timestamp,username,has_replies,is_quote_post,is_reply",
  };
}

/**
 * Search results -> questions worth bringing to his call: top-level, not quotes, not his own,
 * reads like a question, nothing a professional must answer (questionSources rules).
 */
export function parseKeywordSearch(json: unknown, keywords: string[], nowMs: number, ownUsername?: string): ThreadsQuestion[] {
  const data = isObj(json) && Array.isArray(json.data) ? json.data : [];
  const me = (ownUsername ?? "").toLowerCase();
  const out: ThreadsQuestion[] = [];
  for (const item of data) {
    if (!isObj(item)) continue;
    const id = str(item.id);
    const url = str(item.permalink);
    const text = str(item.text).trim();
    if (!id || !/^https:\/\//.test(url) || !text) continue;
    if (item.is_reply === true || item.is_quote_post === true) continue;
    if (me && str(item.username).toLowerCase() === me) continue;
    const [first, ...rest] = text.split(/\n+/);
    const title = truncate(first.trim(), 300);
    const body = rest.join("\n").trim() || undefined;
    if (title.length < 12 || !looksLikeQuestion(text)) continue;
    if (needsProfessional(text)) continue;
    const ts = Date.parse(str(item.timestamp));
    const postedAt = Number.isFinite(ts) ? ts : undefined;
    if (postedAt !== undefined && nowMs - postedAt > MAX_AGE_DAYS * 86_400_000) continue;
    const q = { title, ...(body ? { body } : {}), ...(postedAt !== undefined ? { postedAt } : {}), ...(item.has_replies === false ? { answerCount: 0 } : {}) };
    out.push({
      source: "threads",
      url,
      ...q,
      fingerprint: fingerprint(title),
      keywords,
      priority: priority(q, keywords, nowMs, MAX_AGE_DAYS),
      threadsId: id,
    });
  }
  return out;
}

/** Search a few of his keywords; best first, deduped. A failed keyword is skipped. */
export async function searchThreadsQuestions(
  fetchFn: FetchFn,
  auth: ThreadsAuth & { username?: string },
  keywords: string[],
  nowMs: number,
): Promise<{ questions: ThreadsQuestion[]; errors: string[] }> {
  const best = new Map<string, ThreadsQuestion>();
  const errors: string[] = [];
  for (const k of keywords.map((k) => k.trim()).filter(Boolean).slice(0, MAX_KEYWORDS)) {
    try {
      const json = await threadsCall(fetchFn, "keyword search", "GET", "/keyword_search", keywordSearchParams(k, nowMs), auth.accessToken);
      for (const q of parseKeywordSearch(json, keywords, nowMs, auth.username)) {
        const seen = best.get(q.fingerprint);
        if (!seen || q.priority > seen.priority) best.set(q.fingerprint, q);
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "keyword search failed");
    }
  }
  return { questions: [...best.values()].sort((a, b) => b.priority - a.priority), errors };
}

// ---------- his answer as a quote post ----------

/** His answer + the disclosure line, within Threads' 500 characters (writer disclosures removed). */
export function quoteAnswerText(body: string, lang: ReplyLanguage): string {
  const disclosure = REPLY_DISCLOSURE[lang];
  const clean = stripDisclosure(body);
  for (let room = THREADS_MAX_CHARS - disclosure.length - 2; room > 50; room -= 20) {
    const text = `${truncate(clean, room)}\n\n${disclosure}`;
    if (threadsTextLength(text) <= THREADS_MAX_CHARS) return text;
  }
  return `${truncate(clean, 50)}\n\n${disclosure}`;
}

export type QuoteOutcome = { status: "posted"; id: string; url?: string } | { status: "failed" | "maybe_posted"; error: string };

/** Post `text` as a quote of the question post. */
export async function postThreadsQuote(
  fetchFn: FetchFn,
  login: ThreadsAuth | null,
  a: { quotePostId: string; text: string } & WaitOptions,
): Promise<QuoteOutcome> {
  if (!login) return { status: "failed", error: "His Threads account isn't connected." };
  if (!a.quotePostId.trim() || !a.text.trim()) return { status: "failed", error: "Nothing to quote." };
  const one = await publishOnePost(fetchFn, login, a.text, { quotePostId: a.quotePostId }, a);
  if (!one.ok) return { status: one.status, error: one.status === "maybe_posted" ? `${one.error}: check his Threads profile before retrying.` : one.error };
  let url: string | undefined;
  try {
    url = (await getPermalink(fetchFn, login, one.id)) || undefined;
  } catch {
    url = undefined;
  }
  return { status: "posted", id: one.id, ...(url ? { url } : {}) };
}
