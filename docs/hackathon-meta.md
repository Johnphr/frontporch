# Hackathon log: Meta — Bringing People Closer Together with AI

- **Project:** MEMORIA (Cal Hacks 13.0)
- **What it does:** An AI phone host listens to a grandparent's working life and brings their experience to younger people asking for it online; the readers' replies come back to the elder on the next call.
- **Live app:** https://onboarding-ui-delta.vercel.app · **Repo:** https://github.com/Johnphr/frontporch
- **Meta platform used:** Threads API via OAuth (`threads.com/oauth/authorize`, long-lived tokens with refresh), posting (`/me/threads` container → `threads_publish`, `reply_to_id` chaining), insights (likes/reposts), `/conversation` replies, delete. App in development mode (testers); keyword search built, gated until app review.
- **Code:** `convex/lib/oauthPlatforms.ts`, `convex/lib/oauthFlow.ts`, `convex/oauth.ts` (connect), `convex/lib/threadsClient.ts`, `convex/lib/threadsPublishing.ts` (post), `convex/threadsEngagement.ts` (feedback), `convex/threadsQuestions.ts` (gated quote-answers), `frontend/onboarding-ui/src/pages/setup/OAuthConnect.jsx`.

## How it brings people closer
- **Generations:** an older person talks on the phone; their story reaches readers on Threads as a thread in their own words, with an AI note (`lib/threadsPublishing.ts`).
- **Readers talk back:** every 30 s for fresh posts, replies and likes are read from Threads and become the host's opening line and the next question (`convex/threadsEngagement.ts`, `convex/engagement.ts`, `convex/lib/planner.ts`).
- **Their own account:** "Connect Threads" uses Meta's consent page; tokens are stored encrypted and refreshed (`convex/lib/threadsLogin.ts`).
- **Family in the loop:** a family member can set up, sign in from any device and remove a post (`convex/account.ts`, `convex/undo.ts`).
- **Safety:** strangers' replies are data, never instructions; links, numbers and money asks are filtered before the host reads anything aloud (`convex/lib/readerSafety.ts`).

## Log
- 2026-10-24 `dd2543d` Threads OAuth connect, thread posting, insights/replies, undo (convex/oauth.ts, lib/threadsPublishing.ts, threadsEngagement.ts)
- 2026-10-24 `9f900d5` 30-second reply check and fresh reader question first (convex/crons.ts, lib/planner.ts)
- 2026-10-25 `fac578a` Connect Threads opens in a new tab (frontend)
