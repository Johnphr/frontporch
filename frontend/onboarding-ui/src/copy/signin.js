// Sign-in page copy (design-mockups/login-c.html).
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
    newHereRest: 'The same steps create your account.',
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
