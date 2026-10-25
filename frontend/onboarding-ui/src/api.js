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

/** His zone for the weekly call (the backend checks it, and falls back to his phone's country). */
function browserTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined
  } catch {
    return undefined
  }
}

export const signupApi = {
  /** [{ id, name, language: 'en' | 'es', description }] */
  listCharacters: () => call('query', 'listCharacters', {}),
  /**
   * New elder -> { ok: true, elderId, token } | { ok: false, reason: 'already_signed_up' }.
   * The token proves this browser made the sign-up: every later call needs it.
   */
  register: (name, phone, language) => call('action', 'register', { name, phone, language, timeZone: browserTimeZone() }),
  setCharacter: (elderId, token, characterId) => call('action', 'setCharacter', { elderId, token, characterId }),
  /**
   * { ok: true, handle } | { ok: false, error } with error one of: invalid_handle, not_app_password,
   * privileged_app_password, not_found, locked, rate_limited, busy, wrong_password, account_unavailable,
   * bluesky_busy, failed.
   * The app password is sent once and never kept here.
   */
  connectBluesky: (elderId, token, handle, appPassword) => call('action', 'connectBluesky', { elderId, token, handle, appPassword }),
  /**
   * OAuth connect (Threads; X later): { ok: true, url } (send the browser there) | { ok: false, error }
   * with error one of: not_found, locked, rate_limited, not_configured, failed.
   */
  startOAuthConnect: (elderId, token, platform) => call('action', 'startOAuthConnect', { elderId, token, platform }),
  /** { ok: true, callId } | { ok: false, reason: 'disabled' | 'rate_limited' | 'already_onboarded' | 'failed', message, callId? } */
  requestCall: (elderId, token) => call('action', 'requestCall', { elderId, token }),
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
 * Same rules as convex/lib/signupRules.ts (normalizeBlueskyHandle, normalizeAppPassword), so the
 * form can say "check this" before sending. The backend still decides.
 */
export function tidyBlueskyHandle(raw) {
  let text = (raw || '').trim().toLowerCase()
  if (!text || text.length > 300) return ''
  text = text.replace(/^(?:https?:\/\/)?(?:www\.)?bsky\.app\/profile\//, '').replace(/\/.*$/, '')
  text = text.replace(/^@/, '').replace(/\.$/, '')
  if (!text) return ''
  if (!text.includes('.')) text = `${text}.bsky.social`
  const labels = text.split('.')
  const ok =
    text.length <= 253 &&
    labels.length >= 2 &&
    labels.every((l) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l)) &&
    /^[a-z]/.test(labels[labels.length - 1])
  return ok ? text : ''
}

export function looksLikeAppPassword(raw) {
  return /^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/.test((raw || '').replace(/\s+/g, '').toLowerCase())
}
