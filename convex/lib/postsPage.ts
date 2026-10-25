// TEMPORARY: the posts review page (convex/postsPage.ts serves it at /posts). Lets the team read
// every generated post as it would be published (the Bluesky thread, post 1/N ...) and where each
// platform stands, to iterate fast on the content. Pure HTML rendering, no Convex imports
// (unit-tested). Remove with postsPage.ts.

import { timingSummary, type PostTimings } from "./fastPost.ts";
import { isHoldReason, postUndoInfo } from "./undo.ts";

export type PagePost = {
  id: string;
  createdAt: number;
  status: string;
  elderFirstName: string;
  kind?: string;
  question?: string;
  text: string; // the post as written (platform-neutral)
  /** The Bluesky thread as publish.ts would split it (disclosure in the last post)... */
  thread?: string[];
  /** ...or why it can't be split. */
  threadProblem?: string;
  /** Where it went: one row per platform (postPublications). */
  publications?: PagePublication[];
  guardSummary?: string;
  guardIssues?: string[];
  error?: string;
  /** Post quality (lib/postQuality.ts), when writePost scored it. */
  quality?: { score: number; passed: boolean; rounds: number; notes: string[]; mode?: "fast" };
  /** posts.timings: hang-up -> posted, per stage (lib/fastPost.ts). */
  timings?: PostTimings;
  /** Why a needs_review post is held (posts.heldFor; missing = the fact-check). */
  heldFor?: "quality" | "thread_fit" | "guard";
  /** Taken down (posts.removedAt / removedReason; "held: ..." = held by him on the call). */
  removedAt?: number;
  removedReason?: string;
};

export type PagePublication = { id: string; platform: string; status: string; url?: string; error?: string; posts?: number };

/** A thread reply (threadReplies.ts) as the review page shows it. */
export type PageReply = {
  id: string;
  createdAt: number;
  platform: string;
  status: string;
  threadUrl: string;
  threadTitle: string;
  text: string;
  guardSummary?: string;
  guardIssues?: string[];
  postedUrl?: string;
  error?: string;
};

export type PageCheck ={ postId: string; pass: boolean; summary: string; issues: string[]; mode: string } | { postId: string; error: string };

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

const STATUS_LABEL: Record<string, string> = {
  pending: "Saved (not posted)",
  needs_review: "Held by fact-check",
  posting: "Posting",
  published: "Published",
  partly_posted: "Partly posted",
  failed: "Failed",
  needs_attention: "Needs attention",
  removed: "Removed",
};

const PUBLICATION_LABEL: Record<string, string> = {
  pending: "Not posted yet",
  posting: "Posting",
  posted: "Posted",
  failed: "Failed",
  maybe_posted: "Maybe posted: check his profile",
  skipped: "Off",
  removing: "Taking down",
  removed: "Taken down",
};

const PLATFORM_LABEL: Record<string, string> = { bluesky: "Bluesky", threads: "Threads", x: "X", reddit: "Reddit", linkedin: "LinkedIn" };

function issuesList(issues: string[]): string {
  return issues.length ? `<ul>${issues.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ul>` : "";
}

function checkBlock(check: PageCheck | undefined): string {
  if (!check) return "";
  if ("error" in check) return `<div class="check bad"><strong>Fact-check failed to run.</strong> ${escapeHtml(check.error)}</div>`;
  return `<div class="check ${check.pass ? "good" : "bad"}"><strong>Fact-check now: ${check.pass ? "pass" : "would be held"}</strong> (${escapeHtml(check.mode)}) ${escapeHtml(check.summary)}${issuesList(check.issues)}</div>`;
}

/** A row that didn't finish but has posts out (a thread that stopped partway, any platform). */
function partly(r: PagePublication): boolean {
  return (r.status === "failed" || r.status === "maybe_posted") && (r.posts ?? 0) > 0;
}

/** The post's label, from its real state: a platform row that went out (or may have) wins over "pending". */
export function statusLabel(p: Pick<PagePost, "status" | "heldFor" | "publications" | "removedAt" | "removedReason">): string {
  if (p.removedAt !== undefined || p.status === "removed") return isHoldReason(p.removedReason) ? "Held by him on the call" : STATUS_LABEL.removed;
  if (p.status === "needs_review" && p.heldFor === "quality") return "Held: below the quality bar";
  if (p.status === "needs_review" && p.heldFor === "thread_fit") return "Held: too long for a Bluesky thread";
  const rows = p.publications ?? [];
  if (p.status === "pending" || p.status === "posting") {
    if (rows.some((r) => r.status === "posted")) return "Published";
    if (rows.some((r) => r.status === "maybe_posted")) return "Maybe posted: check";
    if (rows.some((r) => r.status === "posting" || (r.status === "pending" && r.platform === "linkedin"))) return "Posting";
  }
  // Older rows saved a half-posted thread as "failed".
  if (p.status === "failed" && rows.some(partly)) return STATUS_LABEL.partly_posted;
  return STATUS_LABEL[p.status] ?? p.status;
}

