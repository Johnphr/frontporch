// Landing page copy (design-mockups/landing-c-calm.html). Header and footer text live in NAV.

export const HERO = {
  title: 'Tell your work stories over the phone.',
  lead: 'Your host calls you. You talk. We share your stories on LinkedIn, in your words.',
  cta: 'Get your first call',
  family: 'Setting this up for a parent? Start here.',
  art: 'An older woman relaxing on a sofa, talking on the phone, next to a lamp and a plant',
}

export const TRUST = {
  label: 'The short version',
  line: 'No app. No screen. No passwords. Just a phone call.',
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
      title: 'Each week, a few questions. Your stories go on LinkedIn.',
      body: 'Your host asks a few short, open questions and lets you talk. What you say becomes a LinkedIn post, in your own words.',
    },
  ],
}

export const NEED = {
  title: 'What you need',
  lead: 'A phone. That’s really it.',
  items: ['A phone', 'About 15 minutes a week', 'Your memories'],
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

export const QUESTIONS = {
  title: 'Questions your host might ask',
  lead: 'Short, open questions. There are no wrong answers, and you can always say “next question.”',
  items: [
    'What was the first job that made you feel like a professional?',
    'Tell me about a mistake that taught you something you still use.',
    'Who trained you, and what did they get right?',
    'What has changed most in your field since you started?',
    'What would you tell someone starting out in your line of work today?',
  ],
}

export const POST = {
  title: 'What a post looks like',
  lead: 'Here is an example of a short post made from one call. It sounds like the person, because it is their words.',
  label: 'Example LinkedIn post',
  tag: 'Example',
  name: 'Margaret O.',
  meta: 'Ran a neighborhood bakery for 38 years',
  body: [
    'In 1981 I opened a bakery with one oven and a loan from my brother. That first winter I priced bread by what flour cost me that week, and I wrote the price on a chalkboard every morning.',
    'People thought I was crazy to change prices so often. But it kept the doors open, and my regulars knew I was being straight with them.',
    'If you run a small shop today: know your costs better than anyone, and tell your customers the truth.',
  ],
  note: 'Written up with AI from a phone call with Front Porch. Checked against what Margaret said.',
}

export const READERS = {
  title: 'Your readers write back',
  lead: 'Your host reads the reactions and comments on your posts and brings them into your next call.',
  hostLine: '“A reader asked how you priced bread back then. Would you tell me about that?”',
  hostSaid: 'Oscar, at the start of a weekly call',
}

export const QUOTES = {
  title: 'What we hope to hear',
  lead: 'Front Porch is brand new. These are examples of the experience we are building toward, not real reviews.',
  tag: 'Example quote',
  items: [
    {
      text: '“I spent thirty years on night shifts and nobody ever asked me about them. Now young nurses write back with questions.”',
      who: 'A retired nurse, 69',
    },
    {
      text: '“I’m not a computer person. I answer the phone, I talk about the shop, and that’s my part done.”',
      who: 'A hardware store owner, 74',
    },
  ],
}

export const FAMILY = {
  title: 'Setting this up for a parent?',
  lead: 'You can sign up someone you love in a few minutes. They never need to touch a screen.',
  steps: ['Enter their name and phone number.', 'Pick a weekly time that suits them.', 'Let them know their host will call.'],
  cta: 'Set up calls for someone else',
}

export const WHY = {
  title: 'Why we built this',
  body: 'We built Front Porch at Cal Hacks 13.0. So many people we admire carry decades of know-how, and the internet mostly asks them to type. We wanted a way in that starts with a phone call.',
}

export const FINAL = {
  title: 'Ready for your first call?',
  lead: 'Sign up for yourself or for someone you love. Your host will call at the time you choose.',
  cta: 'Get your first call',
  small: 'No app, no screen, no passwords.',
}
