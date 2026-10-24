# Convex

All of Front Porch's backend: tables, vector memory, crons, the Vapi webhook,
the question planner, the post writer, and the actions that call Claude,
OpenAI, Vapi, LinkedAPI and Apify. See `../ARCHITECTURE.md` for the loop,
contracts and who owns which file.

## Run

From the repo root:

```bash
npm install
npx convex dev        # first run: log in, pick the team project
```

The first run generates `convex/_generated/`. Keys go in Convex env, never in
the repo:

```bash
npx convex env set ANTHROPIC_API_KEY <value>
```

## Apify scrapers (`apify.ts`, Integrations)

Env: `APIFY_TOKEN` (required), `STACKEXCHANGE_KEY` (optional; raises the free
Stack Exchange limit from 300 to 10,000 requests/day).

| Function | Run it | What it does |
|---|---|---|
| `apify.scrapeEngagement({ elderId, linkedinUrl?, maxPosts? })` | daily | his recent posts' reaction counts + reader comments → `engagement:upsert` |
| `apify.scrapeProfile({ elderId, linkedinUrl? })` | once, before onboarding | returns `{ knownBackground }` (work history as plain text) |
| `apify.findAudienceQuestions({ elderId, keywords?, sources? })` | weekly | real questions people in his field ask → `audienceQuestions` |
| `apify.topAudienceQuestions({ elderId, limit? })` | from the planner | best unused questions, highest priority first |

Suggested crons for `crons.ts` (Core: Data): daily `scrapeEngagement` and weekly
`findAudienceQuestions` for each active elder. Sources and keyword → subreddit /
Stack Exchange site maps live in `lib/questionSources.ts`.

Try one by hand (dev deployment, after `npx convex env set APIFY_TOKEN ...`):

```bash
npx convex run apify:scrapeProfile '{"elderId":"<id>","linkedinUrl":"https://www.linkedin.com/in/<him>/"}'
npx convex run apify:findAudienceQuestions '{"elderId":"<id>","keywords":["bakery","small business"]}'
```

Pure logic is unit-tested without Convex: `npm test` (Node's test runner, files in `../tests/`).

## Notes

- The webhook is served at `https://<deployment>.convex.site/vapi/webhook` (see `http.ts`).
- `http.ts` and `crons.ts` must keep their default exports, even when empty.
- Vector search (`ctx.vectorSearch`) only works inside actions.
- Files with `"use node"` at the top may only export actions.
- v1 leftovers: `questions.ts`, `answers.ts`, `replies.ts` get deleted;
  `elders.ts`, `calls.ts`, `lib/auth.ts` still use the old `secret` argument
  and get converted to internal functions (Core: Data).
