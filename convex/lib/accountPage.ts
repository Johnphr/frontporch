// His page on the web (account.ts): the sign-up token check, what his profile shows, the weekly
// slot change, and his posts list built from postPublications + engagement.
// Only pure imports: unit-tested directly with Node (tests/accountPage.test.ts).

import { characterFor } from "./characters.ts";
import { callLanguage } from "./onboarding.ts";
import { normalizeSchedule, sameTokenHash, type WeeklySlot } from "./signupRules.ts";

export const MAX_POSTS = 50;

/** The elders fields this page reads. */
export type ElderForPage = {
  name: string;
  language?: string;
  characterId?: string;
  callDay?: string;
  callHour?: number;
  timezone?: string;
  signupTokenHash?: string;
};

export type Profile = {
  name: string;
  characterId: string;
  callDay?: string;
  callHour?: number;
  timezone?: string;
};

/** His row when the token's hash matches his (constant-time), else null. No row = null too. */
export function checkedElder<T extends { signupTokenHash?: string }>(elder: T | null, tokenHash: string): T | null {
  return elder && sameTokenHash(elder.signupTokenHash, tokenHash) ? elder : null;
}

/** What his page shows about him, or null (unknown elder or wrong token). Never his phone. */
export function profileView(elder: ElderForPage | null, tokenHash: string): Profile | null {
  const him = checkedElder(elder, tokenHash);
  if (!him) return null;
  return {
    name: him.name,
    characterId: characterFor(him.characterId, callLanguage(him.language)).id,
    ...(him.callDay ? { callDay: him.callDay } : {}),
    ...(him.callHour !== undefined ? { callHour: him.callHour } : {}),
    ...(him.timezone ? { timezone: him.timezone } : {}),
  };
}

export type ScheduleChange = { ok: true; slot: WeeklySlot } | { ok: false; error: "invalid" | "not_found" };

/** setSchedule's decision: a valid slot first (same rules as elders.seed), then his token. */
export function scheduleChange(
  elder: { signupTokenHash?: string } | null,
  tokenHash: string,
  day: string,
  hour: number,
  timezone: string,
): ScheduleChange {
  const slot = normalizeSchedule(day, hour, timezone);
  if (!slot) return { ok: false, error: "invalid" };
  if (!checkedElder(elder, tokenHash)) return { ok: false, error: "not_found" };
  return { ok: true, slot };
}

// ---------- posts ----------

export type Platform = "bluesky" | "threads" | "x" | "linkedin" | "reddit";

/** The posts fields the list reads. */
export type PostForPage = {
  id: string;
  text: string;
  status: string;
  linkedinUrl?: string; // older LinkedIn-only posts
  removedAt?: number;
  approvedAt?: number;
  createdAt: number;
};

export type PublicationForPage = { postId: string; platform: Platform; status: string; url?: string; postedAt?: number };

export type EngagementForPage = {
  postId?: string;
  linkedinUrl: string; // the platform link (named for LinkedIn, used by every platform)
  reactions: number;
  comments: number; // count
  goneAt?: number;
};

export type PostLink = { platform: Platform; url: string };

export type PublishedPost = {
  id: string;
  text: string;
  postedAt: number;
  reactions: number;
  comments: number;
  links: PostLink[];
  linkedinUrl?: string; // kept for older pages: the LinkedIn link, when there is one
};

const LINK_ORDER: Platform[] = ["bluesky", "threads", "x", "linkedin", "reddit"];

const isLink = (url: string | undefined): url is string => !!url && /^https:\/\/\S+$/.test(url) && url.length <= 500;

/**
 * His posts that went out, newest first (at most `max`): a post shows when at least one
 * platform has it posted with a link. Removed posts and held drafts never show (they have
 * nothing posted). Older LinkedIn-only posts (status "published", linkedinUrl, no
 * postPublications rows) show with their LinkedIn link. Reactions and comments are summed
 * across platforms; engagement rows for a post deleted on its platform (goneAt) don't count.
 * The text is the plain story text.
 */
export function publishedPosts(
  posts: PostForPage[],
  publications: PublicationForPage[],
  engagement: EngagementForPage[],
  max = MAX_POSTS,
): PublishedPost[] {
  const pubsByPost = new Map<string, PublicationForPage[]>();
  for (const pub of publications) {
    const list = pubsByPost.get(pub.postId) ?? [];
    list.push(pub);
    pubsByPost.set(pub.postId, list);
  }

  const out: PublishedPost[] = [];
  for (const post of posts) {
    if (post.removedAt !== undefined) continue;
    const pubs = pubsByPost.get(post.id) ?? [];
    const posted = pubs.filter((p) => p.status === "posted" && isLink(p.url));

    const links: PostLink[] = [];
    for (const platform of LINK_ORDER) {
      const hit = posted.find((p) => p.platform === platform);
      if (hit) links.push({ platform, url: hit.url! });
    }
    const legacy = !pubs.length && post.status === "published" && isLink(post.linkedinUrl);
    if (legacy) links.push({ platform: "linkedin", url: post.linkedinUrl! });
    if (!links.length) continue;

    const urls = new Set(links.map((l) => l.url));
    let reactions = 0;
    let comments = 0;
    for (const row of engagement) {
      if (row.goneAt !== undefined) continue;
      const mine = row.postId ? row.postId === post.id : urls.has(row.linkedinUrl);
      if (!mine) continue;
      reactions += row.reactions;
      comments += row.comments;
    }

    const times = posted.map((p) => p.postedAt).filter((t): t is number => typeof t === "number");
    const postedAt = times.length ? Math.min(...times) : (post.approvedAt ?? post.createdAt);
    const linkedin = links.find((l) => l.platform === "linkedin");
    out.push({
      id: post.id,
      text: post.text.trim(),
      postedAt,
      reactions,
      comments,
      links,
      ...(linkedin ? { linkedinUrl: linkedin.url } : {}),
    });
  }
  return out.sort((a, b) => b.postedAt - a.postedAt).slice(0, max);
}
