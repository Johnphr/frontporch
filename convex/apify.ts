// LinkedIn + audience-question scraping via Apify (and two free public APIs).
//
//   scrapeEngagement       daily: reactions + reader comments on his LinkedIn posts
//                          -> engagement:upsert (Core: Data) per post
//   scrapeProfile          once before onboarding: his work history as plain text
//                          -> { knownBackground } for conversation.planNextCall
//   findAudienceQuestions  weekly: real questions people in his field ask online
//                          -> audienceQuestions table
//   topAudienceQuestions / markAudienceQuestionUsed: for the call planner
//
// Pure mapping/filter logic lives in lib/scrapeMapping.ts and lib/questionSources.ts
// (unit-tested with `npm test`). Env: APIFY_TOKEN (+ optional STACKEXCHANGE_KEY).
// Owner: Integrations.

import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { errorMessage, runActor, sleep } from "./lib/apifyClient";
import {
  type AudienceQuestion,
  type SourceConfig,
  buildApifyInput,
  dedupe,
  deriveKeywords,
  discourseItemsFromSearch,
  discourseSearchUrl,
  enabledSources,
  processItems,
  stackExchangeSearchUrl,
  stackExchangeSitesFor,
} from "./lib/questionSources";
import {
  type EngagementPost,
  buildKnownBackground,
  mapApimaestroPosts,
  mapHarvestPosts,
  MAX_COMMENTS_PER_POST,
} from "./lib/scrapeMapping";

// Convex exposes deployment env vars on process.env (no @types/node here).
declare const process: { env: Record<string, string | undefined> };

const POSTS_ACTOR = "harvestapi/linkedin-profile-posts";
const POSTS_BACKUP_ACTOR = "apimaestro/linkedin-profile-posts";
const PROFILE_ACTOR = "harvestapi/linkedin-profile-scraper";

// Implemented by Core: Data in engagement.ts. Referenced by name so this file
// doesn't depend on their generated types while both are in flight.
const engagementUpsert = makeFunctionReference<"mutation">("engagement:upsert");

// ---------- shared ----------

/** What the scrapers need from an elder. Reads defensively: v2 fields may not exist yet. */
export const getElderForScrape = internalQuery({
  args: { elderId: v.id("elders") },
  handler: async (ctx, args): Promise<{ linkedinUrl?: string; keywords: string[] } | null> => {
    const elder = await ctx.db.get(args.elderId);
    if (!elder) return null;
    const raw = elder as unknown as Record<string, unknown>;
    return {
      ...(typeof raw.linkedinUrl === "string" && raw.linkedinUrl ? { linkedinUrl: raw.linkedinUrl } : {}),
      keywords: deriveKeywords(raw),
    };
  },
});

// ---------- engagement ----------

type EngagementResult = {
  actor: string;
  posts: number;
  comments: number;
  upserted: number;
  errors: string[];
};

