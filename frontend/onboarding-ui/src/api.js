// Sign-up API: the public functions in convex/signup.ts (repo root), called over HTTP.
// No codegen here: this UI is its own package, so functions are referenced by name with
// anyApi (signup:register etc.). Errors are thrown with a `code` that exists in i18n `errors`;
// a backend message we don't recognize is kept on `e.message` and shown as is.

import { ConvexHttpClient } from 'convex/browser'
import { anyApi } from 'convex/server'

const CONVEX_URL = (import.meta.env.VITE_CONVEX_URL || '').trim()

/** False when VITE_CONVEX_URL wasn't set at build time (the app shows a setup screen). */
export const isConfigured = /^https:\/\/.+/.test(CONVEX_URL)

let client = null
function convex() {
  if (!isConfigured) throw coded('SETUP')
  if (!client) client = new ConvexHttpClient(CONVEX_URL)
  return client
}

function coded(code, message) {
  const e = new Error(message || code)
  e.code = code
  return e
}

// Backend messages (convex/signup.ts, English only) -> our i18n codes, so Spanish users read Spanish.
const KNOWN = [
  [/enter your name/i, 'NAME_INVALID'],
  [/phone number/i, 'PHONE_INVALID'],
  [/linkedin profile link/i, 'LINKEDIN_INVALID'],
  [/linkedin is already set up/i, 'LINKEDIN_LOCKED'],
  [/sign-up not found/i, 'NOT_FOUND'],
  [/unknown character/i, 'CHARACTER_UNKNOWN'],
]

function translate(err) {
  if (err && err.code) return err
  // ConvexError from the backend: its user-facing text is in `data`.
  const data = err && typeof err.data === 'string' ? err.data : ''
  if (data) {
    const hit = KNOWN.find(([re]) => re.test(data))
    return coded(hit ? hit[1] : 'SERVER', data)
  }
  // fetch failed (offline, DNS, blocked): no response at all.
  if (err instanceof TypeError) return coded('NETWORK')
  return coded('SERVER')
}

async function call(kind, name, args) {
  try {
    return await convex()[kind](anyApi.signup[name], args)
  } catch (err) {
    throw translate(err)
  }
}

export const signupApi = {
  /** [{ id, name, language: 'en' | 'es', description }] */
  listCharacters: () => call('query', 'listCharacters', {}),
  /** New elder (or the existing one for this phone) -> elderId. */
  register: (name, phone, language) => call('mutation', 'register', { name, phone, language }),
  setCharacter: (elderId, characterId) => call('mutation', 'setCharacter', { elderId, characterId }),
  setLinkedin: (elderId, url) => call('mutation', 'setLinkedin', { elderId, url }),
  /** { ok: true, callId } | { ok: false, reason: 'disabled' | 'rate_limited' | 'already_onboarded' | 'failed', message, callId? } */
  requestCall: (elderId) => call('action', 'requestCall', { elderId }),
  /** { state, canRetry, retryAt? } for the call requestCall placed (convex/lib/callStatus.ts states) */
  callStatus: (callId) => call('query', 'callStatus', { callId }),
}

// SMS verification: the backend has none yet (App.jsx VERIFY_PHONE = false skips this step).
// Kept as a mock so the code screen still works when someone turns it on for a demo.
// Demo trigger: code "000000" -> BAD_CODE.
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
export const phoneVerification = {
  async sendCode(/* e164 */) {
    await wait(600)
  },
  async verifyCode(/* e164 */ _phone, code) {
    await wait(600)
    if (code === '000000') throw coded('BAD_CODE')
  },
}

/**
 * Same rule as convex/lib/signupRules.ts canonicalLinkedInProfileUrl, so the form can say
 * "check the link" before sending. The backend still decides.
 */
export function looksLikeLinkedInProfile(raw) {
  const text = (raw || '').trim()
  if (!text || text.length > 300) return false
  let url
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false
  if (!/^(?:(?:www|[a-z]{2,3})\.)?linkedin\.com$/i.test(url.hostname)) return false
  return /^\/in\/([A-Za-z0-9_%-]{2,100})(?:\/|$)/.test(url.pathname)
}
