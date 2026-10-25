// Thread replies: pure rules (no Convex imports; unit-tested in tests/threadReplies.test.ts).
//
// When a story call's question came from a thread we found online (an audience question),
// we answer that thread in his words, from his own account. Only platforms with a posting API:
//   bluesky   auto: his connected account (lib/logins.ts), threaded under the post
//   reddit    auto ONLY when REDDIT_POSTING=on and the script-app credentials are set
//             (new Reddit API apps need manual approval since Nov 2025)
//   any other source (forums, Q&A sites, Stack Exchange), and Bluesky/Reddit while
//   they're not set up: no reply at all. No row, no draft: draftForCall is a no-op.

import { clampGraphemes, graphemeCount, MAX_POST_GRAPHEMES } from "./bluesky.ts";
import { truncate } from "./linkedinPost.ts";
import { callCharacter } from "./onboarding.ts";

export type ReplyPlatform = "bluesky" | "reddit";
export type ReplyMode = "auto" | "none";
export type ReplyLanguage = "en" | "es";

/**
 * threadReplies.status values (schema stores a string).
 *   failed        nothing was posted (refused before or by the platform): safe to retry
 *   maybe_posted  the post request went out but we don't know if it landed (timeout, 5xx):
 *                 a person checks the thread, then retries with approve: true
 *   removing / removed   taken down by undo.ts (lib/undo.ts)
 */
export const REPLY_STATUSES = ["draft", "needs_review", "posting", "posted", "failed", "maybe_posted", "removing", "removed"] as const;
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
        : { mode: "none", reason: "His Bluesky account isn't connected (lib/logins.ts)." };
    case "reddit": {
      if (!redditPostingOn(env.redditPosting)) return { mode: "none", reason: "Reddit posting is off or his Reddit login isn't set (REDDIT_POSTING)." };
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

/**
 * The language the call ran in: his character's (lib/characters.ts, picked the way
 * cartesia.startCall picks it), else elders.language, else English.
 */
export function callLanguageOf(elder: { characterId?: string; language?: string } | null | undefined): string {
  if (!elder) return "en";
  return callCharacter(elder).language || elder.language || "en";
}

const LANGUAGE_NAME: Record<ReplyLanguage, string> = { en: "English", es: "Spanish" };

/**
 * The writer answers in the thread's language, so a reply can be a translation of the call.
 * Tell the fact-check (postGuard `context`) so it compares meaning, not wording. Undefined when
 * the reply is in the call's language. Holds no facts about him, only how to read the reply.
 */
export function guardContextForReply(replyLang: ReplyLanguage, callLanguage: string | undefined): string | undefined {
  const call = replyLanguage(callLanguage);
  if (call === replyLang) return undefined;
  return `How to read this reply (not a fact about him): it is written in ${LANGUAGE_NAME[replyLang]}, translated from the phone call, which was in ${LANGUAGE_NAME[call]}. Compare meaning, not wording: a faithful translation of what he said counts as his words.`;
}

// ---------- posting claims ----------

/** removed: the reply or its call's post was taken down (undo.ts); it never posts again. */
export type ReplyState = { status: string; claimedAt?: number; removed?: boolean };

/**
 * May this run post the reply now? One run at a time (claim -> `posting`), never twice.
 *   draft / failed -> yes (failed means nothing went out)
 *   needs_review   -> only when a person approves it (approve: true)
 *   maybe_posted   -> only with approve: true, after a person checked the thread
 *   posting        -> only if the earlier claim is stale (crashed run) AND approve: true,
 *                     since the crashed run may have posted
 *   posted         -> no
 *   removed (or its post taken down) -> never
 * (On Bluesky, posting also checks for his existing reply under the post first.)
 */
export function canClaimReply(reply: ReplyState, now: number, approve: boolean): { ok: true } | { ok: false; reason: string } {
  // Taken down (the reply, or the post from the same call): never posted, approve or not.
  if (reply.removed) return { ok: false, reason: "Taken down: it won't be posted." };
  switch (reply.status) {
    case "draft":
    case "failed":
      return { ok: true };
    case "needs_review":
      return approve ? { ok: true } : { ok: false, reason: "Held by the fact-check: approve it to post." };
    case "maybe_posted":
      return approve
        ? { ok: true }
        : { ok: false, reason: "It may already be on the thread: check it, then retry with approve: true." };
    case "posting":
      if (reply.claimedAt === undefined || now - reply.claimedAt <= STALE_CLAIM_MS) return { ok: false, reason: "Already being posted." };
      return approve
        ? { ok: true }
        : { ok: false, reason: "An earlier run stopped mid-post: check the thread, then retry with approve: true." };
    case "posted":
      return { ok: false, reason: "Already posted." };
    case "removing":
    case "removed":
      return { ok: false, reason: "Taken down: it won't be posted." };
    default:
      return { ok: false, reason: `Unknown status ${reply.status}.` };
  }
}

/**
 * After the post request itself failed: "failed" when the platform clearly refused it (4xx,
 * nothing was posted), "maybe_posted" when we can't tell (no response / timeout, 408, 5xx, or a
 * 2xx we couldn't read).
 */
export function writeFailureStatus(httpStatus: number | undefined): "failed" | "maybe_posted" {
  if (httpStatus === undefined || httpStatus === 408 || httpStatus >= 500 || (httpStatus >= 200 && httpStatus < 300)) return "maybe_posted";
  return "failed";
}

/** postDrafts: drafts newer than this many days (default 7, 1-60) get posted. */
export function draftCutoff(now: number, maxAgeDays: number | undefined): number {
  const days = maxAgeDays === undefined || !Number.isFinite(maxAgeDays) ? 7 : Math.min(60, Math.max(1, maxAgeDays));
  return now - days * 86_400_000;
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
