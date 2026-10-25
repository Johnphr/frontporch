// Publishing a story post to his accounts. One postPublications row per post per platform.
//
//   publishPost({ postId })        scheduled by pipeline.processCall for a new post (AUTO_POST on).
//                                  Never a post with removedAt, or one held for review. Then:
//     1. claim the post (posts.status -> "posting"; one run at a time, retaken after 15 min)
//     2. the fact-check, once (postGuard.checkPost, as linkedapi did; lib/postFlow.shouldRunGuard)
//          fail + POST_GUARD_MODE=enforce -> needs_review (heldFor "guard"), posted nowhere
//     3. each platform in order, each with its own row: claim -> post -> finish -> re-read the
//        post; if it was taken down meanwhile (removedAt), schedule undo:removePost and stop
//          bluesky   his login (lib/logins.ts): the post as a 3-5 post thread
//                    (lib/blueskyThread.ts); records = every post, root first; url = post 1
//          reddit    only when redditLoginForElder returns a login (REDDIT_POSTING=on): a self
//                    post on his profile (sr=u_<name>), title = the hook
//          linkedin  only when LINKEDIN_POSTING=on, through linkedapi.startPublication
//                    (LinkedAPI + polling); otherwise its row is "skipped"
//        an unclear failure (timeout after the request went out, 5xx) -> maybe_posted: never
//        retried on its own; a person checks his profile, then retryPublication approve:true
//     4. posts.status: published (any platform posted; linkedinUrl only from LinkedIn) |
//        failed (none did) | needs_review (held)
//   approvePost({ postId })        a person read a held post: runs the fact-check first if it was
//                                  held for quality (never checked), then publishes everywhere.
//   retryPublication({ publicationId, approve? })   one failed / maybe_posted / skipped row
//                                  (maybe_posted needs approve: true, after checking his profile).
//                                  A Bluesky retry continues a half-posted thread, and first
//                                  looks in his repo for posts an earlier attempt made.
//
//   npx convex run publish:publishPost '{"postId":"<posts id>"}'
//   npx convex run publish:approvePost '{"postId":"<posts id>"}'
//   npx convex run publish:retryPublication '{"publicationId":"<postPublications id>","approve":true}'
//
// Disclosure + fact-check language: the language his calls run in (callCharacter(elder).language).
// Never log tokens, passwords or post text: ids and statuses only.
// Env: AUTO_POST, POST_GUARD_MODE, LINKEDIN_POSTING (+ the login variables in lib/logins.ts).
// Owner: Integrations.

import { v } from "convex/values";
import { makeFunctionReference } from "convex/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, type ActionCtx } from "./_generated/server";
import { sharedSessionCache, type FetchFn } from "./lib/blueskyClient";
import { splitBlueskyThread } from "./lib/blueskyThread";
import { blueskyLoginForElder, redditLoginForElder } from "./lib/logins";
import { callCharacter } from "./lib/onboarding";
import {
  buildGuardContext,
  canClaimPublication,
  canRetry,
  canStartPublish,
  enabledPlatforms,
  linkedinPostingOn,
  overallPostStatus,
  publishOne,
  runPublish,
  skipReason,
  type ClaimCheck,
  type GuardResult,
  type Platform,
  type PlatformOutcome,
  type PublishDeps,
  type PublishResult,
} from "./lib/postFlow";
import { postBlueskyStory, redditStoryParts, submitRedditStory } from "./lib/storyPublishing";
import type { Turn } from "./lib/linkedinPost";

declare const process: { env: Record<string, string | undefined> };

const HTTP_TIMEOUT_MS = 20_000;

// undo.ts (another branch) defines it with args { postId, reason? }.
const removePost = makeFunctionReference<"action", { postId: Id<"posts">; reason?: string }>("undo:removePost");

