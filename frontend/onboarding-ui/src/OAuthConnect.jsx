import { useEffect, useState } from 'react'
import { signupApi } from './api'
import { Button, ErrorBanner, Note } from './ui'

// "Connect with ..." buttons for OAuth platforms (convex/signup.ts startOAuthConnect).
// Click -> the backend gives the platform's consent URL -> the browser goes there -> the
// platform sends him to convex /oauth/<id>/callback -> back here with ?connected=<id> or
// ?connect_error=<code>&platform=<id>. Sign-up progress survives the trip in sessionStorage
// (App.jsx); which platforms are connected is kept under OAUTH_KEY. No token ever reaches this page.

/** Add X here: { id: 'x', name: 'X', Icon: XIcon }. Labels come from t.sOAuth. */
export const OAUTH_PLATFORMS = [{ id: 'threads', name: 'Threads', Icon: ThreadsIcon }]

export const OAUTH_KEY = 'onboarding-v2-oauth'

const loadConnected = () => {
  try {
    return JSON.parse(sessionStorage.getItem(OAUTH_KEY)) || {}
  } catch {
    return {}
  }
}
const saveConnected = (value) => {
  try {
    sessionStorage.setItem(OAUTH_KEY, JSON.stringify(value))
  } catch {
    /* storage unavailable */
  }
}

/** ?connected= / ?connect_error= from the callback, read once and removed from the address bar. */
function readReturn() {
  try {
    const params = new URLSearchParams(window.location.search)
    const connected = params.get('connected')
    const error = params.get('connect_error')
    if (!connected && !error) return null
    const known = (id) => OAUTH_PLATFORMS.some((p) => p.id === id)
    const platform = connected || params.get('platform')
    ;['connected', 'connect_error', 'platform'].forEach((k) => params.delete(k))
    const rest = params.toString()
    window.history.replaceState(null, '', window.location.pathname + (rest ? `?${rest}` : '') + window.location.hash)
    if (!known(platform)) return null
    return connected ? { platform, ok: true } : { platform, ok: false, code: error }
  } catch {
    return null
  }
}

export function OAuthConnect({ t, elderId, token }) {
  const [connected, setConnected] = useState(loadConnected)
  const [notice, setNotice] = useState(null) // { platform, ok, code? }
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    const back = readReturn()
    if (!back) return
    setNotice(back)
    if (back.ok) {
      setConnected((prev) => {
        const next = { ...prev, [back.platform]: true }
        saveConnected(next)
        return next
      })
    }
  }, [])

  async function connect(id) {
    setError('')
    setNotice(null)
    if (!elderId || !token) {
      setError(t.errors.NOT_FOUND)
      return
    }
    setBusy(id)
    try {
      const res = await signupApi.startOAuthConnect(elderId, token, id)
      if (res?.ok && /^https:\/\//.test(res.url || '')) {
        window.location.assign(res.url) // progress is already in sessionStorage
        return
      }
      setError(t.sOAuth.errors[res?.error] || t.sOAuth.errors.failed)
    } catch (err) {
      setError(t.errors[err.code] || t.sOAuth.errors.failed)
    }
    setBusy('')
  }

  const nameOf = (id) => OAUTH_PLATFORMS.find((p) => p.id === id)?.name || id

  return (
    <div className="flex flex-col gap-3">
      {notice?.ok && <Note>{t.sOAuth.connected(nameOf(notice.platform))}</Note>}
      {notice && !notice.ok && <ErrorBanner>{t.sOAuth.errors[notice.code] || t.sOAuth.errors.failed}</ErrorBanner>}
      <ErrorBanner>{error}</ErrorBanner>
      {OAUTH_PLATFORMS.map(({ id, name, Icon }) =>
        connected[id] ? (
          <p key={id} className="flex items-center gap-3 text-lg font-bold text-tinta-900">
            <Icon />
            {t.sOAuth.done(name)}
          </p>
        ) : (
          <Button key={id} variant="secondary" icon={<Icon />} disabled={Boolean(busy)} onClick={() => connect(id)}>
            {busy === id ? t.sOAuth.opening(name) : t.sOAuth.connect(name)}
          </Button>
        ),
      )}
      <p className="text-lg">{t.sOAuth.note}</p>
    </div>
  )
}

export function ThreadsIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true">
      <rect width="24" height="24" rx="5" fill="#000" />
      <text x="12" y="17" textAnchor="middle" fontSize="15" fontWeight="700" fontFamily="Arial, sans-serif" fill="#fff">
        @
      </text>
    </svg>
  )
}
