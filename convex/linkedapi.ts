// LinkedIn posting via LinkedAPI, on grandpa's own account.
//
// Flow (called by pipeline.processCall after it inserts a `posts` row):
//   await ctx.runAction(internal.linkedapi.createPost, { postId })
//
//   1. load the post + the call transcript
//   2. lib/linkedinPost.prepareLinkedInText: plain text, <= 3 hashtags,
//      disclosure line once at the end, <= 3,000 characters
//   3. postGuard.checkPost: fact-check against what he said
//        fail + POST_GUARD_MODE=enforce -> status "needs_review", NOT posted
//   4. POST https://api.linkedapi.io/workflows  { actionType: "st.createPost", text }
//      -> status "pending" + workflowId
//   5. checkPostStatus polls GET /workflows/{workflowId} with backoff and saves
//      linkedinUrl + "published" (apify.scrapeEngagement matches on that URL),
//      or "failed" + error.
//
// Live test without posting:
//   npx convex run linkedapi:previewText '{"text": "...", "turns": [{"role":"elder","text":"..."}]}'
//   npx convex run linkedapi:previewPost '{"postId": "<posts id>"}'
//
// Env: LINKEDAPI_TOKEN, LINKEDAPI_ID_TOKEN (+ ANTHROPIC_API_KEY, POST_GUARD_MODE for the guard)
// Owner: Integrations.

import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import {
  MAX_POLL_ATTEMPTS,
  pollDelayMs,
  prepareLinkedInText,
  type Turn,
} from "./lib/linkedinPost";

// Convex exposes env vars on process.env (declared so we don't need @types/node).
declare const process: { env: Record<string, string | undefined> };

const LINKEDAPI = "https://api.linkedapi.io";

type GuardResult = {
  pass: boolean;
  issues: string[];
  summary: string;
  mode: "enforce" | "warn" | "off";
};

type CreatePostResult = {
  status: "pending" | "needs_review" | "published" | "failed";
  url?: string;
  error?: string;
  issues?: string[];
};

const turnValidator = v.object({ role: v.string(), text: v.string() });

// ---------- database helpers ----------