const platformValidator = v.union(v.literal("bluesky"), v.literal("reddit"), v.literal("linkedin"));
const recordValidator = v.object({ uri: v.string(), cid: v.string() });
const outcomeValidator = v.union(
  v.object({
    status: v.literal("posted"),
    url: v.optional(v.string()),
    records: v.optional(v.array(recordValidator)),
    externalId: v.optional(v.string()),
  }),
  v.object({ status: v.literal("pending"), externalId: v.string() }),
  v.object({
    status: v.union(v.literal("failed"), v.literal("maybe_posted")),
    error: v.string(),
    url: v.optional(v.string()),
    records: v.optional(v.array(recordValidator)),
  }),
);

/** The language his calls run in: the disclosure line and the fact-check follow it. */
function postLanguage(elder: Doc<"elders"> | null): "en" | "es" {
  return elder ? callCharacter(elder).language : "en";
}

// ---------- queries + mutations ----------

/** Everything a publish run needs (no secrets). */
export const getForPublish = internalQuery({
  args: { postId: v.id("posts") },
  handler: async (ctx, { postId }) => {
    const post = await ctx.db.get(postId);
    if (!post) return null;
    const [call, elder] = await Promise.all([ctx.db.get(post.callId), ctx.db.get(post.elderId)]);
    const turns: Turn[] = call?.transcript ?? [];
    const context = buildGuardContext({
      profile: (elder as Record<string, unknown> | null)?.profile,
      summary: (call as Record<string, unknown> | null)?.summary,
    });
    return { post, turns, context, lang: postLanguage(elder) };
  },
});

export const isRemoved = internalQuery({
  args: { postId: v.id("posts") },
  handler: async (ctx, { postId }): Promise<boolean> => (await ctx.db.get(postId))?.removedAt !== undefined,
});

export const getPublication = internalQuery({
  args: { publicationId: v.id("postPublications") },
  handler: async (ctx, { publicationId }) => ctx.db.get(publicationId),
});

/** Atomically take the post for this run (posts.status -> "posting"). */
export const claimPost = internalMutation({
  args: { postId: v.id("posts"), approve: v.boolean() },
  handler: async (ctx, { postId, approve }): Promise<ClaimCheck> => {
    const post = await ctx.db.get(postId);
    if (!post) return { ok: false, reason: "Post not found." };
    const now = Date.now();
    const check = canStartPublish(post, now, approve);
    if (!check.ok) return check;
    await ctx.db.patch(postId, { status: "posting", claimedAt: now, error: undefined, ...(approve ? { approvedAt: now } : {}) });
    return { ok: true };
  },
});

/** The fact-check result. hold: needs_review (heldFor "guard", so a second approve skips it). */
export const saveGuard = internalMutation({
  args: { postId: v.id("posts"), hold: v.boolean(), issues: v.array(v.string()), summary: v.string() },
  handler: async (ctx, { postId, hold, issues, summary }) => {
    await ctx.db.patch(postId, {
      guardIssues: issues,
      guardSummary: summary,
      ...(hold ? { status: "needs_review", heldFor: "guard" as const, claimedAt: undefined } : {}),
    });
  },
});

/** The row for this post + platform (created if missing). Off platforms: a pending row becomes skipped. */
export const ensurePublication = internalMutation({
  args: { postId: v.id("posts"), platform: platformValidator, enabled: v.boolean() },
  handler: async (ctx, { postId, platform, enabled }): Promise<{ id: Id<"postPublications"> }> => {
    const post = await ctx.db.get(postId);
    if (!post) throw new Error("Post not found");
    const rows = await ctx.db.query("postPublications").withIndex("by_post", (q) => q.eq("postId", postId)).collect();
    const existing = rows.find((r) => r.platform === platform);
    if (existing) {
      if (!enabled && existing.status === "pending" && !existing.externalId) {
        await ctx.db.patch(existing._id, { status: "skipped", error: skipReason(platform) });
      }
      return { id: existing._id };
    }
    const id = await ctx.db.insert("postPublications", {
      postId,
      elderId: post.elderId,
      platform,
      status: enabled ? "pending" : "skipped",
      ...(enabled ? {} : { error: skipReason(platform) }),
    });
    return { id };
  },
});

