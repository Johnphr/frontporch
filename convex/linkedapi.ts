// LinkedIn posting via LinkedAPI, on grandpa's own account. SWITCHED OFF by default: nothing here
// calls LinkedAPI unless LINKEDIN_POSTING=on (LinkedAPI needs a connected account per person).
// Story posts go out through publish.ts (Bluesky thread first, Reddit gated, LinkedIn here).
//
// With LINKEDIN_POSTING=on, publish.ts posts through:
//   startPublication({ postId, publicationId })   format + POST /workflows (no fact-check:
//       publish.ts ran it) -> the postPublications row is "pending" with the workflow id in
//       externalId -> checkPublicationStatus polls and finishes the row (posted + canonical
//       url; posts.linkedinUrl via publish.settlePost) | failed | maybe_posted.
//
// The older one-platform flow below (createPost / approvePost / checkPostStatus on the posts
// row) is kept, also behind LINKEDIN_POSTING, for posts that never went through publish.ts:
// it refuses any post with postPublications rows. It was called by pipeline.processCall:
//   await ctx.runAction(internal.linkedapi.createPost, { postId, context? })
//     context: optional background the fact-check may treat as his words
//     (e.g. memories used to write the post). His profile and the call summary
//     are loaded automatically when they exist.
//
//   1. claimPost: atomically move the row to "posting" (no double posting)
//   2. lib/linkedinPost.prepareLinkedInText: plain text, <= 3 hashtags,
//      disclosure line once at the end, <= 3,000 characters
//   3. postGuard.checkPost: fact-check against the call + background
//        fail + POST_GUARD_MODE=enforce -> status "needs_review", NOT posted
//   4. POST https://api.linkedapi.io/workflows  { actionType: "st.createPost", text }
//        -> status "pending" + workflowId
//        no clear answer (timeout / 5xx) -> "failed" + maybePosted: a human checks
//        his LinkedIn first; we never auto-retry into a duplicate post
//   5. checkPostStatus polls GET /workflows/{workflowId} with backoff and saves
//      the canonical post URL + "published" (apify.scrapeEngagement matches on
//      it), or "failed" + error, or "needs_attention" if polling can't continue.
//
// Statuses: pending -> posting -> pending(+workflowId) -> published
//           needs_review (guard held it) · failed · needs_attention
//
// Human actions:
//   npx convex run linkedapi:approvePost '{"postId": "<id>"}'   post a needs_review row as-is
//   npx convex run linkedapi:checkPostStatus '{"postId": "<id>"}' resume polling
// Live test without posting:
//   npx convex run linkedapi:previewText '{"text": "...", "turns": [{"role":"elder","text":"..."}]}'
//   npx convex run linkedapi:previewPost '{"postId": "<posts id>"}'
//
// Env: LINKEDIN_POSTING (default off), LINKEDAPI_TOKEN, LINKEDAPI_ID_TOKEN
//      (+ OPENAI_API_KEY, POST_GUARD_MODE for the guard)
// Owner: Integrations.

import { v } from "convex/values";
import { makeFunctionReference } from "convex/server";
import { internal } from "./_generated/api";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type ActionCtx,
  type QueryCtx,
} from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import {
  MAX_POLL_ATTEMPTS,
  disclosureFor,
  pollDelayMs,
  prepareLinkedInText,
  type Turn,
} from "./lib/linkedinPost";
import { callCharacter, callLanguage } from "./lib/onboarding";
import {
  MAYBE_POSTED_MESSAGE,
  buildGuardContext,
  canClaim,
  classifyStart,
  guardDecision,
  linkedinPostingOn,
  parseWorkflowResult,
  shouldRestartPolling,
  shouldRunGuard,
  type GuardResult,
  type PlatformOutcome,
} from "./lib/postFlow";
import { canonicalLinkedInPostUrl } from "./lib/linkedinUrl";

// Convex exposes env vars on process.env (declared so we don't need @types/node).
declare const process: { env: Record<string, string | undefined> };

const LINKEDAPI = "https://api.linkedapi.io";
const REQUEST_TIMEOUT_MS = 30_000;

