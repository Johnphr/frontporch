import { useState, type FormEvent } from "react";
import { useQuery } from "convex/react";
import { api } from "../../convexApi";
import { backend } from "../../backend";
import { useBackendAction } from "../../useBackendAction";
import Notice from "../../components/Notice";
import { platformLabel } from "../../components/AnswerCard";
import type { Answer, Publication, Reply } from "../../types";

const PLATFORMS = ["feed", "bluesky", "linkedin", "reddit", "quora", "discourse"];

export default function AnswersSection() {
  const answers = useQuery(api.answers.listAll) as Answer[] | undefined;

  return (
    <section className="card section">
      <div className="section-head">
        <h2>Answers</h2>
      </div>
      {answers === undefined && <p className="loading">Loading…</p>}
      {answers?.length === 0 && (
        <p className="muted">No answers yet. They appear here as soon as a call ends.</p>
      )}
      <div className="answers-admin">
        {answers?.map((answer) => <AnswerAdmin key={answer._id} answer={answer} />)}
      </div>
    </section>
  );
}

function AnswerAdmin({ answer }: { answer: Answer }) {
  const { busy, message, run } = useBackendAction();
  const [copied, setCopied] = useState<string | null>(null);

  const copy = async (pub: Publication) => {
    if (!pub.draftText) return;
    try {
      await navigator.clipboard.writeText(pub.draftText);
      setCopied(pub.platform);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      window.prompt("Copy this text:", pub.draftText);
    }
  };

  const publish = (platform: string) =>
    run(`publish-${platform}`, () => backend.publish(answer._id, [platform]), () =>
      `Sent to ${platformLabel(platform)}.`,
    );

  return (
    <article className="answer-admin">
      <div className="answer-admin-head">
        <div>
          <p className="muted small">
            {answer.elderName} answered:{" "}
            {answer.questionUrl ? (
              <a href={answer.questionUrl} target="_blank" rel="noreferrer">
                {answer.questionTitle}
              </a>
            ) : (
              answer.questionTitle
            )}
          </p>
          <h3>{answer.title}</h3>
        </div>
        <span className={`pill pill-${answer.status}`}>{answer.status}</span>
      </div>

      <p className="answer-admin-body">{answer.body}</p>
      {answer.keyPoints.length > 0 && (
        <ul className="key-points small">
          {answer.keyPoints.map((p, i) => (
            <li key={i}>{p}</li>
          ))}
        </ul>
      )}

      <details className="small">
        <summary>Call transcript</summary>
        <pre className="raw-transcript">{answer.transcript}</pre>
      </details>

      <Notice message={message} />

      {answer.publications.length > 0 && (
        <ul className="publications">
          {answer.publications.map((pub) => (
            <li key={pub.platform} className={`pub pub-${pub.status}`}>
              <span className="pub-name">{platformLabel(pub.platform)}</span>
              <span className={`pill pill-${pub.status}`}>{pub.status}</span>
              {pub.url && (
                <a href={pub.url} target="_blank" rel="noreferrer" className="small">
                  View
                </a>
              )}
              {pub.status === "draft" && pub.draftText && (
                <>
                  <button className="btn btn-small" onClick={() => copy(pub)}>
                    {copied === pub.platform ? "Copied!" : "Copy text"}
                  </button>
                  {answer.questionUrl && (
                    <a
                      href={answer.questionUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="btn btn-small btn-ghost"
                    >
                      Open question
                    </a>
                  )}
                </>
              )}
              {pub.error && <span className="pub-error small">{pub.error}</span>}
            </li>
          ))}
        </ul>
      )}

      <div className="actions wrap">
        {PLATFORMS.map((platform) => (
          <button
            key={platform}
            className="btn btn-small"
            disabled={busy !== null || answer.status === "rejected"}
            onClick={() => publish(platform)}
          >
            {busy === `publish-${platform}` ? "Sending…" : `→ ${platformLabel(platform)}`}
          </button>
        ))}
      </div>
      <div className="actions wrap">
        {answer.status !== "approved" && answer.status !== "published" && (
          <button
            className="btn btn-small btn-primary"
            disabled={busy !== null}
            onClick={() =>
              run("approve", () => backend.setAnswerStatus(answer._id, "approved"), () =>
                "Approved.",
              )
            }
          >
            Approve
          </button>
        )}
        {answer.status !== "rejected" && (
          <button
            className="btn btn-small btn-danger"
            disabled={busy !== null}
            onClick={() =>
              run("reject", () => backend.setAnswerStatus(answer._id, "rejected"), () =>
                "Rejected. It won't be published.",
              )
            }
          >
            Reject
          </button>
        )}
      </div>

      <Replies answerId={answer._id} />
    </article>
  );
}

function Replies({ answerId }: { answerId: string }) {
  const replies = useQuery(api.replies.listForAnswer, { answerId }) as Reply[] | undefined;
  const { busy, message, run } = useBackendAction();
  const [form, setForm] = useState({ platform: "bluesky", author: "", text: "" });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const result = await run(
      "reply",
      () =>
        backend.addReply(answerId, {
          platform: form.platform,
          author: form.author.trim(),
          text: form.text.trim(),
        }),
      () => "Saved. Pip will read it on the next call.",
    );
    if (result) setForm({ ...form, author: "", text: "" });
  };

  return (
    <details className="replies small">
      <summary>Thank-you replies {replies && replies.length > 0 ? `(${replies.length})` : ""}</summary>
      {replies?.map((r) => (
        <p key={r._id} className="reply">
          <strong>{r.author}</strong> on {platformLabel(r.platform)}: “{r.text}”{" "}
          <span className="muted">{r.readToElder ? "· read to elder" : "· not read yet"}</span>
        </p>
      ))}
      <form className="form form-inline" onSubmit={submit}>
        <span className="muted">Simulate a thank-you reply:</span>
        <select
          value={form.platform}
          onChange={(e) => setForm({ ...form, platform: e.target.value })}
        >
          {PLATFORMS.map((p) => (
            <option key={p} value={p}>
              {platformLabel(p)}
            </option>
          ))}
        </select>
        <input
          required
          placeholder="Jake, 19"
          value={form.author}
          onChange={(e) => setForm({ ...form, author: e.target.value })}
        />
        <input
          required
          className="grow"
          placeholder="This helped me fix my bike, thank you!"
          value={form.text}
          onChange={(e) => setForm({ ...form, text: e.target.value })}
        />
        <button className="btn btn-small" type="submit" disabled={busy !== null}>
          {busy === "reply" ? "Saving…" : "Add"}
        </button>
      </form>
      <Notice message={message} />
    </details>
  );
}
