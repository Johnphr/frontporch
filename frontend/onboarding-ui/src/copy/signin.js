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
  demo: 'Demo',
  sending: 'Sending…',
  checking: 'Checking…',
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
    hint: "We'll text a 6-digit code. Standard text rates may apply.",
    submit: 'Send me a code',
    tooShort: (n) => `Enter a phone number with at least ${n} digits.`,
  },

  code: {
    title: 'Enter the code we texted you',
    sentTo: 'We sent a code to',
    change: 'Change number',
    label: '6-digit code',
    hint: "It's in a text message from Front Porch.",
    submit: 'Continue',
    incomplete: 'Enter all 6 digits from the text message.',
    wait: "Didn't get it? You can send it again in",
    resend: "Didn't get it? Send the code again",
    resent: (phone) => `We sent a new code to ${phone}.`,
    demo: 'Any 6 digits work. Type 000000 to see the wrong-code message.',
  },

  email: {
    title: "What's your email address?",
    lead: "We'll email you a link. Click it and you're signed in. No password needed.",
    label: 'Email address',
    submit: 'Email me a sign-in link',
    invalid: 'Enter an email address like name@example.com.',
  },

  emailSent: {
    title: 'Check your email',
    sentTo: 'We sent a sign-in link to',
    lead: "Open the email and click the link. It works for 15 minutes. If you can't find it, look in your spam or junk folder.",
    resend: 'Send the link again',
    resent: (email) => `We sent another link to ${email}.`,
    different: 'Use a different email',
    demo: 'In real life you would click the link in your email.',
    clicked: 'I clicked the link',
  },

  done: {
    title: "You're in.",
    lead: 'Next, a few short questions so your host knows who to call and when.',
    next: 'Continue',
  },
}
