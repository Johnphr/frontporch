import { useEffect, useState } from "react";
import { backend, type Health } from "../../backend";

export default function IntegrationsSection() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setError(null);
    backend
      .health()
      .then(setHealth)
      .catch((err: Error) => setError(err.message));
  };

  useEffect(load, []);

  return (
    <section className="card section">
      <div className="section-head">
        <h2>Integrations</h2>
        <button className="btn btn-ghost" onClick={load}>
          Refresh
        </button>
      </div>
      {error && <p className="notice notice-error">{error}</p>}
      {!health && !error && <p className="loading">Checking backend…</p>}
      {health && (
        <>
          <div className="badges">
            {Object.entries(health.integrations).map(([name, ok]) => (
              <span key={name} className={`badge ${ok ? "badge-on" : "badge-off"}`}>
                <span className="dot" aria-hidden="true" />
                {name}
                <span className="sr-only">{ok ? " configured" : " not configured"}</span>
              </span>
            ))}
          </div>
          <p className="muted small">
            When an elder says "yes" on a call, answers go to:{" "}
            <strong>{health.defaultPlatforms.join(", ") || "nowhere yet"}</strong>. Twilio calls{" "}
            <code>{health.publicBaseUrl}</code>.
          </p>
        </>
      )}
    </section>
  );
}
