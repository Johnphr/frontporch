# Hackathon log: Best Use of Apify

- **Project:** MEMORIA (Cal Hacks 13.0)
- **What it does:** An AI phone host calls older professionals and turns their stories into posts; each call starts from a real question people are asking online.
- **Live app:** https://onboarding-ui-delta.vercel.app · **Repo:** https://github.com/Johnphr/frontporch
- **Apify actors used:** `trudax/reddit-scraper` (Reddit search and communities), `blackfalcondata/quora-scraper` (Quora), `harvestapi/linkedin-profile-scraper` (profile prefill). Stack Exchange is queried directly; Bluesky via its search API.
- **Code:** `convex/apify.ts`, `convex/lib/apifyClient.ts` (run-sync actor calls, timeouts), `convex/lib/questionSources.ts` (sources, keywords, dedupe, scoring), `convex/lib/scrapeMapping.ts`, `convex/conversation.ts` (`prepareCall`, question bank ranking in `convex/lib/planner.ts`).

## How we use Apify
- **Find the question:** before a story call, `apify.findAudienceQuestions` runs the actors with keywords from his industry and specialty, keeps questions (title, body, community, votes, answers), fingerprints titles to de-duplicate across sites, scores by recency and engagement, and stores them in `audienceQuestions`.
- **Plan the call:** `conversation.refreshQuestionBank` ranks them with open threads and readers' questions; the top one becomes the host's `<question>` for the call, and the host says where it came from.
- **Answer where it was asked:** if the call's question came from a thread we can post on (Bluesky now; Reddit built, awaiting API approval), `threadReplies.draftForCall` writes his answer, fact-checks it and posts it on that thread (`convex/threadReplies.ts`).
- **Know him before the first call:** a public profile scrape fills `knownBackground` so the onboarding call already knows his field (`apify.scrapeProfile`).
- **Scheduled:** weekly cron for every active elder, plus `prepareCall` about an hour before each scheduled call (`convex/crons.ts`, `convex/schedule.ts`).

## Log
- 2026-10-24 `9da994d` Apify question search + audienceQuestions table (convex/apify.ts)
- 2026-10-24 `00a52c9` question bank ranking uses audience questions (convex/lib/planner.ts)
- 2026-10-24 `d71fd58` profile prefill + engagement scrape (convex/apify.ts)
- 2026-10-24 `5d4c60a` replies on the thread the question came from (convex/threadReplies.ts)
- 2026-10-25 `3c2580c` the host names the research source on the call
