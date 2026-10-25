// Decisions for the LinkedIn posting flow: pure functions, no runtime imports,
// so Node can unit-test them directly (`node --test "tests/**/*.test.ts"`).
// linkedapi.ts and postGuard.ts do the I/O and call these.

// ---------- post guard ----------

// Same as linkedinPost.GuardMode (kept import-free so Node and Convex both load it).
export type GuardMode = "enforce" | "warn" | "off";

export type GuardResult = {
  pass: boolean;
  issues: string[];
  summary: string;
  mode: GuardMode;
};

/** Hold the post only when the check failed AND the guard is enforcing. */
export function guardDecision(guard: Pick<GuardResult, "pass" | "mode">): "post" | "hold" {
  return !guard.pass && guard.mode === "enforce" ? "hold" : "post";
}

export const GENERIC_GUARD_ISSUE =
  "The fact-checker flagged this post but didn't say why. Compare the post with the call transcript before approving it.";

/** Clean up the judge's JSON: pass only with zero issues, never fail without a reason. */
export function normalizeJudgeResult(parsed: unknown): { pass: boolean; issues: string[]; summary: string } {
  const obj = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
  const issues = Array.isArray(obj.issues)
    ? obj.issues.filter((i): i is string => typeof i === "string" && i.trim() !== "").map((i) => i.trim())
    : [];
  const pass = obj.pass === true && issues.length === 0;
  if (!pass && issues.length === 0) issues.push(GENERIC_GUARD_ISSUE);
  return { pass, issues, summary: typeof obj.summary === "string" ? obj.summary : "" };
}

/**
 * Background facts the judge may treat as his own words: his profile, earlier
 * memories, the call summary, plus anything the caller passes.
 */
export function buildGuardContext(parts: { profile?: unknown; summary?: unknown; extra?: unknown }): string {
  const sections: string[] = [];
  const profile = describe(parts.profile);
  if (profile) sections.push(`His profile:\n${profile}`);
  if (typeof parts.summary === "string" && parts.summary.trim()) {
    sections.push(`Summary of this call:\n${parts.summary.trim()}`);
  }
  const extra = describe(parts.extra);
  if (extra) sections.push(extra);
  return sections.join("\n\n");
}

function describe(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map(describe).filter(Boolean).map((s) => `- ${s}`).join("\n");
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, v]) => {
        const text = Array.isArray(v) ? v.map(describe).filter(Boolean).join("; ") : describe(v);
        return text ? `${key}: ${text}` : "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return String(value);
}

// ---------- claiming a post (no double posting) ----------

export const STALE_CLAIM_MS = 15 * 60 * 1000; // a crashed run frees the row after this
export const STALE_POLL_MS = 45 * 60 * 1000; // longer than the longest poll delay (30 min)

export type PostState = {
  status: string;
  workflowId?: string;
  claimedAt?: number;
  lastPolledAt?: number;
  maybePosted?: boolean;
  linkedinUrl?: string;
};

export type ClaimCheck = { ok: true } | { ok: false; reason: string };

/** Why a `needs_review` post is held: the quality check (llm.writePost) or the fact-check (postGuard). */
export type HeldFor = "quality" | "guard";

/**
 * Does this posting run fact-check the post? createPost: always. approvePost: only a post held
 * for quality, because the fact-check never ran on it; a guard hold was already checked and a
 * person approved it (so a second approvePost after a guard hold skips it, as before). Rows
 * held before heldFor existed count as guard holds.
 */
export function shouldRunGuard(approve: boolean, heldFor: HeldFor | undefined): boolean {
  return !approve || heldFor === "quality";
}

/**
 * May this run take the row and send it to LinkedAPI?
 * `approve` is a human approving it (linkedapi.approvePost).
 */
export function canClaim(post: PostState, now: number, approve: boolean): ClaimCheck {
  switch (post.status) {
    case "published":
      return { ok: false, reason: "Already published." };
    case "pending":
    case "needs_attention":
      return post.workflowId
        ? { ok: false, reason: "Already sent to LinkedAPI; waiting for the result." }
        : { ok: true };
    case "posting":
      if (post.workflowId) return { ok: false, reason: "Already sent to LinkedAPI; waiting for the result." };
      if (post.claimedAt !== undefined && now - post.claimedAt > STALE_CLAIM_MS) return { ok: true };
      return { ok: false, reason: "Another run is posting this right now." };
    case "needs_review":
      return approve
        ? { ok: true }
        : { ok: false, reason: "Held by the post guard. Review it, then run linkedapi:approvePost." };
    case "failed":
      if (post.maybePosted && !approve) {
        return {
          ok: false,
          reason:
            "LinkedAPI may already have posted this. Check his LinkedIn first; if it isn't there, run linkedapi:approvePost.",
        };
      }
      return { ok: true };
    default:
      return { ok: false, reason: `Unknown post status "${post.status}".` };
  }
}

