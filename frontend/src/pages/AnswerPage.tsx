import { useQuery } from "convex/react";
import { api } from "../convexApi";
import AnswerCard from "../components/AnswerCard";
import type { PublishedAnswer } from "../types";

export default function AnswerPage({ id }: { id: string }) {
  const answer = useQuery(api.answers.getPublic, { answerId: id }) as
    | PublishedAnswer
    | null
    | undefined;

  return (
    <main className="page feed">
      <p>
        <a href="#/" className="back-link">
          ← All answers
        </a>
      </p>
      {answer === undefined && <p className="loading">Loading…</p>}
      {answer === null && (
        <div className="card empty">
          <h2>Answer not found</h2>
          <p>It may not be published yet.</p>
        </div>
      )}
      {answer && <AnswerCard answer={answer} linkTitle={false} />}
    </main>
  );
}
