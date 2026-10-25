# Convex

All of MEMORIA's backend: tables, vector memory, crons, the question
planner, the post writer, and the actions that call OpenAI, Cartesia,
Bluesky, Threads, X, Reddit, LinkedAPI and Apify. See `../ARCHITECTURE.md` for the loop,
contracts and who owns which file. Where posts go (and each switch):
[`../README.md` → Where posts go](../README.md#where-posts-go); every env var:
[`../ARCHITECTURE.md` → Env vars](../ARCHITECTURE.md#env-vars-all-in-convex).

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

**Deploys are automatic:** every push to `main` runs the tests, then `npx convex deploy`
(`.github/workflows/convex-deploy.yml`, key = GitHub secret `CONVEX_DEPLOY_KEY`, today the dev
deployment hip-dodo-105). Don't `npx convex dev` against that deployment: it overwrites `main`
until the next push.

## Onboarding call (`cartesia.ts`, `pipeline.ts`, `llm.ts`; slice 1)

Cartesia runs the call; Convex starts it, polls for the transcript, and has the LLM build
his profile + story seeds. Setup: `../voice/README.md`.

```bash
npx convex run cartesiaAgents:syncAgent                              # push one agent per character (lib/characters.ts)
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
| `CARTESIA_API_KEY`, `CARTESIA_FROM_NUMBER_ID` | Cartesia account + the phone number's id (`ap_...`); every character calls from it |
| `CARTESIA_VOICE_ID_DANIEL`, `_OSCAR`, `_VICTORIA`, `CARTESIA_MODEL` | optional English voices (unset keeps the linked agent's current voice) + in-call model (default `claude-haiku-4.5`) |
| `CARTESIA_VOICE_ID_DIANA` | Diana's Spanish voice; required before syncing her |
| `OPENAI_API_KEY` | LLM jobs (profile, memories, post, planner) + memory embeddings; `OPENAI_MODEL` optional (default `gpt-6-luna`) |
| `APIFY_TOKEN` | optional: prefill his LinkedIn background (needs `linkedinUrl` on the elder) |
| `AUTO_POST` | optional, default `on`. `off` = story posts are saved but not posted anywhere (for tests); post one with `publish:publishPost` |
| `LINKEDIN_POSTING` | optional, default off. `on` also posts to LinkedIn through LinkedAPI (needs the LinkedAPI tokens) |
| `PUBLIC_CALLS` | optional, default off. Lets the sign-up page start his first call (`signup:requestCall`; max 3 a day, 10 min apart), and lets the hourly cron call a website sign-up still in onboarding. `on` = only `CALL_ALLOWLIST` numbers; `all` = anyone (only once SMS is real) |
| `CALL_ALLOWLIST` | comma-separated E.164 test numbers the sign-up page may call when `PUBLIC_CALLS=on` |
| `ACCOUNTS_ENC_KEY` | encrypts connected Bluesky app passwords (`accounts.ts`, `lib/accountCrypto.ts`). Base64 of 32 bytes: `openssl rand -base64 32` |
| `DEMO_ACCOUNT_FALLBACK` | optional, default off. `on` = elders who never connected an account use the env demo account (`BLUESKY_HANDLE` / `BLUESKY_APP_PASSWORD`); an invalid or disconnected account of his never does |

Agent ids are not env vars: `syncAgent` saves one row per character in the `characterAgents`
table (`characterId`, `agentId`, `syncedAt`), and `startCall` reads it. If his character has no
row yet, `startCall` throws before any row is written. From the hourly cron that costs that
week's call (`schedule.tick` records the slot first), so sync every character first. Add a
character: `../voice/README.md`.

## Repeat calls fast (iterate on calls) + what the sign-up page shows

```
call ends ──► wait CALL_INTERVAL_MINUTES ──► next call ──► call ends ──► wait ...
   ▲ still ringing / talking / being written up? the clock hasn't started yet
```

```bash
npx convex env set AUTO_POST off                  # required for a fast loop (nothing posts)
npx convex env set CALL_INTERVAL_MINUTES 5        # next call 5 min after the last one ENDS
npx convex env set CALL_ALLOWLIST "+1...,+52..."  # only these numbers are repeated (Twilio-verified ones)
npx convex env remove CALL_INTERVAL_MINUTES       # stop
```

- Change the number any time (dashboard → Settings → Environment Variables); it applies within a
  minute (`callLoop.tick`, every minute). Set `CALL_LOOP=all` to repeat everyone (not for now).
- Never the first call: that's "Call me now" (or `cartesia:startCall` by hand).
- After 3 missed calls in a row (no answer, voicemail, busy...) it stops calling that number until a
  real conversation happens (start one by hand). Our own failures (busy lines, config) don't count.
- Off with an interval under a day unless `AUTO_POST=off` (posts and thread replies could go out
  on his real accounts every few minutes). Set `npx convex env set AUTO_POST off` to loop. While
  it's blocked, `callLoop.tick` logs a warning once an hour (minute 0) saying so.
- Numbers it covers are skipped by the weekly `schedule.tick`. No quiet hours: keep the list small.

**Sign-up page call status:** after "Call me now" the page shows what is happening in plain words
(dialing, on the call, no answer, busy, voicemail, wrong number, cut short, our trouble...) from
`signup:callStatus({ callId })`, and offers "Try again" only when `requestCall` would accept it
(10 min apart, 3 a day). States: `convex/lib/callStatus.ts`; copy: `frontend/onboarding-ui/src/i18n.js`.

## Review generated posts (temporary page)

Read every post as it would be published, and where each platform stands (Bluesky, Threads, X,
Reddit, LinkedIn: status + link):

```bash
npx convex env set POSTS_PAGE_KEY <long random string>   # off without it
npx convex env get POSTS_PAGE_KEY                        # then open:
# https://<deployment>.convex.site/posts?key=<that key>
```

Newest first, with the call's question and why the fact-check held a post. "Fact-check now"
reruns the check (nothing is posted). Temporary: remove `postsPage.ts`, `lib/postsPage.ts` and the
route in `http.ts` once posts are reviewed on the platforms themselves.

## Try the after-call flow without a phone

Fixtures in `../tests/fixtures/`. Use a throwaway seeded elder: fixture facts merge into his
profile and memories. A story fixture ends in a post, so `seedEndedCall` refuses it unless `AUTO_POST=off`
(or you pass `"allowPost": true`); `npx convex env set AUTO_POST off` keeps the post `pending`.

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

1. Agents + preview-only posting (once):

   ```bash
   npx convex run cartesiaAgents:syncAgent   # same agent per character for onboarding and story calls
   npx convex env set AUTO_POST off          # posts stay `pending`, nothing is posted
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
   `dynamicVariables` (`first_name`, `goal`, `context`) are exactly what his character's agent gets. An empty bank falls back to a default opening question (and schedules a
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

6. Preview the post: the `/posts` page shows the Bluesky thread split; the fact-check alone
   (nothing is posted, LinkedAPI isn't called):

   ```bash
   npx convex run linkedapi:previewPost '{"postId":"<posts id>"}'
   ```

   Post it on purpose later with `npx convex run publish:publishPost '{"postId":"<posts id>"}'`
   (or `publish:approvePost` if it was held). Turn auto-posting back on with
   `npx convex env set AUTO_POST on`.

## Test an inbound call (he calls the MEMORIA number; `inbound.ts`)

One number routes to one Cartesia agent, and an agent has one voice for the whole call (no
mid-call voice change, no hand-off to another agent), so a single bilingual inbound agent
answers every call **as one host**: `CARTESIA_INBOUND_HOST` (character id, default `daniel`).
It greets generically, then calls the `lookup_caller` tool → `POST /cartesia/inbound-lookup`
(`http.ts`) → `inbound.handleLookup`: his number → elder → the same plan an outbound call would
use (onboarding or story, his language), a `calls` row with `direction: "inbound"`, and the usual
poll → `pipeline.processCall`. If his host is a different one, the line's host says it's his
colleague; it never claims to be him. Unknown numbers get a polite goodbye and no row. A
10-minute cron (`inbound.syncInboundCalls`) records any finished inbound call the lookup missed.

1. Once (needs the HTTPS site URL; Convex gives functions `CONVEX_SITE_URL`, else set
   `INBOUND_SITE_URL=https://<deployment>.convex.site`):

   ```bash
   npx convex env set CARTESIA_TOOL_SECRET <long random string>
   npx convex run cartesiaAgents:syncAgent '{"inbound":true,"assignNumber":true}'   # prints the next two lines
   npx convex env set CARTESIA_LOOKUP_TOOL_ID <id>
   npx convex env set CARTESIA_INBOUND_AGENT_ID <id>
   ```

   `CARTESIA_INBOUND_HOST=<daniel|oscar|victoria|diana>` picks the host whose voice, language
   and persona the line uses (its `CARTESIA_VOICE_ID_<HOST>` must be set; re-sync `{inbound:true}`
   after changing it). For the demo: the host the demo elder picks. Without it, the default host
   for `CARTESIA_INBOUND_LANGUAGE` (`en` → Daniel, `es` → Diana).

2. From the elder's phone (his `phone` field, E.164), call the MEMORIA number. The host
   greets, looks him up, greets him by name and continues his onboarding or story call.
3. Watch: a `calls` row with `direction: "inbound"`, `queued` is skipped (`in_progress` →
   `ended` → `done`), then memories, a `pending` post (with `AUTO_POST=off`) and a used bank row.
   What the tool got: `npx convex run inbound:lastLookups '{"limit":3}'` (`known story`,
   `unknown no_elder`, `error unauthorized`, ...; the same text is one `inbound-lookup:` log line
   per request, never with a number).
4. From a number that isn't an elder: polite goodbye, no row.
5. Backstop by hand: `npx convex run inbound:syncInboundCalls`.

Safety: every lookup is checked with Cartesia first (a live call on `CARTESIA_INBOUND_AGENT_ID`
from that caller), so the tool secret alone gets nothing; a repeated lookup of the same call gets
the same cached answer; phones typed in the dashboard in other formats still match (normalized
comparison). A plain `syncAgent` only updates the inbound pieces when both
`CARTESIA_INBOUND_AGENT_ID` and `CARTESIA_LOOKUP_TOOL_ID` are set.

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
| `apify.scrapeEngagement({ elderId, linkedinUrl?, maxPosts? })` | daily, only with `LINKEDIN_POSTING=on` (otherwise returns `skipped`) | his recent LinkedIn posts' reaction counts + reader comments → `engagement:upsert` |
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

## Publishing story posts (Integrations)

`publish.publishPost({ postId })` (scheduled by `pipeline.insertPost` in the same mutation
that saves the post) fact-checks the post once, then posts it to each platform that's on, in
this order, one `postPublications` row per platform: Bluesky as a 3-5 post thread (his login),
Threads as a 2-5 post thread (when he connected Threads), X as a self-thread (only with
`X_POSTING=on` and his X login; `X_THREAD=off` = one post), Reddit on his profile (only with
`REDDIT_POSTING=on`), LinkedIn (only with `LINKEDIN_POSTING=on`, below). Off platforms get a
`skipped` row.
Row statuses: `pending` → `posting` → `posted` | `failed` (nothing went out, unless `records`
is set: a thread that stopped partway) | `maybe_posted` (unclear: check his profile
first) | `skipped`; undo adds `removing` / `removed`. A Threads, X, Reddit or LinkedIn run that
stopped mid-post (claim older than 15 min) becomes `maybe_posted`; Bluesky retries look in his
repo first (only posts made after the row existed count), Threads retries in his recent posts.
A Threads / X retry continues after the posts in `records`.
`posts.status`: `published` (a platform posted) | `partly_posted` (only part of a thread is
out, any platform) | `failed` (nothing went out) | `needs_review` (`heldFor`: `quality`,
`thread_fit` or `guard`). The disclosure language is decided once, on `posts.language`.
A Bluesky login that's refused marks his account invalid (`lib/logins.reportBlueskyLoginError`).

```bash
npx convex run publish:approvePost '{"postId":"<posts id>"}'                       # post a held post (fact-checked first unless the fact-check held it)
npx convex run publish:retryPublication '{"publicationId":"<row id>"}'             # retry a failed platform (or re-check a stuck LinkedIn one)
npx convex run publish:retryPublication '{"publicationId":"<row id>","approve":true}'  # after checking a maybe_posted one
```

A retry needs a post the fact-check cleared (`guardPassedAt`); one that never got checked
(nothing was set up when it ran) is refused: run `publish:publishPost`, which checks it first.
The old `linkedapi:createPost` / `approvePost` / `checkPostStatus` refuse posts that have
`postPublications` rows.

## LinkedIn posting (off) + post guard (Integrations)

LinkedIn is switched off: nothing calls LinkedAPI unless `LINKEDIN_POSTING=on`. With it on,
`publish.ts` posts through `linkedapi.startPublication` + `checkPublicationStatus`. The older
one-platform flow below is kept (also gated).

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
| `LINKEDIN_POSTING` | default off; `on` lets anything here call LinkedAPI |
| `LINKEDAPI_TOKEN`, `LINKEDAPI_ID_TOKEN` | LinkedAPI account + grandpa's connected LinkedIn |
| `OPENAI_API_KEY` | Shared with Brain; the guard calls the LLM (`lib/openai.ts`) |
| `POST_GUARD_MODE` | `enforce` (default: failing posts become `needs_review`, not posted) · `warn` (post anyway, keep issues) · `off` |

Try it without posting anything:

```bash
npx convex run linkedapi:previewText '{"text":"My first job...","turns":[{"role":"elder","text":"My first job was at a bakery"}]}'
npx convex run linkedapi:previewPost '{"postId":"<posts id>"}'
```

The AI-disclosure footer follows the post's language (`posts.language`, set once when the post
is saved: the language his calls run in, `callCharacter(elder).language`; older rows fall back
to that): Spanish gets `SPANISH_DISCLOSURE`, everyone else the English
line (`lib/linkedinPost.ts`). `previewPost` uses the post's elder; `previewText` takes an
optional `"language":"es-MX"`.

**Post quality** (`llm.writePost`, `lib/postQuality.ts`): the writer is platform-neutral: one
short story (120-200 words, short paragraphs) whose first line works on its own as the opening
post, so publishing can turn it into a short thread (at most 5 Bluesky posts). 3 drafts with
different angles, a judge scores each (hook, story, voice, lesson, question, clarity, 0-10, plus
any fact not in the call or his profile = score 0), code checks (120-200 words, under 1,250
characters in total, hook ≤200 chars, ≤2 hashtags, stock phrases, markdown or lists, closing
question, language), then at most one critique -> rewrite round on the best (`FAST_POST=on`:
one draft, no judge, falling back to this loop). The call is skipped
only when most of the 3 drafts decline; failed drafts never count as a skip (too many failures
fail the post step, which is safe to retry). A failed judge call is retried once; if it still
fails, the post is held (fail closed). The loop is `runQualityLoop` (unit-tested with fake model
calls).
It passes at 75/100 with no criterion under 5. Below the bar the post is saved as
`needs_review` with the judge's notes on `posts.quality` (shown once on `/posts`) and never
auto-posts; after a look, post it with `npx convex run publish:approvePost '{"postId":"<posts id>"}'`. Such a post
(`heldFor: "quality"`, or `"thread_fit"` when it's too long for a 5-post Bluesky thread: shorten
`posts.text` first, approve refuses it until it fits) was never fact-checked, so approving it
runs the post guard first: if the guard fails, it's held again as a normal fact-check hold
(`heldFor: "guard"`, the guard's issues), and a second `approvePost` skips the guard. Approving
anything else (a `pending` post with `AUTO_POST=off`, a `failed` one) runs the guard too. Cost: up to ~15 model calls per post.
Time: the post step gets what's left of `processCall`'s 10-minute limit minus 60 s, capped at
240 s (`postBudgetMs`); no model call starts past that deadline. With under 120 s left the step
fails instead of starting (`process_failed`, retry by hand).

Unit tests for the formatter and posting decisions (no Convex needed): `node --test "tests/**/*.test.ts"`.

## Thread replies (`threadReplies.ts`, `replyWriter.ts`, Integrations)

When a story call's question came from a Bluesky or Reddit thread (an `audienceQuestions` row),
the pipeline's `reply` step schedules `threadReplies.draftForCall`: his answer, in his words,
first person, posted back on that thread from **his own account**, with a one-line AI
disclosure and no links. One reply per thread. It gets the same fact-check as LinkedIn posts
(`postGuard`); a failing reply is held as `needs_review` (Copy text + Open thread on the
`/posts` page, or approve it with `postReply` + `approve: true`). Questions from any other
source (Quora, Discourse, Stack Exchange) get **no reply and no row**.

| Platform | Posting | Why |
|---|---|---|
| Bluesky | **auto** (`BLUESKY_HANDLE` + `BLUESKY_APP_PASSWORD`) | Open AT Protocol API; reply threaded under the post, 300 graphemes incl. the disclosure |
| Reddit | **gated**: auto only with `REDDIT_POSTING=on` + the credentials below; until then no reply (no draft) | New API apps need Reddit's approval (Responsible Builder Policy, Nov 2025); many subreddits ban AI-written replies, so check the subreddit's rules |
| Anything else (Quora, Discourse, Stack Exchange) | none | No posting API we use (Quora has none; Stack Exchange bans AI content). Still used as question sources |

Bluesky without his login set, or Reddit while it's off, also means no reply and no row.
`AUTO_POST=off` keeps every reply a draft (nothing is posted). Bluesky is also a question
**source** (`bluesky-search` in `lib/questionSources.ts`): with his login set, the weekly
audience-question search includes recent Bluesky posts that read like questions (the public
Bluesky search API refuses unauthenticated requests, so it searches through his session).

```bash
npx convex env set BLUESKY_HANDLE walter.bsky.social
npx convex env set BLUESKY_APP_PASSWORD <app password>   # Bluesky: Settings -> Privacy and security -> App passwords
npx convex run threadReplies:draftForCall '{"callId":"<calls id>"}'     # draft (again) for a call
npx convex run threadReplies:postReply '{"replyId":"<id>"}'             # post a draft now
npx convex run threadReplies:postReply '{"replyId":"<id>","approve":true}'   # post one the fact-check held
```

Optional: `BLUESKY_SERVICE` (his PDS, default `https://bsky.social`).

**Reddit credentials (needed before `REDDIT_POSTING=on`):**
1. Log in as his Reddit account and open https://www.reddit.com/prefs/apps -> "create another app" ->
   type **script**, any name, redirect uri `http://localhost:8080` (unused). Note the client id
   (under the app name) and the secret.
2. Request Data API access for that app under Reddit's Responsible Builder Policy (Reddit's developer
   support / API access request form). New OAuth apps don't work until Reddit approves them.
3. Once approved, set: `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `REDDIT_USERNAME`, `REDDIT_PASSWORD`
   (his account; if it uses 2FA, script-app password logins need it off or an app-specific setup),
   optional `REDDIT_USER_AGENT` (default `web:frontporch:v1 (by /u/<username>)`), then
   `npx convex env set REDDIT_POSTING on`.

## Memory, engagement, scheduling (Core: Data)

Env: `OPENAI_API_KEY` (embeddings for `memories.ts`; `addMany` and `search` throw a
clear error without it).

| Function | Called by | What it does |
|---|---|---|
| `memories.addMany({ elderId, callId?, items, resolveThreadIds? })` | `pipeline.processCall` | embed + store what he said; merges near-duplicates, resolves finished open threads |
| `memories.search({ elderId, text, k, kinds? })` | `conversation.planNextCall` | memories closest to a text (e.g. the next question) |
| `memories.listForElder({ elderId, kinds?, status?, limit? })` | planner | e.g. all active open threads |
| `blueskyEngagement.scrapeForElder({ elderId })` | `schedule.dailyEngagement` | his Bluesky threads from the last 30 days: likes + reposts on the root post, replies by others (oldest 20, not hidden or labelled) → `engagement:upsert`; a deleted thread → `engagement:markGone` (his session if connected, else the public AppView). Returns `{ threads, upserted, likes, reposts, replies, gone, errors }` |
| `threadsEngagement.scrapeForElder({ elderId })` | `schedule.dailyEngagement` (always) | his Threads threads from the last 30 days: likes + reposts on the root, replies by others → `engagement:upsert` (`platform: "threads"`). Nothing to do without Threads posts |
| `xEngagement.scrapeForElder({ elderId })` | `schedule.dailyEngagement` (only `X_READ_FEEDBACK=on`) | his X posts from the last 30 days: likes + retweets + quotes; reply texts only with `X_READ_REPLIES=on` → `engagement:upsert` (`platform: "x"`). Logs `estimatedReads` |
| `engagement.upsert(...)` | the three scrapers above, `apify.scrapeEngagement` | latest reactions + comments per post per platform (`platform`: bluesky / threads / x / linkedin, default linkedin; only LinkedIn links get the LinkedIn URL cleanup); schedules a question-bank refresh when something changed |
| `engagement.recentFeedback({ elderId, sinceDays? })` | planner | posts with reactions + comments, newest first |
| `schedule.tick` | hourly cron | `conversation.prepareCall` ~1h before his call, `cartesia.startCall` at the call hour |

Crons (`crons.ts`, UTC): hourly `schedule.tick`; daily 13:15 `schedule.dailyEngagement`
(→ per active elder `blueskyEngagement.scrapeForElder`, `threadsEngagement.scrapeForElder`
10 s later, `xEngagement.scrapeForElder` 20 s later only with `X_READ_FEEDBACK=on`; then
`apify.scrapeEngagement` per active elder with a `linkedinUrl` only when `LINKEDIN_POSTING=on`,
after the whole batch); weekly Monday 14:30
`schedule.weeklyAudienceQuestions` (→ `apify.findAudienceQuestions`). `tick` only acts
on elders with `stage`, `timezone`, `callDay` and `callHour` set, and skips a target
that isn't deployed yet (that slot is NOT retried: start that week's call by hand).

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

- Calls run on Cartesia Managed Agents; transcripts are polled. `http.ts` serves the inbound
  lookup tool, the temporary `/posts` page and the OAuth callbacks (`/oauth/threads/callback`,
  `/oauth/x/callback`: one per platform).
- `http.ts` and `crons.ts` must keep their default exports, even when empty.
- Vector search (`ctx.vectorSearch`) only works inside actions.
- Files with `"use node"` at the top may only export actions.
- Only `signup.ts` and `account.ts` are public (the web app: sign-up, and his page); everything
  else is `internal*` (run it with `npx convex run`). Public Convex functions are callable by
  anyone with the deployment URL; the deleted v1 dashboard queries exposed call transcripts that
  way. After `register`, every public function needs his sign-up token (hashed in an action,
  checked in an internal query or mutation). `signup.*` return ids and ok/reason only;
  `account.*` return only his name, host, call slot and posts that went out, never elder rows,
  his phone, transcripts or held drafts. `signup:signIn({ phone, code })` (phone + 6-digit
  family code → a new token) and `signup:startOver` (archive that number's setup) are rate
  limited (5 wrong codes / 15 min per phone) and never say whether a number is signed up.
- Give a test elder a family code (rows from before codes, or a lost one):
  `npx convex run signup:setFamilyCode '{"elderId":"<id>"}'` prints `{ familyCode }` once
  (pass `"code":"123456"` to pick it). Only the hash is stored.
- v1 leftovers are deleted (`questions.ts`, `answers.ts`, `replies.ts`, `calls.ts`,
  `lib/auth.ts`); `elders.ts` keeps only `seed`. The v1 `questions`, `answers` and `replies`
  tables stay in `schema.ts` until they're empty.