/** Atomic claim of one platform row (never for a post that was taken down). */
export const claimPublication = internalMutation({
  args: { publicationId: v.id("postPublications"), approve: v.boolean() },
  handler: async (ctx, { publicationId, approve }): Promise<ClaimCheck & { previous?: string }> => {
    const row = await ctx.db.get(publicationId);
    if (!row) return { ok: false, reason: "Publication not found." };
    const post = await ctx.db.get(row.postId);
    const now = Date.now();
    const check = canClaimPublication(row, now, approve, !post || post.removedAt !== undefined);
    if (!check.ok) return check;
    await ctx.db.patch(publicationId, { status: "posting", claimedAt: now, error: undefined });
    return { ok: true, previous: row.status };
  },
});

/** Record what one platform attempt ended with (records/url are kept on a partial thread too). */
export const finishPublication = internalMutation({
  args: { publicationId: v.id("postPublications"), outcome: outcomeValidator },
  handler: async (ctx, { publicationId, outcome }) => {
    // Only the run that holds the row finishes it; never overwrite undo's removing / removed.
    const row = await ctx.db.get(publicationId);
    if (!row || (row.status !== "posting" && row.status !== "pending")) return;
    const base = {
      status: outcome.status,
      claimedAt: undefined,
      ...("url" in outcome && outcome.url ? { url: outcome.url } : {}),
      ...("records" in outcome && outcome.records?.length ? { records: outcome.records } : {}),
      ...("externalId" in outcome && outcome.externalId ? { externalId: outcome.externalId } : {}),
    };
    if (outcome.status === "posted") await ctx.db.patch(publicationId, { ...base, postedAt: Date.now(), error: undefined });
    else if (outcome.status === "pending") await ctx.db.patch(publicationId, { ...base, error: undefined });
    else await ctx.db.patch(publicationId, { ...base, error: outcome.error.slice(0, 500) });
  },
});

/**
 * posts.status from its rows (lib/postFlow.overallPostStatus). Leaves a post with removedAt (or
 * status "removed") alone: undo.ts owns it from then on.
 */
export const settlePost = internalMutation({
  args: { postId: v.id("posts") },
  handler: async (ctx, { postId }): Promise<{ status: string; error?: string }> => {
    const post = await ctx.db.get(postId);
    if (!post) return { status: "failed", error: "Post not found." };
    // Taken down (removedAt / "removed"), or held: undo and review own those states.
    if (post.removedAt !== undefined || !["posting", "published", "failed", "pending"].includes(post.status)) return { status: post.status };
    const rows = await ctx.db.query("postPublications").withIndex("by_post", (q) => q.eq("postId", postId)).collect();
    const overall = overallPostStatus(rows);
    const linkedin = rows.find((r) => r.platform === "linkedin" && r.status === "posted" && r.url);
    await ctx.db.patch(postId, {
      status: overall.status,
      error: overall.error,
      ...(overall.status === "posting" ? {} : { claimedAt: undefined }),
      ...(linkedin?.url ? { linkedinUrl: linkedin.url } : {}),
    });
    return overall;
  },
});

// ---------- actions ----------

/** fetch with a timeout (AbortController); a timeout surfaces as a thrown error. */
const timedFetch: FetchFn = async (url, init) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};

type PublishData = NonNullable<Awaited<ReturnType<typeof loadData>>>;

function loadData(ctx: ActionCtx, postId: Id<"posts">) {
  return ctx.runQuery(internal.publish.getForPublish, { postId });
}

/**
 * Which platforms are on for him (lib/logins.ts decides Bluesky and Reddit). A lookup that
 * throws (an account we can't read, e.g. a missing key) counts as on, so its row ends up
 * `failed` with a clear error instead of being skipped silently.
 */
