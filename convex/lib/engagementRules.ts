// Rules for engagement.upsert: did readers react since the last scrape, and when should his
// question bank refresh? Plus which scrape runs the daily and 5-min crons schedule.
// No Convex imports: tested with Node.

import { canonicalLinkedInPostUrl } from "./linkedinUrl.ts";
import { isSwitchOn } from "./postFlow.ts";

export type Comment = { author: string; text: string };
export type Snapshot = { reactions: number; comments: Comment[] };

/** Older posts: wait this long after a change before refreshing the bank, so the rest of
 *  that scrape run (one upsert per post) lands first. */
export const BANK_REFRESH_DELAY_MS = 2 * 60 * 1000;

/** Older posts: refreshes for one elder start at least this far apart. */
export const BANK_REFRESH_GAP_MS = 10 * 60 * 1000;

/** A post from the last 48h: refresh right away, at most one start per 30 s per elder. */
export const RECENT_REFRESH_GAP_MS = 30 * 1000;

function commentKey(c: Comment): string {
  return `${c.author.trim().toLowerCase()}|${c.text.trim().toLowerCase().replace(/\s+/g, " ")}`;
}

/** Clean comments: trimmed, non-empty text, no exact repeats. */
export function cleanComments(comments: Comment[]): Comment[] {
  const seen = new Set<string>();
  const out: Comment[] = [];
  for (const c of comments ?? []) {
    const text = (c?.text ?? "").trim();
    if (!text) continue;
    const comment = { author: (c?.author ?? "").trim() || "Someone", text };
    const key = commentKey(comment);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(comment);
  }
  return out;
}

/** New post, a different reaction count, or any comment added/removed. */
export function engagementChanged(prev: Snapshot | null | undefined, next: Snapshot): boolean {
  if (!prev) return next.reactions > 0 || next.comments.length > 0;
  if (prev.reactions !== next.reactions) return true;
  const a = new Set(prev.comments.map(commentKey));
  const b = new Set(next.comments.map(commentKey));
  if (a.size !== b.size) return true;
  for (const key of b) if (!a.has(key)) return true;
  return false;
}

/**
 * A reader change just landed: when should the bank refresh run? `pendingAt` is the run time of
 * the last refresh we scheduled (elders.lastBankRefreshAt). `recent`: the post is from the last
 * 48h (no delay, 30 s gap); else 2 min delay, 10 min gap.
 * A pending refresh (still in the future) hasn't started and will read this change, so nothing
 * new, unless the post is recent and that one is further off than the short gap: then one now.
 * Otherwise one after the delay, and at least the gap after the last (a trailing refresh: a
 * change during the gap is never dropped).
 */
export function planBankRefresh(
  pendingAt: number | undefined,
  nowMs: number,
  recent = false,
): { schedule: false } | { schedule: true; runAt: number } {
  const delay = recent ? 0 : BANK_REFRESH_DELAY_MS;
  const gap = recent ? RECENT_REFRESH_GAP_MS : BANK_REFRESH_GAP_MS;
  if (pendingAt !== undefined && pendingAt > nowMs) {
    return recent && pendingAt > nowMs + gap ? { schedule: true, runAt: nowMs } : { schedule: false };
  }
  return { schedule: true, runAt: Math.max(nowMs + delay, (pendingAt ?? -Infinity) + gap) };
}

/** Is this post recent enough for the fast refresh? (its posts row's creation time) */
export function isRecentPost(post: { _creationTime: number } | null | undefined, nowMs: number): boolean {
  return !!post && post._creationTime >= nowMs - RECENT_POST_WINDOW_MS;
}

/**
 * Snapshot to store for this scrape. `commentsKnown: false` means the source only
 * had counts (the backup Actor): keep the comments we already have and compare
 * reactions only, so a backup run never wipes comments or fakes a change.
 */
