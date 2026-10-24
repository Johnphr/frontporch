import { useEffect, useState, type FormEvent } from "react";
import { useQuery } from "convex/react";
import { api } from "../../convexApi";
import { backend } from "../../backend";
import { useBackendAction } from "../../useBackendAction";
import Notice from "../../components/Notice";
import type { Question, QuestionSource, QuestionStatus } from "../../types";

const TABS: QuestionStatus[] = ["new", "assigned", "answered", "skipped"];

type SourceReport = {
  fetched?: number;
  kept?: number;
  inserted?: number;
  duplicate?: number;
  filtered?: number;
  error?: string;
};

function summarize(result: Record<string, unknown>): string {
  const parts = Object.entries(result)
    .filter(([, v]) => typeof v === "number" || typeof v === "string")
    .map(([k, v]) => `${k}: ${v}`);
  const routing = result.routing as Record<string, number> | undefined;
  if (routing) {
    parts.push(`assigned ${routing.assigned ?? 0}, skipped ${routing.skipped ?? 0}`);
  }
  const sources = result.sources as Record<string, SourceReport> | undefined;
  if (sources) {
    for (const [name, r] of Object.entries(sources)) {
      parts.push(
        r.error
          ? `${name}: ${r.error}`
          : `${name}: ${r.inserted ?? 0} new of ${r.fetched ?? 0} (${r.filtered ?? 0} filtered, ${r.duplicate ?? 0} dupes)`,
      );
    }
  }
  return parts.length ? parts.join(" · ") : "Done.";
}

function timeAgo(ms?: number): string | null {
  if (!ms) return null;
  const days = Math.floor((Date.now() - ms) / 86_400_000);
  if (days < 1) return "today";
  if (days === 1) return "yesterday";
  if (days < 60) return `${days} days ago`;
  return new Date(ms).toLocaleDateString();
}

function SourcePicker({
  sources,
  selected,
  onToggle,
}: {
  sources: QuestionSource[];
  selected: Set<string>;
  onToggle: (name: string) => void;
}) {
  return (
    <fieldset className="form">
      <legend className="small muted">Sources to search</legend>
      <div className="tags">
        {sources.map((s) => (
          <label key={s.name} className="tag" title={s.enabled ? "On by default" : "Off by default"}>
            <input
              type="checkbox"
              checked={selected.has(s.name)}
              onChange={() => onToggle(s.name)}
            />{" "}
            {s.label}
            {!s.enabled && <span className="muted"> (off)</span>}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export default function QuestionsSection() {
  const [tab, setTab] = useState<QuestionStatus>("assigned");
  const questions = useQuery(api.questions.list, { status: tab }) as Question[] | undefined;
  const { busy, message, run } = useBackendAction();
  const [form, setForm] = useState({ title: "", body: "", sourceUrl: "" });
  const [sources, setSources] = useState<QuestionSource[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [limit, setLimit] = useState(10);

  useEffect(() => {
    backend
      .questionSources()
      .then((list) => {
        setSources(list);
        setSelected(new Set(list.filter((s) => s.enabled).map((s) => s.name)));
      })
      .catch(() => setSources([])); // backend down: the button still works with defaults
  }, []);

  const toggle = (name: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const refresh = () =>
    run(
      "refresh",
      () =>
        backend.refreshQuestions(
          sources && sources.length ? { sources: [...selected], limit } : { limit },
        ),
      summarize,
    );

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const result = await run(
      "manual",
      () =>
        backend.addQuestion({
          title: form.title.trim(),
          body: form.body.trim() || undefined,
          sourceUrl: form.sourceUrl.trim() || undefined,
        }),
      summarize,
    );
    if (result) setForm({ title: "", body: "", sourceUrl: "" });
  };

  return (
    <section className="card section">
      <div className="section-head">
        <h2>Questions</h2>
        <div className="actions">
          <label className="small">
            Per source{" "}
            <input
              type="number"
              min={1}
              max={100}
              value={limit}
              onChange={(e) => setLimit(Math.max(1, Math.min(100, Number(e.target.value) || 1)))}
              style={{ width: "4.5em" }}
            />
          </label>
          <button
            className="btn btn-primary"
            disabled={busy !== null || (sources !== null && sources.length > 0 && selected.size === 0)}
            onClick={refresh}
          >
            {busy === "refresh" ? "Searching… (can take a minute)" : "Find questions"}
          </button>
          <button
            className="btn"
            disabled={busy !== null}
            onClick={() => run("route", backend.routeQuestions, summarize)}
          >
            {busy === "route" ? "Routing…" : "Re-route"}
          </button>
        </div>
      </div>
      {sources && sources.length > 0 && (
        <SourcePicker sources={sources} selected={selected} onToggle={toggle} />
      )}
      <Notice message={message} />

      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            className={`tab ${tab === t ? "tab-active" : ""}`}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </div>

      {questions === undefined && <p className="loading">Loading…</p>}
      {questions?.length === 0 && <p className="muted">No {tab} questions.</p>}
      <ul className="list">
        {questions?.map((q) => {
          const posted = timeAgo(q.postedAt);
          return (
            <li key={q._id} className="list-row list-row-top">
              <div>
                <span className="tag tag-source">{q.source}</span>{" "}
                {q.community && <span className="tag">{q.community}</span>}{" "}
                {q.sourceUrl ? (
                  <a href={q.sourceUrl} target="_blank" rel="noreferrer">
                    <strong>{q.title}</strong>
                  </a>
                ) : (
                  <strong>{q.title}</strong>
                )}
                {q.body && <p className="muted small clamp">{q.body}</p>}
                <p className="muted small">
                  {[
                    q.score !== undefined ? `▲ ${q.score}` : null,
                    q.answerCount !== undefined ? `${q.answerCount} answers` : null,
                    posted ? `posted ${posted}` : null,
                    q.priority !== undefined ? `priority ${q.priority.toFixed(1)}` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
                <div className="tags">
                  {q.topics.map((t) => (
                    <span key={t} className="tag">
                      {t}
                    </span>
                  ))}
                </div>
              </div>
              <div className="small right">
                {q.assignedElderName && <span>→ {q.assignedElderName}</span>}
                {q.skipReason && <span className="muted">Skipped: {q.skipReason}</span>}
              </div>
            </li>
          );
        })}
      </ul>

      <form className="form" onSubmit={submit}>
        <h3>Add a question by hand</h3>
        <p className="muted small">Useful as a demo backup if scraping is slow.</p>
        <div className="form-grid">
          <label className="span-2">
            Question
            <input
              required
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              placeholder="How did you keep your marriage strong for 50 years?"
            />
          </label>
          <label className="span-2">
            Details (optional)
            <textarea
              rows={2}
              value={form.body}
              onChange={(e) => setForm({ ...form, body: e.target.value })}
            />
          </label>
          <label className="span-2">
            Link to the original question (optional)
            <input
              type="url"
              value={form.sourceUrl}
              onChange={(e) => setForm({ ...form, sourceUrl: e.target.value })}
              placeholder="https://www.reddit.com/r/AskOldPeople/…"
            />
          </label>
        </div>
        <button className="btn btn-primary" type="submit" disabled={busy !== null}>
          {busy === "manual" ? "Adding…" : "Add question"}
        </button>
      </form>
    </section>
  );
}