export const scrapeEngagement = internalAction({
  args: {
    elderId: v.id("elders"),
    linkedinUrl: v.optional(v.string()),
    maxPosts: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<EngagementResult> => {
    const elder = await ctx.runQuery(internal.apify.getElderForScrape, { elderId: args.elderId });
    const profileUrl = args.linkedinUrl ?? elder?.linkedinUrl;
    if (!profileUrl) throw new Error("No LinkedIn URL: pass linkedinUrl or set it on the elder");
    const maxPosts = Math.max(1, Math.min(args.maxPosts ?? 10, 50));
    const errors: string[] = [];

    let actor = POSTS_ACTOR;
    let posts: EngagementPost[] = [];
    try {
      const items = await runActor(POSTS_ACTOR, {
        targetUrls: [profileUrl],
        maxPosts,
        includeReposts: false,
        includeQuotePosts: false,
        // Reaction COUNTS come with every post. scrapeReactions would also list
        // every person who reacted, billed per reaction, so it stays off.
        scrapeReactions: false,
        scrapeComments: true,
        maxComments: MAX_COMMENTS_PER_POST,
        postNestedComments: true,
      });
      posts = mapHarvestPosts(items);
    } catch (error) {
      errors.push(`${POSTS_ACTOR}: ${errorMessage(error)}`);
    }

    if (posts.length === 0) {
      // LinkedIn scrapers break now and then; the backup returns counts only.
      actor = POSTS_BACKUP_ACTOR;
      try {
        const items = await runActor(POSTS_BACKUP_ACTOR, { username: profileUrl, total_posts: maxPosts });
        posts = mapApimaestroPosts(items);
      } catch (error) {
        errors.push(`${POSTS_BACKUP_ACTOR}: ${errorMessage(error)}`);
      }
    }

    let upserted = 0;
    for (const post of posts) {
      try {
        await ctx.runMutation(engagementUpsert, {
          elderId: args.elderId,
          linkedinUrl: post.linkedinUrl,
          reactions: post.reactions,
          comments: post.comments,
        });
        upserted += 1;
      } catch (error) {
        errors.push(`engagement:upsert ${post.linkedinUrl}: ${errorMessage(error)}`);
        if (upserted === 0) break; // probably not deployed yet; don't repeat the same error N times
      }
    }

    return {
      actor,
      posts: posts.length,
      comments: posts.reduce((n, p) => n + p.comments.length, 0),
      upserted,
      errors,
    };
  },
});

// ---------- profile ----------

export const scrapeProfile = internalAction({
  args: { elderId: v.id("elders"), linkedinUrl: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ knownBackground: string; linkedinUrl: string }> => {
    const elder = await ctx.runQuery(internal.apify.getElderForScrape, { elderId: args.elderId });
    const profileUrl = args.linkedinUrl ?? elder?.linkedinUrl;
    if (!profileUrl) throw new Error("No LinkedIn URL: pass linkedinUrl or set it on the elder");
    const items = await runActor(
      PROFILE_ACTOR,
      { profileScraperMode: "Profile details no email ($4 per 1k)", queries: [profileUrl] },
      { timeoutSecs: 180, maxItems: 1 },
    );
    const knownBackground = buildKnownBackground(items[0]);
    if (!knownBackground) throw new Error(`${PROFILE_ACTOR} returned no usable profile for ${profileUrl}`);
    return { knownBackground, linkedinUrl: profileUrl };
  },
});

// ---------- audience questions ----------

type SourceReport = { fetched: number; kept: number; dropped: Record<string, number>; error?: string };

async function fetchSource(source: SourceConfig, keywords: string[]): Promise<unknown[]> {
  if (source.kind === "apify") {
    if (!source.actor) throw new Error(`source ${source.name} has no actor`);
    return runActor(source.actor, buildApifyInput(source, keywords), {
      timeoutSecs: 240,
      maxItems: source.maxQuestions * 3,
    });
  }

  if (source.kind === "stackexchange_api") {
    // Free official API: 300 requests/day without a key, 10,000 with one.
    const key = process.env.STACKEXCHANGE_KEY || undefined;
    const sites = stackExchangeSitesFor(keywords);
    const queries = keywords.slice(0, 2);
    const items: unknown[] = [];
    for (const site of sites) {
      for (const query of queries) {
        const response = await fetch(stackExchangeSearchUrl(site, query, 10, key));
        const data = (await response.json()) as {
          items?: Record<string, unknown>[];
          backoff?: number;
          error_message?: string;
          quota_remaining?: number;
        };
        if (!response.ok || data.error_message) {
          throw new Error(`Stack Exchange ${site}: ${data.error_message ?? `HTTP ${response.status}`}`);
        }
        for (const item of data.items ?? []) items.push({ ...item, site });
        if (data.quota_remaining === 0) return items;
        // The API asks clients to wait `backoff` seconds before the next call.
        if (data.backoff) await sleep(data.backoff * 1000);
      }
    }
    return items;
  }

  // discourse_json
  const items: unknown[] = [];
  for (const forum of source.forumUrls ?? []) {
    for (const query of keywords.slice(0, 2)) {
      const response = await fetch(discourseSearchUrl(forum, query), { headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error(`Discourse ${forum}: HTTP ${response.status}`);
      items.push(...discourseItemsFromSearch(await response.json(), forum));
    }
  }
  return items;
}

type AudienceResult = {
  keywords: string[];
  sources: Record<string, SourceReport>;
  unique: number;
  inserted: number;
  duplicates: number;
};

export const findAudienceQuestions = internalAction({
  args: {
    elderId: v.id("elders"),
    keywords: v.optional(v.array(v.string())),
    /** source names from lib/questionSources.ts; default: every enabled source */
    sources: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args): Promise<AudienceResult> => {
    const elder = await ctx.runQuery(internal.apify.getElderForScrape, { elderId: args.elderId });
    const given = (args.keywords ?? []).map((k) => k.trim().toLowerCase()).filter(Boolean);
    const keywords = given.length ? given.slice(0, 5) : (elder?.keywords ?? deriveKeywords(null));
    const now = Date.now();

    const reports: Record<string, SourceReport> = {};
    const found: AudienceQuestion[] = [];
    await Promise.all(
      enabledSources(args.sources).map(async (source) => {
        try {
          const items = await fetchSource(source, keywords);
          const result = processItems(items, source, keywords, now);
          reports[source.name] = { fetched: items.length, kept: result.kept.length, dropped: result.dropped };
          found.push(...result.kept);
        } catch (error) {
          reports[source.name] = { fetched: 0, kept: 0, dropped: {}, error: errorMessage(error) };
        }
      }),
    );

    const unique = dedupe(found);
    const saved = await ctx.runMutation(internal.apify.saveAudienceQuestions, {
      elderId: args.elderId,
      questions: unique,
    });
    return { keywords, sources: reports, unique: unique.length, ...saved };
  },
});

const audienceQuestionInput = v.object({
  source: v.string(),
  title: v.string(),
  body: v.optional(v.string()),
  url: v.string(),
  community: v.optional(v.string()),
  score: v.optional(v.number()),
  answerCount: v.optional(v.number()),
  postedAt: v.optional(v.number()),
  fingerprint: v.string(),
  priority: v.number(),
  keywords: v.array(v.string()),
});

/** Insert new questions; for ones we already have (same fingerprint), refresh the ranking if unused. */
export const saveAudienceQuestions = internalMutation({
  args: { elderId: v.id("elders"), questions: v.array(audienceQuestionInput) },
  handler: async (ctx, args): Promise<{ inserted: number; duplicates: number }> => {
    let inserted = 0;
    let duplicates = 0;
    for (const question of args.questions) {
      const existing = await ctx.db
        .query("audienceQuestions")
        .withIndex("by_elder_fingerprint", (q) =>
          q.eq("elderId", args.elderId).eq("fingerprint", question.fingerprint),
        )
        .first();
      if (existing) {
        duplicates += 1;
        if (existing.usedAt === undefined) {
          await ctx.db.patch(existing._id, {
            priority: question.priority,
            ...(question.score !== undefined ? { score: question.score } : {}),
            ...(question.answerCount !== undefined ? { answerCount: question.answerCount } : {}),
          });
        }
        continue;
      }
      await ctx.db.insert("audienceQuestions", { elderId: args.elderId, ...question });
      inserted += 1;
    }
    return { inserted, duplicates };
  },
});

/** Best unused questions for his next call, highest priority first. */
export const topAudienceQuestions = internalQuery({
  args: { elderId: v.id("elders"), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("audienceQuestions")
      .withIndex("by_elder_priority", (q) => q.eq("elderId", args.elderId))
      .order("desc")
      .filter((q) => q.eq(q.field("usedAt"), undefined))
      .take(Math.max(1, Math.min(args.limit ?? 5, 25)));
    return rows.map((r) => ({
      _id: r._id,
      title: r.title,
      body: r.body,
      url: r.url,
      source: r.source,
      community: r.community,
      score: r.score,
      priority: r.priority,
    }));
  },
});

/** Call planner: mark a question as used so it isn't offered again. */
export const markAudienceQuestionUsed = internalMutation({
  args: { id: v.id("audienceQuestions"), callId: v.optional(v.id("calls")) },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, {
      usedAt: Date.now(),
      ...(args.callId ? { usedInCallId: args.callId } : {}),
    });
  },
});
