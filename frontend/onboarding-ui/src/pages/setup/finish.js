// Setup's two saves. Review's button: saveSetup (register once, then host + weekly slot). The
// accounts step's Finish: placeCall. register gives a sign-up token that every later call needs;
// a number that's already signed up gets no token (ALREADY_SIGNED_UP), so a retry after a later
// step failed reuses the elderId + token saved on this device instead of registering again.
import { accountApi, coded, signupApi } from '../../api'
import { browserTimezone } from '../../copy'
import { loadSession, saveSession } from '../../lib/session'
import { saveCallId } from '../../lib/useCallStatus'

/** Ring them now. -> { callId } or { reason: 'disabled' | 'rate_limited' | 'already_onboarded' | 'failed' }. Never throws. */
export async function placeCall(elderId, token) {
  try {
    const res = await signupApi.requestCall(elderId, token)
    if (res?.callId) {
      saveCallId(res.callId)
      return { callId: res.callId }
    }
    return { reason: res?.reason || 'failed' }
  } catch (e) {
    console.error('requestCall failed', e.code || 'error')
    return { reason: 'failed' }
  }
}

/** -> { elderId, token }. Throws an api.js coded error (Review shows errorText(e)). */
export async function saveSetup({ name, phone, language, hostId, callDay, callHour }) {
  const saved = loadSession()
  let { elderId, token } = saved
  if (!elderId || !token || saved.phone !== phone) {
    const res = await signupApi.register(name.trim(), phone, language)
    if (!res?.ok) throw coded('ALREADY_SIGNED_UP')
    elderId = res.elderId
    token = res.token
    saveSession({ phone, elderId, token })
    saveCallId(null) // forget a call from an earlier visit
  }
  await signupApi.setCharacter(elderId, token, hostId)
  await accountApi.setSchedule(elderId, token, callDay, callHour, browserTimezone())
  return { elderId, token }
}
