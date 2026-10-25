// Publishing a story post to his accounts. One postPublications row per post per platform.
//
//   publishPost({ postId })        scheduled by pipeline.insertPost for a new post (AUTO_POST on),
//                                  in the same mutation that saves it. Never a post with
//                                  removedAt, or one held for review. Then:
//     1. claim the post (posts.status -> "posting"; one run at a time, retaken after 15 min)
//     2. the fact-check, once (postGuard.checkPost; lib/postFlow.shouldRunGuard)
//          fail + POST_GUARD_MODE=enforce -> needs_review (heldFor "guard"), posted nowhere
//          cleared -> guardPassedAt
//          FAST_POST=on: it starts while the logins are read, with an 8 s timeout; if that
//          times out, the normal check runs (slower, never skipped)
//     3. each platform in order, each with its own row: claim -> post -> finish -> re-read the
//        post; if it was taken down meanwhile (removedAt), schedule undo:removePost and stop
//          bluesky   his login (lib/logins.ts): the post as a 3-5 post thread
//                    (lib/blueskyThread.ts); records = every post, root first; url = post 1.
//                    A refused login marks his account invalid (reportBlueskyLoginError).
//          threads   when he connected Threads (lib/threadsLogin.ts): a 2-5 post thread
//                    (lib/threadsPublishing.ts); a retry looks in his profile first
//          x         only when X_POSTING=on and he connected X (lib/xLogin.ts): a self-thread,
//                    or one post with X_THREAD=off (lib/xPublishing.ts)
//          reddit    only when redditLoginForElder returns a login (REDDIT_POSTING=on): a self
//                    post on his profile (sr=u_<name>), title = the hook
//          linkedin  only when LINKEDIN_POSTING=on, through linkedapi.startPublication
//                    (LinkedAPI + polling); otherwise its row is "skipped"
//        an unclear failure (timeout after the request went out, 5xx, or a Threads / X /
//        Reddit / LinkedIn run that stopped mid-post) -> maybe_posted: never retried on its own; a person checks
//        his profile, then retryPublication approve:true
//        posts.timings: checkedAt (fact-check answered), postedAt (first platform posted);
//        one log line per run with the seconds per stage (lib/fastPost.timingLine, no text)
//     4. posts.status: published (any platform posted; linkedinUrl only from LinkedIn) |
//        partly_posted (only part of a thread is out, any platform) | failed (nothing went out) |
//        needs_review (held)
//   approvePost({ postId })        a person read a held post. A fact-check hold goes out as it
//                                  is; anything else (quality / thread-fit hold, a pending post
//                                  with AUTO_POST=off, a failed one) is fact-checked first. A
//                                  thread-fit hold is refused until the text fits.
//   retryPublication({ publicationId, approve? })   one failed / maybe_posted / skipped row of
//                                  a post the fact-check cleared (maybe_posted needs approve:
//                                  true, after checking his profile). A Bluesky retry continues
//                                  a half-posted thread, and first looks in his repo for posts an
//                                  earlier attempt made (only ones made after the row existed).
//                                  A LinkedIn row stuck "pending" (sent, checks stopped) is
//                                  checked again; nothing is sent.
//
//   npx convex run publish:publishPost '{"postId":"<posts id>"}'
//   npx convex run publish:approvePost '{"postId":"<posts id>"}'
//   npx convex run publish:retryPublication '{"publicationId":"<postPublications id>","approve":true}'
//
// Disclosure + fact-check language: posts.language, decided once when the post is saved
// (postLanguage: the language his calls run in). Older rows: postLanguage(elder).
// Never log tokens, passwords or post text: ids and statuses only.
// Env: AUTO_POST, POST_GUARD_MODE, FAST_POST, LINKEDIN_POSTING, X_POSTING, X_THREAD (+ the login variables
// in lib/logins.ts, lib/threadsLogin.ts, lib/xLogin.ts).
// Owner: Integrations.

