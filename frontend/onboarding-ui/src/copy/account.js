// His page (#/home, #/posts): copy from design-mockups/dashboard-c.html.

export const ACCOUNT = {
  tabsLabel: (name) => (name ? `${name}'s page` : 'Your page'),
  tabs: { home: 'Home', posts: 'Posts' },
  loading: 'Loading your page…',
  tryAgain: 'Try again',
  notFound: "We couldn't find your page. Please sign in again.",
}

/** Morning before noon, afternoon before 5 PM, evening after. */
function partOfDay(hour) {
  if (hour < 12) return 'morning'
  if (hour < 17) return 'afternoon'
  return 'evening'
}

export const HOME = {
  greeting: (name, hour) => `Good ${partOfDay(hour)}, ${name}.`,
  callsEvery: (host, day, time) => `${host} calls you every ${day} at ${time}.`,
  noSchedule: (host) => `Choose when ${host} should call.`,
  // Setup stopped at step 6 (where stories go) on this device: a way back to it.
  finishSetupTitle: 'Setup is not finished',
  finishSetupLead: 'Choose where the stories go, then get the first call.',
  finishSetup: 'Finish setup',
  hostTitle: 'Your host',
  chooseHost: 'Choose your host',
  callsIn: (language) => `Calls in ${language}`,
  currentHost: 'Current host',
  /** language: the new call language, only when it changes. */
  switchTo: (host, language) => `Switch to ${host}? ${host} will call from next week.${language ? ` Calls will be in ${language}.` : ''}`,
  hostSaved: (host) => `Saved. ${host} will call from next week.`,
  scheduleTitle: (host) => `When ${host} calls`,
  day: 'Day',
  time: 'Time',
  summary: (host, day, time) => `${host} will call every ${day} at ${time}.`,
  scheduleSaved: (host, day, time) => `Saved. ${host} will call every ${day} at ${time}.`,
  save: 'Save',
  saving: 'Saving…',
  cancel: 'Cancel',
}

export const POSTS = {
  title: 'Your posts',
  lead: 'Every post is made from one of your calls, in your words.',
  loading: 'Loading your posts…',
  empty: 'No posts yet. Your first post comes after your next call.',
  posted: (date) => `Posted ${date}`,
  reactions: (n) => `${n} ${n === 1 ? 'reaction' : 'reactions'}`,
  comments: (n) => `${n} ${n === 1 ? 'comment' : 'comments'}`,
  view: (platform) => `View on ${platform}`,
  platforms: { bluesky: 'Bluesky', threads: 'Threads', x: 'X', linkedin: 'LinkedIn', reddit: 'Reddit' },
  newTab: '(opens in a new tab)',
}
