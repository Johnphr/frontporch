// Where is the call requestCall placed? Polls signup:callStatus (states: convex/lib/callStatus.ts).
// Checks every 4 s for 3 min, then every 15 s, stops after 20 min or once the call is over, and
// pauses while the tab is hidden. When "Try again" opens later (retryAt), it checks once more then
// so the button appears without a reload. The callId survives a refresh (sessionStorage).
import { useEffect, useState } from 'react'
import { signupApi } from '../api'

const CALL_KEY = 'fp-call'
export const LIVE = new Set(['dialing', 'in_call', 'wrapping_up'])
export const GOOD = new Set(['dialing', 'in_call', 'wrapping_up', 'done'])
const FAST_MS = 4000
const SLOW_MS = 15000
const FAST_FOR_MS = 3 * 60_000
const STOP_AFTER_MS = 20 * 60_000

export const loadCallId = () => {
  try {
    return sessionStorage.getItem(CALL_KEY)
  } catch {
    return null
  }
}
export const saveCallId = (id) => {
  try {
    if (id) sessionStorage.setItem(CALL_KEY, id)
    else sessionStorage.removeItem(CALL_KEY)
  } catch {
    /* storage unavailable: the panel just won't survive a refresh */
  }
}

/** Polls signup:callStatus for one call. Returns { status, stopped, offline }. */
export function useCallStatus(callId) {
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