type PostStatus = "pending" | "posting" | "needs_review" | "published" | "failed" | "needs_attention" | "off";

const LINKEDIN_OFF = "LinkedIn posting is off (LINKEDIN_POSTING). Story posts go out with publish:publishPost.";
const linkedinOn = () => linkedinPostingOn(process.env.LINKEDIN_POSTING);

// undo.ts (another branch) defines it with args { postId, reason? }.
const removePost = makeFunctionReference<"action", { postId: Id<"posts">; reason?: string }>("undo:removePost");

type CreatePostResult = {
  status: PostStatus;
  url?: string;
  error?: string;
  issues?: string[];
  note?: string;
};

type PreviewResult = {
  text: string;
  warnings: string[];
  chars: number;
  guard: GuardResult;
  wouldPost: boolean;
};

type ClaimResult =
  | { ok: true; runGuard: boolean }
  | { ok: false; reason: string; status: PostStatus; url?: string; restartPolling: boolean };

const USES_PUBLISH =
  "This post goes out through publish.ts (it has postPublications rows): use publish:approvePost or publish:retryPublication.";

async function hasPublications(ctx: { db: QueryCtx["db"] }, postId: Id<"posts">): Promise<boolean> {
  return (await ctx.db.query("postPublications").withIndex("by_post", (q) => q.eq("postId", postId)).first()) !== null;
}

const turnValidator = v.object({ role: v.string(), text: v.string() });

// ---------- database helpers ----------

export const getPostForPosting = internalQuery({
  args: { postId: v.id("posts") },
  handler: async (ctx, { postId }) => {
    const post = await ctx.db.get(postId);
    if (!post) return null;
    const call = await ctx.db.get(post.callId);
    const elder = await ctx.db.get(post.elderId);
    const turns: Turn[] = call?.transcript ?? [];
    // v2 fields (elders.profile, calls.summary) may not be in the schema yet:
    // read them defensively so this keeps working before and after Data's PR.
    const context = buildGuardContext({
      profile: (elder as Record<string, unknown> | null)?.profile,
      summary: (call as Record<string, unknown> | null)?.summary,
    });
    // Disclosure footer in the post's language (posts.language; older rows: his calls' language).
    const disclosure = disclosureFor(post.language ?? (elder ? callCharacter(elder).language : "en"));
    return { post, turns, context, disclosure, usesPublish: await hasPublications(ctx, postId) };
  },
});

/** Atomically take the row for this run. Mutations are serializable, so only one caller wins. */
export const claimPost = internalMutation({
  args: { postId: v.id("posts"), approve: v.boolean() },
  handler: async (ctx, { postId, approve }): Promise<ClaimResult> => {
    const post = await ctx.db.get(postId);
    if (!post) return { ok: false, reason: "Post not found", status: "failed", restartPolling: false };
    const now = Date.now();
    // publish.ts owns it (its workflowId, if any, is a publish.ts LinkedIn row's).
    if (await hasPublications(ctx, postId)) {
      return { ok: false, reason: USES_PUBLISH, status: post.status as PostStatus, restartPolling: false };
    }

    if (shouldRestartPolling(post, now)) {
      // Sent to LinkedAPI but nobody is polling: restart once (lastPolledAt = now
      // stops a second caller from scheduling another poll chain).
      await ctx.db.patch(postId, { status: "pending", lastPolledAt: now });
      return {
        ok: false,
        reason: "Already sent to LinkedAPI; restarted the status checks.",
        status: "pending",
        restartPolling: true,
      };
    }

    const check = canClaim(post, now, approve);
    if (!check.ok) {
      return {
        ok: false,
        reason: check.reason,
        status: post.status as PostStatus,
        url: post.linkedinUrl,
        restartPolling: false,
      };
    }
    // Decided before the claim changes the status (lib/postFlow.shouldRunGuard).
    const runGuard = shouldRunGuard(post, approve);
    await ctx.db.patch(postId, {
      status: "posting",
      claimedAt: now,
      error: undefined,
      maybePosted: undefined,
      ...(approve ? { approvedAt: now } : {}),
    });
    return { ok: true, runGuard };
  },
});

