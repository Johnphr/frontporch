// Sign-in page copy (design-mockups/login-c.html). The page is English; the family-code and
// start-over lines also exist in Spanish (SIGNIN_BY_LANG.es), like the error codes in copy.js.
import { splitE164 } from '../phone'

/** "+15550123456" -> "(555) 012-3456"; other countries keep their dial code: "+52 55 1234 5678". */
export function showPhone(e164) {
  const { country, national } = splitE164(e164)
  return country.code === 'US' ? national : `${country.dial} ${national}`
}

export const SIGNIN = {
  backHome: 'Back to home',
  back: 'Back',
  continuing: 'One moment…',
  art: 'An older man with white hair sitting at a table, reading his phone, with a cup of coffee by his hand',

  welcome: {
    title: 'Sign in or create your account',
    lead: 'Use a phone number or an email address.',
    phone: 'Continue with your phone number',
    or: 'or',
    email: 'Continue with email',
    newHere: 'New here?',
    newHereRest: 'Enter your phone number, then choose "Sign up".',
  },

  phone: {
    title: "What's your phone number?",
    lead: "This number is for signing in. You'll choose the number your host calls in the next steps.",
    country: 'Country',
    label: 'Phone number',
    submit: 'Continue',
    tooShort: (n) => `Enter a phone number with at least ${n} digits.`,
  },

  email: {
    title: "What's your email address?",
    lead: "No password needed. Next, a few short questions so your host knows who to call and when.",
    label: 'Email address',
    submit: 'Continue',
    invalid: 'Enter an email address like name@example.com.',
  },
}

// Family code (sign in from any device) and "Start over", in both languages.
export const SIGNIN_BY_LANG = {
  en: {
    code: {
      title: 'Enter your family code',
      lead: (phone) => `The 6-digit code from the day ${phone} was set up. It's on the card you wrote it on.`,
      label: 'Family code',
      hint: '6 digits',
      submit: 'Sign in',
      busy: 'Signing in…',
      incomplete: 'Enter the 6-digit family code.',
      newHere: 'New here?',
      signUp: 'Sign up',
      startOver: 'Start over with this number',
    },
    startOver: {
      title: 'Start over with this number?',
      lead: 'This removes the current setup for this number. Posts already published stay up.',
      confirm: 'Yes, start over',
      busy: 'One moment…',
      cancel: 'Cancel',
    },
  },
  es: {
    code: {
      title: 'Escriba su código familiar',
      lead: (phone) => `El código de 6 dígitos del día en que se configuró ${phone}. Está en la tarjeta donde lo anotó.`,
      label: 'Código familiar',
      hint: '6 dígitos',
      submit: 'Entrar',
      busy: 'Entrando…',
      incomplete: 'Escriba el código familiar de 6 dígitos.',
      newHere: '¿Es nuevo aquí?',
      signUp: 'Registrarse',
      startOver: 'Empezar de nuevo con este número',
    },
    startOver: {
      title: '¿Empezar de nuevo con este número?',
      lead: 'Esto borra la configuración actual de este número. Las publicaciones ya hechas siguen en línea.',
      confirm: 'Sí, empezar de nuevo',
      busy: 'Un momento…',
      cancel: 'Cancelar',
    },
  },
}