/** The label of one platform row. */
export function publicationLabel(r: PagePublication): string {
  if (partly(r)) {
    const n = `${r.posts} post${r.posts === 1 ? "" : "s"} out`;
    return r.status === "maybe_posted" ? `Partly posted (${n}), maybe more: check his profile` : `Partly posted (${n})`;
  }
  return PUBLICATION_LABEL[r.status] ?? r.status;
}

/** The command a person runs next for this post / platform row ("" when none). */
export function nextCommand(p: Pick<PagePost, "id" | "status">, row?: PagePublication): string {
  if (row) {
    if (row.status === "maybe_posted") return `npx convex run publish:retryPublication '{"publicationId":"${row.id}","approve":true}'`;
    if (row.status === "failed") return `npx convex run publish:retryPublication '{"publicationId":"${row.id}"}'`;
    return "";
  }
  if (p.status === "needs_review") return `npx convex run publish:approvePost '{"postId":"${p.id}"}'`;
  if (p.status === "pending" || p.status === "failed") return `npx convex run publish:publishPost '{"postId":"${p.id}"}'`;
  return "";
}

function threadBlock(p: PagePost): string {
  if (p.thread?.length) {
    const n = p.thread.length;
    return `<div class="thread">${p.thread
      .map((t, i) => `<div class="tpost"><span class="tnum">${i + 1}/${n}</span><div class="post">${escapeHtml(t)}</div></div>`)
      .join("")}</div>`;
  }
  return `${p.threadProblem ? `<p class="err">Doesn't fit a Bluesky thread: ${escapeHtml(p.threadProblem)}</p>` : ""}<div class="post">${escapeHtml(p.text)}</div>`;
}

function publicationsBlock(p: PagePost): string {
  const rows = p.publications ?? [];
  if (!rows.length) return "";
  const items = rows.map((r) => {
    const href = safeHref(r.url);
    const cmd = nextCommand(p, r);
    const counted = r.posts && !partly(r) ? ` (${r.posts} post${r.posts === 1 ? "" : "s"})` : "";
    return `<li><strong>${escapeHtml(PLATFORM_LABEL[r.platform] ?? r.platform)}</strong>: <span class="pstatus s-${escapeHtml(r.status)}">${escapeHtml(publicationLabel(r))}</span>${counted}${href ? ` <a href="${href}" target="_blank" rel="noopener noreferrer">open</a>` : ""}${r.error && r.status !== "posted" ? ` <span class="perr">${escapeHtml(r.error)}</span>` : ""}${cmd ? `<br><code>${escapeHtml(cmd)}</code>` : ""}</li>`;
  });
  return `<ul class="pubs">${items.join("")}</ul>`;
}

const WENT_OUT = new Set(["posted", "maybe_posted", "posting", "removing"]);

/** Take-down status + the undo command (lib/undo.postUndoInfo), for a post that went out or was taken down. */
export function undoBlock(p: Pick<PagePost, "id" | "removedAt" | "removedReason" | "publications">): string {
  const rows = p.publications ?? [];
  const wentOut = rows.some((r) => WENT_OUT.has(r.status) || partly(r));
  if (p.removedAt === undefined && !wentOut) return "";
  const info = postUndoInfo(
    { _id: p.id, ...(p.removedAt !== undefined ? { removedAt: p.removedAt } : {}), ...(p.removedReason ? { removedReason: p.removedReason } : {}) },
    rows,
  );
  return `<p class="cmd">${escapeHtml(info.status)}${info.command ? ` <code>${escapeHtml(info.command)}</code>` : ""}</p>`;
}

function qualityBlock(q: PagePost["quality"]): string {
  if (!q) return "";
  if (q.mode === "fast") {
    const rest = q.notes.filter((n) => !/^Fast mode/.test(n));
    return `<div class="check good"><strong>Fast mode: one draft, no judge</strong> (FAST_POST=on; fact-checked before posting)${issuesList(rest)}</div>`;
  }
  const rewrites = `${q.rounds} rewrite${q.rounds === 1 ? "" : "s"}`;
  return `<div class="check ${q.passed ? "good" : "bad"}"><strong>Quality: ${q.score}/100 (${q.passed ? "passed" : "below the bar"})</strong>, ${rewrites}${issuesList(q.notes)}</div>`;
}