export const updatePost = internalMutation({
  args: {
    postId: v.id("posts"),
    status: v.optional(v.string()),
    text: v.optional(v.string()),
    linkedinUrl: v.optional(v.string()),
    error: v.optional(v.string()),
    clearError: v.optional(v.boolean()),
    workflowId: v.optional(v.string()),
    guardIssues: v.optional(v.array(v.string())),
    guardSummary: v.optional(v.string()),
    heldFor: v.optional(v.union(v.literal("quality"), v.literal("thread_fit"), v.literal("guard"))),
    pollAttempts: v.optional(v.number()),
    lastPolledAt: v.optional(v.number()),
    maybePosted: v.optional(v.boolean()),
  },
  handler: async (ctx, { postId, clearError, ...fields }) => {
    const patch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) patch[key] = value;
    }
    if (clearError && fields.error === undefined) patch.error = undefined;
    await ctx.db.patch(postId, patch);
  },
});

// ---------- LinkedAPI HTTP ----------

function linkedApiHeaders(): Record<string, string> | null {
  const token = process.env.LINKEDAPI_TOKEN;
  const idToken = process.env.LINKEDAPI_ID_TOKEN;
  if (!token || !idToken) return null;
  return {
    "Content-Type": "application/json",
    "linked-api-token": token,
    "identification-token": idToken,
  };
}

const MISSING_TOKENS = "LINKEDAPI_TOKEN / LINKEDAPI_ID_TOKEN are not set in Convex";

