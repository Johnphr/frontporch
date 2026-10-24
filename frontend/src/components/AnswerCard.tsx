import type { PublishedAnswer } from "../types";

const PLATFORM_LABELS: Record<string, string> = {
  feed: "Front Porch",
  bluesky: "Bluesky",
  linkedin: "LinkedIn",
  reddit: "Reddit",
  quora: "Quora",
  discourse: "Forum",
};

export function platformLabel(platform: string) {
  return PLATFORM_LABELS[platform] ?? platform;
}

export default function AnswerCard({
  answer,
  linkTitle = true,
}: {
  answer: PublishedAnswer;
  linkTitle?: boolean;
}) {
  const elsewhere = answer.publications.filter(
    (p) => p.status === "published" && p.url && p.platform !== "feed",
  );
  return (
    <article className="card answer-card">
      <p className="question-label">Someone asked</p>
      <h2 className="question-title">
        {answer.questionUrl ? (
          <a href={answer.questionUrl} target="_blank" rel="noreferrer">
            {answer.questionTitle}
          </a>
        ) : (
          answer.questionTitle
        )}
      </h2>
      <h3 className="answer-title">
        {linkTitle ? <a href={`#/answer/${answer._id}`}>{answer.title}</a> : answer.title}
      </h3>
      <div className="answer-body">
        {answer.body.split(/\n{2,}/).map((para, i) => (
          <p key={i}>{para}</p>
        ))}
      </div>
      {answer.keyPoints.length > 0 && (
        <ul className="key-points">
          {answer.keyPoints.map((point, i) => (
            <li key={i}>{point}</li>
          ))}
        </ul>
      )}
      <p className="signature">— {answer.elderFirstName}</p>
      <p className="disclosure">Answered by phone, written up with AI from their own words.</p>
      {elsewhere.length > 0 && (
        <p className="elsewhere">
          Also on{" "}
          {elsewhere.map((p, i) => (
            <span key={p.platform}>
              {i > 0 && " · "}
              <a href={p.url} target="_blank" rel="noreferrer">
                {platformLabel(p.platform)}
              </a>
            </span>
          ))}
        </p>
      )}
    </article>
  );
}
