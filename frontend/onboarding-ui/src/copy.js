// Shared interface copy (English only for now). Page-specific copy lives in src/copy/<page>.js.

export const HOSTS = {
  daniel: {
    name: 'Daniel',
    language: 'en',
    languageName: 'English',
    qualities: ['Kind', 'Easygoing', 'Good listener'],
    blurb: 'A friendly young voice who lets you set the pace.',
  },
  oscar: {
    name: 'Oscar',
    language: 'en',
    languageName: 'English',
    qualities: ['Funny', 'Down-to-earth', 'Nostalgic'],
    blurb: 'Relaxed and good-humored; loves hearing about the old days.',
  },
  victoria: {
    name: 'Victoria',
    language: 'en',
    languageName: 'English',
    qualities: ['Attentive', 'Courteous', 'Precise'],
    blurb: 'Polite and formal; asks careful, thoughtful questions.',
  },
  diana: {
    name: 'Diana',
    language: 'es',
    languageName: 'Spanish',
    qualities: ['Enthusiastic', 'Grateful', 'Humble'],
    blurb: 'Warm and energetic; speaks Latin American Spanish.',
  },
}

/** Default host for a call language (each host speaks one language). */
export const hostForLanguage = (language) => (language === 'es' ? 'diana' : 'daniel')

/** Host ids that speak a language. */
export const hostsForLanguage = (language) => Object.keys(HOSTS).filter((id) => HOSTS[id].language === language)

export const DAYS = [
  { id: 'monday', short: 'Mon', name: 'Monday' },
  { id: 'tuesday', short: 'Tue', name: 'Tuesday' },
  { id: 'wednesday', short: 'Wed', name: 'Wednesday' },
  { id: 'thursday', short: 'Thu', name: 'Thursday' },
  { id: 'friday', short: 'Fri', name: 'Friday' },
  { id: 'saturday', short: 'Sat', name: 'Saturday' },
  { id: 'sunday', short: 'Sun', name: 'Sunday' },
]

export const TIME_PRESETS = [
  { hour: 9, label: 'Morning' },
  { hour: 11, label: 'Late morning' },
  { hour: 15, label: 'Afternoon' },
  { hour: 18, label: 'Evening' },
]

/** 0-23 -> "11:00 AM" */
export const formatHour = (hour) => `${((hour + 11) % 12) + 1}:00 ${hour < 12 ? 'AM' : 'PM'}`

export const dayName = (id) => DAYS.find((d) => d.id === id)?.name ?? id

/** The browser's IANA timezone, e.g. "America/Chicago" (fallback for old browsers). */
export function browserTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Chicago'
  } catch {
    return 'America/Chicago'
  }
}

export const NAV = {
  brand: 'Front Porch',
  textSize: 'Text size',
  signIn: 'Sign in',
  signOut: 'Sign out',
  getStarted: 'Get your first call',
  skip: 'Skip to main content',
  back: 'Back',
  alsoSpanish: 'Also in Spanish with Diana.',
  builtAt: 'Built at Cal Hacks 13.0. Every post is labeled as written up with AI from a phone call.',
}

export const SETUP_NEEDED = {
  title: 'This page is not set up yet',
  lead: 'The page does not know which server to talk to. Whoever published it needs to set VITE_CONVEX_URL and publish it again.',
}

// Error codes thrown by api.js -> what we say.
export const ERRORS = {
  BAD_CODE: "That code doesn't match. Check the text message and try again, or send a new code.",
  NAME_INVALID: 'Please enter a name (up to 100 characters).',
  PHONE_INVALID: 'Please check the phone number and try again.',
  LINKEDIN_INVALID: 'Please check the link. It should look like linkedin.com/in/your-name.',
  LINKEDIN_LOCKED: 'Your LinkedIn is already set up.',
  SCHEDULE_INVALID: 'Please choose a day and a time for the call.',
  NOT_FOUND: "We couldn't find your sign-up. Please sign in again.",
  CHARACTER_UNKNOWN: 'That host is no longer available. Please choose another.',
  SETUP: 'This page is not set up yet.',
  SERVER: 'Something went wrong on our side. Please try again in a moment.',
  NETWORK: 'No connection. Check your internet and try again.',
}

/** An api.js error -> a sentence to show (unknown backend text is shown as is). */
export function errorText(error) {
  if (!error) return ''
  return ERRORS[error.code] || error.message || ERRORS.SERVER
}

// What is happening with the first call (lib/useCallStatus.js; states from convex/lib/callStatus.ts).
export const CALL_STATUS = {
  checking: 'Checking on your call…',
  dialing: 'We are dialing your number. Your phone will ring in a moment.',
  in_call: 'Your phone is ringing, or you are on the call. Take your time.',
  wrapping_up: 'The call has ended. Thank you for your time. We are saving your stories.',
  done: 'Thank you for the chat. Your stories are saved.',
  no_answer: 'We called, but nobody answered. Please check that the phone is on and has signal.',
  busy: 'The line was busy.',
  voicemail: 'The call went to voicemail. Try again when you can answer.',
  unreachable: "We couldn't reach that number. Please check it, with the country code.",
  ended_early: 'The call ended before we could talk.',
  busy_lines: 'Our lines are busy right now.',
  start_failed: "We couldn't place the call.",
  unsure: "We're not sure the call went out. If the phone doesn't ring within a minute, don't worry.",
  trouble: 'Something went wrong on our side with this call. We are sorry.',
  none: 'We can no longer find this call.',
  canRetry: 'You can try again whenever you are ready.',
  retryAt: (time) => `You can try again at ${time}.`,
  retryLater: "You can't ask for another call from this page right now.",
  tryAgain: 'Try again',
  stopped: "We stopped checking on the call. If nobody called, please try again later.",
  offline: 'No connection to check on the call. Still trying…',
  callDisabled: 'Calls from this page are turned off for now. Your host will call at the time you chose.',
  callRateLimited: 'You asked for a call a moment ago. Please wait a few minutes or try again tomorrow.',
  callFailed: "We couldn't start the call. Please try again later.",
  callAlreadyDone: 'Your first call is done. Thank you!',
}
