// Decisions for posting (publish.ts: every platform; linkedapi.ts: LinkedIn): pure functions, no runtime imports,
// so Node can unit-test them directly (`node --test "tests/**/*.test.ts"`).
// publish.ts, linkedapi.ts and postGuard.ts do the I/O and call these.

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

/**
 * Why a `needs_review` post is held: the quality check (llm.writePost), too long for a Bluesky
 * thread (pipeline.insertPost), or the fact-check (postGuard).
 */
export type HeldFor = "quality" | "thread_fit" | "guard";

/**
 * Does this posting run fact-check the post? It skips it only when a person approves a post
 * the fact-check itself held (needs_review + heldFor "guard", or no heldFor on rows from before
 * heldFor existed). Everything else is checked: a new post, a quality or thread-fit hold, a
 * pending post approved by hand (AUTO_POST=off), a failed post.
 */
export function shouldRunGuard(post: { status: string; heldFor?: HeldFor }, approve: boolean): boolean {
  const guardHold = post.status === "needs_review" && (post.heldFor === "guard" || post.heldFor === undefined);
  return !(approve && guardHold);
}

/**
 * Did the fact-check clear this post? guardPassedAt (it passed, warn/off mode let it through, or
 * a person approved its hold). Rows from before guardPassedAt: a saved fact-check with no issues.
 */
