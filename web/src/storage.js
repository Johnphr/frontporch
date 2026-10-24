// Browser storage helpers. Storage can be missing or blocked, so every access is guarded.

const KEY = 'onboarding-v2'
const ELDER_KEY = 'frontporch-elder-id'

// Progress survives a refresh. The password and the SMS code are never stored.
export const loadProgress = () => {
  try {
    return JSON.parse(sessionStorage.getItem(KEY)) || {}
  } catch {
    return {}
  }
}

export const saveProgress = (state) => {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(state))
  } catch {
    /* storage unavailable: the flow still works */
  }
}

// The elder id is kept across visits as a convenience; React state is the source of truth.
export const loadElderId = () => {
  try {
    return localStorage.getItem(ELDER_KEY) || null
  } catch {
    return null
  }
}

export const saveElderId = (id) => {
  try {
    localStorage.setItem(ELDER_KEY, id)
  } catch {
    /* storage unavailable */
  }
}
