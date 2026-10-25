// Back from Threads / X: the backend's OAuth callback sends him to SIGNUP_SITE_URL with
// ?connected=<platform> or ?connect_error=<code>&platform=<platform> (never a token). App.jsx
// reads it once at start-up, removes it from the address bar, hands it to the tab that started
// the trip (below), or else opens setup again; OAuthConnect.jsx shows the result.

export const OAUTH_PLATFORM_IDS = ['threads', 'x']

let pending = null

/** Read and remove the return params. -> { platform, ok, code? } | null */
export function readOAuthReturn() {
  try {
    const params = new URLSearchParams(window.location.search)
    const connected = params.get('connected')
    const error = params.get('connect_error')
    if (!connected && !error) return null
    const platform = connected || params.get('platform')
    ;['connected', 'connect_error', 'platform'].forEach((k) => params.delete(k))
    const rest = params.toString()
    window.history.replaceState(null, '', window.location.pathname + (rest ? `?${rest}` : '') + window.location.hash)
    if (!OAUTH_PLATFORM_IDS.includes(platform)) return null
    pending = connected ? { platform, ok: true } : { platform, ok: false, code: String(error).slice(0, 40) }
    return pending
  } catch {
    return null
  }
}

/** The return read at start-up, once (OAuthConnect shows it, then it's gone). */
export function takeOAuthReturn() {
  const back = pending
  pending = null
  return back
}

// ---------- new-tab trip ----------
// "Connect X" opens the platform in a new tab (OAuthConnect.jsx), so the page he started on stays
// put. When the trip comes back in that new tab, it hands the result to the tab that started it
// (BroadcastChannel) and closes; that tab shows it. No answer (an old tab, or no BroadcastChannel):
// the new tab carries on as before (App.jsx).

const CHANNEL = 'fp-oauth'
const ACK_WAIT_MS = 800

/** A result from another tab, checked like readOAuthReturn's. */
function clean(back) {
  if (!back || !OAUTH_PLATFORM_IDS.includes(back.platform)) return null
  return back.ok ? { platform: back.platform, ok: true } : { platform: back.platform, ok: false, code: String(back.code || 'failed').slice(0, 40) }
}

/** The tab that started the trip: call onResult({ platform, ok, code? }) when it comes back. -> stop() */
export function listenOAuthResult(onResult) {
  if (typeof BroadcastChannel === 'undefined') return () => {}
  const channel = new BroadcastChannel(CHANNEL)
  channel.onmessage = (e) => {
    const back = e.data?.type === 'result' ? clean(e.data.back) : null
    if (!back) return
    channel.postMessage({ type: 'ack' })
    onResult(back)
  }
  return () => channel.close()
}

/** The tab the trip came back in: give the result to the tab that started it. -> true if one took it. */
export function handOffOAuthResult(back) {
  return new Promise((resolve) => {
    if (typeof BroadcastChannel === 'undefined') return resolve(false)
    const channel = new BroadcastChannel(CHANNEL)
    const finish = (taken) => {
      clearTimeout(timer)
      channel.close()
      if (taken) pending = null // shown in the other tab, not here
      resolve(taken)
    }
    const timer = setTimeout(() => finish(false), ACK_WAIT_MS)
    channel.onmessage = (e) => {
      if (e.data?.type === 'ack') finish(true)
    }
    channel.postMessage({ type: 'result', back })
  })
}
