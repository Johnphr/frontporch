# Hackathon log: Best People-First Social Impact Hack

- **Project:** MEMORIA (Cal Hacks 13.0)
- **Who it serves:** older professionals who have decades of experience and no presence where people ask for advice today; and the younger people asking.
- **What it does:** An AI phone host calls them weekly, turns one story per call into a post on their own account, and brings readers' questions back on the next call. No app, no screen, no passwords.
- **Live app:** https://onboarding-ui-delta.vercel.app · **Repo:** https://github.com/Johnphr/frontporch

## People-first choices (with the code that proves them)
- **The phone is the interface:** everything happens in a call; he can also call the number and the host knows him (`convex/cartesia.ts`, `convex/inbound.ts`). The website is for the one-time setup, designed large and calm with text-size controls (`frontend/onboarding-ui/DESIGN.md`, `src/lib/textSize.js`).
- **Bilingual from day one:** English and Spanish hosts, prompts, disclosures and site copy (`convex/lib/characters.ts`, `lib/prompts/principles.ts`, `frontend/onboarding-ui/src/copy/*`).
- **Only his words:** the writer may not add facts; every post is fact-checked against the transcript and held if doubtful; every post says it was written with AI (`convex/lib/postQuality.ts`, `convex/postGuard.ts`, `convex/lib/linkedinPost.ts` disclosure).
- **He stays in control:** "Please take my last post down" on any call removes it everywhere; family can remove any post (`convex/undo.ts`, `convex/lib/undo.ts`).
- **Family can help without taking over:** sign-up with a relative, a sign-in that needs no password, a page to change host and call time (`convex/signup.ts`, `convex/account.ts`).
- **Protected from the internet:** his credentials are encrypted per person (`convex/lib/accountCrypto.ts`); strangers' replies are filtered for links, numbers and scam-style asks before the host reads them (`convex/lib/readerSafety.ts`); the host never replies to or tags strangers on X.
- **Recognition, not metrics:** the host opens the next call with what readers said ("A reader asked…"), which is what keeps people talking (`convex/llm.ts` summarizeFeedback).

## Log
- 2026-10-24 `59404de` first call gets to know him; `6fad328` weekly story call
- 2026-10-24 `9918cec` Spanish; `0db09be` Spanish disclosure
- 2026-10-24 `73f3eb3` quality loop + fact-check holds
- 2026-10-24 `dd2543d` his own accounts, encrypted; undo by phone; reply filtering
- 2026-10-24 `cca0c06` "Large & Calm" site for older eyes; `53c5092` call-in line continues his conversation