import { v } from "convex/values";
import { makeFunctionReference } from "convex/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, type ActionCtx } from "./_generated/server";
import { sharedSessionCache, type FetchFn } from "./lib/blueskyClient";
import { splitBlueskyThread } from "./lib/blueskyThread";
import { fastPostOn, timingLine, type PostTimings } from "./lib/fastPost";
import { FAST_GUARD_TIMEOUT_MS } from "./lib/postQuality";
import { blueskyLoginForElder, blueskyLoginState, blueskyProblemReason, redditLoginForElder, reportBlueskyLoginError } from "./lib/logins";
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
  quickThenFullGuard,
  runPublish,
  shouldRecover,
  shouldRunGuard,
  skipReason,
  type ClaimCheck,
  type GuardResult,
  type Platform,
  type PlatformOutcome,
  type PublishDeps,
  type PublishResult,
} from "./lib/postFlow";
import { postBlueskyStory, publishThreadsStory, publishXStory, redditStoryParts, submitRedditStory } from "./lib/storyPublishing";
import { reportThreadsLoginError, threadsLoginForElder } from "./lib/threadsLogin";
import { xLoginForElder } from "./lib/xLogin";
import { xMode, xPostingOn } from "./lib/xPublishing";
import type { Turn } from "./lib/linkedinPost";

declare const process: { env: Record<string, string | undefined> };

const HTTP_TIMEOUT_MS = 20_000;

// undo.ts (another branch) defines it with args { postId, reason? }.
const removePost = makeFunctionReference<"action", { postId: Id<"posts">; reason?: string }>("undo:removePost");

const platformValidator = v.union(v.literal("bluesky"), v.literal("threads"), v.literal("x"), v.literal("reddit"), v.literal("linkedin"));
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

/**
 * The language a post goes out in (disclosure line, fact-check): the language his calls run in,
 * i.e. his character's (callCharacter falls back to elders.language). Saved on posts.language.
 */
export function postLanguage(elder: Pick<Doc<"elders">, "characterId" | "language"> | null): "en" | "es" {
  return elder ? callCharacter(elder).language : "en";
}

/** postLanguage for an elder id (pipeline: the writer's thread-fit check). */
export const languageForElder = internalQuery({
  args: { elderId: v.id("elders") },
  handler: async (ctx, { elderId }): Promise<"en" | "es"> => postLanguage(await ctx.db.get(elderId)),
});

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
    return { post, turns, context, lang: post.language ?? postLanguage(elder) };
  },
});

export const getTimings = internalQuery({
  args: { postId: v.id("posts") },
  handler: async (ctx, { postId }): Promise<PostTimings | null> => (await ctx.db.get(postId))?.timings ?? null,
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
    // A person approving a fact-check hold clears it: this run skips the guard (shouldRunGuard).
    const approvedHold = approve && !shouldRunGuard(post, approve);
    await ctx.db.patch(postId, {
      status: "posting",
      claimedAt: now,
      error: undefined,
      ...(approve ? { approvedAt: now } : {}),
      ...(approvedHold ? { guardPassedAt: now } : {}),
    });
    return { ok: true };
  },
});

/**
 * The fact-check result. hold: needs_review (heldFor "guard", so a second approve skips it).
 * Otherwise it's cleared (guardPassedAt), which retryPublication needs.
 */
export const saveGuard = internalMutation({
  args: { postId: v.id("posts"), hold: v.boolean(), issues: v.array(v.string()), summary: v.string() },
  handler: async (ctx, { postId, hold, issues, summary }) => {
    // Taken down meanwhile: keep its "removed" status (undo owns it).
    const post = await ctx.db.get(postId);
    const removed = post?.removedAt !== undefined;
    await ctx.db.patch(postId, {
      guardIssues: issues,
      guardSummary: summary,
      timings: { ...(post?.timings ?? {}), checkedAt: Date.now() },
      ...(hold
        ? removed
          ? { guardPassedAt: undefined }
          : { status: "needs_review", heldFor: "guard" as const, claimedAt: undefined, guardPassedAt: undefined }
        : { guardPassedAt: Date.now() }),
    });
  },
});