/** A row that was sent to LinkedAPI but nobody is polling any more. */
export function shouldRestartPolling(post: PostState, now: number): boolean {
  if (!post.workflowId) return false;
  if (post.status === "needs_attention") return true;
  if (post.status !== "pending") return false;
  const last = post.lastPolledAt ?? post.claimedAt;
  return last === undefined || now - last > STALE_POLL_MS;
}

// ---------- LinkedAPI responses ----------

export type StartOutcome =
  | { kind: "started"; workflowId: string; pendingReason: string | null }
  | { kind: "rejected"; error: string } // LinkedAPI said no: safe to retry
  | { kind: "uncertain"; error: string }; // it may have accepted: don't auto-retry

export function lookupErrorText(json: any, status: number): string {
  return (
    json?.error?.message ??
    json?.result?.failure?.message ??
    json?.message ??
    `LinkedAPI returned HTTP ${status}`
  );
}

/**
 * Classify the answer to POST /workflows. `status` is the HTTP status, or 0
 * when the request never got a response (timeout, network error).
 */
export function classifyStart(status: number, json: any, networkError?: string): StartOutcome {
  if (status === 0) return { kind: "uncertain", error: networkError ?? "No response from LinkedAPI" };
  if (status >= 500) return { kind: "uncertain", error: lookupErrorText(json, status) };
  if (status >= 400) return { kind: "rejected", error: lookupErrorText(json, status) };
  if (json?.success === false) return { kind: "rejected", error: lookupErrorText(json, status) };
  const workflowId = json?.result?.workflowId;
  if (typeof workflowId === "string" && workflowId) {
    return { kind: "started", workflowId, pendingReason: json?.result?.pendingReason ?? null };
  }
  return { kind: "uncertain", error: "LinkedAPI answered without a workflow id" };
}

export const MAYBE_POSTED_MESSAGE =
  "LinkedAPI didn't confirm whether it accepted this post. Check his LinkedIn before doing anything: if the post is there, paste its URL into linkedinUrl and set status to published; if not, run linkedapi:approvePost.";

export type WorkflowOutcome =
  | { kind: "published"; url?: string }
  | { kind: "failed"; error: string }
  | { kind: "waiting"; pendingReason: string | null };

/** Read the `result` of GET /workflows/{id}. */
export function parseWorkflowResult(result: any): WorkflowOutcome {
  switch (result?.workflowStatus) {
    case "completed": {
      const raw = result.completion;
      const completion = Array.isArray(raw)
        ? raw.find((c: any) => c?.actionType === "st.createPost") ?? raw[0]
        : raw;
      if (completion?.success) {
        const url = completion.data?.postUrl;
        return { kind: "published", url: typeof url === "string" && url ? url : undefined };
      }
      const e = completion?.error;
      return {
        kind: "failed",
        error: e ? `${e.type ?? "error"}: ${e.message ?? ""}`.trim() : "LinkedAPI completed without success",
      };
    }
    case "failed": {
      const f = result.failure;
      return {
        kind: "failed",
        error: f ? `${f.reason ?? "failed"}: ${f.message ?? ""}`.trim() : "LinkedAPI workflow failed",
      };
    }
    default:
      // "pending" (queued / outsideWorkingHours) or "running"
      return { kind: "waiting", pendingReason: result?.pendingReason ?? null };
  }
}

// ---------- auto-post switch ----------

/**
 * AUTO_POST env -> post right after the call or not. Default on (the locked auto-post
 * decision); "off" / "false" / "0" / "no" keeps the post as a `pending` row for preview
 * (linkedapi:previewPost) until someone posts it on purpose (linkedapi:createPost).
 */
export function parseAutoPost(value: string | undefined): boolean {
  const v = (value ?? "").trim().toLowerCase();
  return !["off", "false", "0", "no"].includes(v);
}