export const getPostForPosting = internalQuery({
  args: { postId: v.id("posts") },
  handler: async (ctx, { postId }) => {
    const post = await ctx.db.get(postId);
    if (!post) return null;
    const call = await ctx.db.get(post.callId);
    const turns: Turn[] = call?.transcript ?? [];
    return { post, turns };
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

function errorText(json: any, status: number): string {
  return (
    json?.error?.message ??
    json?.result?.failure?.message ??
    json?.message ??
    `LinkedAPI returned HTTP ${status}`
  );
}

// ---------- actions ----------

/** Format + fact-check + post. Never posts the same row twice. */
export const createPost = internalAction({
  args: { postId: v.id("posts") },
  handler: async (ctx, { postId }): Promise<CreatePostResult> => {
    const data = await ctx.runQuery(internal.linkedapi.getPostForPosting, { postId });
    if (!data) return { status: "failed", error: "Post not found" };
    const { post, turns } = data;

    if (post.status === "published") {
      return { status: "published", url: post.linkedinUrl };
    }
    if (post.status === "pending" && post.workflowId) {
      return { status: "pending" }; // already sent to LinkedAPI
    }

    let prepared;
    try {
      prepared = prepareLinkedInText(post.text);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      await ctx.runMutation(internal.linkedapi.updatePost, { postId, status: "failed", error });
      return { status: "failed", error };
    }

    const guard: GuardResult = await ctx.runAction(internal.postGuard.checkPost, {
      postText: prepared.text,
      turns,
    });
    if (!guard.pass && guard.mode === "enforce") {
      await ctx.runMutation(internal.linkedapi.updatePost, {
        postId,
        status: "needs_review",
        text: prepared.text,
        guardIssues: guard.issues,
        guardSummary: guard.summary,
      });
      return { status: "needs_review", issues: guard.issues };
    }

    const headers = linkedApiHeaders();
    if (!headers) {
      const error = "LINKEDAPI_TOKEN / LINKEDAPI_ID_TOKEN are not set in Convex";
      await ctx.runMutation(internal.linkedapi.updatePost, {
        postId,
        status: "failed",
        text: prepared.text,
        error,
        guardIssues: guard.issues,
        guardSummary: guard.summary,
      });
      return { status: "failed", error, issues: guard.issues };
    }

    let json: any = null;
    let httpStatus = 0;
    try {
      const res = await fetch(`${LINKEDAPI}/workflows`, {
        method: "POST",
        headers,
        body: JSON.stringify({ actionType: "st.createPost", label: "frontporch-post", text: prepared.text }),
      });
      httpStatus = res.status;
      json = await res.json().catch(() => null);
      if (!res.ok || !json?.success || !json?.result?.workflowId) {
        throw new Error(errorText(json, httpStatus));
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      await ctx.runMutation(internal.linkedapi.updatePost, {
        postId,
        status: "failed",
        text: prepared.text,
        error,
        guardIssues: guard.issues,
        guardSummary: guard.summary,
      });
      return { status: "failed", error, issues: guard.issues };
    }

    const workflowId: string = json.result.workflowId;
    await ctx.runMutation(internal.linkedapi.updatePost, {
      postId,
      status: "pending",
      text: prepared.text,
      workflowId,
      pollAttempts: 0,
      guardIssues: guard.issues,
      guardSummary: guard.summary,
      clearError: true,
    });
    await ctx.scheduler.runAfter(
      pollDelayMs(0, json.result.pendingReason),
      internal.linkedapi.checkPostStatus,
      { postId },
    );
    return { status: "pending", issues: guard.issues };
  },
});

/** Poll the LinkedAPI workflow until the post is live (or failed). Safe to run by hand. */
export const checkPostStatus = internalAction({
  args: { postId: v.id("posts") },
  handler: async (ctx, { postId }) => {
    const data = await ctx.runQuery(internal.linkedapi.getPostForPosting, { postId });
    const post = data?.post;
    if (!post || post.status !== "pending" || !post.workflowId) return;

    const headers = linkedApiHeaders();
    if (!headers) {
      await ctx.runMutation(internal.linkedapi.updatePost, {
        postId,
        error: "LINKEDAPI_TOKEN / LINKEDAPI_ID_TOKEN are not set in Convex",
      });
      return;
    }

    const attempts = (post.pollAttempts ?? 0) + 1;
    const retryLater = async (pendingReason: string | null, note?: string) => {
      if (attempts >= MAX_POLL_ATTEMPTS) {
        await ctx.runMutation(internal.linkedapi.updatePost, {
          postId,
          pollAttempts: attempts,
          error:
            note ??
            `Still waiting on LinkedAPI after ${attempts} checks. Run linkedapi:checkPostStatus to check again.`,
        });
        return;
      }
      await ctx.runMutation(internal.linkedapi.updatePost, { postId, pollAttempts: attempts });
      await ctx.scheduler.runAfter(pollDelayMs(attempts, pendingReason), internal.linkedapi.checkPostStatus, {
        postId,
      });
    };

    let json: any;
    try {
      const res = await fetch(`${LINKEDAPI}/workflows/${encodeURIComponent(post.workflowId)}`, { headers });
      json = await res.json().catch(() => null);
      if (!res.ok || !json?.result) throw new Error(errorText(json, res.status));
    } catch (err) {
      await retryLater(null, `Could not reach LinkedAPI: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    const result = json.result;
    switch (result.workflowStatus) {
      case "completed": {
        const raw = result.completion;
        const completion = Array.isArray(raw)
          ? raw.find((c: any) => c?.actionType === "st.createPost") ?? raw[0]
          : raw;
        if (completion?.success) {
          const url: string | undefined = completion.data?.postUrl ?? undefined;
          await ctx.runMutation(internal.linkedapi.updatePost, {
            postId,
            status: "published",
            pollAttempts: attempts,
            ...(url
              ? { linkedinUrl: url, clearError: true }
              : {
                  // Published, but LinkedIn didn't return the address. Do NOT retry.
                  error: "Posted, but LinkedIn didn't return the post URL. Copy it from his profile into linkedinUrl.",
                }),
          });
        } else {
          const e = completion?.error;
          await ctx.runMutation(internal.linkedapi.updatePost, {
            postId,
            status: "failed",
            pollAttempts: attempts,
            error: e ? `${e.type ?? "error"}: ${e.message ?? ""}`.trim() : "LinkedAPI completed without success",
          });
        }
        return;
      }
      case "failed": {
        const f = result.failure;
        await ctx.runMutation(internal.linkedapi.updatePost, {
          postId,
          status: "failed",
          pollAttempts: attempts,
          error: f ? `${f.reason ?? "failed"}: ${f.message ?? ""}`.trim() : "LinkedAPI workflow failed",
        });
        return;
      }
      default:
        // "pending" (queued / outsideWorkingHours) or "running"
        await retryLater(result.pendingReason ?? null);
    }
  },
});

/** Format + fact-check an existing posts row WITHOUT posting or saving anything. */
export const previewPost = internalAction({
  args: { postId: v.id("posts") },
  handler: async (ctx, { postId }) => {
    const data = await ctx.runQuery(internal.linkedapi.getPostForPosting, { postId });
    if (!data) throw new Error("Post not found");
    const prepared = prepareLinkedInText(data.post.text);
    const guard: GuardResult = await ctx.runAction(internal.postGuard.checkPost, {
      postText: prepared.text,
      turns: data.turns,
    });
    return { text: prepared.text, warnings: prepared.warnings, chars: prepared.text.length, guard };
  },
});

/** Same as previewPost, but for raw text + turns (no posts row needed). */
export const previewText = internalAction({
  args: { text: v.string(), turns: v.array(turnValidator) },
  handler: async (ctx, { text, turns }) => {
    const prepared = prepareLinkedInText(text);
    const guard: GuardResult = await ctx.runAction(internal.postGuard.checkPost, {
      postText: prepared.text,
      turns,
    });
    return { text: prepared.text, warnings: prepared.warnings, chars: prepared.text.length, guard };
  },
});
