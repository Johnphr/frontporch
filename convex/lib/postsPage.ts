// TEMPORARY: the posts review page (convex/postsPage.ts serves it at /posts). Lets the team read
// every generated post as it would be published, to iterate fast on the content before LinkedIn
// is connected. Pure HTML rendering, no Convex imports (unit-tested). Remove with postsPage.ts.

export type PagePost = {
  id: string;
  createdAt: number;
  status: string;
  elderFirstName: string;
  kind?: string;
  question?: string;
  text: string; // as it would be published (formatted, disclosure line included)
  guardSummary?: string;
  guardIssues?: string[];
  error?: string;
};

/** A thread reply (threadReplies.ts) as the review page shows it. */
export type PageReply = {
  id: string;
  createdAt: number;
  platform: string;
  status: string;
  threadUrl: string;
  threadTitle: string;
  text: string;
  reason?: string;
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
  failed: "Failed",
  needs_attention: "Needs attention",
};

function issuesList(issues: string[]): string {
  return issues.length ? `<ul>${issues.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ul>` : "";
}

function checkBlock(check: PageCheck | undefined): string {
  if (!check) return "";
  if ("error" in check) return `<div class="check bad"><strong>Fact-check failed to run.</strong> ${escapeHtml(check.error)}</div>`;
  return `<div class="check ${check.pass ? "good" : "bad"}"><strong>Fact-check now: ${check.pass ? "pass" : "would be held"}</strong> (${escapeHtml(check.mode)}) ${escapeHtml(check.summary)}${issuesList(check.issues)}</div>`;
}

function card(p: PagePost, key: string, check: PageCheck | undefined): string {
  const date = new Date(p.createdAt).toISOString().slice(0, 16).replace("T", " ");
  const stored = p.guardSummary || p.guardIssues?.length
    ? `<div class="check bad"><strong>Held:</strong> ${escapeHtml(p.guardSummary ?? "")}${issuesList(p.guardIssues ?? [])}</div>`
    : "";
  const href = `?key=${encodeURIComponent(key)}&check=${encodeURIComponent(p.id)}#${encodeURIComponent(p.id)}`;
  return `<article id="${escapeHtml(p.id)}">
  <header><span class="who">${escapeHtml(p.elderFirstName)}</span><span class="badge s-${escapeHtml(p.status)}">${escapeHtml(STATUS_LABEL[p.status] ?? p.status)}</span><time>${date} UTC</time></header>
  ${p.question ? `<p class="q">Call question: ${escapeHtml(p.question)}</p>` : ""}
  <div class="post">${escapeHtml(p.text)}</div>
  ${p.error ? `<p class="err">${escapeHtml(p.error)}</p>` : ""}
  ${stored}${checkBlock(check?.postId === p.id ? check : undefined)}
  <footer><a href="${href}">Fact-check now</a> <span class="id">${escapeHtml(p.id)}</span></footer>
</article>`;
}

// ---------- thread replies ----------

const REPLY_STATUS_LABEL: Record<string, string> = {
  draft: "Ready to post",
  needs_review: "Held by fact-check",
  posting: "Posting",
  posted: "Posted",
  manual: "Post by hand",
  skipped: "Skipped",
  failed: "Failed",
};

const REPLY_PLATFORM_LABEL: Record<string, string> = {
  bluesky: "Bluesky",
  discourse: "Forum",
  reddit: "Reddit",
  quora: "Quora",
  stackexchange: "Stack Exchange",
  other: "Web",
};

/** Only http(s) links are rendered as links (the data came from scraped pages). */
function safeHref(url: string | undefined): string | undefined {
  return url && /^https?:\/\//i.test(url) ? escapeHtml(url) : undefined;
}

function replyCard(r: PageReply): string {
  const date = new Date(r.createdAt).toISOString().slice(0, 16).replace("T", " ");
  const thread = safeHref(r.threadUrl);
  const posted = safeHref(r.postedUrl);
  const canCopy = Boolean(r.text) && ["manual", "needs_review", "draft", "failed"].includes(r.status);
  const held = r.guardSummary || r.guardIssues?.length
    ? `<div class="check bad"><strong>Held:</strong> ${escapeHtml(r.guardSummary ?? "")}${issuesList(r.guardIssues ?? [])}</div>`
    : "";
  return `<article id="reply-${escapeHtml(r.id)}">
  <header><span class="who">${escapeHtml(REPLY_PLATFORM_LABEL[r.platform] ?? r.platform)}</span><span class="badge s-${escapeHtml(r.status)}">${escapeHtml(REPLY_STATUS_LABEL[r.status] ?? r.status)}</span><time>${date} UTC</time></header>
  <p class="q">Thread: ${escapeHtml(r.threadTitle)}</p>
  ${r.text ? `<div class="post" id="reply-text-${escapeHtml(r.id)}">${escapeHtml(r.text)}</div>` : ""}
  ${r.reason ? `<p class="q">${escapeHtml(r.reason)}</p>` : ""}
  ${r.error ? `<p class="err">${escapeHtml(r.error)}</p>` : ""}
  ${held}
  <footer>${thread ? `<a href="${thread}" target="_blank" rel="noopener noreferrer">Open thread</a>` : ""}${canCopy ? ` <button type="button" data-copy="reply-text-${escapeHtml(r.id)}">Copy text</button>` : ""}${posted ? ` <a href="${posted}" target="_blank" rel="noopener noreferrer">See the reply</a>` : ""} <span class="id">${escapeHtml(r.id)}</span></footer>
</article>`;
}

/** The "Thread replies" section ("" when there are none). Copy buttons use a tiny inline script. */
export function renderRepliesSection(replies: PageReply[]): string {
  if (!replies.length) return "";
  return `<h1>Thread replies</h1><p class="sub">His answers on the threads his call questions came from. "Post by hand": copy the text, open the thread, post from his account.</p>
${replies.map(replyCard).join("\n")}
<script>document.addEventListener("click",function(e){var b=e.target.closest&&e.target.closest("button[data-copy]");if(!b)return;var t=document.getElementById(b.getAttribute("data-copy"));if(!t||!navigator.clipboard)return;navigator.clipboard.writeText(t.textContent||"").then(function(){b.textContent="Copied";setTimeout(function(){b.textContent="Copy text"},1500)})});</script>`;
}

export function renderPostsPage(posts: PagePost[], opts: { key: string; check?: PageCheck; replies?: PageReply[] }): string {
  const body = posts.length
    ? posts.map((p) => card(p, opts.key, opts.check)).join("\n")
    : `<p class="empty">No posts yet. Finish a story call (or run pipeline:seedEndedCall with tests/fixtures/story_call.json).</p>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Front Porch posts (temporary)</title>
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
.s-needs_review,.s-failed,.s-needs_attention{color:var(--bad);border-color:var(--bad)}.s-published{color:var(--good);border-color:var(--good)}
.post{white-space:pre-wrap;font-size:15.5px}
.check{font-size:14px;border-left:3px solid var(--line);padding:4px 10px}.check.good{border-color:var(--good)}.check.bad{border-color:var(--bad)}
.check ul{margin:4px 0 0;padding-left:18px}.err{color:var(--bad);margin:0;font-size:14px}
footer{display:flex;gap:12px;font-size:13px;flex-wrap:wrap}a{color:inherit}.id{font-family:ui-monospace,monospace;font-size:12px}
</style></head><body><main>
<h1>Generated posts</h1><p class="sub">Temporary review page. Newest first, as they would be published. Nothing here posts to LinkedIn.</p>
${body}
${renderRepliesSection(opts.replies ?? [])}
</main></body></html>`;
}
