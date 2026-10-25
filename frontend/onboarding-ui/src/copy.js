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
  brand: 'MEMORIA',
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

// Error codes thrown by api.js -> what we say, in English and Spanish (the page is English for
// now; errorText(e, 'es') is ready for a Spanish page). Codes match the backend's.
export const ERRORS = {
  en: {
    NAME_INVALID: 'Please enter a name (up to 100 characters).',
    PHONE_INVALID: 'Please check the phone number and try again.',
    LINKEDIN_INVALID: 'Please check the link. It should look like linkedin.com/in/your-name.',
    LINKEDIN_LOCKED: 'Your LinkedIn is already set up.',
    SCHEDULE_INVALID: 'Please choose a day and a time for the call.',
    NOT_FOUND: "We couldn't find your sign-up. Please sign in again.",
    ALREADY_SIGNED_UP: 'This number is already signed up. Sign in with it instead.',
    TOO_MANY_TRIES: 'Too many tries. Please wait 15 minutes and try again.',
    CHARACTER_UNKNOWN: 'That host is no longer available. Please choose another.',
    SETUP: 'This page is not set up yet.',
    SERVER: 'Something went wrong on our side. Please try again in a moment.',
    NETWORK: 'No connection. Check your internet and try again.',
  },
  es: {
    NAME_INVALID: 'Escriba un nombre (hasta 100 letras).',
    PHONE_INVALID: 'Revise el número de teléfono e intente otra vez.',
    LINKEDIN_INVALID: 'Revise el enlace. Debe verse como linkedin.com/in/su-nombre.',
    LINKEDIN_LOCKED: 'Su LinkedIn ya está configurado.',
    SCHEDULE_INVALID: 'Elija un día y una hora para la llamada.',
    NOT_FOUND: 'No encontramos su registro. Inicie sesión otra vez, por favor.',
    ALREADY_SIGNED_UP: 'Este número ya está registrado. Inicie sesión con él.',
    TOO_MANY_TRIES: 'Demasiados intentos. Espere 15 minutos e intente otra vez.',
    CHARACTER_UNKNOWN: 'Esa opción ya no está disponible. Elija otra.',
    SETUP: 'La página no está configurada todavía.',
    SERVER: 'Algo salió mal de nuestro lado. Intente otra vez en un momento.',
    NETWORK: 'No hay conexión. Revise su internet e intente otra vez.',
  },
}

/** An api.js error -> a sentence to show (unknown backend text is shown as is). */
export function errorText(error, lang = 'en') {
  if (!error) return ''
  const words = ERRORS[lang] || ERRORS.en
  return words[error.code] || error.message || words.SERVER
}

// What is happening with the first call (lib/useCallStatus.js; states from convex/lib/callStatus.ts).
export const CALL_STATUS_BY_LANG = {
  en: {
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
  },
  es: {
    checking: 'Revisando su llamada…',
    dialing: 'Estamos marcando su número. Su teléfono sonará en un momento.',
    in_call: 'Su teléfono está sonando o ya está en la llamada. Con calma.',
    wrapping_up: 'La llamada terminó. Gracias por su tiempo. Estamos guardando sus historias.',
    done: 'Gracias por la plática. Sus historias quedaron guardadas.',
    no_answer: 'Llamamos, pero nadie contestó. Revise que el teléfono esté encendido y con señal.',
    busy: 'La línea estaba ocupada.',
    voicemail: 'La llamada se fue al buzón de voz. Intente otra vez cuando pueda contestar.',
    unreachable: 'No pudimos comunicarnos con ese número. Revíselo, con la clave del país.',
    ended_early: 'La llamada se cortó antes de poder platicar.',
    busy_lines: 'Nuestras líneas están ocupadas en este momento.',
    start_failed: 'No pudimos hacer la llamada.',
    unsure: 'No estamos seguros de que la llamada haya salido. Si el teléfono no suena en un minuto, no se preocupe.',
    trouble: 'Algo salió mal de nuestro lado con esta llamada. Disculpe la molestia.',
    none: 'Ya no encontramos esta llamada.',
    canRetry: 'Puede intentar de nuevo cuando esté listo.',
    retryAt: (time) => `Puede intentar de nuevo a las ${time}.`,
    retryLater: 'Por ahora no puede pedir otra llamada desde esta página.',
    tryAgain: 'Intentar de nuevo',
    stopped: 'Dejamos de revisar la llamada. Si no le llamaron, intente más tarde.',
    offline: 'No hay conexión para revisar la llamada. Seguimos intentando…',
    callDisabled: 'Por ahora las llamadas desde esta página están apagadas. Su anfitrión le llamará a la hora que eligió.',
    callRateLimited: 'Ya pidió una llamada hace poco. Espere unos minutos o intente mañana.',
    callFailed: 'No pudimos iniciar la llamada. Intente de nuevo más tarde.',
    callAlreadyDone: 'Su primera llamada ya se hizo. ¡Gracias!',
  },
}

/** The page is English for now; CALL_STATUS_BY_LANG.es is ready for a Spanish page. */
export const CALL_STATUS = CALL_STATUS_BY_LANG.en