async function platformsFor(ctx: ActionCtx, elderId: Id<"elders">): Promise<Record<Platform, boolean>> {
  const has = (p: Promise<unknown>) => p.then(Boolean, () => true);
  const [bluesky, reddit] = await Promise.all([has(blueskyLoginForElder(ctx, elderId)), has(redditLoginForElder(ctx, elderId))]);
  return enabledPlatforms({ blueskyLogin: bluesky, redditLogin: reddit, linkedinOn: linkedinPostingOn(process.env.LINKEDIN_POSTING) });
}

/** A login lookup that throws -> null + a fixed error (nothing is posted). Never the error text. */
async function loginOrError<T>(lookup: Promise<T | null>, what: string): Promise<{ login: T | null; error?: string }> {
  try {
    return { login: await lookup };
  } catch {
    return { login: null, error: `Couldn't read his ${what} login (account setup error); nothing was posted.` };
  }
}

/** Post to one platform. `previous` = the row's status before this claim. Never throws on purpose. */
async function postTo(
  ctx: ActionCtx,
  data: PublishData,
  platform: Platform,
  publicationId: Id<"postPublications">,
  previous: string | undefined,
): Promise<PlatformOutcome> {
  const { post, lang } = data;
  if (platform === "bluesky") {
    const { login, error } = await loginOrError(blueskyLoginForElder(ctx, post.elderId), "Bluesky");
    if (error) return { status: "failed", error };
    const split = splitBlueskyThread(post.text, lang);
    if (!split.ok) return { status: "failed", error: `Doesn't fit a Bluesky thread: ${split.reason}` };
    const row = await ctx.runQuery(internal.publish.getPublication, { publicationId });
    return postBlueskyStory(timedFetch, sharedSessionCache(), login, {
      texts: split.posts,
      langs: split.langs,
      done: row?.records ?? [],
      // An earlier attempt may have posted more than we know.
      recover: previous === "maybe_posted" || previous === "posting" || Boolean(row?.records?.length),
    });
  }
  if (platform === "reddit") {
    const { login, error } = await loginOrError(redditLoginForElder(ctx, post.elderId), "Reddit");
    if (error) return { status: "failed", error };
    return submitRedditStory(timedFetch, login, redditStoryParts(post.text, lang));
  }
  if (!linkedinPostingOn(process.env.LINKEDIN_POSTING)) return { status: "failed", error: skipReason("linkedin") };
  return ctx.runAction(internal.linkedapi.startPublication, { postId: post._id, publicationId });
}

