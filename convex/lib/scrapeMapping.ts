// Map Apify LinkedIn scraper output to what Front Porch stores.
//
//   harvestapi/linkedin-profile-posts   (primary)  -> EngagementPost[] (counts + comment text)
//   apimaestro/linkedin-profile-posts   (backup)   -> EngagementPost[] (counts only, no comment text)
//   harvestapi/linkedin-profile-scraper            -> knownBackground (plain text for onboarding)
//
// Field names come from each Actor's README on apify.com. No runtime imports on
// purpose: tests run this file directly with Node.

import { cleanText, isRecord, parseTimestamp, truncate } from "./text.ts";

export type EngagementComment = { author: string; text: string };

export type EngagementPost = {
  linkedinUrl: string;
  reactions: number;
  comments: EngagementComment[];
  /** extra context, not sent to engagement.upsert (kept for debugging/tests) */
  postedAt?: number;
  text?: string;
};

export const MAX_COMMENTS_PER_POST = 20;
const MAX_COMMENT_CHARS = 500;

/** Strip query string, hash and trailing slash so the same post URL always matches. */
export function normalizeLinkedInUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return "";
  try {
    const parsed = new URL(trimmed);
    parsed.search = "";
    parsed.hash = "";
    parsed.hostname = parsed.hostname.replace(/^[a-z]{2,3}\.linkedin\.com$/, "www.linkedin.com");
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return trimmed.replace(/[?#].*$/, "").replace(/\/+$/, "");
  }
}

function sumReactionCounts(list: unknown): number | undefined {
  if (!Array.isArray(list) || list.length === 0) return undefined;
  let total = 0;
  for (const entry of list) {
    if (isRecord(entry) && typeof entry.count === "number") total += entry.count;
  }
  return total;
}

function commentFrom(raw: unknown): (EngagementComment & { postId?: string; byAuthor: boolean }) | null {
  if (!isRecord(raw)) return null;
  const text = cleanText(raw.commentary ?? raw.text ?? raw.comment ?? "");
  if (!text) return null;
  const actor = isRecord(raw.actor) ? raw.actor : isRecord(raw.author) ? raw.author : {};
  const author = cleanText(actor.name ?? "") || "A reader";
  return {
    author,
    text: truncate(text, MAX_COMMENT_CHARS),
    postId: typeof raw.postId === "string" ? raw.postId : undefined,
    // actor.author === true means the post's own author replied (his reply, not reader feedback)
    byAuthor: actor.author === true,
  };
}

/** harvestapi/linkedin-profile-posts: posts (+ comments nested or as separate items). */
export function mapHarvestPosts(items: unknown[], maxComments = MAX_COMMENTS_PER_POST): EngagementPost[] {
  const posts: Record<string, unknown>[] = [];
  const commentsByPost = new Map<string, EngagementComment[]>();

  for (const item of items) {
    if (!isRecord(item)) continue;
    if (item.type === "comment") {
      const comment = commentFrom(item);
      if (comment && !comment.byAuthor && comment.postId) {
        const list = commentsByPost.get(comment.postId) ?? [];
        list.push({ author: comment.author, text: comment.text });
        commentsByPost.set(comment.postId, list);
      }
      continue;
    }
    if (item.type === undefined || item.type === "post") posts.push(item);
  }

  const result: EngagementPost[] = [];
  for (const post of posts) {
    const share = isRecord(post.socialContent) ? post.socialContent.shareUrl : undefined;
    const rawUrl = [post.linkedinUrl, post.url, share].find((u) => typeof u === "string" && u.trim());
    if (typeof rawUrl !== "string") continue;

    const engagement = isRecord(post.engagement) ? post.engagement : {};
    const reactions =
      sumReactionCounts(engagement.reactions) ??
      (typeof engagement.likes === "number" ? engagement.likes : 0);

    const comments: EngagementComment[] = [];
    if (Array.isArray(post.comments)) {
      for (const raw of post.comments) {
        const comment = commentFrom(raw);
        if (comment && !comment.byAuthor) comments.push({ author: comment.author, text: comment.text });
      }
    }
    const id = typeof post.id === "string" ? post.id : undefined;
    if (id && commentsByPost.has(id)) comments.push(...(commentsByPost.get(id) ?? []));

    const postedAt = isRecord(post.postedAt)
      ? parseTimestamp(post.postedAt.timestamp ?? post.postedAt.date)
      : parseTimestamp(post.postedAt);
    const text = cleanText(post.content ?? post.text ?? "");

    result.push({
      linkedinUrl: normalizeLinkedInUrl(rawUrl),
      reactions,
      comments: dedupeComments(comments).slice(0, maxComments),
      ...(postedAt !== undefined ? { postedAt } : {}),
      ...(text ? { text: truncate(text, 280) } : {}),
    });
  }
  return result;
}

/** apimaestro/linkedin-profile-posts (backup): counts only. Items may wrap posts in data.posts. */
export function mapApimaestroPosts(items: unknown[]): EngagementPost[] {
  const flat: Record<string, unknown>[] = [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    const data = isRecord(item.data) ? item.data : undefined;
    const nested = Array.isArray(data?.posts) ? data?.posts : Array.isArray(item.posts) ? item.posts : undefined;
    if (nested) {
      for (const p of nested) if (isRecord(p)) flat.push(p);
    } else {
      flat.push(item);
    }
  }
  const result: EngagementPost[] = [];
  for (const post of flat) {
    if (typeof post.url !== "string" || !post.url.trim()) continue;
    const stats = isRecord(post.stats) ? post.stats : {};
    let reactions = typeof stats.total_reactions === "number" ? stats.total_reactions : undefined;
    if (reactions === undefined) {
      reactions = ["like", "support", "love", "insight", "celebrate", "funny"]
        .map((k) => (typeof stats[k] === "number" ? (stats[k] as number) : 0))
        .reduce((a, b) => a + b, 0);
    }
    const postedAt = isRecord(post.posted_at)
      ? parseTimestamp(post.posted_at.timestamp ?? post.posted_at.date)
      : undefined;
    const text = cleanText(post.text ?? "");
    result.push({
      linkedinUrl: normalizeLinkedInUrl(post.url),
      reactions,
      comments: [],
      ...(postedAt !== undefined ? { postedAt } : {}),
      ...(text ? { text: truncate(text, 280) } : {}),
    });
  }
  return result;
}

function dedupeComments(comments: EngagementComment[]): EngagementComment[] {
  const seen = new Set<string>();
  return comments.filter((c) => {
    const key = `${c.author}|${c.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------- profile ----------

function dateText(value: unknown): string {
  if (!isRecord(value)) return typeof value === "string" ? value : "";
  if (typeof value.text === "string" && value.text) return value.text;
  const parts = [value.month, value.year].filter((p) => p !== undefined && p !== null && p !== "");
  return parts.join(" ");
}

/**
 * harvestapi/linkedin-profile-scraper item -> short plain-text background that
 * the onboarding call can open with ("30 years at Boeing?").
 */
export function buildKnownBackground(profile: unknown, maxChars = 2000): string {
  if (!isRecord(profile)) return "";
  const lines: string[] = [];

  const name = [profile.firstName, profile.lastName].map((p) => cleanText(p)).filter(Boolean).join(" ");
  const headline = cleanText(profile.headline);
  if (name || headline) lines.push([name, headline].filter(Boolean).join(" — "));

  const location = isRecord(profile.location) ? cleanText(profile.location.linkedinText) : cleanText(profile.location);
  if (location) lines.push(`Location: ${location}`);

  const about = cleanText(profile.about ?? profile.summary);
  if (about) lines.push(`About: ${truncate(about, 400)}`);

  const experience = Array.isArray(profile.experience) ? profile.experience : [];
  const roles: string[] = [];
  for (const raw of experience.slice(0, 8)) {
    if (!isRecord(raw)) continue;
    const title = cleanText(raw.position ?? raw.title);
    const company = cleanText(raw.companyName ?? raw.company);
    if (!title && !company) continue;
    const start = dateText(raw.startDate);
    const end = dateText(raw.endDate);
    const span = [start, end].filter(Boolean).join(" – ");
    const duration = cleanText(raw.duration);
    const when = [span, duration].filter(Boolean).join(", ");
    roles.push(`- ${[title, company].filter(Boolean).join(" at ")}${when ? ` (${when})` : ""}`);
  }
  if (roles.length) lines.push("Experience:", ...roles);

  const education = Array.isArray(profile.education) ? profile.education : [];
  const schools: string[] = [];
  for (const raw of education.slice(0, 4)) {
    if (!isRecord(raw)) continue;
    const school = cleanText(raw.schoolName ?? raw.school);
    if (!school) continue;
    const degree = [cleanText(raw.degree), cleanText(raw.fieldOfStudy)].filter(Boolean).join(", ");
    const period = cleanText(raw.period) || [dateText(raw.startDate), dateText(raw.endDate)].filter(Boolean).join(" – ");
    schools.push(`- ${[degree, school].filter(Boolean).join(" — ")}${period ? ` (${period})` : ""}`);
  }
  if (schools.length) lines.push("Education:", ...schools);

  const skills = Array.isArray(profile.skills)
    ? profile.skills
        .map((s) => (isRecord(s) ? cleanText(s.name) : cleanText(s)))
        .filter(Boolean)
        .slice(0, 8)
    : [];
  if (skills.length) lines.push(`Skills: ${skills.join(", ")}`);

  return truncate(lines.join("\n"), maxChars);
}
