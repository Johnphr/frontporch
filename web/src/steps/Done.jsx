import { BigMarigold } from '../Scene'
import { Button, ErrorBanner, Note, ScreenHeader } from '../ui'

// Done: ask for a call now, or go back and change who calls.
// callResult: null | 'ok' | 'disabled' | 'rate_limited' | 'failed'
export default function Done({ t, headingRef, busy, error, characterName, linkedin, callResult, onCallNow, onChangeCaller }) {
  const callError = callResult && callResult !== 'ok' ? t.callErrors[callResult] || t.callErrors.failed : ''
  return (
    <>
      <BigMarigold className="h-24 w-24 self-center" />
      <ScreenHeader headingRef={headingRef} title={t.done.title} lead={t.done.lead} />
      <Note>
        {characterName ? `${t.done.caller(characterName)} ` : ''}
        {linkedin === 'saved' ? t.done.linkedinYes : t.done.linkedinNo}
      </Note>
      <div className="flex-1" />
      <div aria-live="polite" className="flex flex-col gap-4">
        {callResult === 'ok' && <Note>{t.done.callOk}</Note>}
        <ErrorBanner>{callError || error}</ErrorBanner>
      </div>
      <div className="flex flex-col gap-4">
        <Button onClick={onCallNow} disabled={busy}>
          {busy ? t.done.calling : t.done.callNow}
        </Button>
        <Button variant="secondary" onClick={onChangeCaller} disabled={busy}>
          {t.done.changeCaller}
        </Button>
      </div>
    </>
  )
}