/** "Posted 21.1 s after hang-up (detect 2.1s, write 9.8s, ...)", or the stages so far. */
export function timingBlock(t: PagePost["timings"]): string {
  const s = timingSummary(t);
  if (!s.stages.length && s.totalSeconds === undefined) return "";
  const stages = s.stages.map((x) => `${x.stage} ${x.seconds}s`).join(", ");
  const head = s.totalSeconds !== undefined ? `Posted ${s.totalSeconds} s after hang-up` : "Not posted yet";
  return `<p class="cmd">${escapeHtml(head)}${stages ? ` (${escapeHtml(stages)})` : ""}</p>`;
}

function card(p: PagePost, key: string, check: PageCheck | undefined): string {
  const date = new Date(p.createdAt).toISOString().slice(0, 16).replace("T", " ");
  // A quality hold's notes are already in the quality block: show its summary only (older
  // rows also copied the notes into guardIssues).
  const heldIssues = p.heldFor === "quality" && p.quality ? [] : (p.guardIssues ?? []);
  const stored = p.guardSummary || heldIssues.length
    ? `<div class="check bad"><strong>Held:</strong> ${escapeHtml(p.guardSummary ?? "")}${issuesList(heldIssues)}</div>`
    : "";
  const href = `?key=${encodeURIComponent(key)}&check=${encodeURIComponent(p.id)}#${encodeURIComponent(p.id)}`;
  const cmd = nextCommand(p);
  return `<article id="${escapeHtml(p.id)}">
  <header><span class="who">${escapeHtml(p.elderFirstName)}</span><span class="badge s-${escapeHtml(p.status)}">${escapeHtml(statusLabel(p))}</span><time>${date} UTC</time></header>
  ${p.question ? `<p class="q">Call question: ${escapeHtml(p.question)}</p>` : ""}
  ${threadBlock(p)}
  ${publicationsBlock(p)}
  ${timingBlock(p.timings)}
  ${p.error ? `<p class="err">${escapeHtml(p.error)}</p>` : ""}
  ${qualityBlock(p.quality)}${stored}${checkBlock(check?.postId === p.id ? check : undefined)}
  ${cmd && p.removedAt === undefined ? `<p class="cmd">${p.status === "needs_review" ? "Approve and post" : "Post it"}: <code>${escapeHtml(cmd)}</code></p>` : ""}
  ${undoBlock(p)}
  <footer><form method="post" action="${escapeHtml(href)}"><button type="submit">Fact-check now</button></form> <span class="id">${escapeHtml(p.id)}</span></footer>
</article>`;
}

// ---------- thread replies ----------

const REPLY_STATUS_LABEL: Record<string, string> = {
  draft: "Ready to post",
  needs_review: "Held by fact-check",
  posting: "Posting",
  posted: "Posted",
  failed: "Failed",
  maybe_posted: "Maybe posted: check the thread",
};

const REPLY_PLATFORM_LABEL: Record<string, string> = {
  bluesky: "Bluesky",
  reddit: "Reddit",
};

/** Only http(s) links are rendered as links (the data came from scraped pages). */
function safeHref(url: string | undefined): string | undefined {
  return url && /^https?:\/\//i.test(url) ? escapeHtml(url) : undefined;
}

function replyCard(r: PageReply): string {
  const date = new Date(r.createdAt).toISOString().slice(0, 16).replace("T", " ");
  const thread = safeHref(r.threadUrl);
  const posted = safeHref(r.postedUrl);
  // Copy text / Open thread only matter for a reply a person has to look at.
  const canCopy = Boolean(r.text) && (r.status === "needs_review" || r.status === "maybe_posted");
  const unclear = r.status === "maybe_posted"
    ? `<p class="err">It may already be on the thread. Open the thread first; only if his reply isn't there, run <code>npx convex run threadReplies:postReply '{"replyId":"${escapeHtml(r.id)}","approve":true}'</code></p>`
    : "";
  const held = r.guardSummary || r.guardIssues?.length
    ? `<div class="check bad"><strong>Held:</strong> ${escapeHtml(r.guardSummary ?? "")}${issuesList(r.guardIssues ?? [])}</div>`
    : "";
  return `<article id="reply-${escapeHtml(r.id)}">
  <header><span class="who">${escapeHtml(REPLY_PLATFORM_LABEL[r.platform] ?? r.platform)}</span><span class="badge s-${escapeHtml(r.status)}">${escapeHtml(REPLY_STATUS_LABEL[r.status] ?? r.status)}</span><time>${date} UTC</time></header>
  <p class="q">Thread: ${escapeHtml(r.threadTitle)}</p>
  ${r.text ? `<div class="post" id="reply-text-${escapeHtml(r.id)}">${escapeHtml(r.text)}</div>` : ""}
  ${r.error ? `<p class="err">${escapeHtml(r.error)}</p>` : ""}
  ${unclear}${held}
  <footer>${thread && canCopy ? `<a href="${thread}" target="_blank" rel="noopener noreferrer">Open thread</a>` : ""}${canCopy ? ` <button type="button" data-copy="reply-text-${escapeHtml(r.id)}">Copy text</button>` : ""}${posted ? ` <a href="${posted}" target="_blank" rel="noopener noreferrer">See the reply</a>` : ""} <span class="id">${escapeHtml(r.id)}</span></footer>
</article>`;
}

