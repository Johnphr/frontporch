import { useEffect, useState } from 'react'
import { signupApi } from './api'
import { BigMarigold } from './Scene'
import { Button, ErrorBanner, Note } from './ui'

// The last screen: "Call me now", then what is happening with that call, in plain words.
// requestCall returns a callId; signup:callStatus says where the call is (dialing, on the call,
// no answer, voicemail, ...) and whether "Try again" is allowed yet (convex/lib/callStatus.ts).
// Checks every 4 s for 3 min, then every 15 s, stops after 20 min or once the call is over, and
// pauses while the tab is hidden. When "Try again" opens later (retryAt), it checks once more then
// so the button appears without a reload. The callId survives a refresh (sessionStorage).

const CALL_KEY = 'onboarding-v2-call'
const LIVE = new Set(['dialing', 'in_call', 'wrapping_up'])
const GOOD = new Set(['dialing', 'in_call', 'wrapping_up', 'done'])
const FAST_MS = 4000
const SLOW_MS = 15000
const FAST_FOR_MS = 3 * 60_000
const STOP_AFTER_MS = 20 * 60_000

const loadCallId = () => {
  try {
    return sessionStorage.getItem(CALL_KEY)
  } catch {
    return null
  }
}
const saveCallId = (id) => {
  try {
    if (id) sessionStorage.setItem(CALL_KEY, id)
    else sessionStorage.removeItem(CALL_KEY)
  } catch {
    /* storage unavailable: the panel just won't survive a refresh */
  }
}

/** Polls signup:callStatus for one call. Returns { status, stopped, offline }. */
function useCallStatus(callId) {
  const [status, setStatus] = useState(null) // { state, canRetry, retryAt? }
  const [stopped, setStopped] = useState(false)
  const [offline, setOffline] = useState(false)

  useEffect(() => {
    if (!callId) return undefined
    setStatus(null)
    setStopped(false)
    setOffline(false)
    const started = Date.now()
    let timer
    let done = false
    let inFlight = false // a tab switch mid-check must not start a second polling chain
    const schedule = () => {
      const elapsed = Date.now() - started
      if (elapsed > STOP_AFTER_MS) {
        setStopped(true)
        return
      }
      timer = setTimeout(check, elapsed < FAST_FOR_MS ? FAST_MS : SLOW_MS)
    }
    async function check() {
      if (done || inFlight) return
      if (document.hidden) return schedule() // nobody is looking: try again later
      inFlight = true
      try {
        const next = await signupApi.callStatus(callId)
        if (done) return
        setOffline(false)
        setStatus(next)
        if (LIVE.has(next?.state)) schedule()
        else if (next?.retryAt) timer = setTimeout(check, Math.max(5000, next.retryAt - Date.now() + 1000))
      } catch (e) {
        if (done) return
        if (e.code === 'NETWORK') {
          setOffline(true)
          schedule()
        } else {
          // Unknown or bad call id, or a server error: don't spin on "checking", let him call again.
          setStatus({ state: 'trouble', canRetry: true })
        }
      } finally {
        inFlight = false
      }
    }
    check()
    const onVisible = () => {
      if (!document.hidden && !done) {
        clearTimeout(timer)
        check()
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      done = true
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [callId])

  return { status, stopped, offline }
}

export function DoneStep({ t, name, characterName, bluesky, connectedHandle, elderId, token, headingRef, headingClass, errorText, onStartOver }) {
  const [callId, setCallId] = useState(loadCallId)
  const [requestResult, setRequestResult] = useState(null) // i18n key in t.done when no call was placed
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const { status, stopped, offline } = useCallStatus(callId)

  // Too old to look up (3 h): forget it so "Call me now" comes back under the message.
  useEffect(() => {
    if (status?.state !== 'none') return
    saveCallId(null)
    setCallId(null)
  }, [status?.state])

  async function onCall() {
    setBusy(true)
    setError(null)
    setRequestResult(null)
    try {
      if (!elderId || !token) throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' })
      const res = await signupApi.requestCall(elderId, token)
      if (res?.callId) {
        saveCallId(res.callId)
        setCallId(res.callId)
        return
      }
      if (res?.reason === 'disabled') setRequestResult('callDisabled')
      else if (res?.reason === 'rate_limited') setRequestResult('callRateLimited')
      else if (res?.reason === 'already_onboarded') setRequestResult('callAlreadyDone')
      else setRequestResult('callFailed')
    } catch (e) {
      setError({ code: e.code || 'SERVER', message: e.message })
    } finally {
      setBusy(false)
    }
  }

  const state = status?.state
  const live = LIVE.has(state)
  const timeOf = (ms) => new Date(ms).toLocaleTimeString(t.htmlLang, { hour: 'numeric', minute: '2-digit' })
  // The button shows before the first call, and again once a failed call may be retried.
  const showCall = !callId || (!!status && !live && status.canRetry)

  let message = null
  if (callId && !status) message = <Note>{t.status.checking}</Note>
  else if (state) {
    const text = t.status[state] || t.status.trouble
    message = GOOD.has(state) ? <Note>{text}</Note> : <ErrorBanner>{text}</ErrorBanner>
  }
  let followUp = null
  if (status && !live && state !== 'done' && state !== 'none') {
    if (status.canRetry) followUp = <Note>{t.status.canRetry}</Note>
    else if (status.retryAt) followUp = <Note>{t.status.retryAt(timeOf(status.retryAt))}</Note>
    else followUp = <Note>{t.status.retryLater}</Note>
  }

  return (
    <>
      <BigMarigold className="h-24 w-24 self-center" />
      <header className="flex flex-col gap-3">
        <h1 ref={headingRef} tabIndex={-1} className={headingClass}>
          {t.done.title}
        </h1>
        <p>{name ? t.done.lead(name) : t.done.leadNoName}</p>
      </header>
      {characterName && <Note>{t.done.character(characterName)}</Note>}
      <Note>
        {bluesky === 'saved' && connectedHandle
          ? t.done.blueskyYes(connectedHandle)
          : bluesky === 'locked'
            ? t.done.blueskyLocked
            : t.done.blueskyNo}
      </Note>
      <div aria-live="polite" className="flex flex-col gap-4">
        {message}
        {followUp}
        {live && stopped && <Note>{t.status.stopped}</Note>}
        {offline && <Note>{t.status.offline}</Note>}
        {requestResult && <ErrorBanner>{t.done[requestResult]}</ErrorBanner>}
        <ErrorBanner>{errorText(error)}</ErrorBanner>
      </div>
      <div className="flex-1" />
      {showCall && (
        <Button onClick={onCall} disabled={busy}>
          {busy ? t.done.calling : callId ? t.status.tryAgain : t.done.call}
        </Button>
      )}
      <Button
        variant="quiet"
        onClick={() => {
          saveCallId(null)
          onStartOver()
        }}
      >
        {t.done.startOver}
      </Button>
    </>
  )
}