/** The DB + HTTP side of lib/postFlow.runPublish / publishOne for one post. */
function depsFor(ctx: ActionCtx, postId: Id<"posts">, state: { data: PublishData | null }): PublishDeps {
  const previous = new Map<string, string | undefined>();
  return {
    load: async () => {
      state.data = await loadData(ctx, postId);
      const p = state.data?.post;
      return p ? { status: p.status, ...(p.removedAt !== undefined ? { removedAt: p.removedAt } : {}), ...(p.heldFor ? { heldFor: p.heldFor } : {}) } : null;
    },
    platforms: () => platformsFor(ctx, state.data!.post.elderId),
    claimPost: (approve) => ctx.runMutation(internal.publish.claimPost, { postId, approve }),
    guard: async (): Promise<GuardResult> => {
      const data = state.data!;
      const split = splitBlueskyThread(data.post.text, data.lang);
      try {
        return await ctx.runAction(internal.postGuard.checkPost, {
          postText: split.ok ? split.body : data.post.text, // our disclosure line isn't a claim from the call
          turns: data.turns,
          ...(data.context.trim() ? { context: data.context } : {}),
        });
      } catch (err) {
        // Fail closed: if the check itself crashed, hold the post. Fixed text only.
        const what = err instanceof Error && /^[\w .:()-]{1,120}$/.test(err.message) ? err.message : "error";
        return { pass: false, issues: [`Fact-check crashed: ${what}`], summary: "Fact-check error.", mode: "enforce" };
      }
    },
    saveGuard: async (guard, hold) => {
      await ctx.runMutation(internal.publish.saveGuard, { postId, hold, issues: guard.issues, summary: guard.summary });
    },
    ensureRow: (platform, enabled) => ctx.runMutation(internal.publish.ensurePublication, { postId, platform, enabled }),
    claimRow: async (id, approve) => {
      const claim = await ctx.runMutation(internal.publish.claimPublication, { publicationId: id as Id<"postPublications">, approve });
      previous.set(id, claim.ok ? claim.previous : undefined);
      return claim;
    },
    post: (platform, rowId) => postTo(ctx, state.data!, platform, rowId as Id<"postPublications">, previous.get(rowId)),
    finishRow: async (id, outcome) => {
      await ctx.runMutation(internal.publish.finishPublication, { publicationId: id as Id<"postPublications">, outcome });
    },
    isRemoved: () => ctx.runQuery(internal.publish.isRemoved, { postId }),
    scheduleUndo: async () => {
      try {
        await ctx.scheduler.runAfter(0, removePost, { postId });
        console.warn(`publish: post ${postId} was taken down while posting; undo:removePost scheduled`);
      } catch {
        console.error(`publish: post ${postId} was taken down while posting, and undo:removePost could not be scheduled: run it by hand`);
      }
    },
    settle: () => ctx.runMutation(internal.publish.settlePost, { postId }),
  };
}

async function publish(ctx: ActionCtx, postId: Id<"posts">, approve: boolean): Promise<PublishResult> {
  const result = await runPublish(depsFor(ctx, postId, { data: null }), approve);
  console.log(`publish: post ${postId} ${result.status}`, JSON.stringify(Object.entries(result.platforms ?? {}).map(([p, s]) => `${p}:${s.split(":")[0]}`)));
  return result;
}

/** Fact-check + post to every enabled platform. Never posts the same row twice. */
export const publishPost = internalAction({
  args: { postId: v.id("posts") },
  handler: async (ctx, { postId }): Promise<PublishResult> => publish(ctx, postId, false),
});

/**
 * A person read a held post (needs_review) and wants it out: a quality hold is fact-checked
 * first (it never was); a fact-check hold goes out as it is. Same claims, so no double posts.
 */
export const approvePost = internalAction({
  args: { postId: v.id("posts") },
  handler: async (ctx, { postId }): Promise<PublishResult> => publish(ctx, postId, true),
});

/**
 * Post one platform again: a failed or skipped row, or (approve: true, after checking his
 * profile) a maybe_posted one. The post must have been published or failed before.
 */
export const retryPublication = internalAction({
  args: { publicationId: v.id("postPublications"), approve: v.optional(v.boolean()) },
  handler: async (ctx, { publicationId, approve }): Promise<{ status: string; reason?: string; post?: string }> => {
    const row = await ctx.runQuery(internal.publish.getPublication, { publicationId });
    if (!row) return { status: "failed", reason: "Publication not found." };
    const state: { data: PublishData | null } = { data: await loadData(ctx, row.postId) };
    if (!state.data) return { status: "failed", reason: "Post not found." };
    const allowed = canRetry(state.data.post, row);
    if (!allowed.ok) return { status: row.status, reason: allowed.reason };
    const platform = row.platform as Platform;
    if (!(await platformsFor(ctx, row.elderId))[platform]) return { status: row.status, reason: skipReason(platform) };

    const one = await publishOne(depsFor(ctx, row.postId, state), platform, publicationId, approve ?? false);
    const settled = await ctx.runMutation(internal.publish.settlePost, { postId: row.postId });
    console.log(`publish.retryPublication: ${platform} row ${publicationId} ${one.status}; post ${row.postId} ${settled.status}`);
    return { status: one.status, ...(one.reason ? { reason: one.reason } : {}), post: settled.status };
  },
});
