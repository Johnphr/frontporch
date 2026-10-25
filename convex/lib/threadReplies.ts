// Thread replies: pure rules (no Convex imports; unit-tested in tests/threadReplies.test.ts).
//
// When a story call's question came from a thread we found online (an audience question),
// we answer that thread in his words, from his own account. Which platforms we can post to:
//   bluesky        auto: his account (BLUESKY_HANDLE + app password), threaded under the post
//   discourse      auto: a user API key he authorized on that forum (User-Api-Key header)
//   reddit         auto ONLY when REDDIT_POSTING=on and the script-app credentials are set
//                  (new Reddit API apps need manual approval since Nov 2025); otherwise manual
//   quora          manual: no posting API, browser automation breaks Quora's rules
//   stackexchange  skipped: the network bans AI-generated content, even pasted by hand
//   anything else  manual
// "manual" = a teammate posts the draft from the /posts page (Copy text + Open thread).

import { clampGraphemes, graphemeCount, MAX_POST_GRAPHEMES } from "./bluesky.ts";
import { truncate } from "./linkedinPost.ts";

export type ReplyPlatform = "bluesky" | "discourse" | "reddit" | "quora" | "stackexchange" | "other";
export type ReplyMode = "auto" | "manual" | "skipped";
export type ReplyLanguage = "en" | "es";

/** threadReplies.status values (schema stores a string). */
export const REPLY_STATUSES = ["draft", "needs_review", "posting", "posted", "manual", "skipped", "failed"] as const;
export type ReplyStatus = (typeof REPLY_STATUSES)[number];

/** A posting claim older than this is assumed crashed and can be retaken. */
export const STALE_CLAIM_MS = 15 * 60_000;

/** Platform comment limits (characters). Our replies aim for ~80-200 words, far below these. */
export const MAX_REPLY_CHARS: Record<ReplyPlatform, number> = {
  bluesky: MAX_POST_GRAPHEMES, // graphemes, disclosure included (lib/bluesky.ts)
  reddit: 10_000,
  discourse: 32_000,
  quora: 10_000,
  stackexchange: 30_000,
  other: 10_000,
};

export const REPLY_DISCLOSURE: Record<ReplyLanguage, string> = {
  en: "Written up with AI from a phone interview with me.",
  es: "Redactado con ayuda de IA a partir de una entrevista telefónica conmigo.",
};

/** Bluesky's 300-grapheme posts get a shorter line. */
export const BLUESKY_DISCLOSURE: Record<ReplyLanguage, string> = {
  en: "(AI-assisted, from my phone interview)",
  es: "(Con ayuda de IA, de mi entrevista telefónica)",
};

/** What the writer aims for on Bluesky, so the final text rarely needs cutting. */
export const BLUESKY_BODY_TARGET = 240;

// ---------- which thread does this call answer? ----------

/**
 * The audience question behind a call: the call's plan names the question-bank row it used
 * (plan.bankId); a row with source "audience" points at an audienceQuestions id (sourceRef).
 * Anything else (open thread, memory, reader comment, recent topic) gets no thread reply.
 */
export function audienceIdForCall(
  plan: unknown,
  bankRow: { _id: string; source?: string; sourceRef?: string } | null,
): string | null {
  const bankId = (plan as { bankId?: unknown } | null | undefined)?.bankId;
  if (typeof bankId !== "string" || !bankId || !bankRow || bankRow._id !== bankId) return null;
  if (bankRow.source !== "audience") return null;
  return typeof bankRow.sourceRef === "string" && bankRow.sourceRef ? bankRow.sourceRef : null;
}

// ---------- platform rules ----------

/** audienceQuestions.source (+ its url as a fallback) -> platform. */
export function platformOf(source: string | undefined, url: string | undefined): ReplyPlatform {
  const s = (source ?? "").toLowerCase();
  if (s === "bluesky") return "bluesky";
  if (s === "discourse") return "discourse";
  if (s === "reddit") return "reddit";
  if (s === "quora") return "quora";
  if (s === "stackexchange" || s === "stackoverflow") return "stackexchange";
  const host = hostOf(url);
  if (host === "bsky.app") return "bluesky";
  if (/(^|\.)reddit\.com$|^redd\.it$/.test(host)) return "reddit";
  if (/(^|\.)quora\.com$/.test(host)) return "quora";
  if (/(^|\.)(stackexchange|stackoverflow|superuser|serverfault|askubuntu|mathoverflow)\.(com|net)$/.test(host)) {
    return "stackexchange";
  }
  return "other";
}

