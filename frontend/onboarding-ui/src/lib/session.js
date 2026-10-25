// Who is signed in on this device. Sign-in is not real yet (the text code is a mock in api.js),
// so this only remembers the phone they typed and the elderId sign-up returned. Real auth will
// replace it with a session token.

const KEY = 'fp-session'

/** { phone?: string (E.164), elderId?: string } — empty object when nobody is signed in. */
export function loadSession() {
  try {
    const raw = localStorage.getItem(KEY)
    const data = raw ? JSON.parse(raw) : {}
    return data && typeof data === 'object' ? data : {}
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
  } catch {
    /* nothing to clear */
  }
}
