// Landing page copy (design-mockups/landing-c-calm.html). Header and footer text live in NAV.

export const HERO = {
  title: 'Tell your work stories over the phone.',
  lead: 'Your host calls you. You talk. We share your stories on your own social accounts, in your words.',
  cta: 'Get your first call',
  family: 'Setting this up for a parent? Start here.',
  art: 'Margaret, an older woman, smiling on the phone with her host Daniel',
}

export const HOW = {
  title: 'How it works',
  lead: 'Three steps. The first one takes about five minutes.',
  stepLabel: (n) => `Step ${n}: `,
  steps: [
    {
      title: 'You sign up on the web, or someone does it for you.',
      body: 'Enter a name, a phone number and a good time to call. A family member or friend can do this part.',
    },
    {
      title: 'Your host calls to get to know you.',
      body: 'On the first call, Daniel, Oscar, Victoria or Diana asks about your field, your specialty and how your career went. Take your time.',
    },
    {
      title: 'Each week, a few questions. Your stories go online.',
      body: 'Your host asks a few short, open questions and lets you talk. What you say becomes a post on your own accounts, in your own words.',
    },
  ],
}

export const PROMISES = {
  title: 'Our promises to you',
  lead: 'Your name goes on these posts, so we take that seriously.',
  items: [
    { title: 'Your own words.', body: 'Posts are built from what you said on the call, the way you said it.' },
    { title: 'Checked before it goes out.', body: 'Every post is checked against the call. Your host never adds facts and never gives advice.' },
    { title: 'Clearly labeled.', body: 'Every post says it was written up with AI from a phone call.' },
  ],
}

export const POST = {
  title: 'What a post looks like',
  lead: 'Here is an example of a short post made from one call. It sounds like the person, because it is their words.',
  label: 'Example post',
  tag: 'Example',
  name: 'Margaret O.',
  meta: 'Ran a neighborhood bakery for 38 years',
  body: [
    'In 1981 I opened a bakery with one oven and a loan from my brother. That first winter I priced bread by what flour cost me that week, and I wrote the price on a chalkboard every morning.',
    'People thought I was crazy to change prices so often. But it kept the doors open, and my regulars knew I was being straight with them.',
    'If you run a small shop today: know your costs better than anyone, and tell your customers the truth.',
  ],
  note: 'Written up with AI from a phone call with MEMORIA. Checked against what Margaret said.',
}

export const FAMILY = {
  title: 'Setting this up for a parent?',
  lead: 'You can sign up someone you love in a few minutes. They never need to touch a screen.',
  steps: ['Enter their name and phone number.', 'Pick a weekly time that suits them.', 'Let them know their host will call.'],
  cta: 'Set up calls for someone else',
}

export const FINAL = {
  title: 'Ready for your first call?',
  lead: 'Sign up for yourself or for someone you love. Your host will call at the time you choose.',
  cta: 'Get your first call',
  small: 'No app, no screen, no passwords.',
}
