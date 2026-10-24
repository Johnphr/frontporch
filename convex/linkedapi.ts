// LinkedIn posting via LinkedAPI, on grandpa's own account.
//
// Flow (called by pipeline.processCall after it inserts a `posts` row):
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
// Env: LINKEDAPI_TOKEN, LINKEDAPI_ID_TOKEN (+ OPENAI_API_KEY, POST_GUARD_MODE for the guard)
// Owner: Integrations.

import { v } from "convex/values";
import { internal } from "./_generated/api";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type ActionCtx,
} from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import {
  MAX_POLL_ATTEMPTS,
  pollDelayMs,
  prepareLinkedInText,
  type Turn,
} from "./lib/linkedinPost";
import {
  MAYBE_POSTED_MESSAGE,
  buildGuardContext,
  canClaim,
  classifyStart,
  guardDecision,
  parseWorkflowResult,
  shouldRestartPolling,
  type GuardResult,
} from "./lib/postFlow";
import { canonicalLinkedInPostUrl } from "./lib/linkedinUrl";

// Convex exposes env vars on process.env (declared so we don't need @types/node).
declare const process: { env: Record<string, string | undefined> };

const LINKEDAPI = "https://api.linkedapi.io";
const REQUEST_TIMEOUT_MS = 30_000;

type PostStatus = "pending" | "posting" | "needs_review" | "published" | "failed" | "needs_attention";

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
  | { ok: true }
  | { ok: false; reason: string; status: PostStatus; url?: string; restartPolling: boolean };

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
    return { post, turns, context };
  },
});

/** Atomically take the row for this run. Mutations are serializable, so only one caller wins. */
export const claimPost = internalMutation({
  args: { postId: v.id("posts"), approve: v.boolean() },
  handler: async (ctx, { postId, approve }): Promise<ClaimResult> => {
    const post = await ctx.db.get(postId);
    if (!post) return { ok: false, reason: "Post not found", status: "failed", restartPolling: false };
    const now = Date.now();

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
    await ctx.db.patch(postId, {
      status: "posting",
      claimedAt: now,
      error: undefined,
      maybePosted: undefined,
      ...(approve ? { approvedAt: now } : {}),
    });
    return { ok: true };
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
    prepared = prepareLinkedInText(data.post.text);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await ctx.runMutation(internal.linkedapi.updatePost, { postId, status: "failed", error });
    return { status: "failed", error };
  }

  let guard: GuardResult | null = null;
  if (!opts.approve) {
    let checked: GuardResult;
    try {
      checked = await ctx.runAction(internal.postGuard.checkPost, {
        postText: prepared.text,
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
    runPosting(ctx, postId, { approve: false, context }),
});

/**
 * A human reviewed a needs_review post (or checked his LinkedIn after an
 * unconfirmed send) and wants it posted as it is. Skips the guard, still
 * formats it and still goes through the claim, so it can't double post.
 */
export const approvePost = internalAction({
  args: { postId: v.id("posts") },
  handler: async (ctx, { postId }): Promise<CreatePostResult> => runPosting(ctx, postId, { approve: true }),
});

/** Poll the LinkedAPI workflow until the post is live (or failed). Safe to run by hand. */
export const checkPostStatus = internalAction({
  args: { postId: v.id("posts") },
  handler: async (ctx, { postId }): Promise<void> => {
    const data = await ctx.runQuery(internal.linkedapi.getPostForPosting, { postId });
    const post = data?.post;
    if (!post || !post.workflowId || !["pending", "needs_attention"].includes(post.status)) return;

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

/** Format + fact-check an existing posts row WITHOUT posting or saving anything. */
export const previewPost = internalAction({
  args: { postId: v.id("posts"), context: v.optional(v.string()) },
  handler: async (ctx, { postId, context }): Promise<PreviewResult> => {
    const data = await ctx.runQuery(internal.linkedapi.getPostForPosting, { postId });
    if (!data) throw new Error("Post not found");
    const prepared = prepareLinkedInText(data.post.text);
    const fullContext = [data.context, context ?? ""].filter((s) => s.trim()).join("\n\n");
    const guard: GuardResult = await ctx.runAction(internal.postGuard.checkPost, {
      postText: prepared.text,
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
  args: { text: v.string(), turns: v.array(turnValidator), context: v.optional(v.string()) },
  handler: async (ctx, { text, turns, context }): Promise<PreviewResult> => {
    const prepared = prepareLinkedInText(text);
    const guard: GuardResult = await ctx.runAction(internal.postGuard.checkPost, {
      postText: prepared.text,
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
