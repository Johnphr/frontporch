# Convex

All of Front Porch's backend: tables, vector memory, crons, the question
planner, the post writer, and the actions that call Claude, OpenAI, Cartesia,
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
npx convex env set ANTHROPIC_API_KEY <value>
```

## Onboarding call (`cartesia.ts`, `pipeline.ts`, `llm.ts`; slice 1)

Cartesia runs the call; Convex starts it, polls for the transcript, and has Claude build
his profile + story seeds. Setup: `../voice/README.md`.

```bash
npx convex run cartesia:syncAgent                                    # push prompt + settings
npx convex run elders:seed '{"name":"Walter Smith","phone":"+14155550123"}'   # -> elderId
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
| `CARTESIA_VOICE_ID`, `CARTESIA_MODEL` | optional voice + in-call model (default `claude-haiku-4.5`) |
| `ANTHROPIC_API_KEY` | profile extraction |
| `APIFY_TOKEN` | optional: prefill his LinkedIn background (needs `linkedinUrl` on the elder) |

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
| `ANTHROPIC_API_KEY` | Shared with Brain; the guard calls Claude |
| `POST_GUARD_MODE` | `enforce` (default: failing posts become `needs_review`, not posted) · `warn` (post anyway, keep issues) · `off` |

Try it without posting anything:

```bash
npx convex run linkedapi:previewText '{"text":"My first job...","turns":[{"role":"elder","text":"My first job was at a bakery"}]}'
npx convex run linkedapi:previewPost '{"postId":"<posts id>"}'
```

Unit tests for the formatter and posting decisions (no Convex needed): `node --test "tests/**/*.test.ts"`.

## Notes

- Calls run on Cartesia Managed Agents; transcripts are polled, so `http.ts` has no routes yet.
- `http.ts` and `crons.ts` must keep their default exports, even when empty.
- Vector search (`ctx.vectorSearch`) only works inside actions.
- Files with `"use node"` at the top may only export actions.
- v1 leftovers: `questions.ts`, `answers.ts`, `replies.ts` get deleted;
  `elders.ts`, `calls.ts`, `lib/auth.ts` still use the old `secret` argument
  and get converted to internal functions (Core: Data).
