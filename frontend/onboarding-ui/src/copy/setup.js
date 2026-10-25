// First-time setup copy (design-mockups/onboarding-c.html). Most lines change between "you" and
// the person's name / "their", depending on who is setting it up (step 1), so they are built by
// setupCopy({ them, name, host }).

export const TOTAL_STEPS = 6

/** The browser's time zone in words, e.g. "Central Daylight Time" (empty if unknown). */
export function zoneName() {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZoneName: 'long' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName')
    return part ? part.value : ''
  } catch {
    return ''
  }
}

export const SETUP = {
  stepOf: (n) => `Step ${n} of ${TOTAL_STEPS}`,
  backHome: 'Back to home',
  backReview: 'Back to review',
  back: 'Back',
  next: 'Continue',
  nextReview: 'Save and go back to review',

  who: {
    title: 'Who is setting this up?',
    lead: 'This takes about five minutes. You can change anything later.',
    legend: 'Choose one',
    self: "I'm setting this up for myself",
    helper: "I'm helping someone else",
    helperSub: 'A family member, friend or someone I care for.',
    missing: 'Please choose one to continue.',
  },

  language: {
    legend: 'Language',
    hint: 'Each host speaks one language, so choosing a language also picks the host.',
    en: 'English',
    enSub: 'Calls with Pip',
    es: 'Spanish',
    esSub: 'Español. Calls with Juanito',
  },

  when: {
    lead: 'Calls happen once a week, at the same time.',
    day: 'Day',
    time: 'Time',
    other: 'Or pick another time',
    otherNone: 'Choose a time',
  },

  linkedin: {
    lead: 'This is optional. It helps us put the stories in the right place.',
    hint: 'For example: linkedin.com/in/margaret-olsen',
    invalid: "That doesn't look like a LinkedIn profile address. It should look like linkedin.com/in/name.",
    reassureTitle: 'Checked before it goes out.',
    later: 'Skip for now',
  },

  review: {
    who: 'Set up by',
    name: 'Name',
    phone: 'Phone',
    lang: 'Language and host',
    when: 'Weekly call',
    linkedin: 'LinkedIn',
    change: 'Change',
    edit: 'Edit',
    // Read after "Change" / "Edit" by screen readers only.
    what: { who: 'who is setting this up', name: 'name', phone: 'phone number', lang: 'language', when: 'call time', linkedin: 'LinkedIn' },
    phoneLabel: 'Phone number',
    country: 'Country',
    save: 'Save number',
    cancel: 'Cancel',
    phoneShort: (n) => `Enter a phone number with ${n} digits.`,
    phoneMissing: 'Please add the phone number to call.',
    noLinkedin: "No profile. That's fine.",
    laterLinkedin: 'Not added yet. You can add it later.',
    finish: 'Finish',
    finishing: 'Setting up…',
  },

  done: {
    expect: 'What to expect on the first call',
    tryAgainBusy: 'Calling…',
  },
}

/** Lines that depend on step 1 (them = helping someone), the name and the host. */
export function setupCopy({ them, name, host }) {
  const n = (name || '').trim() || (them ? 'them' : 'there')
  const your = them ? 'their' : 'your'
  return {
    n,
    selfSub: `${host} will call me.`,
    nameTitle: them ? "What's their name?" : `What should ${host} call you?`,
    nameLabel: them ? 'Their name' : 'Your name',
    nameHint: `The name ${them ? 'they like' : 'you like'} to be called. ${host} will use it on every call.`,
    nameMissing: them ? 'Please enter their name.' : `Please tell us what ${host} should call you.`,
    langTitle: them ? `Which language should ${n}'s calls be in?` : 'Which language would you like your calls in?',
    hostTag: them ? `${n}'s host` : 'Your host',
    hostDesc:
      host === 'Juanito'
        ? 'Courteous and formal. Speaks Latin American Spanish and always says “usted.”'
        : 'Warm and curious. Asks one question at a time and loves the details.',
    hostLine:
      host === 'Juanito'
        ? `“Buenas tardes, ${n}. Soy Juanito. ¿Me cuenta usted cómo empezó en su oficio?”`
        : `“Hi ${n}, it's Pip. I'd love to hear how you got started. What was your very first job?”`,
    hostTranslation: `In English: “Good afternoon, ${n}. This is Juanito. Would you tell me how you got started in your trade?”`,
    whenTitle: them ? `When should ${host} call ${n}?` : `When should ${host} call?`,
    whenSummary: (day, time) => `${host} will call ${them ? `${n} ` : ''}every ${day} at ${time}.`,
    liTitle: them ? `Does ${n} have a LinkedIn profile?` : 'Do you have a LinkedIn profile?',
    liLabel: `${them ? `${n}'s` : 'Your'} LinkedIn profile address (optional)`,
    liNone: them ? "They don't have one" : "I don't have one",
    liReassure: `Nothing goes on LinkedIn before the first call. Every post is labeled as written up with AI from a phone call, and checked against what ${them ? n : 'you'} said.`,
    reviewTitle: them ? `Does this look right for ${n}?` : 'Does this look right?',
    reviewIntro: `You can change anything later from ${them ? `${n}'s` : 'your'} page.`,
    reviewWho: them ? `Me, helping ${n}` : 'Me, for myself',
    phoneNote: (signedIn) =>
      them ? `The number ${host} will call. Make sure it is ${n}'s phone.` : signedIn ? 'The number you signed in with.' : `The number ${host} will call.`,
    phoneHint: them ? `Enter ${n}'s number. ${host} will call it.` : `${host} will call this number.`,
    reviewLang: (languageName) => `${languageName}, with ${host}`,
    reviewWhen: (day, time, zone) => `Every ${day} at ${time}${zone ? `, ${zone}` : ''}`,
    doneCalling: (phone) => `${host} is calling ${them ? `${n} at ` : ''}${phone} now.`,
    doneWeekly: (day, time) => `${host} will call ${them ? n : 'you'} every ${day} at ${time}.`,
    doneSubCalling: them
      ? `Let ${n} know the phone is about to ring. There is nothing to prepare.`
      : 'Answer when it rings. There is nothing to prepare.',
    doneSubWeekly: 'There is nothing to prepare.',
    expect: [
      `${host} says hello and explains how Front Porch works.`,
      `${host} asks about ${your} field, ${your} specialty and how ${your} career went.`,
      them
        ? 'They can take their time, skip any question or end the call whenever they like.'
        : 'Take your time. You can skip any question or end the call whenever you like.',
    ],
    goHome: them ? `Go to ${n}'s page` : 'Go to your page',
  }
}