/**
 * The row for this post + platform (created if missing). Off platforms: a pending row becomes
 * skipped, with `reason` (else lib/postFlow.skipReason).
 */
export const ensurePublication = internalMutation({
  args: { postId: v.id("posts"), platform: platformValidator, enabled: v.boolean(), reason: v.optional(v.string()) },
  handler: async (ctx, { postId, platform, enabled, reason }): Promise<{ id: Id<"postPublications"> }> => {
    const post = await ctx.db.get(postId);
    if (!post) throw new Error("Post not found");
    const why = reason ?? skipReason(platform);
    const rows = await ctx.db.query("postPublications").withIndex("by_post", (q) => q.eq("postId", postId)).collect();
    const existing = rows.find((r) => r.platform === platform);
    if (existing) {
      if (!enabled && existing.status === "pending" && !existing.externalId) {
        await ctx.db.patch(existing._id, { status: "skipped", error: why });
      }
      return { id: existing._id };
    }
    const id = await ctx.db.insert("postPublications", {
      postId,
      elderId: post.elderId,
      platform,
      status: enabled ? "pending" : "skipped",
      ...(enabled ? {} : { error: why }),
    });
    return { id };
  },
});

/**
 * Atomic claim of one platform row (never for a post that was taken down). A stale claim on
 * anything but Bluesky becomes maybe_posted here (lib/postFlow.canClaimPublication).
 */
