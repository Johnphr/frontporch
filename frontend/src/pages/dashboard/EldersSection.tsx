import { useState, type FormEvent } from "react";
import { useQuery } from "convex/react";
import { api } from "../../convexApi";
import { backend } from "../../backend";
import { useBackendAction } from "../../useBackendAction";
import Notice from "../../components/Notice";
import type { Elder } from "../../types";

const LANGUAGES = [
  { value: "en-US", label: "English (US)" },
  { value: "es-MX", label: "Spanish (Mexico)" },
  { value: "es-ES", label: "Spanish (Spain)" },
  { value: "fr-FR", label: "French" },
  { value: "pt-BR", label: "Portuguese (Brazil)" },
];

const EMPTY = { name: "", phone: "", expertise: "", language: "en-US", bio: "" };

export default function EldersSection() {
  const elders = useQuery(api.elders.list) as Elder[] | undefined;
  const { busy, message, run } = useBackendAction();
  const [form, setForm] = useState(EMPTY);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const result = await run(
      "create",
      () =>
        backend.createElder({
          name: form.name.trim(),
          phone: form.phone.trim(),
          expertise: form.expertise
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
          language: form.language,
          bio: form.bio.trim() || undefined,
        }),
      () => `Added ${form.name.trim()}.`,
    );
    if (result) setForm(EMPTY);
  };

  return (
    <section className="card section">
      <div className="section-head">
        <h2>Elders</h2>
      </div>
      <Notice message={message} />

      {elders === undefined && <p className="loading">Loading…</p>}
      {elders?.length === 0 && <p className="muted">No one added yet. Add the first person below.</p>}
      <ul className="list">
        {elders?.map((elder) => (
          <li key={elder._id} className="list-row">
            <div>
              <strong>{elder.name}</strong>{" "}
              <span className="muted small">
                {elder.phoneMasked} · {elder.language}
              </span>
              {elder.expertise.length > 0 && (
                <div className="tags">
                  {elder.expertise.map((t) => (
                    <span key={t} className="tag">
                      {t}
                    </span>
                  ))}
                </div>
              )}
              {elder.bio && <p className="muted small">{elder.bio}</p>}
            </div>
            <button
              className="btn"
              disabled={busy !== null}
              onClick={() =>
                run(`call-${elder._id}`, () => backend.callElder(elder._id), () =>
                  `Calling ${elder.name}…`,
                )
              }
            >
              {busy === `call-${elder._id}` ? "Calling…" : "Call now"}
            </button>
          </li>
        ))}
      </ul>

      <form className="form" onSubmit={submit}>
        <h3>Add someone</h3>
        <div className="form-grid">
          <label>
            Name
            <input
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Rosa Martínez"
            />
          </label>
          <label>
            Phone (E.164)
            <input
              required
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
              placeholder="+15551234567"
              pattern="\+[1-9]\d{6,14}"
              title="Start with + and the country code, digits only"
            />
          </label>
          <label>
            Expertise (comma-separated)
            <input
              value={form.expertise}
              onChange={(e) => setForm({ ...form, expertise: e.target.value })}
              placeholder="cooking, gardening, raising kids"
            />
          </label>
          <label>
            Language
            <select
              value={form.language}
              onChange={(e) => setForm({ ...form, language: e.target.value })}
            >
              {LANGUAGES.map((l) => (
                <option key={l.value} value={l.value}>
                  {l.label}
                </option>
              ))}
            </select>
          </label>
          <label className="span-2">
            Short bio (optional)
            <textarea
              rows={2}
              value={form.bio}
              onChange={(e) => setForm({ ...form, bio: e.target.value })}
              placeholder="Retired mechanic, 40 years fixing cars in Oakland."
            />
          </label>
        </div>
        <button className="btn btn-primary" type="submit" disabled={busy !== null}>
          {busy === "create" ? "Adding…" : "Add elder"}
        </button>
      </form>
    </section>
  );
}
