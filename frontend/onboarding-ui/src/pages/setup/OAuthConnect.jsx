// "Connect Threads" / "Connect X" (convex/signup.ts startOAuthConnect). Click -> the backend gives
// the platform's consent URL -> the browser goes there -> the platform sends him to convex
// /oauth/<id>/callback -> back to the site with ?connected=<id> or ?connect_error=<code>&platform=<id>
// (lib/oauthReturn.js). Setup progress survives the trip (lib/setupProgress.js); which platforms
// setup connected is kept under OAUTH_KEY:<elderId> in localStorage (the trip may come back in a
// new tab), and OAUTH_FROM_KEY says whether it started in setup or on his page (App.jsx).
// No token from the platform ever reaches this page.
import { useEffect, useState } from 'react'
import { signupApi } from '../../api'
import { errorText } from '../../copy'
import { takeOAuthReturn } from '../../lib/oauthReturn'
import { OAUTH_FROM_KEY, OAUTH_KEY } from '../../lib/session'
import { CheckMark } from '../../art/setup'
import { Button, ErrorText } from '../../ui/controls'

export const OAUTH_PLATFORMS = [
  { id: 'threads', name: 'Threads', Icon: ThreadsIcon },
  { id: 'x', name: 'X', Icon: XIcon },
]

const connectedKey = (elderId) => `${OAUTH_KEY}:${elderId}`
const loadConnected = (elderId) => {
  try {
    const saved = JSON.parse(localStorage.getItem(connectedKey(elderId)))
    return saved && typeof saved === 'object' ? saved : {}
  } catch {
    return {}
  }
}
const saveConnected = (elderId, value) => {
  try {
    localStorage.setItem(connectedKey(elderId), JSON.stringify(value))
  } catch {
    /* storage unavailable */
  }
}
const noteStart = (from) => {
  try {
    localStorage.setItem(OAUTH_FROM_KEY, from)
  } catch {
    /* storage unavailable: App.jsx falls back to setup progress */
  }
}

/**
 * words = accountsCopy().oauth. beforeLeave() saves setup progress before the browser leaves.
 * `only`: platform ids to offer (his page offers the ones not connected); `labels` overrides
 * the button text per platform (e.g. "Reconnect Threads").
 */
export function OAuthConnect({ words, lang = 'en', elderId, token, beforeLeave, only, labels = {} }) {
  const shown = only ? OAUTH_PLATFORMS.filter((p) => only.includes(p.id)) : OAUTH_PLATFORMS
  // His page knows the real states (getProfile), so it doesn't read setup's saved list.
  const [connected, setConnected] = useState(() => (only || !elderId ? {} : loadConnected(elderId)))
  const [notice, setNotice] = useState(null) // { platform, ok, code? }
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    const back = takeOAuthReturn()
    if (!back) return
    setNotice(back)
    if (back.ok) {
      setConnected((prev) => {
        const next = { ...prev, [back.platform]: true }
        if (!only && elderId) saveConnected(elderId, next)
        return next
      })
    }
  }, [])

  async function connect(id) {
    setError('')
    setNotice(null)
    if (!elderId || !token) {
      setError(words.errors.not_found)
      return
    }
    setBusy(id)
    try {
      const res = await signupApi.startOAuthConnect(elderId, token, id)
      if (res?.ok && /^https:\/\//.test(res.url || '')) {
        beforeLeave?.()
        noteStart(only ? 'home' : 'setup')
        window.location.assign(res.url)
        return
      }
      setError(words.errors[res?.error] || words.errors.failed)
    } catch (err) {
      setError(err.code === 'NOT_FOUND' ? words.errors.not_found : err.code === 'NETWORK' ? errorText(err, lang) : words.errors.failed)
    }
    setBusy('')
  }

  const nameOf = (id) => OAUTH_PLATFORMS.find((p) => p.id === id)?.name || id

  return (
    <div className="flex w-full flex-col gap-4">
      <div aria-live="polite" className="flex w-full flex-col gap-4 empty:hidden">
        {notice?.ok && <p className="rounded-inset bg-sage-tint px-5 py-4 text-sm">{words.connected(nameOf(notice.platform))}</p>}
        {notice && !notice.ok && <ErrorText>{words.errors[notice.code] || words.errors.failed}</ErrorText>}
        <ErrorText>{error}</ErrorText>
      </div>
      {shown.map(({ id, name, Icon }) =>
        connected[id] ? (
          <p key={id} className="flex items-center gap-3 font-bold">
            <CheckMark />
            {words.done(name)}
          </p>
        ) : (
          <Button key={id} variant="secondary" busy={busy === id} busyLabel={words.opening(name)} disabled={Boolean(busy)} onClick={() => connect(id)}>
            <Icon />
            {labels[id] || words.connect(name)}
          </Button>
        ),
      )}
      <p className="text-sm text-muted">{words.note}</p>
      {shown.map(({ id }) =>
        words.notes?.[id] ? (
          <p key={id} className="text-sm text-muted">
            {words.notes[id]}
          </p>
        ) : null,
      )}
      {!only && <p className="text-sm text-muted">{words.reddit}</p>}
    </div>
  )
}

export function XIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect width="24" height="24" rx="5" fill="#3A2A2E" />
      <path d="M6 6l12 12M18 6L6 18" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  )
}

export function ThreadsIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect width="24" height="24" rx="5" fill="#3A2A2E" />
      <text x="12" y="17" textAnchor="middle" fontSize="15" fontWeight="700" fontFamily="Arial, sans-serif" fill="#fff">
        @
      </text>
    </svg>
  )
}
