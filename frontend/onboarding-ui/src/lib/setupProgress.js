// Setup progress (pages/setup/Onboarding.jsx): { data, step, elderId?, result? }.
// Before Review saves the sign-up it lives in this tab (sessionStorage). Once there's an elderId
// it is also kept in localStorage under that elderId, so the Threads / X round trip survives a
// new tab, a refresh on Done shows Done again (step 7 + result), and his page can offer
// "Finish setup" (unfinishedSetup). Never the app password or the sign-up token (lib/session.js).
import { SETUP_KEY, loadSession } from './session'

export const ACCOUNTS_STEP = 6
export const DONE_STEP = 7
const byElder = (elderId) => `${SETUP_KEY}:${elderId}`

// window.localStorage itself can throw (blocked site data), so it is only touched inside try.
const local = () => window.localStorage
const tabStore = () => window.sessionStorage

function read(store, key) {
  try {
    const saved = JSON.parse(store().getItem(key))
    if (!saved || typeof saved !== 'object' || !saved.data || typeof saved.data !== 'object') return null
    const step = Number(saved.step)
    if (!(step >= 1 && step <= DONE_STEP)) return null
    if (step >= ACCOUNTS_STEP && !saved.elderId) return { ...saved, step: ACCOUNTS_STEP - 1 } // 6-7 need the sign-up: back to Review
    if (step === DONE_STEP && (!saved.result || typeof saved.result !== 'object')) return null
    return { ...saved, step }
  } catch {
    return null
  }
}

/** Progress for whoever is signed in on this device, or null. */
export function loadProgress() {
  const { elderId, token } = loadSession()
  const signedUp = Boolean(elderId && token)
  const tab = read(tabStore, SETUP_KEY)
  if (tab?.elderId && signedUp && tab.elderId === elderId) return tab
  const mine = signedUp ? read(local, byElder(elderId)) : null
  if (mine && mine.elderId === elderId) return mine
  return tab && !tab.elderId ? tab : null // before the sign-up was saved (no elderId yet)
}

export function saveProgress(value) {
  try {
    tabStore().setItem(SETUP_KEY, JSON.stringify(value))
    if (value.elderId) local().setItem(byElder(value.elderId), JSON.stringify(value))
  } catch {
    /* storage unavailable: progress just won't survive a refresh */
  }
}

/** True when this sign-up stopped at step 6 (accounts) and never finished. */
export function unfinishedSetup(elderId) {
  if (!elderId) return false
  const saved = read(local, byElder(elderId))
  return Boolean(saved && saved.elderId === elderId && saved.step === ACCOUNTS_STEP)
}
