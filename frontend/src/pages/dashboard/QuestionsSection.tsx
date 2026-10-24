import { useState, type FormEvent } from "react";
import { useQuery } from "convex/react";
import { api } from "../../convexApi";
import { backend } from "../../backend";
import { useBackendAction } from "../../useBackendAction";
import Notice from "../../components/Notice";
import type { Question, QuestionStatus } from "../../types";

const TABS: QuestionStatus[] = ["new", "assigned", "answered", "skipped"];

function summarize(result: Record<string, unknown>): string {
  const parts = Object.entries(result)
    .filter(([, v]) => typeof v === "number" || typeof v === "string")
    .map(([k, v]) => `${k}: ${v}`);
  return parts.length ? parts.join(" · ") : "Done.";
}

export default function QuestionsSection() {
  const [tab, setTab] = useState<QuestionStatus>("assigned");
  const questions = useQuery(api.questions.list, { status: tab }) as Question[] | undefined;
  const { busy, message, run } = useBackendAction();
  const [form, setForm] = useState({ title: "", body: "", sourceUrl: "" });

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
          <button
            className="btn btn-primary"
            disabled={busy !== null}
            onClick={() => run("refresh", backend.refreshQuestions, summarize)}
          >
            {busy === "refresh" ? "Searching… (can take a minute)" : "Find questions with Apify"}
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
        {questions?.map((q) => (
          <li key={q._id} className="list-row list-row-top">
            <div>
              <span className="tag tag-source">{q.source}</span>{" "}
              {q.sourceUrl ? (
                <a href={q.sourceUrl} target="_blank" rel="noreferrer">
                  <strong>{q.title}</strong>
                </a>
              ) : (
                <strong>{q.title}</strong>
              )}
              {q.body && <p className="muted small clamp">{q.body}</p>}
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
        ))}
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
