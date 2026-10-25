// Thread replies: pure rules (no Convex imports; unit-tested in tests/threadReplies.test.ts).
//
// When a story call's question came from a thread we found online (an audience question),
// we answer that thread in his words, from his own account. Only platforms with a posting API:
//   bluesky   auto: his account (BLUESKY_HANDLE + app password), threaded under the post
//   reddit    auto ONLY when REDDIT_POSTING=on and the script-app credentials are set
//             (new Reddit API apps need manual approval since Nov 2025)
//   any other source (forums, Q&A sites, Stack Exchange), and Bluesky/Reddit while
//   they're not set up: no reply at all. No row, no draft: draftForCall is a no-op.

import { clampGraphemes, graphemeCount, MAX_POST_GRAPHEMES } from "./bluesky.ts";
import { truncate } from "./linkedinPost.ts";

export type ReplyPlatform = "bluesky" | "reddit";
export type ReplyMode = "auto" | "none";
export type ReplyLanguage = "en" | "es";

/** threadReplies.status values (schema stores a string). */
export const REPLY_STATUSES = ["draft", "needs_review", "posting", "posted", "failed"] as const;
export type ReplyStatus = (typeof REPLY_STATUSES)[number];

/** A posting claim older than this is assumed crashed and can be retaken. */
export const STALE_CLAIM_MS = 15 * 60_000;

/** Platform comment limits (characters). Our replies aim for ~80-200 words, far below these. */
export const MAX_REPLY_CHARS: Record<ReplyPlatform, number> = {
  bluesky: MAX_POST_GRAPHEMES, // graphemes, disclosure included (lib/bluesky.ts)
  reddit: 10_000,
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

/** audienceQuestions.source (+ its url as a fallback) -> a platform we can reply on, or null. */
export function platformOf(source: string | undefined, url: string | undefined): ReplyPlatform | null {
  const s = (source ?? "").toLowerCase();
  if (s === "bluesky") return "bluesky";
  if (s === "reddit") return "reddit";
  if (s) return null; // any other source: no reply
  const host = hostOf(url);
  if (host === "bsky.app") return "bluesky";
  if (/(^|\.)reddit\.com$|^redd\.it$/.test(host)) return "reddit";
  return null;
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

/**
 * Can we reply on this platform right now? "auto" = draft + post from his account; "none" = no
 * reply and no row (the reason is only returned to the caller, never stored).
 */
export function replyMode(platform: ReplyPlatform | null, env: ReplyEnv): { mode: ReplyMode; reason: string } {
  switch (platform) {
    case "bluesky":
      return env.blueskyHandle && env.blueskyPassword
        ? { mode: "auto", reason: "Posted on Bluesky from his account, threaded under the question." }
        : { mode: "none", reason: "Bluesky login isn't set (BLUESKY_HANDLE, BLUESKY_APP_PASSWORD)." };
    case "reddit": {
      if (!redditPostingOn(env.redditPosting)) return { mode: "none", reason: "Reddit posting is off (REDDIT_POSTING)." };
      const creds = [env.redditClientId, env.redditClientSecret, env.redditUsername, env.redditPassword];
      if (creds.some((c) => !c)) return { mode: "none", reason: "Reddit credentials are missing." };
      return { mode: "auto", reason: "Posted through Reddit's API as his account." };
    }
    default:
      return { mode: "none", reason: "We only reply on Bluesky and Reddit (platforms with a posting API)." };
  }
}

/**
 * The one decision draftForCall makes before writing anything: reply on this thread (and on
 * which platform), or do nothing at all (no row). Bluesky also needs the post's at:// uri.
 */
export function replyTarget(
  question: { source?: string; url?: string; atUri?: string },
  env: ReplyEnv,
): { ok: true; platform: ReplyPlatform } | { ok: false; reason: string } {
  const platform = platformOf(question.source, question.url);
  const mode = replyMode(platform, env);
  if (!platform || mode.mode !== "auto") return { ok: false, reason: mode.reason };
  if (platform === "bluesky" && !question.atUri) {
    return { ok: false, reason: "This Bluesky question has no post uri to reply under." };
  }
  return { ok: true, platform };
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
 *   posted         -> no
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
    case "posted":
      return { ok: false, reason: "Already posted." };
    default:
      return { ok: false, reason: `Unknown status ${reply.status}.` };
  }
}

/** Status for a fresh draft: held by the fact-check, or ready to auto-post. */
export function draftStatus(guard: { pass: boolean; mode: string } | null): ReplyStatus {
  if (guard && !guard.pass && guard.mode === "enforce") return "needs_review";
  return "draft";
}

// ---------- platform responses ----------

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
