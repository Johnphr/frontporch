// Who is signed in on this device. Sign-in is not real yet (no code or link is asked for),
// so this remembers the phone they typed, the elderId sign-up returned, and the sign-up token
// (signup:register). Every call about his sign-up or his page sends the token; the elderId
// alone is not enough. Real auth will replace both with a session.
//
// The backend hands a token out once (register), so signing out must not lose it: every
// complete { phone, elderId, token } is also kept under KNOWN_KEY ("known device"), and the
// same phone signing in again gets it back (SignIn.jsx, finish.js). A sign-up the backend no
// longer knows (NOT_FOUND) is dropped from both (forgetDevice).

const KEY = 'fp-session'
const KNOWN_KEY = 'fp-known' // [{ phone, elderId, token }], newest first
const KNOWN_MAX = 5
export const SETUP_KEY = 'fp-setup' // setup progress (lib/setupProgress.js)
export const OAUTH_KEY = 'fp-oauth' // OAuth platforms connected during setup (OAuthConnect.jsx)
export const OAUTH_FROM_KEY = 'fp-oauth-from' // 'setup' | 'home': where a Threads / X trip started

const complete = (s) =>
  Boolean(s && typeof s.phone === 'string' && s.phone && typeof s.elderId === 'string' && s.elderId && typeof s.token === 'string' && s.token)

/** { phone?: string (E.164), elderId?: string, token?: string } — empty object when nobody is signed in. */
export function loadSession() {
  try {
    const raw = localStorage.getItem(KEY)
    const data = raw ? JSON.parse(raw) : {}
    if (!data || typeof data !== 'object') return {}
    // A sign-up saved without its token (older version) can't be used: keep only the phone.
    if (data.elderId && !data.token) {
      const kept = typeof data.phone === 'string' ? { phone: data.phone } : {}
      localStorage.setItem(KEY, JSON.stringify(kept))
      return kept
    }
    return data
  } catch {
    return {}
  }
}

export function saveSession(patch) {
  const next = { ...loadSession(), ...patch }
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    /* storage unavailable: they stay signed in until the tab closes */
  }
  if (complete(next)) rememberDevice(next)
  return next
}

/** Sign out of this tab's session. The known-device entry stays, so he can sign in again. */
export function clearSession() {
  rememberDevice(loadSession())
  try {
    localStorage.removeItem(KEY)
    sessionStorage.removeItem('fp-call')
    sessionStorage.removeItem(SETUP_KEY)
    sessionStorage.removeItem(OAUTH_KEY)
  } catch {
    /* nothing to clear */
  }
}

function readKnown() {
  try {
    const list = JSON.parse(localStorage.getItem(KNOWN_KEY))
    return Array.isArray(list) ? list.filter(complete) : []
  } catch {
    return []
  }
}

function writeKnown(list) {
  try {
    if (list.length) localStorage.setItem(KNOWN_KEY, JSON.stringify(list.slice(0, KNOWN_MAX)))
    else localStorage.removeItem(KNOWN_KEY)
  } catch {
    /* storage unavailable */
  }
}

/** Keep a complete sign-up for this phone (newest first). Anything incomplete is ignored. */
export function rememberDevice(session) {
  if (!complete(session)) return
  const { phone, elderId, token } = session
  writeKnown([{ phone, elderId, token }, ...readKnown().filter((k) => k.phone !== phone && k.elderId !== elderId)])
}

/** The sign-up this device made for a phone, or null. */
export function knownSignup(phone) {
  return readKnown().find((k) => k.phone === phone) || null
}

/** The backend no longer knows this sign-up: drop it here too (session and known device). */
export function forgetDevice(elderId) {
  if (!elderId) return
  writeKnown(readKnown().filter((k) => k.elderId !== elderId))
  const s = loadSession()
  if (s.elderId === elderId) {
    try {
      localStorage.setItem(KEY, JSON.stringify(typeof s.phone === 'string' ? { phone: s.phone } : {}))
    } catch {
      /* storage unavailable */
    }
  }
}
