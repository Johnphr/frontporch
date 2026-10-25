# Hackathon log

- **Project:** MEMORIA
- **Event:** Cal Hacks 13.0
- **What it does:** An AI phone host calls older professionals, turns their stories into posts on their own Bluesky/Threads/X accounts, and brings readers' replies back into the next call.
- **Live app:** https://onboarding-ui-delta.vercel.app
- **Repo:** https://github.com/Johnphr/frontporch
- **Frontend:** Vercel
- **Convex deployment:** https://hip-dodo-105.convex.cloud
- **Components:** none (no convex/convex.config.ts)
- **Convex features:** schema (19 tables, 39 indexes, 1 vector index), queries, mutations, actions, HTTP actions (5 routes), crons (7), scheduled functions (ctx.scheduler chains the whole post-call pipeline). No file storage, full text search, realtime useQuery or paginated queries: the site uses ConvexHttpClient and polls call status.
- **Auth:** none (phone sign-in; a per-sign-up token hash gates every write, convex/lib/signupRules.ts)
- **AI models:** gpt-6-luna (default; gpt-6.1-sol / gpt-6-astra selectable), text-embedding-3-small, claude-haiku-4.5 (Cartesia in-call model)
- **Started:** 2026-10-24T05:40:00Z
- **Last updated:** 2026-10-25T14:41:36Z

## How we use Convex
- **The host remembers him across calls:** memories are embedded and stored in a `memories` table with a vector index (`convex/schema.ts`, `convex/memories.ts`); `conversation.planNextCall` searches them to build each call's context.
- **Weekly and inbound calls:** `crons.hourly` runs `schedule.tick`, which schedules `cartesia.startCall` at his local hour; an HTTP action `/cartesia/inbound-lookup` identifies a caller by number for the inbound agent (`convex/crons.ts`, `convex/schedule.ts`, `convex/http.ts`, `convex/inbound.ts`).
- **A post 15–30 s after hang-up:** `cartesia.pollCall` re-schedules itself every 3 s; `pipeline.processCall` runs memories, the writer and the fact-check as isolated steps, and `insertPost` schedules `publish.publishPost` (`convex/pipeline.ts`, `convex/publish.ts`); per-platform claims in `postPublications` stop double posts.
- **Readers steer the next call:** `crons.interval` every 30 s reads replies on fresh Bluesky/Threads posts, `engagement.upsert` schedules `conversation.refreshQuestionBank` (`convex/blueskyEngagement.ts`, `convex/engagement.ts`).
- **Undo by voice:** `undo.removePost` deletes on every platform and retries itself with the scheduler (`convex/undo.ts`).
- **Connect his accounts:** `signup.ts` / `account.ts` public actions with token checks; OAuth callbacks are HTTP actions (`convex/oauth.ts`, `convex/xAuth.ts`). Secrets are AES-GCM encrypted (`convex/lib/accountCrypto.ts`).
- Screens update by polling (call status on Done), not live queries.

## Log
- 2026-10-24 `015a9b8` memories table + vector index, schedule.tick (convex/schema.ts, memories.ts, schedule.ts)
- 2026-10-24 `00a52c9` planner, question bank, pipeline.processCall (convex/conversation.ts, pipeline.ts, llm.ts)
- 2026-10-24 `59404de` `6fad328` onboarding + story calls via Cartesia, pollCall (convex/cartesia.ts)
- 2026-10-24 `9da994d` Apify question search, audienceQuestions (convex/apify.ts)
- 2026-10-24 `506b903` sign-up site on Vercel, public signup.ts actions (frontend/onboarding-ui)
- 2026-10-24 `1b15958` inbound calls: HTTP action lookup tool (convex/http.ts, inbound.ts)
- 2026-10-24 `73f3eb3` post quality loop; `5d4c60a` thread replies (convex/lib/postQuality.ts, threadReplies.ts)
- 2026-10-24 `61aadee` GitHub Actions: tests + `npx convex deploy` on every push
- 2026-10-24 `dd2543d` per-elder encrypted accounts, Bluesky/Threads/X publishing, undo, feedback loop (convex/accounts.ts, publish.ts, undo.ts, oauth.ts)
- 2026-10-24 `9f900d5` 30-s reply check cron; `ec85057` fast posts (convex/crons.ts, cartesia.ts, pipeline.ts)
- 2026-10-24 `53c5092` inbound host + inboundLookups table; `846f8bc` rename to MEMORIA
- 2026-10-25 `fac578a` phone sign-in; `3c2580c` host cites the research source
