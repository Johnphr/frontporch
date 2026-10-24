# Convex

All of Front Porch's backend: tables, vector memory, crons, the question
planner, the post writer, and the actions that call OpenAI, Cartesia,
LinkedAPI and Apify. See `../ARCHITECTURE.md` for the loop,
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
npx convex env set OPENAI_API_KEY <value>
```

## Onboarding call (`cartesia.ts`, `pipeline.ts`, `llm.ts`; slice 1)

Cartesia runs the call; Convex starts it, polls for the transcript, and has the LLM build
his profile + story seeds. Setup: `../voice/README.md`.

```bash
npx convex run cartesiaAgents:syncAgent                              # push the agents (Spanish: '{"language":"es"}')
npx convex run elders:seed '{"name":"Walter Smith","phone":"+14155550123","language":"en-US",
  "timezone":"America/Los_Angeles","callDay":"sunday","callHour":10}'   # -> elderId (es-MX → Juanito)
npx convex run cartesia:startCall '{"elderId":"<id>"}'               # phone rings
npx convex logs                                                      # watch poll -> done
```

Call statuses: `queued` → `in_progress` → `ended` → `done` (profile saved), or
`no_conversation` (voicemail / busy / under 30 words), `failed` (Cartesia refused; nothing rang),
`start_unknown` (timeout or 5xx while dialing: the phone may have rung, so check Cartesia's
call log), `poll_error` / `poll_timeout`, `process_failed` (retry:
`npx convex run pipeline:processCall '{"callId":"<id>"}'`).
`startCall` refuses while a call to him is open (queued, in progress, unknown start, or ended
and waiting to be processed; 90 min window); add `"force": true` to call anyway.

Local backend + `"use node"` files need Node 20–24: `npx -p node@24 -c 'npx convex dev'`.

| Env var | Purpose |
|---|---|
| `CARTESIA_API_KEY`, `CARTESIA_FROM_NUMBER_ID` | Cartesia account + the phone number's id (`ap_...`) |
| `CARTESIA_ONBOARDING_AGENT_ID` | printed by the first `syncAgent` run |
| `CARTESIA_STORY_AGENT_ID` | story agent (slice 2), printed by the first `syncAgent` run that creates it |
| `CARTESIA_ONBOARDING_AGENT_ID_ES`, `CARTESIA_STORY_AGENT_ID_ES` | Juanito (Spanish elders), printed by `cartesiaAgents:syncAgent '{"language":"es"}'` |
| `CARTESIA_VOICE_ID`, `CARTESIA_MODEL` | optional voice + in-call model (default `claude-haiku-4.5`) |
| `CARTESIA_VOICE_ID_ES` | a Spanish voice; required before syncing Juanito |
| `OPENAI_API_KEY` | LLM jobs (profile, memories, post, planner) + memory embeddings; `OPENAI_MODEL` optional (default `gpt-6-luna`) |
| `APIFY_TOKEN` | optional: prefill his LinkedIn background (needs `linkedinUrl` on the elder) |
| `AUTO_POST` | optional, default `on`. `off` = story posts are saved but not sent to LinkedIn (preview only, for tests) |
| `PUBLIC_CALLS` | optional, default off. `on` = the sign-up page can start his first call (`signup:requestCall`; max 3 a day, 10 min apart) |

If his kind + language has no agent id, `startCall` throws before any row is written. From the
hourly cron that costs that week's call (`schedule.tick` records the slot first), so keep the ids
of every language your elders use set.

## Try the after-call flow without a phone

Fixtures in `../tests/fixtures/`. Use a throwaway seeded elder: fixture facts merge into his
profile and memories. A story fixture ends in a post, so `seedEndedCall` refuses it while posting
is live (both LinkedAPI tokens set and `AUTO_POST` on) unless you pass `"allowPost": true`;
`npx convex env set AUTO_POST off` keeps the post `pending`.

```bash
ID=$(npx convex run elders:seed '{"name":"Test Walter","phone":"+15550001111","profile":{"industry":"Baking","specialty":"Bread"}}' | tr -d '"')
npx convex run pipeline:seedEndedCall "$(jq --arg id $ID '{elderId:$id,kind,turns,summary,endReason}' tests/fixtures/story_call.json)"
npx convex run conversation:planNextCall '{"elderId":"'$ID'"}'      # what Pip would get next
```

A memories step that fails (e.g. no `OPENAI_API_KEY`) doesn't fail the call: the row is `done`
with error `memories step failed (not retried)`. To rerun it, clear that row's `processedAt` in the
dashboard, then `npx convex run pipeline:processCall '{"callId":"<id>"}'` (memories for a callId
are never duplicated, and the post is reused).

## Test a follow-up (story) call (slice 2)

For an elder who already did the onboarding call (his row has `stage: "active"` and a profile).
`startCall` picks the kind by itself: onboarding until the profile is usable, then story.

1. Story agent + preview-only posting (once):

   ```bash
   npx convex run cartesiaAgents:syncAgent '{"only":"story"}'   # first run prints the next line
   npx convex env set CARTESIA_STORY_AGENT_ID <id>             # Spanish elders: '{"language":"es"}' -> ..._ES
   npx convex env set AUTO_POST off                       # posts stay `pending`, nothing goes to LinkedIn
   ```

   Also needed: `OPENAI_API_KEY` (planning, memories, post, memory search).

2. Optional, give the plan fresh material (each takes a minute or two):

   ```bash
   npx convex run conversation:prepareCall '{"elderId":"<id>"}'        # audience questions + recent news in his field (APIFY_TOKEN + OPENAI_API_KEY); schedules a bank refresh
   npx convex run conversation:refreshQuestionBank '{"elderId":"<id>"}' # or just rebuild the question bank from what he's told us
   ```

3. See what Pip will ask, without calling:

   ```bash
   npx convex run conversation:planNextCall '{"elderId":"<id>"}'
   ```

   `plan.question` (the call's one goal: a story that starts from it), `plan.memories` and
   `dynamicVariables` are exactly what the story agent gets. An empty bank falls back to a default opening question (and schedules a
   refresh), so run step 2 first for a real follow-up.

4. Call him:

   ```bash
   npx convex run cartesia:startCall '{"elderId":"<id>"}'   # phone rings; returns {status: "started", kind: "story", ...}
   npx convex logs
   ```

5. Watch in the dashboard:
   - `calls`: new row, `kind: "story"`, `plan` saved, `queued` → `in_progress` → `ended` → `done`.
   - `questionBank`: the planned row flips to `used` with `usedInCallId` when the call starts.
   - `memories`: new facts, people, open threads from this call (`callId` = this call).
   - `posts`: one row for the call, `status: "pending"` (with `AUTO_POST=off`).

6. Preview the post (formatting + fact-check, nothing is posted):

   ```bash
   npx convex run linkedapi:previewPost '{"postId":"<posts id>"}'
   ```

   Post it on purpose later with `npx convex run linkedapi:createPost '{"postId":"<posts id>"}'`
   (or `linkedapi:approvePost` if the fact-check held it). Turn auto-posting back on with
   `npx convex env set AUTO_POST on`.

## Apify scrapers (`apify.ts`, Integrations)

Env: `APIFY_TOKEN` (required), `STACKEXCHANGE_KEY` (optional; raises the free
Stack Exchange limit from 300 to 10,000 requests/day). **Set it for the demo:** the
no-key limit is per IP, and Convex actions share outbound IPs with other apps.
A failing Stack Exchange request no longer loses the rest; errors show up in
the run's per-source report, and the run throws only if every source fails.

**Post URLs:** scraped posts are stored as
`https://www.linkedin.com/feed/update/urn:li:activity:<id>` (`lib/linkedinUrl.ts`,
shared with `linkedapi.ts`), so `engagement:upsert` can match `posts.linkedinUrl`
with a plain equality check.

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