export const claimPublication = internalMutation({
  args: { publicationId: v.id("postPublications"), approve: v.boolean() },
  handler: async (ctx, { publicationId, approve }): Promise<ClaimCheck & { previous?: string }> => {
    const row = await ctx.db.get(publicationId);
    if (!row) return { ok: false, reason: "Publication not found." };
    const post = await ctx.db.get(row.postId);
    const now = Date.now();
    const check = canClaimPublication(row, now, approve, !post || post.removedAt !== undefined);
    if (!check.ok) {
      if ("becomes" in check) await ctx.db.patch(publicationId, { status: check.becomes, claimedAt: undefined, error: check.reason });
      return { ok: false, reason: check.reason };
    }
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
    if (outcome.status === "posted") {
      const now = Date.now();
      await ctx.db.patch(publicationId, { ...base, postedAt: now, error: undefined });
      // posts.timings.postedAt: the first platform that finished (Bluesky, in order).
      const post = await ctx.db.get(row.postId);
      if (post && post.timings?.postedAt === undefined) await ctx.db.patch(row.postId, { timings: { ...(post.timings ?? {}), postedAt: now } });
    }
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
    if (post.removedAt !== undefined || !["posting", "published", "partly_posted", "failed", "pending"].includes(post.status)) {
      return { status: post.status };
    }
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
 * Which platforms are on for him (lib/postFlow.enabledPlatforms), and why one is off when the
 * plain skipReason would mislead. The Bluesky and Reddit lookups never throw (null = off): an
 * account whose login can't be read (ACCOUNTS_ENC_KEY missing or rotated) is skipped with that
 * reason, not "not connected". A Threads / X lookup that throws counts as on, so its row ends
 * up `failed` with a clear error. X's login is only read when X_POSTING is on.
 */
async function platformsFor(
  ctx: ActionCtx,
  elderId: Id<"elders">,
): Promise<{ on: Record<Platform, boolean>; reasons: Partial<Record<Platform, string>> }> {
  const has = (p: Promise<unknown>) => p.then(Boolean, () => true);
  const xOn = xPostingOn(process.env);
  const [bluesky, threads, x, reddit] = await Promise.all([
    blueskyLoginState(ctx, elderId),
    has(threadsLoginForElder(ctx, elderId, { fetchFn: timedFetch })),
    xOn ? has(xLoginForElder(ctx, elderId, { fetchFn: timedFetch })) : Promise.resolve(false),
    has(redditLoginForElder(ctx, elderId)),
  ]);
  const on = enabledPlatforms({
    blueskyLogin: bluesky.login !== null,
    threadsLogin: threads,
    xOn,
    xLogin: x,
    redditLogin: reddit,
    linkedinOn: linkedinPostingOn(process.env.LINKEDIN_POSTING),
  });
  return { on, reasons: bluesky.problem ? { bluesky: blueskyProblemReason(bluesky.problem) } : {} };
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
      // An earlier attempt may have posted more than we know: only posts made after this row
      // existed (its first claim came right after) can be that attempt's.
      recover: shouldRecover(previous, row?.records),
      ...(row ? { since: row._creationTime } : {}),
      // A revoked or changed app password: mark his account invalid (lib/logins.ts).
      onLoginError: (e) => reportBlueskyLoginError(ctx, post.elderId, e),
    });
  }
  if (platform === "threads") {
    const { login, error } = await loginOrError(threadsLoginForElder(ctx, post.elderId, { fetchFn: timedFetch }), "Threads");
    if (error) return { status: "failed", error };
    const row = await ctx.runQuery(internal.publish.getPublication, { publicationId });
    // No repo check like Bluesky's: the recovery reads his recent posts and replies instead.
    return publishThreadsStory(timedFetch, login, {
      text: post.text,
      lang,
      done: row?.records ?? [],
      recover: shouldRecover(previous, row?.records),
      // Meta refused his token (code 190): mark his Threads account invalid (lib/threadsLogin.ts).
      onLoginError: (e) => reportThreadsLoginError(ctx, post.elderId, e),
    });
  }
  if (platform === "x") {
    if (!xPostingOn(process.env)) return { status: "failed", error: skipReason("x") };
    const { login, error } = await loginOrError(xLoginForElder(ctx, post.elderId, { fetchFn: timedFetch }), "X");
    if (error) return { status: "failed", error };
    const row = await ctx.runQuery(internal.publish.getPublication, { publicationId });
    return publishXStory(timedFetch, login, { text: post.text, lang, mode: xMode(process.env), done: row?.records ?? [] });
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
  const fast = fastPostOn(process.env);
  let reasons: Partial<Record<Platform, string>> = {}; // why a platform is off (platformsFor)
  return {
    load: async () => {
      state.data = await loadData(ctx, postId);
      const p = state.data?.post;
      return p ? { status: p.status, ...(p.removedAt !== undefined ? { removedAt: p.removedAt } : {}), ...(p.heldFor ? { heldFor: p.heldFor } : {}) } : null;
    },
    platforms: async () => {
      const found = await platformsFor(ctx, state.data!.post.elderId);
      reasons = found.reasons;
      return found.on;
    },
    claimPost: (approve) => ctx.runMutation(internal.publish.claimPost, { postId, approve }),
    guardEarly: fast,
    guard: async (): Promise<GuardResult> => {
      const data = state.data!;
      const split = splitBlueskyThread(data.post.text, data.lang);
      const args = {
        postText: split.ok ? split.body : data.post.text, // our disclosure line isn't a claim from the call
        turns: data.turns,
        ...(data.context.trim() ? { context: data.context } : {}),
      };
      try {
        const full = () => ctx.runAction(internal.postGuard.checkPost, args);
        if (!fast) return await full();
        const out = await quickThenFullGuard(() => ctx.runAction(internal.postGuard.checkPost, { ...args, timeoutMs: FAST_GUARD_TIMEOUT_MS }), full);
        if (out.slow) console.warn(`publish: post ${postId} fast fact-check didn't answer in time; ran the normal check`);
        return out;
      } catch (err) {
        // Fail closed: if the check itself crashed, hold the post. Fixed text only.
        const what = err instanceof Error && /^[\w .:()-]{1,120}$/.test(err.message) ? err.message : "error";
        return { pass: false, issues: [`Fact-check crashed: ${what}`], summary: "Fact-check error.", mode: "enforce" };
      }
    },
    saveGuard: async (guard, hold) => {
      await ctx.runMutation(internal.publish.saveGuard, { postId, hold, issues: guard.issues, summary: guard.summary });
    },
    ensureRow: (platform, enabled) =>
      ctx.runMutation(internal.publish.ensurePublication, { postId, platform, enabled, ...(!enabled && reasons[platform] ? { reason: reasons[platform] } : {}) }),
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
  try {
    const timings = await ctx.runQuery(internal.publish.getTimings, { postId });
    if (timings) console.log(`publish: post ${postId} timings: ${timingLine(timings)}`);
  } catch {
    // only a log line
  }
  return result;
}

/** Fact-check + post to every enabled platform. Never posts the same row twice. */
export const publishPost = internalAction({
  args: { postId: v.id("posts") },
  handler: async (ctx, { postId }): Promise<PublishResult> => publish(ctx, postId, false),
});

/**
 * A person read a post and wants it out: a fact-check hold goes out as it is; anything else
 * (quality / thread-fit hold, a pending or failed post) is fact-checked first. A thread-fit hold
 * whose text still doesn't fit is refused. Same claims, so no double posts.
 */
export const approvePost = internalAction({
  args: { postId: v.id("posts") },
  handler: async (ctx, { postId }): Promise<PublishResult> => {
    const data = await loadData(ctx, postId);
    if (data && data.post.status === "needs_review" && data.post.heldFor === "thread_fit") {
      const split = splitBlueskyThread(data.post.text, data.lang);
      if (!split.ok) {
        return {
          status: "needs_review",
          reason: `Held: too long for a Bluesky thread (${split.reason}). Shorten posts.text, then run publish:approvePost again.`,
        };
      }
    }
    return publish(ctx, postId, true);
  },
});

/**
 * Post one platform again: a failed or skipped row, or (approve: true, after checking his
 * profile) a maybe_posted one. The post must have gone through publishing and been cleared by
 * the fact-check (else: run publish:publishPost). A LinkedIn row LinkedAPI accepted whose
 * status checks stopped is only checked again.
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
    if (allowed.repoll) {
      if (!linkedinPostingOn(process.env.LINKEDIN_POSTING)) return { status: row.status, reason: skipReason("linkedin") };
      // LinkedAPI already has it: check its status again with a fresh poll budget. Never sends again.
      await ctx.runMutation(internal.linkedapi.updatePost, { postId: row.postId, pollAttempts: 0 });
      await ctx.runAction(internal.linkedapi.checkPublicationStatus, { postId: row.postId, publicationId });
      const after = await ctx.runQuery(internal.publish.getPublication, { publicationId });
      const settled = await ctx.runMutation(internal.publish.settlePost, { postId: row.postId });
      console.log(`publish.retryPublication: linkedin row ${publicationId} re-checked: ${after?.status ?? "gone"}`);
      return { status: after?.status ?? row.status, post: settled.status };
    }
    const found = await platformsFor(ctx, row.elderId);
    if (!found.on[platform]) return { status: row.status, reason: found.reasons[platform] ?? skipReason(platform) };

    const one = await publishOne(depsFor(ctx, row.postId, state), platform, publicationId, approve ?? false);
    const settled = await ctx.runMutation(internal.publish.settlePost, { postId: row.postId });
    console.log(`publish.retryPublication: ${platform} row ${publicationId} ${one.status}; post ${row.postId} ${settled.status}`);
    return { status: one.status, ...(one.reason ? { reason: one.reason } : {}), post: settled.status };
  },
});