export function hostOf(url: string | undefined): string {
  try {
    return new URL(url ?? "").host.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

export type ReplyEnv = {
  blueskyHandle?: string;
  blueskyPassword?: string;
  discourseUrl?: string;
  discourseKey?: string;
  redditPosting?: string;
  redditClientId?: string;
  redditClientSecret?: string;
  redditUsername?: string;
  redditPassword?: string;
};

/** Is REDDIT_POSTING switched on ("on", "true", "1", "yes")? Off by default. */
export function redditPostingOn(value: string | undefined): boolean {
  return ["on", "true", "1", "yes"].includes((value ?? "").trim().toLowerCase());
}

/** How a reply to this thread gets posted, and why. */
export function replyMode(platform: ReplyPlatform, threadUrl: string, env: ReplyEnv): { mode: ReplyMode; reason: string } {
  switch (platform) {
    case "stackexchange":
      return { mode: "skipped", reason: "Stack Exchange bans AI-generated answers, so we don't reply there." };
    case "quora":
      return { mode: "manual", reason: "Quora has no posting API: post this draft by hand." };
    case "bluesky":
      return env.blueskyHandle && env.blueskyPassword
        ? { mode: "auto", reason: "Posted on Bluesky from his account, threaded under the question." }
        : { mode: "manual", reason: "Bluesky login isn't set (BLUESKY_HANDLE, BLUESKY_APP_PASSWORD): post this draft by hand." };
    case "reddit": {
      if (!redditPostingOn(env.redditPosting)) {
        return { mode: "manual", reason: "Reddit posting is off (REDDIT_POSTING): post this draft by hand." };
      }
      const creds = [env.redditClientId, env.redditClientSecret, env.redditUsername, env.redditPassword];
      if (creds.some((c) => !c)) {
        return { mode: "manual", reason: "Reddit credentials are missing: post this draft by hand." };
      }
      return { mode: "auto", reason: "Posted through Reddit's API as his account." };
    }
    case "discourse": {
      if (!env.discourseUrl || !env.discourseKey) {
        return { mode: "manual", reason: "No Discourse user API key set: post this draft by hand." };
      }
      if (hostOf(env.discourseUrl) !== hostOf(threadUrl)) {
        return { mode: "manual", reason: "The key in DISCOURSE_URL is for a different forum: post this draft by hand." };
      }
      if (discourseTopicId(threadUrl) === undefined) {
        return { mode: "manual", reason: "Couldn't find the forum topic id in the thread link: post this draft by hand." };
      }
      return { mode: "auto", reason: "Posted to the forum with his user API key." };
    }
    default:
      return { mode: "manual", reason: "No posting integration for this site: post this draft by hand." };
  }
}

/** Discourse topic id from a topic URL: /t/<slug>/<id>[/<post>] or /t/<id>. */
export function discourseTopicId(url: string | undefined): number | undefined {
  let path = "";
  try {
    path = new URL(url ?? "").pathname;
  } catch {
    return undefined;
  }
  const m = /\/t\/(?:[^/]+\/)?(\d+)(?:\/\d+)?\/?$/.exec(path);
  if (!m) return undefined;
  const id = Number(m[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

/** Reddit "fullname" of the post (t3_<id>) from its URL: /comments/<id>/... or redd.it/<id>. */
export function redditThingId(url: string | undefined): string | undefined {
  let u: URL;
  try {
    u = new URL(url ?? "");
  } catch {
    return undefined;
  }
  const host = u.host.toLowerCase();
  const fromComments = /\/comments\/([a-z0-9]{2,12})(?:\/|$)/i.exec(u.pathname);
  if (fromComments && /(^|\.)reddit\.com$/.test(host)) return `t3_${fromComments[1].toLowerCase()}`;
  const short = /^\/([a-z0-9]{2,12})\/?$/i.exec(u.pathname);
  if (short && host === "redd.it") return `t3_${short[1].toLowerCase()}`;
  return undefined;
}

// ---------- the text ----------

/** Drop any AI-disclosure lines the writer added (either language) in the last two paragraphs. */
export function stripDisclosure(text: string): string {
  const paras = text.trim().split(/\n\s*\n/);
  const tail = paras.slice(-2).map((p) =>
    p
      .split("\n")
      .filter((line) => !isDisclosureLine(line))
      .join("\n")
      .trim(),
  );
  return [...paras.slice(0, -2), ...tail].filter(Boolean).join("\n\n").trim();
}

function isDisclosureLine(line: string): boolean {
  const l = line.trim().toLowerCase();
  if (!l || l.length > 160) return false;
  if (/^\(?\s*(ai[- ]assisted|con ayuda de (ia|i\.a\.))\b/.test(l)) return true;
  return (
    /\b(written|drafted|made|created)\b.{0,40}\b(with|by|using)\b.{0,20}\b(ai|a\.i\.)\b/.test(l) ||
    /\b(redactad[oa]|escrit[oa]|hech[oa])\b.{0,40}\b(con|por)\b.{0,30}\b(ia|i\.a\.)\b/.test(l)
  );
}

/** Final reply text: body (writer disclosures removed, clamped to the platform) + ours, once. */
export function finalReplyText(body: string, lang: ReplyLanguage, platform: ReplyPlatform): string {
  const clean = stripDisclosure(body);
  if (platform === "bluesky") {
    // 300 graphemes for the whole post, disclosure included.
    const line = BLUESKY_DISCLOSURE[lang];
    return `${clampGraphemes(clean, MAX_POST_GRAPHEMES - graphemeCount(line) - 2)}\n\n${line}`;
  }
  const disclosure = REPLY_DISCLOSURE[lang];
  const room = MAX_REPLY_CHARS[platform] - disclosure.length - 2;
  return `${truncate(clean, room)}\n\n${disclosure}`;
}

/** The body without our disclosure, i.e. what the fact-check should read. */
export function replyBody(text: string): string {
  return stripDisclosure(text);
}

export function wordCount(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

/** The writer's language field -> "en" | "es" (anything unknown is English). */
export function replyLanguage(value: unknown): ReplyLanguage {
  return typeof value === "string" && value.trim().toLowerCase().startsWith("es") ? "es" : "en";
}

// ---------- posting claims ----------

export type ReplyState = { status: string; claimedAt?: number };

/**
 * May this run post the reply now? One run at a time (claim -> `posting`), never twice.
 *   draft / failed -> yes
 *   needs_review   -> only when a person approves it (approve: true)
 *   posting        -> only if the earlier claim is stale (crashed run)
 *   manual         -> no (a person posts it; record it with markPostedByHand)
 *   posted / skipped -> no
 */
export function canClaimReply(reply: ReplyState, now: number, approve: boolean): { ok: true } | { ok: false; reason: string } {
  switch (reply.status) {
    case "draft":
    case "failed":
      return { ok: true };
    case "needs_review":
      return approve ? { ok: true } : { ok: false, reason: "Held by the fact-check: approve it to post." };
    case "posting":
      return reply.claimedAt !== undefined && now - reply.claimedAt > STALE_CLAIM_MS
        ? { ok: true }
        : { ok: false, reason: "Already being posted." };
    case "manual":
      return { ok: false, reason: "This platform is posted by hand." };
    case "posted":
      return { ok: false, reason: "Already posted." };
    case "skipped":
      return { ok: false, reason: "Skipped: we don't reply on this platform." };
    default:
      return { ok: false, reason: `Unknown status ${reply.status}.` };
  }
}

/** Status for a fresh draft: held by the guard, posted by hand, or ready to auto-post. */
export function draftStatus(mode: ReplyMode, guard: { pass: boolean; mode: string } | null): ReplyStatus {
  if (mode === "skipped") return "skipped";
  if (guard && !guard.pass && guard.mode === "enforce") return "needs_review";
  return mode === "auto" ? "draft" : "manual";
}

// ---------- platform responses ----------

/** Link to a new Discourse post from POST /posts.json's response. */
export function discoursePostUrl(base: string, json: unknown, topicId: number): string | undefined {
  const j = (json ?? {}) as Record<string, unknown>;
  const root = base.trim().replace(/\/+$/, "");
  const topic = typeof j.topic_id === "number" ? j.topic_id : topicId;
  const slug = typeof j.topic_slug === "string" && j.topic_slug ? j.topic_slug : "topic";
  const n = typeof j.post_number === "number" ? `/${j.post_number}` : "";
  return root ? `${root}/t/${slug}/${topic}${n}` : undefined;
}

/** Link + error codes from POST /api/comment (api_type=json). */
export function parseRedditComment(json: unknown): { url?: string; errors: string[] } {
  const inner = ((json ?? {}) as { json?: { errors?: unknown; data?: { things?: unknown } } }).json ?? {};
  const errors = Array.isArray(inner.errors)
    ? inner.errors.map((e) => (Array.isArray(e) ? String(e[0]) : String(e))).filter(Boolean)
    : [];
  const things = Array.isArray(inner.data?.things) ? (inner.data?.things as Array<{ data?: { permalink?: unknown } }>) : [];
  const permalink = things[0]?.data?.permalink;
  return {
    ...(typeof permalink === "string" && permalink ? { url: `https://www.reddit.com${permalink}` } : {}),
    errors,
  };
}
