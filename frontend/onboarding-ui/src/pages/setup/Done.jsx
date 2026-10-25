// Last screen: "Oscar is calling … now" (a call was placed) or "Oscar will call … every Tuesday",
// then where that call is (useCallStatus), "Try again" when the status allows it, his family code
// (shown here once; Home has it behind a button), what to expect, and the way to their page.
import { useState } from 'react'
import { CALL_STATUS_BY_LANG, FAMILY_CODE_BY_LANG, dayName, formatHour, spacedCode } from '../../copy'
import { SETUP } from '../../copy/setup'
import { showPhone } from '../../copy/signin'
import { go } from '../../lib/route'
import { loadSession } from '../../lib/session'
import { GOOD, LIVE, useCallStatus } from '../../lib/useCallStatus'
import { CheckMark, RingingArt } from '../../art/setup'
import { CallUsLine } from '../../ui/CallUsLine'
import { branded } from '../../ui/Brand'
import { Button, Card, ErrorText } from '../../ui/controls'
import { placeCall } from './finish'

// requestCall's reason when no call was placed -> CALL_STATUS sentence
const REASON = {
  disabled: 'callDisabled',
  rate_limited: 'callRateLimited',
  already_onboarded: 'callAlreadyDone',
  failed: 'callFailed',
}

function Note({ children }) {
  return <p className="rounded-inset bg-wash px-5 py-4 text-sm motion-safe:animate-enter">{children}</p>
}

/** The call's current state at reading size. While the call is live a rose dot ripples, so "it is
 *  happening" shows at a glance; each new state eases in (keyed by state). */
function LiveStatus({ live, children }) {
  return (
    <p className="flex items-center gap-4 rounded-inset border border-line bg-white px-5 py-4 font-bold leading-snug motion-safe:animate-enter">
      <span aria-hidden="true" className="relative grid h-4 w-4 flex-none place-items-center">
        {live && <span className="absolute inset-0 rounded-full bg-rose motion-safe:animate-beacon" />}
        <span className={`relative h-3.5 w-3.5 rounded-full ${live ? 'bg-rose' : 'bg-ink'}`} />
      </span>
      {children}
    </p>
  )
}

const timeOf = (ms, lang) => new Date(ms).toLocaleTimeString(lang === 'es' ? 'es-MX' : 'en-US', { hour: 'numeric', minute: '2-digit' })

/** What is happening with the call (read out as it changes), and whether "Try again" may show. */
function useCallPanel(callId, reason, CALL_STATUS, lang) {
  const { status, stopped, offline } = useCallStatus(callId)
  const state = status?.state
  const live = LIVE.has(state)

  let message = null
  if (callId && !status) message = <LiveStatus live>{CALL_STATUS.checking}</LiveStatus>
  else if (state) {
    const text = CALL_STATUS[state] || CALL_STATUS.trouble
    message = GOOD.has(state) ? (
      <LiveStatus key={state} live={live}>
        {text}
      </LiveStatus>
    ) : (
      <ErrorText key={state}>{text}</ErrorText>
    )
  }
  let followUp = null
  if (status && !live && state !== 'done' && state !== 'none') {
    if (status.canRetry) followUp = <Note>{CALL_STATUS.canRetry}</Note>
    else if (status.retryAt) followUp = <Note>{CALL_STATUS.retryAt(timeOf(status.retryAt, lang))}</Note>
    else followUp = <Note>{CALL_STATUS.retryLater}</Note>
  }
  const reasonText = reason && CALL_STATUS[REASON[reason] || 'callFailed']

  return {
    canRetry: !!callId && !!status && !live && !!status.canRetry,
    panel: (
      <div aria-live="polite" className="flex w-full flex-col gap-4 empty:hidden">
        {message}
        {followUp}
        {live && stopped && <Note>{CALL_STATUS.stopped}</Note>}
        {offline && <Note>{CALL_STATUS.offline}</Note>}
        {reasonText && (reason === 'failed' ? <ErrorText>{reasonText}</ErrorText> : <Note>{reasonText}</Note>)}
      </div>
    ),
  }
}

/** His 6-digit family code in a calm card: one digit at a time, with what it's for. */
export function FamilyCodeCard({ code, lang = 'en', id = 'family-code-title' }) {
  const F = FAMILY_CODE_BY_LANG[lang] || FAMILY_CODE_BY_LANG.en
  if (!code) return null
  return (
    <section aria-labelledby={id} className="flex w-full flex-col gap-3 rounded-inset bg-wash px-5 py-5 motion-safe:animate-enter sm:px-6">
      <h2 id={id} className="text-sm font-bold uppercase tracking-[0.08em] text-muted">
        {F.title}
      </h2>
      <p className="font-display text-[2.5rem] leading-none tracking-[0.2em] [font-variant-numeric:tabular-nums]" aria-label={F.code(spacedCode(code))}>
        {spacedCode(code)}
      </p>
      <p>{F.lead}</p>
    </section>
  )
}

export default function Done({ words, lang = 'en', host, elderId, token, phone, callDay, callHour, headingRef, ...first }) {
  const CALL_STATUS = CALL_STATUS_BY_LANG[lang] || CALL_STATUS_BY_LANG.en
  const [familyCode] = useState(() => loadSession().familyCode || '')
  const [callId, setCallId] = useState(first.callId || null)
  const [reason, setReason] = useState(first.reason || null)
  const [busy, setBusy] = useState(false)
  const { canRetry, panel } = useCallPanel(callId, reason, CALL_STATUS, lang)

  const day = dayName(callDay)
  const time = formatHour(callHour)
  const calling = !!callId

  async function tryAgain() {
    setBusy(true)
    setReason(null)
    const res = await placeCall(elderId, token) // never throws
    if (res.callId) setCallId(res.callId)
    else setReason(res.reason)
    setBusy(false)
  }

  return (
    <Card className="shadow-card">
      <RingingArt className="w-full max-w-[22rem] self-center" />
      <h1 ref={headingRef} tabIndex={-1} className="text-title">
        {calling ? words.doneCalling(showPhone(phone)) : words.doneWeekly(day, time)}
      </h1>
      <p className="text-lg">{calling ? words.doneSubCalling : words.doneSubWeekly}</p>
      {panel}
      <CallUsLine host={host} />
      {canRetry && (
        <Button variant="secondary" busy={busy} busyLabel={SETUP.done.tryAgainBusy} onClick={tryAgain}>
          {CALL_STATUS.tryAgain}
        </Button>
      )}
      <FamilyCodeCard code={familyCode} lang={lang} />
      <h2 className="text-subhead">{SETUP.done.expect}</h2>
      <ul className="flex flex-col gap-5">
        {words.expect.map((line) => (
          <li key={line} className="flex items-start gap-4">
            <CheckMark />
            <span>{branded(line)}</span>
          </li>
        ))}
      </ul>
      <Button onClick={() => go('/home')}>{words.goHome}</Button>
    </Card>
  )
}