## LinkedIn posting + post guard (Integrations)

`linkedapi.createPost({ postId, context? })` claims the row (so it can't be posted
twice), formats the post for LinkedIn, fact-checks it against the whole call plus his
profile, the call summary and any `context` you pass (e.g. the memories used to write
it), then posts through LinkedAPI and polls until the post URL is saved on the
`posts` row. URLs are saved in one canonical form (`lib/linkedinUrl.ts`) so scraped
engagement matches them.

Post statuses: `pending` → `posting` → `pending` (sent, has `workflowId`) → `published`.
Also `needs_review` (guard held it), `failed` (see `error`; if `maybePosted` is set,
LinkedAPI didn't confirm the send, so check his LinkedIn before retrying) and
`needs_attention` (sent, but status checks stopped; see `error`).

Human fixes:

```bash
npx convex run linkedapi:approvePost '{"postId":"<posts id>"}'      # post a needs_review row as it is
npx convex run linkedapi:checkPostStatus '{"postId":"<posts id>"}'  # resume status checks
```

| Env var | Purpose |
|---|---|
| `LINKEDAPI_TOKEN`, `LINKEDAPI_ID_TOKEN` | LinkedAPI account + grandpa's connected LinkedIn |
| `OPENAI_API_KEY` | Shared with Brain; the guard calls the LLM (`lib/openai.ts`) |
| `POST_GUARD_MODE` | `enforce` (default: failing posts become `needs_review`, not posted) · `warn` (post anyway, keep issues) · `off` |

Try it without posting anything:

```bash
npx convex run linkedapi:previewText '{"text":"My first job...","turns":[{"role":"elder","text":"My first job was at a bakery"}]}'
npx convex run linkedapi:previewPost '{"postId":"<posts id>"}'
```

Unit tests for the formatter and posting decisions (no Convex needed): `node --test "tests/**/*.test.ts"`.

## Memory, engagement, scheduling (Core: Data)

Env: `OPENAI_API_KEY` (embeddings for `memories.ts`; `addMany` and `search` throw a
clear error without it).

| Function | Called by | What it does |
|---|---|---|
| `memories.addMany({ elderId, callId?, items, resolveThreadIds? })` | `pipeline.processCall` | embed + store what he said; merges near-duplicates, resolves finished open threads |
| `memories.search({ elderId, text, k, kinds? })` | `conversation.planNextCall` | memories closest to a text (e.g. the next question) |
| `memories.listForElder({ elderId, kinds?, status?, limit? })` | planner | e.g. all active open threads |
| `engagement.upsert(...)` | `apify.scrapeEngagement` | latest reactions + comments per post; schedules a question-bank refresh when something changed |
| `engagement.recentFeedback({ elderId, sinceDays? })` | planner | posts with reactions + comments, newest first |
| `schedule.tick` | hourly cron | `conversation.prepareCall` ~1h before his call, `cartesia.startCall` at the call hour |

Crons (`crons.ts`, UTC): hourly `schedule.tick`; daily 13:15 `schedule.dailyEngagement`
(→ `apify.scrapeEngagement` per active elder with a `linkedinUrl`); weekly Monday 14:30
`schedule.weeklyAudienceQuestions` (→ `apify.findAudienceQuestions`). `tick` only acts
on elders with `stage`, `timezone`, `callDay` and `callHour` set, and skips a target
that isn't deployed yet (it retries next hour).

Set up a demo elder in the dashboard (Data → elders → edit): `stage: "active"`,
`timezone: "America/Los_Angeles"`, `callDay: "sunday"`, `callHour: 10`,
`linkedinUrl: "https://www.linkedin.com/in/<him>/"`. Then try:

```bash
npx convex env set OPENAI_API_KEY <key>
npx convex run memories:addMany '{"elderId":"<id>","items":[{"kind":"person","name":"Maria","text":"his wife of 52 years"},{"kind":"open_thread","text":"the flood at the plant in 1978"}]}'
npx convex run memories:search '{"elderId":"<id>","text":"his family","k":3}'
npx convex run schedule:tick '{"now": 1792944000000}'   # Sunday 2026-10-25 09:00 PDT: prepares a 10:00 call
```

## Notes

- Calls run on Cartesia Managed Agents; transcripts are polled, so `http.ts` has no routes yet.
- `http.ts` and `crons.ts` must keep their default exports, even when empty.
- Vector search (`ctx.vectorSearch`) only works inside actions.
- Files with `"use node"` at the top may only export actions.
- Only `signup.ts` is public (the sign-up page); everything else is `internal*` (run it with
  `npx convex run`). Public Convex functions are callable by anyone with the deployment URL;
  the deleted v1 dashboard queries exposed call transcripts that way. Public functions return
  ids and ok/reason only, never elder rows or transcripts.
- v1 leftovers are deleted (`questions.ts`, `answers.ts`, `replies.ts`, `calls.ts`,
  `lib/auth.ts`); `elders.ts` keeps only `seed`. The v1 `questions`, `answers` and `replies`
  tables stay in `schema.ts` until they're empty.