export function guardCleared(post: { guardPassedAt?: number; guardIssues?: string[] }): boolean {
  return post.guardPassedAt !== undefined || (Array.isArray(post.guardIssues) && post.guardIssues.length === 0);
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

let warnedAutoPost = false; // the unknown-value warning, once per process

/**
 * AUTO_POST env -> post right after the call or not. On when unset or empty (the locked
 * auto-post decision), or "on" / "true" / "1" / "yes". Anything else is off (with one warning):
 * the post stays a `pending` row for preview until someone posts it on purpose
 * (publish:publishPost). A typo never turns posting on.
 */
export function parseAutoPost(value: string | undefined): boolean {
  const v = (value ?? "").trim().toLowerCase();
  if (v === "" || ["on", "true", "1", "yes"].includes(v)) return true;
  if (!["off", "false", "0", "no"].includes(v) && !warnedAutoPost) {
    warnedAutoPost = true;
    console.warn("AUTO_POST has an unknown value: treated as off (use on or off).");
  }
  return false;
}

// ---------- platform switches ----------

/** An on/off env switch: "on", "true", "1" or "yes" (any case, trimmed) is on; anything else is off. */
export function isSwitchOn(value: string | undefined): boolean {
  return ["on", "true", "1", "yes"].includes((value ?? "").trim().toLowerCase());
}

/** LINKEDIN_POSTING: LinkedIn is off unless this is on (LinkedAPI needs a connected account per person). */
export function linkedinPostingOn(value: string | undefined): boolean {
  return isSwitchOn(value);
}

// ---------- publishing a story post to several platforms (publish.ts) ----------
// One postPublications row per post per platform. posts.status stays the summary:
//   pending -> posting (publish.ts claimed it) -> published (any platform posted)
//   | partly_posted (only part of a thread went out, on any platform) | failed (nothing went out)
//   | needs_review (held by the fact-check, the quality check or the thread fit)

export const PLATFORMS = ["bluesky", "threads", "x", "reddit", "linkedin"] as const;
export type Platform = (typeof PLATFORMS)[number];

export type PublicationStatus = "pending" | "posting" | "posted" | "failed" | "maybe_posted" | "skipped" | "removing" | "removed";

export const PLATFORM_LABEL: Record<Platform, string> = {
  bluesky: "Bluesky",
  threads: "Threads",
  x: "X",
  reddit: "Reddit",
  linkedin: "LinkedIn",
};

/** Why a platform is skipped (its switch is off, or he has no usable login there). */
export function skipReason(platform: Platform): string {
  switch (platform) {
    case "bluesky":
      return "His Bluesky account isn't connected.";
    case "threads":
      return "His Threads account isn't connected.";
    case "x":
      return "X posting is off (X_POSTING) or his X account isn't connected.";
    case "reddit":
      return "Reddit posting is off (REDDIT_POSTING) or his Reddit login isn't set.";
    case "linkedin":
      return "LinkedIn posting is off (LINKEDIN_POSTING).";
  }
}

export type PlatformSwitches = {
  blueskyLogin: boolean;
  /** He has a usable Threads login (no env switch: connecting it is the opt-in). */
  threadsLogin: boolean;
  /** X_POSTING=on (X charges per post). */
  xOn: boolean;
  xLogin: boolean;
  redditLogin: boolean;
  linkedinOn: boolean;
};

/** Which platforms this run posts to. */
export function enabledPlatforms(a: PlatformSwitches): Record<Platform, boolean> {
  return {
    bluesky: a.blueskyLogin,
    threads: a.threadsLogin,
    x: a.xOn && a.xLogin,
    reddit: a.redditLogin,
    linkedin: a.linkedinOn,
  };
}

/** Retry with recovery: an earlier attempt may have posted more than the row knows. */
export function shouldRecover(previous: string | undefined, records: unknown[] | undefined): boolean {
  return previous === "maybe_posted" || previous === "posting" || Boolean(records?.length);
}

/**
 * May publishPost / approvePost start on this post? `approve` = a person approved a held post
 * (publish.approvePost). A post with removedAt is never posted.
 */
export function canStartPublish(
  post: { status: string; claimedAt?: number; removedAt?: number },
  now: number,
  approve: boolean,
): ClaimCheck {
  if (post.removedAt !== undefined) return { ok: false, reason: "Taken down (removedAt is set): not posting it." };
  switch (post.status) {
    case "pending":
    case "failed":
    case "partly_posted": // a run continues the half-posted thread
      return { ok: true };
    case "needs_review":
      return approve ? { ok: true } : { ok: false, reason: "Held for review. Read it, then run publish:approvePost." };
    case "posting":
      if (post.claimedAt !== undefined && now - post.claimedAt > STALE_CLAIM_MS) return { ok: true };
      return { ok: false, reason: "Another run is publishing this right now." };
    case "published":
      return { ok: false, reason: "Already published. Retry one platform with publish:retryPublication." };
    default:
      return { ok: false, reason: `Post is "${post.status}".` };
  }
}

export type PublicationState = { platform: string; status: string; claimedAt?: number; externalId?: string };

/** A claim refusal; `becomes`: the claim mutation sets the row to this status (a stale claim). */
export type PublicationClaim = ClaimCheck | { ok: false; reason: string; becomes: "maybe_posted" };

export const STALE_POSTING_MESSAGE =
  "A run stopped while posting (no answer for 15 minutes), so it may be out: check his profile, then run publish:retryPublication with approve: true.";

/**
 * May this run take the platform row and post? One run at a time; maybe_posted only with
 * approve (a person checked first); LinkedIn `pending` with a workflow id is waiting on LinkedAPI.
 * A claim older than STALE_CLAIM_MS: Bluesky retakes it (the retry looks in his repo first);
 * every other platform (Threads, X, Reddit, LinkedIn) becomes maybe_posted: a person checks.
 */
export function canClaimPublication(row: PublicationState, now: number, approve: boolean, postRemoved: boolean): PublicationClaim {
  if (postRemoved) return { ok: false, reason: "Taken down (removedAt is set): not posting it." };
  switch (row.status) {
    case "pending":
      return row.platform === "linkedin" && row.externalId
        ? { ok: false, reason: "Already sent to LinkedAPI; waiting for the result." }
        : { ok: true };
    case "failed":
    case "skipped":
      return { ok: true };
    case "maybe_posted":
      return approve
        ? { ok: true }
        : { ok: false, reason: "It may already be posted. Check his profile, then run publish:retryPublication with approve: true." };
    case "posting":
      if (row.claimedAt === undefined || now - row.claimedAt <= STALE_CLAIM_MS) {
        return { ok: false, reason: "Another run is posting this right now." };
      }
      return row.platform === "bluesky" ? { ok: true } : { ok: false, reason: STALE_POSTING_MESSAGE, becomes: "maybe_posted" };
    case "posted":
      return { ok: false, reason: "Already posted." };
    case "removing":
    case "removed":
      return { ok: false, reason: "Taken down (undo)." };
    default:
      return { ok: false, reason: `Unknown status "${row.status}".` };
  }
}

export type ThreadRecord = { uri: string; cid: string };

/** What one platform attempt ended with. `records`/`url` can be set on a failure too (a partial thread). */
export type PlatformOutcome =
  | { status: "posted"; url?: string; records?: ThreadRecord[]; externalId?: string }
  | { status: "pending"; externalId: string } // LinkedIn: LinkedAPI accepted it, polling for the result
  | { status: "failed" | "maybe_posted"; error: string; url?: string; records?: ThreadRecord[] };

/** Did anything (maybe) go out? Then a post removed meanwhile must be taken down again. */
export function mayBeOut(outcome: PlatformOutcome): boolean {
  return outcome.status !== "failed" || Boolean(outcome.records?.length);
}

/** A row that didn't finish but has posts out: a thread (any platform) that stopped partway. */
export function isPartlyPosted(row: { status: string; records?: unknown[] }): boolean {
  return (row.status === "failed" || row.status === "maybe_posted") && (row.records?.length ?? 0) > 0;
}

/**
 * posts.status from its platform rows (+ a short error naming the platforms that didn't post).
 * partly_posted: nothing finished, but part of a thread is live on some platform (a retry continues it).
 */
export function overallPostStatus(
  rows: { platform: string; status: string; error?: string; externalId?: string; records?: unknown[] }[],
): { status: "published" | "posting" | "partly_posted" | "failed"; error?: string } {
  const label = (p: string) => PLATFORM_LABEL[p as Platform] ?? p;
  const what = (r: (typeof rows)[number]) =>
    isPartlyPosted(r)
      ? r.status === "maybe_posted" ? "partly posted, maybe more: check first" : "partly posted"
      : r.status === "maybe_posted" ? "maybe posted, check first" : "failed";
  const problems = rows
    .filter((r) => r.status === "failed" || r.status === "maybe_posted")
    .map((r) => `${label(r.platform)}: ${what(r)}${r.error ? ` (${r.error})` : ""}`);
  const error = problems.length ? problems.join("; ").slice(0, 600) : undefined;
  if (rows.some((r) => r.status === "posted")) return { status: "published", ...(error ? { error } : {}) };
  if (rows.some((r) => r.status === "posting" || (r.status === "pending" && r.platform === "linkedin" && r.externalId))) {
    return { status: "posting", ...(error ? { error } : {}) };
  }
  if (rows.some(isPartlyPosted)) return { status: "partly_posted", error };
  if (problems.length) return { status: "failed", error };
  return { status: "failed", error: "Nowhere to post: no platform is set up (connect his Bluesky or Threads account), then run publish:publishPost." };
}

export const NOT_CHECKED_MESSAGE =
  "This post was never fact-checked (nothing was set up to post to when it ran): run publish:publishPost, which checks it first.";

/**
 * retryPublication: only rows that didn't post, on a post that went through publishing and was
 * cleared by the fact-check (guardCleared). repoll: a LinkedIn row LinkedAPI accepted whose
 * status checks stopped: check it again (nothing is sent).
 */
export function canRetry(
  post: { status: string; removedAt?: number; guardPassedAt?: number; guardIssues?: string[] },
  row: { platform?: string; status: string; externalId?: string },
): { ok: true; repoll?: true } | { ok: false; reason: string } {
  if (post.removedAt !== undefined) return { ok: false, reason: "Taken down (removedAt is set): not posting it." };
  if (post.status === "needs_review") return { ok: false, reason: "The post is held for review: run publish:approvePost." };
  if (post.status === "pending") return { ok: false, reason: "Not published yet: run publish:publishPost." };
  if (row.platform === "linkedin" && row.status === "pending" && row.externalId) return { ok: true, repoll: true };
  if (!["failed", "maybe_posted", "skipped"].includes(row.status)) {
    return { ok: false, reason: `This platform is "${row.status}"; only failed, maybe_posted or skipped rows are retried.` };
  }
  if (!guardCleared(post)) return { ok: false, reason: NOT_CHECKED_MESSAGE };
  return { ok: true };
}

export type PublishResult = { status: string; reason?: string; platforms?: Partial<Record<Platform, string>> };

export type PublishDeps = {
  /** The post, or null. */
  load(): Promise<{ status: string; removedAt?: number; heldFor?: HeldFor } | null>;
  /** Which platforms are on for him. */
  platforms(): Promise<Record<Platform, boolean>>;
  /** Take the post. A person approving a fact-check hold also clears it (guardPassedAt). */
  claimPost(approve: boolean): Promise<ClaimCheck>;
  /** The fact-check (fail closed: a crash returns a failing result). */
  guard(): Promise<GuardResult>;
  /** Save the guard result; hold = needs_review, posted nowhere; else guardPassedAt. */
  saveGuard(guard: GuardResult, hold: boolean): Promise<void>;
  /** The row for this platform (created if missing); a disabled platform's pending row becomes skipped. */
  ensureRow(platform: Platform, enabled: boolean): Promise<{ id: string }>;
  claimRow(id: string, approve: boolean): Promise<ClaimCheck>;
  post(platform: Platform, rowId: string): Promise<PlatformOutcome>;
  finishRow(id: string, outcome: PlatformOutcome): Promise<void>;
  /** Re-read the post: was removedAt set meanwhile? */
  isRemoved(): Promise<boolean>;
  scheduleUndo(): Promise<void>;
  /** Recompute posts.status from the rows. */
  settle(): Promise<{ status: string; error?: string }>;
};

/**
 * One platform: claim -> post -> finish -> re-read the post; if it was taken down meanwhile and
 * something may be out, schedule the undo.
 */
export async function publishOne(
  deps: Pick<PublishDeps, "claimRow" | "post" | "finishRow" | "isRemoved" | "scheduleUndo">,
  platform: Platform,
  rowId: string,
  approve: boolean,
): Promise<{ status: string; reason?: string; removed: boolean }> {
  const claim = await deps.claimRow(rowId, approve);
  if (!claim.ok) return { status: "not_claimed", reason: claim.reason, removed: false };
  let outcome: PlatformOutcome;
  try {
    outcome = await deps.post(platform, rowId);
  } catch {
    // post() handles its own errors; reaching here is a bug, and it may be out.
    outcome = { status: "maybe_posted", error: "Unexpected error while posting: check his profile before retrying." };
  }
  await deps.finishRow(rowId, outcome);
  let removed = false;
  if (mayBeOut(outcome) && (await deps.isRemoved())) {
    removed = true;
    await deps.scheduleUndo();
  }
  const reason = outcome.status === "failed" || outcome.status === "maybe_posted" ? outcome.error : undefined;
  return { status: outcome.status, ...(reason ? { reason } : {}), removed };
}

/**
 * The whole publish run: never a removed post; the fact-check once (shouldRunGuard); then each
 * platform in order (disabled ones get a skipped row); stop if the post is taken down meanwhile.
 */
export async function runPublish(deps: PublishDeps, approve: boolean): Promise<PublishResult> {
  const post = await deps.load();
  if (!post) return { status: "failed", reason: "Post not found." };
  if (post.removedAt !== undefined) return { status: post.status, reason: "Taken down (removedAt is set): not posting it." };
  const claim = await deps.claimPost(approve);
  if (!claim.ok) return { status: post.status, reason: claim.reason };

  const enabled = await deps.platforms();
  if (PLATFORMS.some((p) => enabled[p]) && shouldRunGuard(post, approve)) {
    const guard = await deps.guard();
    const hold = guardDecision(guard) === "hold";
    await deps.saveGuard(guard, hold);
    if (hold) return { status: "needs_review", reason: "Held by the fact-check." };
  }

  const platforms: Partial<Record<Platform, string>> = {};
  for (const platform of PLATFORMS) {
    if (await deps.isRemoved()) break;
    const row = await deps.ensureRow(platform, enabled[platform]);
    if (!enabled[platform]) {
      platforms[platform] = "skipped";
      continue;
    }
    const one = await publishOne(deps, platform, row.id, false);
    platforms[platform] = one.reason ? `${one.status}: ${one.reason}` : one.status;
    if (one.removed) break;
  }
  const settled = await deps.settle();
  return { status: settled.status, ...(settled.error ? { reason: settled.error } : {}), platforms };
}