async function fetchJson(url: string, init: RequestInit): Promise<{ status: number; json: any; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const json = await res.json().catch(() => null);
    return { status: res.status, json };
  } catch (err) {
    return { status: 0, json: null, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- shared posting flow ----------

async function runPosting(
  ctx: ActionCtx,
  postId: Id<"posts">,
  opts: { approve: boolean; context?: string },
): Promise<CreatePostResult> {
  const claim: ClaimResult = await ctx.runMutation(internal.linkedapi.claimPost, {
    postId,
    approve: opts.approve,
  });
  if (!claim.ok) {
    if (claim.restartPolling) {
      await ctx.scheduler.runAfter(0, internal.linkedapi.checkPostStatus, { postId });
    }
    return { status: claim.status, url: claim.url, note: claim.reason };
  }

  const data = await ctx.runQuery(internal.linkedapi.getPostForPosting, { postId });
  if (!data) return { status: "failed", error: "Post not found" };

  let prepared;
  try {
    prepared = prepareLinkedInText(data.post.text, { disclosure: data.disclosure });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await ctx.runMutation(internal.linkedapi.updatePost, { postId, status: "failed", error });
    return { status: "failed", error };
  }

  let guard: GuardResult | null = null;
  // Skipped only for a person approving a fact-check hold (claimPost decided it).
  if (claim.runGuard) {
    let checked: GuardResult;
    try {
      checked = await ctx.runAction(internal.postGuard.checkPost, {
        postText: prepared.body, // our own disclosure line isn't a claim from the call
        turns: data.turns,
        context: [data.context, opts.context ?? ""].filter((s) => s.trim()).join("\n\n") || undefined,
      });
    } catch (err) {
      // Fail closed: if the check itself crashed, hold the post.
      const message = err instanceof Error ? err.message : String(err);
      checked = { pass: false, issues: [`Fact-check crashed: ${message}`], summary: "Fact-check error.", mode: "enforce" };
    }
    guard = checked;
    if (guardDecision(checked) === "hold") {
      await ctx.runMutation(internal.linkedapi.updatePost, {
        postId,
        status: "needs_review",
        heldFor: "guard", // a second approvePost now skips the fact-check, as for any guard hold
        text: prepared.text,
        guardIssues: checked.issues,
        guardSummary: checked.summary,
      });
      return { status: "needs_review", issues: checked.issues };
    }
  }
  const guardFields = guard ? { guardIssues: guard.issues, guardSummary: guard.summary } : {};

  const headers = linkedApiHeaders();
  if (!headers) {
    await ctx.runMutation(internal.linkedapi.updatePost, {
      postId,
      status: "failed",
      text: prepared.text,
      error: MISSING_TOKENS,
      ...guardFields,
    });
    return { status: "failed", error: MISSING_TOKENS, issues: guard?.issues };
  }

  const res = await fetchJson(`${LINKEDAPI}/workflows`, {
    method: "POST",
    headers,
    body: JSON.stringify({ actionType: "st.createPost", label: "frontporch-post", text: prepared.text }),
  });
  const start = classifyStart(res.status, res.json, res.error);

  if (start.kind === "rejected") {
    await ctx.runMutation(internal.linkedapi.updatePost, {
      postId,
      status: "failed",
      text: prepared.text,
      error: start.error,
      ...guardFields,
    });
    return { status: "failed", error: start.error, issues: guard?.issues };
  }
  if (start.kind === "uncertain") {
    const error = `${MAYBE_POSTED_MESSAGE} (${start.error})`;
    await ctx.runMutation(internal.linkedapi.updatePost, {
      postId,
      status: "failed",
      text: prepared.text,
      error,
      maybePosted: true,
      ...guardFields,
    });
    return { status: "failed", error, issues: guard?.issues };
  }

  await ctx.runMutation(internal.linkedapi.updatePost, {
    postId,
    status: "pending",
    text: prepared.text,
    workflowId: start.workflowId,
    pollAttempts: 0,
    lastPolledAt: Date.now(),
    clearError: true,
    ...guardFields,
  });
  await ctx.scheduler.runAfter(pollDelayMs(0, start.pendingReason), internal.linkedapi.checkPostStatus, {
    postId,
  });
  return { status: "pending", issues: guard?.issues };
}

// ---------- actions ----------

/** Format + fact-check + post. Never posts the same row twice. */
export const createPost = internalAction({
  args: { postId: v.id("posts"), context: v.optional(v.string()) },
  handler: async (ctx, { postId, context }): Promise<CreatePostResult> =>
    linkedinOn() ? runPosting(ctx, postId, { approve: false, context }) : { status: "off", note: LINKEDIN_OFF },
});

/**
 * A human reviewed a needs_review post (or checked his LinkedIn after an
 * unconfirmed send) and wants it posted as it is. Skips the guard, still
 * formats it and still goes through the claim, so it can't double post.
 */
export const approvePost = internalAction({
  args: { postId: v.id("posts") },
  handler: async (ctx, { postId }): Promise<CreatePostResult> =>
    linkedinOn() ? runPosting(ctx, postId, { approve: true }) : { status: "off", note: LINKEDIN_OFF },
});

/** Poll the LinkedAPI workflow until the post is live (or failed). Safe to run by hand. */
export const checkPostStatus = internalAction({
  args: { postId: v.id("posts") },
  handler: async (ctx, { postId }): Promise<void> => {
    if (!linkedinOn()) return;
    const data = await ctx.runQuery(internal.linkedapi.getPostForPosting, { postId });
    const post = data?.post;
    if (!post || !post.workflowId || !["pending", "needs_attention"].includes(post.status)) return;
    if (data.usesPublish) {
      console.warn(`linkedapi.checkPostStatus: post ${postId} goes out through publish.ts; use checkPublicationStatus`);
      return;
    }

    const headers = linkedApiHeaders();
    if (!headers) {
      await ctx.runMutation(internal.linkedapi.updatePost, {
        postId,
        status: "needs_attention",
        error: `${MISSING_TOKENS}. Status checks stopped; set them, then run linkedapi:checkPostStatus.`,
      });
      return;
    }

    const attempts = (post.pollAttempts ?? 0) + 1;
    const retryLater = async (pendingReason: string | null, note?: string) => {
      if (attempts >= MAX_POLL_ATTEMPTS) {
        await ctx.runMutation(internal.linkedapi.updatePost, {
          postId,
          status: "needs_attention",
          pollAttempts: attempts,
          lastPolledAt: Date.now(),
          error:
            note ??
            `Still waiting on LinkedAPI after ${attempts} checks. Check his LinkedIn, or run linkedapi:checkPostStatus to check again.`,
        });
        return;
      }
      await ctx.runMutation(internal.linkedapi.updatePost, {
        postId,
        status: "pending",
        pollAttempts: attempts,
        lastPolledAt: Date.now(),
        ...(note ? { error: note } : {}),
      });
      await ctx.scheduler.runAfter(pollDelayMs(attempts, pendingReason), internal.linkedapi.checkPostStatus, {
        postId,
      });
    };

    const res = await fetchJson(`${LINKEDAPI}/workflows/${encodeURIComponent(post.workflowId)}`, { headers });
    if (res.status < 200 || res.status >= 300 || !res.json?.result) {
      const why = res.error ?? res.json?.error?.message ?? `HTTP ${res.status}`;
      await retryLater(null, `Could not read the LinkedAPI result: ${why}`);
      return;
    }

    const outcome = parseWorkflowResult(res.json.result);
    if (outcome.kind === "published") {
      const url = outcome.url ? canonicalLinkedInPostUrl(outcome.url) : undefined;
      await ctx.runMutation(internal.linkedapi.updatePost, {
        postId,
        status: "published",
        pollAttempts: attempts,
        lastPolledAt: Date.now(),
        ...(url
          ? { linkedinUrl: url, clearError: true }
          : {
              // Published, but LinkedIn didn't return the address. Do NOT retry.
              error: "Posted, but LinkedIn didn't return the post URL. Copy it from his profile into linkedinUrl.",
            }),
      });
    } else if (outcome.kind === "failed") {
      await ctx.runMutation(internal.linkedapi.updatePost, {
        postId,
        status: "failed",
        pollAttempts: attempts,
        lastPolledAt: Date.now(),
        error: outcome.error,
      });
    } else {
      await retryLater(outcome.pendingReason);
    }
  },
});

// ---------- publish.ts path (one postPublications row) ----------

/**
 * Send the post to LinkedAPI for publish.ts (which claimed the row and ran the fact-check).
 * started -> "pending" + the workflow id (polled by checkPublicationStatus); refused -> failed;
 * no clear answer -> maybe_posted (a person checks his LinkedIn first).
 */
export const startPublication = internalAction({
  args: { postId: v.id("posts"), publicationId: v.id("postPublications") },
  handler: async (ctx, { postId, publicationId }): Promise<PlatformOutcome> => {
    if (!linkedinOn()) return { status: "failed", error: LINKEDIN_OFF };
    const data = await ctx.runQuery(internal.linkedapi.getPostForPosting, { postId });
    if (!data) return { status: "failed", error: "Post not found" };
    let text: string;
    try {
      text = prepareLinkedInText(data.post.text, { disclosure: data.disclosure }).text;
    } catch (err) {
      return { status: "failed", error: err instanceof Error ? err.message : "Couldn't format the post" };
    }
    const headers = linkedApiHeaders();
    if (!headers) return { status: "failed", error: MISSING_TOKENS };
    const res = await fetchJson(`${LINKEDAPI}/workflows`, {
      method: "POST",
      headers,
      body: JSON.stringify({ actionType: "st.createPost", label: "frontporch-post", text }),
    });
    const start = classifyStart(res.status, res.json, res.error);
    if (start.kind === "rejected") return { status: "failed", error: start.error };
    if (start.kind === "uncertain") return { status: "maybe_posted", error: `${MAYBE_POSTED_MESSAGE} (${start.error})` };
    await ctx.runMutation(internal.linkedapi.updatePost, { postId, workflowId: start.workflowId, pollAttempts: 0, lastPolledAt: Date.now() });
    await ctx.scheduler.runAfter(pollDelayMs(0, start.pendingReason), internal.linkedapi.checkPublicationStatus, { postId, publicationId });
    return { status: "pending", externalId: start.workflowId };
  },
});

/** Poll the LinkedAPI workflow for a publish.ts row until it's posted (or failed). Safe to run by hand. */
export const checkPublicationStatus = internalAction({
  args: { postId: v.id("posts"), publicationId: v.id("postPublications") },
  handler: async (ctx, { postId, publicationId }): Promise<void> => {
    if (!linkedinOn()) return;
    const row = await ctx.runQuery(internal.publish.getPublication, { publicationId });
    if (!row || row.platform !== "linkedin" || row.status !== "pending" || !row.externalId) return;
    const workflowId = row.externalId;
    const data = await ctx.runQuery(internal.linkedapi.getPostForPosting, { postId });
    if (!data) return;
    const finish = async (outcome: PlatformOutcome) => {
      await ctx.runMutation(internal.publish.finishPublication, { publicationId, outcome });
      await ctx.runMutation(internal.publish.settlePost, { postId });
      if (outcome.status !== "failed" && (await ctx.runQuery(internal.publish.isRemoved, { postId }))) {
        try {
          await ctx.scheduler.runAfter(0, removePost, { postId });
        } catch {
          console.error(`linkedapi: post ${postId} was taken down while posting; run undo:removePost by hand`);
        }
      }
    };
    const headers = linkedApiHeaders();
    if (!headers) {
      await finish({ status: "maybe_posted", error: `${MISSING_TOKENS}. Status checks stopped: check his LinkedIn.` });
      return;
    }
    const attempts = (data.post.pollAttempts ?? 0) + 1;
    const again = async (pendingReason: string | null) => {
      if (attempts >= MAX_POLL_ATTEMPTS) {
        await finish({ status: "maybe_posted", error: `Still waiting on LinkedAPI after ${attempts} checks. Check his LinkedIn.` });
        return;
      }
      await ctx.runMutation(internal.linkedapi.updatePost, { postId, pollAttempts: attempts, lastPolledAt: Date.now() });
      await ctx.scheduler.runAfter(pollDelayMs(attempts, pendingReason), internal.linkedapi.checkPublicationStatus, { postId, publicationId });
    };
    const res = await fetchJson(`${LINKEDAPI}/workflows/${encodeURIComponent(workflowId)}`, { headers });
    if (res.status < 200 || res.status >= 300 || !res.json?.result) {
      await again(null);
      return;
    }
    const outcome = parseWorkflowResult(res.json.result);
    if (outcome.kind === "published") {
      const url = outcome.url ? canonicalLinkedInPostUrl(outcome.url) : undefined;
      await finish({ status: "posted", ...(url ? { url } : {}) });
    } else if (outcome.kind === "failed") {
      await finish({ status: "failed", error: outcome.error });
    } else {
      await again(outcome.pendingReason);
    }
  },
});

/** Format + fact-check an existing posts row WITHOUT posting or saving anything. */
export const previewPost = internalAction({
  args: { postId: v.id("posts"), context: v.optional(v.string()) },
  handler: async (ctx, { postId, context }): Promise<PreviewResult> => {
    const data = await ctx.runQuery(internal.linkedapi.getPostForPosting, { postId });
    if (!data) throw new Error("Post not found");
    const prepared = prepareLinkedInText(data.post.text, { disclosure: data.disclosure });
    const fullContext = [data.context, context ?? ""].filter((s) => s.trim()).join("\n\n");
    const guard: GuardResult = await ctx.runAction(internal.postGuard.checkPost, {
      postText: prepared.body, // our own disclosure line isn't a claim from the call
      turns: data.turns,
      context: fullContext || undefined,
    });
    return {
      text: prepared.text,
      warnings: prepared.warnings,
      chars: prepared.text.length,
      guard,
      wouldPost: guardDecision(guard) === "post",
    };
  },
});

/** Same as previewPost, but for raw text + turns (no posts row needed). */
export const previewText = internalAction({
  args: {
    text: v.string(),
    turns: v.array(turnValidator),
    context: v.optional(v.string()),
    language: v.optional(v.string()), // BCP-47, e.g. "es-MX" -> Spanish disclosure
  },
  handler: async (ctx, { text, turns, context, language }): Promise<PreviewResult> => {
    const prepared = prepareLinkedInText(text, { disclosure: disclosureFor(callLanguage(language)) });
    const guard: GuardResult = await ctx.runAction(internal.postGuard.checkPost, {
      postText: prepared.body, // our own disclosure line isn't a claim from the call
      turns,
      context,
    });
    return {
      text: prepared.text,
      warnings: prepared.warnings,
      chars: prepared.text.length,
      guard,
      wouldPost: guardDecision(guard) === "post",
    };
  },
});
