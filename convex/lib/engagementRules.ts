// Rules for engagement.upsert: did readers react since the last scrape, and is
// it time to refresh his question bank? No Convex imports: tested with Node.

import { canonicalLinkedInPostUrl } from "./linkedinUrl.ts";

export type Comment = { author: string; text: string };
export type Snapshot = { reactions: number; comments: Comment[] };

/** Wait this long after the first changed post before refreshing the bank, so a
 *  whole scrape run (one upsert per post) lands first. */
export const BANK_REFRESH_DELAY_MS = 2 * 60 * 1000;

/** At most one bank refresh per elder in this window. */
export const BANK_REFRESH_DEBOUNCE_MS = 10 * 60 * 1000;

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

/** True if no bank refresh was scheduled for this elder in the debounce window. */
export function shouldRefreshBank(
  lastBankRefreshAt: number | undefined,
  nowMs: number,
  windowMs = BANK_REFRESH_DEBOUNCE_MS,
): boolean {
  return lastBankRefreshAt === undefined || nowMs - lastBankRefreshAt >= windowMs;
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

/** LinkedIn runs start this long after the last Bluesky run: past the bank-refresh debounce
 *  (plus its delay), so their comments schedule a refresh of their own instead of being dropped. */
export const LINKEDIN_AFTER_BLUESKY_MS = BANK_REFRESH_DEBOUNCE_MS + BANK_REFRESH_DELAY_MS;

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
