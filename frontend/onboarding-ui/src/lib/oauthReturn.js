// Back from Threads / X: the backend's OAuth callback sends him to SIGNUP_SITE_URL with
// ?connected=<platform> or ?connect_error=<code>&platform=<platform> (never a token). App.jsx
// reads it once at start-up, removes it from the address bar, and opens setup again;
// OAuthConnect.jsx shows the result.

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
