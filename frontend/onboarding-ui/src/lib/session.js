// Who is signed in on this device. Sign-in is not real yet (the text code is a mock in api.js),
// so this remembers the phone they typed, the elderId sign-up returned, and the sign-up token
// (signup:register). Every call about his sign-up or his page sends the token; the elderId
// alone is not enough. Real auth will replace both with a session.

const KEY = 'fp-session'
export const SETUP_KEY = 'fp-setup' // setup progress (pages/setup/Onboarding.jsx)
export const OAUTH_KEY = 'fp-oauth' // OAuth platforms connected during setup (OAuthConnect.jsx)

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
  return next
}

export function clearSession() {
  try {
    localStorage.removeItem(KEY)
    sessionStorage.removeItem('fp-call')
    sessionStorage.removeItem(SETUP_KEY)
    sessionStorage.removeItem(OAUTH_KEY)
  } catch {
    /* nothing to clear */
  }
}
