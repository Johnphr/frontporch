import { useEffect, useState } from 'react'
import { useBackend } from '../backend'
import { Badge, Button, ErrorBanner, Note, ScreenHeader, cx } from '../ui'

const CARD =
  'flex w-full flex-col items-start gap-2 rounded-2xl border-2 bg-white p-5 text-left transition duration-150 ' +
  'hover:bg-lino-100 active:translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-60'

// Screen 3: choose who calls. Characters in the screen's language come first, but all are shown.
export default function Character({ t, lang, headingRef, busy, error, currentId, onChoose }) {
  const backend = useBackend()
  const [list, setList] = useState(null) // null while loading
  const [loadError, setLoadError] = useState(null) // error code
  const [attempt, setAttempt] = useState(0)
  const [pendingId, setPendingId] = useState(null)

  useEffect(() => {
    let alive = true
    setList(null)
    setLoadError(null)
    backend.listCharacters().then(
      (rows) => alive && setList(Array.isArray(rows) ? rows : []),
      (e) => alive && setLoadError(e.code || 'SERVER'),
    )
    return () => {
      alive = false
    }
  }, [backend, attempt])

  async function choose(c) {
    setPendingId(c.id)
    await onChoose(c)
    setPendingId(null)
  }

  const sorted = list && [...list].sort((a, b) => (b.language === lang) - (a.language === lang))

  return (
    <>
      <ScreenHeader headingRef={headingRef} title={t.character.title} lead={t.character.lead} />

      {!list && !loadError && (
        <p role="status" className="text-lg text-tinta-700">
          {t.loading}
        </p>
      )}

      {loadError && (
        <div className="flex flex-col gap-4">
          <ErrorBanner>{t.errors[loadError] || t.errors.SERVER}</ErrorBanner>
          <Button variant="secondary" onClick={() => setAttempt((n) => n + 1)}>
            {t.retry}
          </Button>
        </div>
      )}

      {sorted && sorted.length === 0 && <Note>{t.character.empty}</Note>}

      {sorted && sorted.length > 0 && (
        <ul className="flex flex-col gap-4">
          {sorted.map((c) => {
            const chosen = c.id === currentId
            return (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => choose(c)}
                  disabled={busy}
                  aria-pressed={chosen}
                  className={cx(CARD, chosen ? 'border-rosa-600 ring-4 ring-rosa-600/30' : 'border-tinta-700')}
                >
                  <span className="flex w-full flex-wrap items-center justify-between gap-3">
                    <span className="font-display text-3xl font-bold text-tinta-900">{c.name}</span>
                    {chosen && <Badge>{t.character.chosen}</Badge>}
                  </span>
                  <span className="text-lg text-tinta-900">{c.description}</span>
                  <span className="text-lg font-bold text-talavera-700">
                    {c.language === 'es' ? t.character.langEs : t.character.langEn}
                  </span>
                  {pendingId === c.id && <span className="text-lg font-bold text-rosa-700">{t.working}</span>}
                </button>
                {/* Room for a voice-sample play button once real voices exist. */}
              </li>
            )
          })}
        </ul>
      )}

      <ErrorBanner>{error}</ErrorBanner>
    </>
  )
}
