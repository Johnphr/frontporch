// Who is signed in on this device: the phone they typed, the elderId the backend returned, the
// sign-up token (signup:register, or a new one from signup:signIn) and his family code. Every
// call about his sign-up or his page sends the token; the elderId alone is not enough.
//
// Signing out must not lose the token: every complete { phone, elderId, token, familyCode? } is
// also kept under KNOWN_KEY ("known device"), and the same phone signing in again on this device
// gets it back without the code (SignIn.jsx, finish.js). On another device he signs in with his
// phone + family code (signup:signIn), which gives a new token and signs the old device out. A
// sign-up the backend no longer knows (NOT_FOUND) is dropped from both (forgetDevice).

const KEY = 'fp-session'
const KNOWN_KEY = 'fp-known' // [{ phone, elderId, token, familyCode? }], newest first
const KNOWN_MAX = 5
export const SETUP_KEY = 'fp-setup' // setup progress (lib/setupProgress.js)
export const OAUTH_KEY = 'fp-oauth' // OAuth platforms connected during setup (OAuthConnect.jsx)
export const OAUTH_FROM_KEY = 'fp-oauth-from' // 'setup' | 'home': where a Threads / X trip started

const complete = (s) =>
  Boolean(s && typeof s.phone === 'string' && s.phone && typeof s.elderId === 'string' && s.elderId && typeof s.token === 'string' && s.token)

/** { phone?: string (E.164), elderId?: string, token?: string, familyCode?: string } — empty object when nobody is signed in. */
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
  const { phone, elderId, token, familyCode } = session
  writeKnown([{ phone, elderId, token, ...(familyCode ? { familyCode } : {}) }, ...readKnown().filter((k) => k.phone !== phone && k.elderId !== elderId)])
}

/** The sign-up this device made (or signed in to) for a phone, or null. */
export function knownSignup(phone) {
  return readKnown().find((k) => k.phone === phone) || null
}

/** He started over with this phone: nothing saved for it on this device is good any more. */
export function forgetPhone(phone) {
  writeKnown(readKnown().filter((k) => k.phone !== phone))
  if (loadSession().phone === phone) {
    try {
      localStorage.removeItem(KEY)
    } catch {
      /* storage unavailable */
    }
  }
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