export function nextSnapshot(
  prev: Snapshot | null | undefined,
  next: Snapshot,
  commentsKnown = true,
): { comments: Comment[]; changed: boolean } {
  if (commentsKnown) return { comments: next.comments, changed: engagementChanged(prev, next) };
  const comments = prev?.comments ?? [];
  const changed = prev ? prev.reactions !== next.reactions : next.reactions > 0;
  return { comments, changed };
}

/** recentFeedback keeps a row unless the post is gone on its platform or we took it down. */
export function feedbackVisible(row: { goneAt?: number }, post: { removedAt?: number } | null | undefined): boolean {
  return row.goneAt === undefined && post?.removedAt === undefined;
}

/** Start of the recentFeedback window (epoch ms). Bad or negative values mean 14 days. */
export function feedbackWindowStart(nowMs: number, sinceDays?: number): number {
  const days = typeof sinceDays === "number" && Number.isFinite(sinceDays) && sinceDays >= 0 ? sinceDays : 14;
  return nowMs - days * 24 * 60 * 60 * 1000;
}

// ---------- platforms ----------

export type EngagementPlatform = "linkedin" | "bluesky" | "threads" | "x";

/** Rows written before Bluesky have no platform: they're LinkedIn. */
export function platformOf(row: { platform?: EngagementPlatform } | null | undefined): EngagementPlatform {
  return row?.platform ?? "linkedin";
}

/**
 * One key per Bluesky post: the bsky.app link without query, hash or trailing slash, host
 * lowercased. The path (handle or did + rkey) is kept as given; we always store the same
 * link for a post (postPublications.url), so it matches itself on every scrape.
 */