/** The "Thread replies" section ("" when there are none). Copy buttons use a tiny inline script. */
export function renderRepliesSection(replies: PageReply[]): string {
  if (!replies.length) return "";
  return `<h1>Thread replies</h1><p class="sub">His answers on the Bluesky and Reddit threads his call questions came from, posted from his account. "Held by fact-check": review it, then approve with threadReplies:postReply (approve: true). "Ready to post" (written while AUTO_POST was off): send them with <code>npx convex run threadReplies:postDrafts</code>.</p>
${replies.map(replyCard).join("\n")}
<script>document.addEventListener("click",function(e){var b=e.target.closest&&e.target.closest("button[data-copy]");if(!b)return;var t=document.getElementById(b.getAttribute("data-copy"));if(!t||!navigator.clipboard)return;navigator.clipboard.writeText(t.textContent||"").then(function(){b.textContent="Copied";setTimeout(function(){b.textContent="Copy text"},1500)})});</script>`;
}

export function renderPostsPage(posts: PagePost[], opts: { key: string; check?: PageCheck; replies?: PageReply[] }): string {
  const body = posts.length
    ? posts.map((p) => card(p, opts.key, opts.check)).join("\n")
    : `<p class="empty">No posts yet. Finish a story call (or run pipeline:seedEndedCall with tests/fixtures/story_call.json).</p>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>MEMORIA posts (temporary)</title>
<style>
:root{--bg:#f6f6f4;--card:#fff;--ink:#1d1d1b;--muted:#6b6b66;--line:#e2e2dd;--good:#1f7a4a;--bad:#a3461f}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--card:#1f1f1d;--ink:#ecece8;--muted:#a0a09a;--line:#33332f;--good:#5fc08c;--bad:#e5895f}}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;padding:24px 16px}
main{max-width:680px;margin:0 auto;display:grid;gap:16px}
h1{font-size:22px;margin:0}.sub{color:var(--muted);margin:0 0 8px}
article{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;display:grid;gap:10px}
header{display:flex;flex-wrap:wrap;gap:8px;align-items:center;font-size:14px}
.who{font-weight:600}time,.id,.q{color:var(--muted)}.q{margin:0;font-size:14px}
.badge{border:1px solid var(--line);border-radius:999px;padding:2px 8px;font-size:12px}
.s-needs_review,.s-failed,.s-partly_posted,.s-needs_attention{color:var(--bad);border-color:var(--bad)}.s-published{color:var(--good);border-color:var(--good)}.s-removed{color:var(--muted)}
.post{white-space:pre-wrap;font-size:15.5px}
.check{font-size:14px;border-left:3px solid var(--line);padding:4px 10px}.check.good{border-color:var(--good)}.check.bad{border-color:var(--bad)}
.check ul{margin:4px 0 0;padding-left:18px}.err{color:var(--bad);margin:0;font-size:14px}
footer{display:flex;gap:12px;font-size:13px;flex-wrap:wrap}footer form{margin:0}a{color:inherit}.id{font-family:ui-monospace,monospace;font-size:12px}
.thread{display:grid;gap:8px}.tpost{border-left:3px solid var(--line);padding:2px 10px}.tnum{color:var(--muted);font-size:12px}
.pubs{margin:0;padding-left:18px;font-size:14px}.perr{color:var(--bad)}.s-posted{color:var(--good)}.s-maybe_posted{color:var(--bad)}
code{font-family:ui-monospace,monospace;font-size:12px;word-break:break-all}.cmd{margin:0;font-size:13px}
</style></head><body><main>
<h1>Generated posts</h1><p class="sub">Temporary review page. Newest first, as the Bluesky thread they become. Threads (when he connected it) and X (X_POSTING) get their own split of the same story; each platform row below has its status and link (Reddit and LinkedIn only when they're on). Nothing on this page posts anything: run the commands shown.</p>
${body}
${renderRepliesSection(opts.replies ?? [])}
</main></body></html>`;
}
