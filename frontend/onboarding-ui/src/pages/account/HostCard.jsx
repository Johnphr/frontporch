// "Your host" card on the Home tab: all hosts as big radio cards, then an in-page
// "Switch to …?" confirm before saving.
import { useState } from 'react'
import { signupApi } from '../../api'
import { HostAvatar } from '../../art/hosts'
import { HOSTS, errorText } from '../../copy'
import { HOME } from '../../copy/account'
import { Button, Card, ErrorText, cx } from '../../ui/controls'
import { QualityChips } from '../../ui/QualityChips'

/** current: a known host id (HomeTab maps old ids to a default first). */
export default function HostCard({ elderId, token, current, onSaved }) {
  const [picked, setPicked] = useState(current)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const changing = picked !== current
  const newLanguage = HOSTS[picked].language !== HOSTS[current].language ? HOSTS[picked].languageName : null

  const pick = (id) => {
    setPicked(id)
    setError('')
  }

  async function save() {
    setBusy(true)
    setError('')
    try {
      await signupApi.setCharacter(elderId, token, picked)
      onSaved(picked)
    } catch (e) {
      console.error('setCharacter failed', e.code || 'error')
      setError(errorText(e)) // keep their choice so they can try again
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card aria-labelledby="host-title">
      <h2 id="host-title" className="text-subhead">
        {HOME.hostTitle}
      </h2>
      <fieldset className="w-full min-w-0">
        <legend className="sr-only">{HOME.chooseHost}</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          {Object.entries(HOSTS).map(([id, host]) => (
            <label
              key={id}
              className={cx(
                'flex cursor-pointer flex-col items-center gap-2 rounded-card border-[3px] px-5 py-7 text-center transition-colors has-[:focus-visible]:outline has-[:focus-visible]:outline-4 has-[:focus-visible]:outline-offset-4 has-[:focus-visible]:outline-ink',
                picked === id ? 'border-rose bg-rose-wash' : 'border-line bg-white hover:border-rose',
              )}
            >
              <input type="radio" name="host" value={id} checked={picked === id} onChange={() => pick(id)} className="sr-only" />
              <HostAvatar id={id} />
              <span className="font-display text-[1.875rem] leading-tight">{host.name}</span>
              <span>{HOME.callsIn(host.languageName)}</span>
              <QualityChips qualities={host.qualities} className="justify-center" />
              <span className="text-sm text-muted">{host.blurb}</span>
              {current === id && (
                <span className="tag self-center">
                  {HOME.currentHost}
                </span>
              )}
            </label>
          ))}
        </div>
      </fieldset>
      {/* Live region stays mounted (sr-only when empty, so no extra gap) so the question is read out. */}
      <div aria-live="polite" className={changing ? 'w-full' : 'sr-only'}>
        {changing && (
          <div className="flex w-full flex-col gap-4 rounded-inset bg-wash p-6 motion-safe:animate-enter">
            <p className="font-display text-lg font-semibold leading-snug">{HOME.switchTo(HOSTS[picked].name, newLanguage)}</p>
            <ErrorText>{error}</ErrorText>
            <div className="flex flex-wrap items-center gap-x-5 gap-y-4">
              <Button small busy={busy} busyLabel={HOME.saving} onClick={save}>
                {HOME.save}
              </Button>
              <Button small variant="secondary" disabled={busy} onClick={() => pick(current)}>
                {HOME.cancel}
              </Button>
            </div>
          </div>
        )}
      </div>
    </Card>
  )
}
