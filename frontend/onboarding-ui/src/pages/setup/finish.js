// The "Finish" button on Review: save the sign-up, then ask for the first call.
// Steps 1-4 throw (Review shows errorText(e) and the button stays for a retry; register returns the
// same elder for the same phone, so a retry is safe). The call request never throws: no callId
// just means Done says why.
import { accountApi, signupApi } from '../../api'
import { browserTimezone } from '../../copy'
import { saveSession } from '../../lib/session'
import { saveCallId } from '../../lib/useCallStatus'

/** Ring them now. -> { callId } or { reason: 'disabled' | 'rate_limited' | 'already_onboarded' | 'failed' } */
export async function placeCall(elderId) {
  try {
    const res = await signupApi.requestCall(elderId)
    if (res?.callId) {
      saveCallId(res.callId)
      return { callId: res.callId }
    }
    return { reason: res?.reason || 'failed' }
  } catch (e) {
    console.error('requestCall failed', e)
    return { reason: 'failed' }
  }
}

/** -> { elderId, callId? , reason? } */
export async function finishSetup({ name, phone, language, hostId, callDay, callHour, linkedinUrl }) {
  const elderId = await signupApi.register(name.trim(), phone, language)
  await signupApi.setCharacter(elderId, hostId)
  await accountApi.setSchedule(elderId, callDay, callHour, browserTimezone())
  if (linkedinUrl) {
    try {
      await signupApi.setLinkedin(elderId, linkedinUrl)
    } catch (e) {
      if (e.code !== 'LINKEDIN_LOCKED') throw e // already set up from an earlier sign-up: fine
    }
  }
  saveSession({ phone, elderId })
  saveCallId(null) // forget a call from an earlier visit
  return { elderId, ...(await placeCall(elderId)) }
}