export function canonicalBlueskyPostUrl(input?: string | null): string {
  const raw = (input ?? "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    url.search = "";
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    return url.toString().replace(/\/+$/, "");
  } catch {
    return raw.replace(/[?#].*$/, "").replace(/\/+$/, "");
  }
}

/**
 * The key engagement rows are stored under. Only LinkedIn links get the LinkedIn cleanup (it
 * rewrites hosts to linkedin.com); Bluesky, Threads and X get the light cleanup above.
 */
export function canonicalEngagementUrl(platform: EngagementPlatform, input: string | null | undefined): string {
  return platform === "linkedin" ? canonicalLinkedInPostUrl(input) : canonicalBlueskyPostUrl(input);
}

// ---------- daily schedule ----------

/** LinkedIn scraping (Apify) runs only when LINKEDIN_POSTING is on. Off by default. */
export function linkedinEngagementOn(env: Record<string, string | undefined>): boolean {
  return ["on", "true", "1", "yes"].includes((env.LINKEDIN_POSTING ?? "").trim().toLowerCase());
}

export type EngagementJob = { kind: "bluesky" | "threads" | "x" | "linkedin"; elderId: string; delayMs: number };

/** LinkedIn runs start this long after the last Bluesky run, so its comments get a refresh of
 *  their own (Apify runs are slow; the refresh would pick them up anyway). */
export const LINKEDIN_AFTER_BLUESKY_MS = 12 * 60 * 1000;

/**
 * Daily engagement runs, per active elder: Bluesky; Threads (always: cheap when he has no
 * Threads posts) a third of a stagger later; X (only when xOn: X_READ_FEEDBACK, see
 * lib/xEngagement.xFeedbackOn) two thirds later. LinkedIn
 * (when on) for active elders with a LinkedIn profile, after the whole batch.
 */
export function planDailyEngagement<Id extends string>(
  elders: { _id: Id; stage?: string; linkedinUrl?: string }[],
  linkedinOn: boolean,
  staggerMs: number,
  xOn = false,
): (EngagementJob & { elderId: Id })[] {
  const active = elders.filter((e) => e.stage === "active");
  const jobs: (EngagementJob & { elderId: Id })[] = active.map((e, i) => ({ kind: "bluesky", elderId: e._id, delayMs: i * staggerMs }));
  const third = Math.round(staggerMs / 3);
  active.forEach((e, i) => jobs.push({ kind: "threads", elderId: e._id, delayMs: i * staggerMs + third }));
  if (xOn) active.forEach((e, i) => jobs.push({ kind: "x", elderId: e._id, delayMs: i * staggerMs + 2 * third }));
  if (linkedinOn) {
    const start = active.length * staggerMs + LINKEDIN_AFTER_BLUESKY_MS;
    active
      .filter((e) => !!e.linkedinUrl)
      .forEach((e, i) => jobs.push({ kind: "linkedin", elderId: e._id, delayMs: start + i * staggerMs }));
  }
  return jobs;
}

// ---------- recent posts (30-s and 5-min crons) ----------

/** Posts this recent are re-read every 30 s (Bluesky + Threads only; X joins the 5-min tier). */
export const FAST_POST_WINDOW_MS = 2 * 60 * 60 * 1000;
/** Posts up to this old (and past the fast window) are re-read every 5 min. */
export const RECENT_POST_WINDOW_MS = 48 * 60 * 60 * 1000;

export type RecentTier = "fast" | "slow";

/** The postedAt range a tier covers: fast [now - 2h, now], slow [now - 48h, now - 2h). */
export function recentWindow(tier: RecentTier, nowMs: number): { from: number; to?: number } {
  return tier === "fast"
    ? { from: nowMs - FAST_POST_WINDOW_MS }
    : { from: nowMs - RECENT_POST_WINDOW_MS, to: nowMs - FAST_POST_WINDOW_MS };
}

/** scrapeForElder's `days` for a tier: fast reads only the last 2h of threads, slow 2 days. */
export function recentScrapeDays(tier: RecentTier): number {
  return (tier === "fast" ? FAST_POST_WINDOW_MS : RECENT_POST_WINDOW_MS) / 86_400_000;
}

/**
 * X replies every 5 min (posts up to 48h old) only with FAST_POST=on and X_READ_FEEDBACK=on;
 * otherwise X stays on the daily job. X bills a post once per UTC day, so re-reads are ~free.
 */
export function xRecentOn(env: Record<string, string | undefined>): boolean {
  return isSwitchOn(env.FAST_POST) && isSwitchOn(env.X_READ_FEEDBACK);
}

/** The postedAt range recentEngagement queries: the 5-min tier with X covers all 48h. */
export function recentQueryWindow(tier: RecentTier, nowMs: number, x: boolean): { from: number; to?: number } {
  return x && tier === "slow" ? { from: nowMs - RECENT_POST_WINDOW_MS } : recentWindow(tier, nowMs);
}

export type RecentJob<Id extends string> = { kind: "bluesky" | "threads" | "x"; elderId: Id; delayMs: number };

/**
 * From posted publications (by_status_posted, newest first): one Bluesky or Threads scrape per
 * elder with such a post in the tier's window, not taken down. With `x`, the 5-min tier also
 * gets one X scrape per elder with an X post from the last 48h. Staggered.
 */
export function planRecentEngagement<Id extends string>(
  pubs: { elderId: Id; platform: string; status: string; postedAt?: number; removedAt?: number }[],
  nowMs: number,
  staggerMs: number,
  tier: RecentTier,
  x = false,
): RecentJob<Id>[] {
  const seen = new Set<string>();
  const jobs: RecentJob<Id>[] = [];
  for (const p of pubs) {
    const kind = p.platform === "bluesky" || p.platform === "threads" || (p.platform === "x" && x && tier === "slow") ? p.platform : null;
    if (!kind) continue;
    const { from, to } = kind === "x" ? recentQueryWindow(tier, nowMs, true) : recentWindow(tier, nowMs);
    if (p.status !== "posted" || p.removedAt !== undefined) continue;
    if (p.postedAt === undefined || p.postedAt < from || (to !== undefined && p.postedAt >= to)) continue;
    const key = `${kind}|${p.elderId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    jobs.push({ kind, elderId: p.elderId, delayMs: jobs.length * staggerMs });
  }
  return jobs;
}
