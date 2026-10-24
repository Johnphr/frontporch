import { useQuery } from "convex/react";
import { api } from "../convexApi";
import AnswerCard from "../components/AnswerCard";
import type { PublishedAnswer } from "../types";

export default function Feed() {
  const answers = useQuery(api.answers.listPublished) as PublishedAnswer[] | undefined;

  return (
    <main className="page feed">
      <section className="hero">
        <h1>Front Porch</h1>
        <p className="tagline">Advice from people who've lived it.</p>
        <p className="hero-sub">
          Every answer here started as a phone call. People share what they've learned, in their own
          words, and we write it up so more people can find it.
        </p>
      </section>

      {answers === undefined && <p className="loading">Loading answers…</p>}

      {answers !== undefined && answers.length === 0 && (
        <div className="card empty">
          <h2>No answers yet</h2>
          <p>
            Here's how they arrive: we find real questions people ask online, Pip calls someone who
            knows the answer, they talk it through, and once they say "yes, post it", the answer
            shows up here.
          </p>
        </div>
      )}

      <div className="answer-list">
        {answers?.map((answer) => <AnswerCard key={answer._id} answer={answer} />)}
      </div>
    </main>
  );
}
