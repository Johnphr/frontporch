import { useQuery } from "convex/react";
import { api } from "../../convexApi";
import type { Call } from "../../types";

export default function CallsSection() {
  const calls = useQuery(api.calls.listRecent) as Call[] | undefined;

  return (
    <section className="card section">
      <div className="section-head">
        <h2>Recent calls</h2>
        <span className="muted small">Updates live</span>
      </div>
      {calls === undefined && <p className="loading">Loading…</p>}
      {calls?.length === 0 && <p className="muted">No calls yet. Press "Call now" on an elder.</p>}
      <div className="calls">
        {calls?.map((call) => (
          <details key={call._id} className="call" open={call.status === "in-progress"}>
            <summary>
              <strong>{call.elderName}</strong>{" "}
              <span className={`pill pill-${call.status}`}>{call.status}</span>{" "}
              <span className="muted small">
                {new Date(call._creationTime).toLocaleTimeString()}
              </span>
            </summary>
            <div className="transcript">
              {call.transcript.length === 0 && <p className="muted small">Waiting for speech…</p>}
              {call.transcript.map((turn, i) => (
                <div key={i} className={`turn turn-${turn.role === "pip" ? "pip" : "elder"}`}>
                  <span className="turn-role">{turn.role === "pip" ? "PIP" : "ELDER"}</span>
                  <p>{turn.text}</p>
                </div>
              ))}
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}
