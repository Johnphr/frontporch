// Setup's two saves. Review's button: saveSetup (register once, then host + weekly slot). The
// accounts step's Finish: placeCall. register gives a sign-up token that every later call needs;
// a number that's already signed up gets no token (ALREADY_SIGNED_UP), so a retry after a later
// step failed (or a sign-in again after signing out) reuses the elderId + token saved on this
// device instead of registering again.
import { accountApi, coded, signupApi } from '../../api'
import { browserTimezone } from '../../copy'
import { forgetDevice, knownSignup, loadSession, saveSession } from '../../lib/session'
import { saveCallId } from '../../lib/useCallStatus'

/** Ring them now. -> { callId } or { reason: 'disabled' | 'rate_limited' | 'already_onboarded' | 'failed' }. Never throws. */
export async function placeCall(elderId, token) {
  try {
    const res = await signupApi.requestCall(elderId, token)
    if (res?.ok === true && res.callId) {
      saveCallId(res.callId)
      return { callId: res.callId }
    }
    return { reason: res?.reason || 'failed' }
  } catch (e) {
    console.error('requestCall failed', e.code || 'error')
    return { reason: 'failed' }
  }
}

/** This device's sign-up for that phone (this session, else a known device), or null. */
function reusableSignup(phone) {
  const s = loadSession()
  if (s.elderId && s.token && s.phone === phone) return { elderId: s.elderId, token: s.token }
  const known = knownSignup(phone)
  return known ? { elderId: known.elderId, token: known.token } : null
}

async function saveChoices({ elderId, token }, { hostId, callDay, callHour }) {
  await signupApi.setCharacter(elderId, token, hostId)
  await accountApi.setSchedule(elderId, token, callDay, callHour, browserTimezone())
}

/**
 * -> { elderId, token }. Throws an api.js coded error (Review shows errorText(e)).
 * A saved sign-up the backend no longer knows (NOT_FOUND: row deleted, or its token no longer
 * matches) is dropped and the number registered once, instead of failing on every try.
 */
export async function saveSetup({ name, phone, language, hostId, callDay, callHour }) {
  const choices = { hostId, callDay, callHour }
  const reused = reusableSignup(phone)
  if (reused) {
    try {
      await saveChoices(reused, choices)
      saveSession({ phone, ...reused })
      return reused
    } catch (e) {
      if (e.code !== 'NOT_FOUND') throw e
      forgetDevice(reused.elderId)
    }
  }
  const res = await signupApi.register(name.trim(), phone, language)
  if (!res?.ok) throw coded('ALREADY_SIGNED_UP')
  const signup = { elderId: res.elderId, token: res.token }
  saveSession({ phone, ...signup })
  saveCallId(null) // forget a call from an earlier visit
  await saveChoices(signup, choices)
  return signup
}
