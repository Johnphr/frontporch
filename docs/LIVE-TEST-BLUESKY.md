# Live test: a story post on a test Bluesky account

## Demo flow (no terminal)

The whole loop runs by itself once the env below is set. Nobody types a command during the demo.

1. **Sign up** on the website: who → name → language + host (Daniel, Oscar, Victoria; Diana in
   Spanish) → day + time → Review **"Looks right. Continue"** → step 6: Bluesky handle + app
   password → **"Finish and call now"**. The host calls. This is the **onboarding** call (get
   to know him, no post). Talk for a couple of minutes (more than 30 words from him), then hang
   up. About a minute later he is `stage: "active"` with a profile, and his question bank is filled.
   - If he hangs up too soon (no real conversation) or the profile comes out empty, he stays in
     onboarding, and his next call (an inbound one too) is another onboarding call.
2. **He calls the Front Porch number himself.** The call-in line answers as
   `CARTESIA_INBOUND_HOST` (one voice per Cartesia agent): **pick that host for the demo elder
   in step 1**, so he hears the same voice that calls him. The agent looks him up
   (`/cartesia/inbound-lookup`), greets him by name and runs a **story** call with today's
   plan: the bank's top question, his memories, the latest feedback line. Wait a minute after
   step 1 before calling, or it's still the onboarding call. If the greeting had no name, run
   `npx convex run inbound:lastLookups '{"limit":3}'` (or look for `inbound-lookup:` in the
   Convex logs): it says `known`, `unknown` or `error` and why.
   After he hangs up, the post is written, fact-checked and posted to his Bluesky as a thread
   (`AUTO_POST` on). **The post appears ~3–6 min after hanging up.**
3. **Someone replies** to the thread on Bluesky from another account. A question works best
   ("How did you price bread when flour went up?").
4. **The reply is noticed and the plan updated within ~1 minute.** Posts from the last 2 hours
   are re-read every 30 s (posts 2–48 h old every 5 min; never X). The change refreshes his
   question bank and the feedback line right away (at most one refresh start per 30 s; a reply
   during one gets a trailing refresh). A reader question from the last 48 h goes to the top.
5. **He calls the number again.** The host shares the feedback ("A reader asked…") and asks the
   reader's question. That call becomes a new post.

Env on the deployment (once):

| Var | Value |
|---|---|
| `AUTO_POST` | `on`, or unset (default on) |
| `ACCOUNTS_ENC_KEY` | set once, never changed (see "Env vars" below) |
| `OPENAI_API_KEY` | set |
| `PUBLIC_CALLS` + `CALL_ALLOWLIST` | `on` + the demo phone in E.164 (`+1415...`; comma-separated for more) |
| `SIGNUP_SITE_URL` | the sign-up site URL (where Threads / X connect sends him back) |
| `CARTESIA_API_KEY`, `CARTESIA_FROM_NUMBER_ID` | set (outbound calls) |
| `CARTESIA_INBOUND_AGENT_ID`, `CARTESIA_LOOKUP_TOOL_ID`, `CARTESIA_TOOL_SECRET` | the inbound agent, its lookup tool, and the tool's bearer secret |
| `CARTESIA_INBOUND_HOST` | the host the demo elder picks (`daniel`, `oscar`, `victoria`, `diana`): the call-in line's voice. Its `CARTESIA_VOICE_ID_<HOST>` must be set. Re-sync `{inbound:true}` after changing it |

The Front Porch number must route its inbound calls to the inbound agent in Cartesia (in the
Cartesia dashboard, or once with `cartesiaAgents:syncAgent "{inbound:true,assignNumber:true}"`,
section 9). The host agents and the inbound agent must be synced with the current prompts
(section 9). **For the demo, set `CARTESIA_INBOUND_HOST` to the host the demo elder picks, then
re-sync `cartesiaAgents:syncAgent "{inbound:true}"`.** A caller whose host is a different one
still gets his name, notes and question, from the line's host speaking as his host's colleague.

If something looks stuck, check in the Convex dashboard (Data): `calls` (the newest row reaches
`done`), `posts` / `postPublications` (`posted`, with the `url`), `engagement` (the reply in
`comments`), `questionBankMeta` (`feedbackLine`, `refreshedAt`) and `questionBank` (a `queued`
row with `source: "reader"` on top).

## The step-by-step test (with commands)

What this proves: a finished story call → post written (quality loop) → fact-check → a 3–5 post
thread on **his** Bluesky account → likes and replies read back → take-down.
No phone needed (a fixture call stands in for one). Section 9 adds a real call.

Code: `convex/pipeline.ts`, `convex/publish.ts`, `convex/blueskyEngagement.ts`, `convex/undo.ts`,
`convex/accounts.ts`, `convex/signup.ts`, `convex/lib/logins.ts`.

## 0. Conventions (read once)

- Run every command from the repo root.
- **Deployment.** The commands target whatever your CLI is configured for. Open `.env.local`: it
  should name `hip-dodo-105` (`CONVEX_DEPLOYMENT=...:hip-dodo-105`). If it doesn't, add
  `--deployment hip-dodo-105` to the end of every `npx convex ...` command. Don't run
  `npx convex dev` against hip-dodo-105: it pushes your local code over what main deployed.
- Dashboard: https://dashboard.convex.dev/d/hip-dodo-105. Site URL (for `/posts`):
  `https://hip-dodo-105.convex.site`.
- **Quoting.** Args are written as JSON5 (`"{elderId:'$ELDER_ID'}"`). The Convex CLI parses args
  with JSON5, so the same line works in bash, Git Bash and PowerShell. Strict JSON
  (`'{"elderId":"..."}'`) works in bash, but Windows PowerShell strips the inner double quotes.
- Keep two ids in a shell variable as you get them. The commands then read the same in both shells:

  ```bash
  ELDER_ID=paste_the_elder_id
  ```

  ```powershell
  $ELDER_ID = "paste_the_elder_id"
  ```

  Do the same for `POST_ID` (`POST_ID=...` / `$POST_ID = "..."`).

## 1. Before you start (once)

### Env vars on hip-dodo-105

Changes apply right away (no redeploy).

**`ACCOUNTS_ENC_KEY`** (required for Path A). It encrypts connected app passwords. First check
whether it's already set:

```bash
npx convex env get ACCOUNTS_ENC_KEY
```

> ⚠️ **If it prints a value, leave it alone.** Changing or removing it makes every saved
> account unreadable (Bluesky, Threads, X): posting then fails with "isn't connected", and
> everyone has to reconnect. Set it once, never rotate it before the demo.

Only if it's not set:

```bash
npx convex env set ACCOUNTS_ENC_KEY "$(openssl rand -base64 32)"
```

```powershell
$b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); npx convex env set ACCOUNTS_ENC_KEY ([Convert]::ToBase64String($b))
```

**`OPENAI_API_KEY`** (required). Used for the post writer, the quality judge, the fact-check,
memories, the question bank and the feedback summary. Without it the fact-check holds every post.

```bash
npx convex env set OPENAI_API_KEY sk-...
```

**`POSTS_PAGE_KEY`** (optional, but you want it). It turns on the `/posts` review page, which
returns 404 without it.

```bash
npx convex env set POSTS_PAGE_KEY "$(openssl rand -hex 24)"
```

```powershell
npx convex env set POSTS_PAGE_KEY ([guid]::NewGuid().ToString('N'))
```

**`AUTO_POST`** (optional, default on). Set it `off` for the test, so a post is saved and you
publish it by hand. `seedEndedCall` refuses a story fixture unless it's off.

```bash
npx convex env set AUTO_POST off
```

Other env vars, all optional (leave them unset unless you need them):

| Var | Default | What it does |
|---|---|---|
| `OPENAI_MODEL` | `gpt-6-luna` | Model for every LLM job |
| `POST_GUARD_MODE` | `enforce` | `warn` posts anyway and keeps the issues; `off` skips the fact-check. Keep `enforce` |
| `BLUESKY_SERVICE` | `https://bsky.social` | Only for an account hosted on another PDS |
| `DEMO_ACCOUNT_FALLBACK`, `BLUESKY_HANDLE`, `BLUESKY_APP_PASSWORD` | off | Path B only (section 3) |
| `X_POSTING`, `REDDIT_POSTING`, `LINKEDIN_POSTING` | off | Keep off. Off platforms get a `skipped` row |
| `PUBLIC_CALLS`, `CALL_ALLOWLIST` | off | Let the website's "Finish and call now" ring a number. Not needed here: with it off, Finish still connects Bluesky and nothing rings |
| `CARTESIA_*` | none | Real calls only (section 9) |

Threads posts only when he connected Threads, so there's no switch for it.

For the pitch, `npx convex env set FAST_POST on`: one draft + fact-check, post in ~15-30 s after hang-up.

### Test Bluesky accounts

Make **two** accounts at https://bsky.app: **the elder** (posts the thread) and **a reader**
(replies in section 6). Use a handle like `fp-walter-test.bsky.social` and confirm the email
Bluesky sends.

Then make an app password on the elder account:

1. Go to Settings → Privacy and security → App passwords → Add App Password.
2. Name it `Front Porch test`.
3. Leave **"Allow access to your direct messages" unchecked.** We refuse an app password with DM
   access (`privileged_app_password`), and also his main password.
4. Copy the `xxxx-xxxx-xxxx-xxxx` password. Bluesky shows it only once.

## 2. Path A: the real flow (website)

Connect Bluesky **while he is still in onboarding**. Once `stage` is `active`, connecting is
locked (section 10).

1. Open https://onboarding-ui-delta.vercel.app in a normal (not private) window. The sign-up
   token is saved in this browser's localStorage (`fp-session`), so keep using the same browser.
2. Enter a name, pick English, and use a phone number that never signed up before, in E.164 form
   (for example `+15550001111`). There's no SMS code screen. If you'll do section 9, use a real
   phone you hold.
3. Pick a host (Daniel, Oscar or Victoria; Diana for Spanish), then a day and time.
4. On Review, click **"Looks right. Continue"** (this saves the sign-up). On step 6, enter the
   elder handle and the app password, then **"Finish and call now"**: it connects Bluesky first.
   With `PUBLIC_CALLS` off nothing rings; with it on (and his number allowed) the onboarding call
   starts.
5. Get the elderId. Pick one of:
   - In the same browser: DevTools → Application → Local storage → `fp-session` → `elderId`.
   - In the dashboard: Data → `elders` → the newest row with your phone → `_id`.
   - From the CLI (newest first):

     ```bash
     npx convex data elders --limit 3
     ```

   Then set `ELDER_ID` (see section 0).
6. Check that it's connected:

   ```bash
   npx convex run accounts:status "{elderId:'$ELDER_ID'}"
   ```

   You want `[{ platform: "bluesky", handle: "fp-walter-test.bsky.social", status: "connected", connectedAt: <ms> }]`.
   In the dashboard, the `elderAccounts` row has `status: "connected"` and `secret` (ciphertext +
   iv). The password is never stored in plain text.

## 3. Path B: quick (demo account from env)

Skip the website: an elder who **never connected** an account posts to the env account.

```bash
npx convex env set BLUESKY_HANDLE fp-walter-test.bsky.social
```

```bash
npx convex env set BLUESKY_APP_PASSWORD xxxx-xxxx-xxxx-xxxx
```

```bash
npx convex env set DEMO_ACCOUNT_FALLBACK on
```

> ⚠️ While this is on, **every** elder without his own connected account posts to this account
> (thread replies too). Turn it off in cleanup.

Make a throwaway elder. Section 4's `elders:seed` command creates him; its output is his
elderId. `accounts:status` returns `[]` for him: that's expected.

## 4. Make a story post without a phone call

### 4.1 Make him `active` with a usable profile

`elders:seed` (internal mutation) upserts **by phone**. For Path A, use the **same phone and
name** you used on the website: it updates that row. For Path B, use any new number. A profile
with `industry` or `specialty` sets `stage: "active"`.

```bash
npx convex run elders:seed "{name:'Test Walter',phone:'+15550001111',profile:{industry:'Baking',specialty:'Bakery owner'}}"
```

It prints the elderId. Set `ELDER_ID` if you haven't.

Dashboard alternative: on his `elders` row, set `stage` to `"active"` **and** add
`profile: {"industry":"Baking"}`. `active` with no usable profile still gets onboarding calls.

The seeded call itself doesn't check `stage`. But `active` is what the daily engagement read
(section 6) and a real story call (section 9) need.

### 4.2 Seed the ended call (`tests/fixtures/story_call.json`)

`pipeline:seedEndedCall` (internal mutation). Its args are `elderId`, `kind`, `turns`, and
optionally `summary`, `endReason`, `cartesiaCallId`, `allowPost`. The fixture has exactly these
fields, with `elderId: "REPLACE_WITH_ELDER_ID"`. The command returns the new callId and
schedules `pipeline:processCall`. The CLI has no `--file` flag, so the file is turned into the
arg.

bash / Git Bash (needs `node`):

```bash
npx convex run pipeline:seedEndedCall "$(node -e "const f=JSON.parse(require('fs').readFileSync('tests/fixtures/story_call.json','utf8'));f.elderId=process.argv[1];console.log(JSON.stringify(f))" "$ELDER_ID")"
```

PowerShell: turn it into JSON5 with single quotes, so no double quotes reach `npx`. This works
in 5.1 and 7.x.

```powershell
$f = Get-Content tests/fixtures/story_call.json -Raw | ConvertFrom-Json; $f.elderId = $ELDER_ID; $a = ($f | ConvertTo-Json -Depth 5 -Compress) -replace "'", "\'" -replace '"', "'"; npx convex run pipeline:seedEndedCall $a
```

No-shell alternative: Dashboard → Functions → `pipeline:seedEndedCall` → Run function. Paste the
fixture's JSON with your elderId in place of `REPLACE_WITH_ELDER_ID`.

Watch it (2–4 min: memories and post together, 3 drafts, the judge, at most 1 rewrite):

```bash
npx convex logs
```

Wait for `pipeline.processCall: call <id> story done ["memories:ok","post:ok","reply:ok","plan:ok"]`.
The `reply` step is a no-op for the fixture, because its question didn't come from an online
thread.

### 4.3 Review it (`AUTO_POST=off`)

Get the post (newest first) and set `POST_ID` to its `_id`:

```bash
npx convex data posts --limit 1
```

Expect `status: "pending"`, `language: "en"` and `quality: { score, passed: true, rounds, notes }`.

Open the review page (the key comes from `npx convex env get POSTS_PAGE_KEY`):
`https://hip-dodo-105.convex.site/posts?key=<POSTS_PAGE_KEY>`

Check these:

- The label says **"Saved (not posted)"**.
- The thread shows as `1/N … N/N` with N = 3–5. Post 1 is the hook. The last post ends with the
  AI line.
- The quality line reads **"Quality: NN/100 (passed)"**. The bar is 75, and no criterion may be
  under 5.
- Optional: "Fact-check now" runs the fact-check alone. Nothing is posted.

### 4.4 Post it

Which command depends on `posts.status`:

| status | command |
|---|---|
| `pending` (`AUTO_POST=off`) or `failed` | `publish:publishPost`: runs the fact-check, then posts |
| `needs_review` (held: `heldFor` quality / thread_fit / guard) | `publish:approvePost`: a guard hold goes out as is; a quality or thread-fit hold is fact-checked first |

```bash
npx convex run publish:publishPost "{postId:'$POST_ID'}"
```

```bash
npx convex run publish:approvePost "{postId:'$POST_ID'}"
```

The `/posts` page also prints the right command for each post.

## 5. What success looks like

`publishPost` returns
`{ status: "published", platforms: { bluesky: "posted", threads: "skipped", x: "skipped", reddit: "skipped", linkedin: "skipped" } }`.

- **`posts` row:** `status: "published"`, `guardPassedAt` set, `guardIssues: []`.
- **`postPublications`:** check the rows with this command.

  ```bash
  npx convex data postPublications --limit 5
  ```

  The Bluesky row has `status: "posted"`, `url: https://bsky.app/profile/<handle>/post/<rkey>`
  (post 1), `records` with 3–5 `{uri, cid}` (root first) and `postedAt`. The other 4 rows are
  `skipped`, with the reason in `error`.
- **bsky.app:** open the `url`. You should see a 3–5 post thread from the test account, each post
  replying to the one before, with hashtags as links.
- **The AI note:** the last post ends with
  *"I told this story in a phone interview with Front Porch. It was written up with AI from my own words."*
- **`/posts`:** the Bluesky row shows Published, with the link.

## 6. Feedback test (do this before undo)

Undo marks the rows `removed`, and only `posted` rows are read, so do this first.

1. From the **reader** account, reply to any post in the thread with a question, for example
   "How did you end up hiring Eddie?". Like post 1 too. Wait about a minute.
2. Read the engagement (internal action):

   ```bash
   npx convex run blueskyEngagement:scrapeForElder "{elderId:'$ELDER_ID'}"
   ```

   You want `{ threads: 1, upserted: 1, likes: 1, reposts: 0, replies: 1, gone: 0, errors: [] }`.
   It only counts replies from others; his own posts aren't counted.
3. Check the `engagement` row:

   ```bash
   npx convex data engagement --limit 1
   ```

   It has `platform: "bluesky"`, `linkedinUrl` = the bsky.app link (the field name is from before
   Bluesky), `reactions` (likes + reposts on post 1), `comments: [{author, text}]`, `postId` and
   `changedAt`.
4. Check the question bank refresh. A changed row on a post from the last 48 h schedules
   `conversation:refreshQuestionBank` right away (at most one start per 30 s per elder; a change
   during that gap gets a trailing refresh). Older posts: 2 min later, 10 min apart.
   `elders.lastBankRefreshAt` is when the last scheduled one runs. After a minute, check the bank:

   ```bash
   npx convex data questionBank --limit 12
   ```

   You want fresh `queued` rows, with a `source: "reader"` row built from the reply on top (a
   reader question from the last 48 h ranks above everything else). Also check that
   `questionBankMeta` has a new `refreshedAt`, `feedbackLine` and `resonated`. To skip the wait:

   ```bash
   npx convex run conversation:refreshQuestionBank "{elderId:'$ELDER_ID'}"
   ```

   See what the host would ask next:

   ```bash
   npx convex run conversation:planNextCall "{elderId:'$ELDER_ID'}"
   ```

You don't have to run step 2 by hand: posts from the last 2 h are read every 30 s and posts up
to 48 h old every 5 min (crons "fresh engagement" and "recent engagement"; Bluesky + Threads,
never X). The daily cron (13:15 UTC) still reads 30 days of posts for every `active` elder.

## 7. Undo test

`undo:removePost` (internal action) takes `postId` and an optional `reason`:

```bash
npx convex run undo:removePost "{postId:'$POST_ID',reason:'live test cleanup'}"
```

It returns `{ removed: [...], failed: [], manual: [], waiting: [] }`.

- **bsky.app:** reload the thread URL. Every post of the thread is gone, and the link shows
  "post not found".
- **`posts` row:** `status: "removed"`, `removedAt`, `removedReason: "live test cleanup"`.
- **`postPublications`:** all 5 rows are `status: "removed"` (the skipped ones too).
- If `failed` isn't empty, it retries by itself (3 tries in all). Running it again is safe.
- `/posts` shows the post as removed.

On a call, the host's take-down line runs `undo:removeLatest` for his newest post
(`npx convex run undo:removeLatest "{elderId:'$ELDER_ID'}"` by hand).

## 8. Second post (optional)

Run section 4.2 again: each seed is a new call and a new post. To see a post go out by itself,
set `AUTO_POST` to `on` first. Turn it back off after.

## 9. Optional: a real phone call

Needs `CARTESIA_API_KEY`, `CARTESIA_FROM_NUMBER_ID`, the hosts' voices
(`CARTESIA_VOICE_ID_DANIEL`, `CARTESIA_VOICE_ID_OSCAR`, `CARTESIA_VOICE_ID_VICTORIA`;
`CARTESIA_VOICE_ID_DIANA` is required before Diana's agent is first created) and
`CARTESIA_TOOL_SECRET` (inbound). His `phone` must be a phone you hold. On a trial
Twilio/Cartesia number, it must be a verified one.

When prompts change, re-sync the agents (`cartesiaAgents:syncAgent`, internal action). With no
args it syncs every host (daniel, oscar, victoria, diana), and the inbound agent too once both
of its ids are set:

```bash
npx convex run cartesiaAgents:syncAgent
```

One host only:

```bash
npx convex run cartesiaAgents:syncAgent "{characterId:'daniel'}"
```

The inbound agent + its lookup tool (created if missing), and route the number's inbound calls
to it (`assignNumber`). The agent speaks as `CARTESIA_INBOUND_HOST` (default `daniel`): set it
to the demo elder's host first, with that host's `CARTESIA_VOICE_ID_<HOST>` set.

```bash
npx convex env set CARTESIA_INBOUND_HOST oscar
npx convex run cartesiaAgents:syncAgent "{inbound:true,assignNumber:true}"
```

If it prints `npx convex env set CARTESIA_LOOKUP_TOOL_ID ...` / `CARTESIA_INBOUND_AGENT_ID ...`,
it created new ones (those env vars weren't set). Run the printed lines. Changing the host
later: set the env var, re-sync `"{inbound:true}"` (no `assignNumber` needed).

After a test call-in, what the lookup tool got (no numbers; newest first):

```bash
npx convex run inbound:lastLookups "{limit:3}"
```

`known story` is the happy path. `unknown no_elder` = the caller's number isn't an elder's
(check `elders.phone`); `unknown no_caller_id` = the number was withheld; `error unauthorized` =
the tool's bearer secret doesn't match `CARTESIA_TOOL_SECRET` (re-sync `{inbound:true}`);
`error not_verified:...` = Cartesia didn't show a live call from that number on
`CARTESIA_INBOUND_AGENT_ID`. No row at all = the tool was never called (check the agent's
tools in the Cartesia dashboard, and re-sync).

Then give the host a plan, and call:

```bash
npx convex run conversation:refreshQuestionBank "{elderId:'$ELDER_ID'}"
```

```bash
npx convex run cartesia:startCall "{elderId:'$ELDER_ID'}"
```

It returns `{status: "started", kind: "story", ...}`. `kind: "onboarding"` means he isn't
`active` with a profile. Talk for 2+ minutes, tell one story (more than 30 words from you), then
hang up. The call goes `queued → in_progress → ended → done` (polled every 15 s, 3 s with `FAST_POST=on`). After that,
continue from section 4.3.

## 10. Troubleshooting

| What you see | Cause | Fix |
|---|---|---|
| Website: "Bluesky did not accept that username and password" (`wrong_password`) | Typo in the handle, or the app password was revoked | Use the full handle (`name.bsky.social`). Make a new app password |
| Website: "please use an app password, not your regular password" | His main password, or not the `xxxx-xxxx-xxxx-xxxx` shape | Make an app password (section 1) |
| Website: "That app password can read your private messages" | The DM access box was checked | Make a new one without DM access |
| Website: "Something went wrong on our side" (`failed`) | `ACCOUNTS_ENC_KEY` missing or malformed (logs: `connectBluesky: ACCOUNTS_ENC_KEY ...`) | Set it (section 1), then connect again |
| Website jumps to done, but `accounts:status` is `[]` | He was already `active`: connect is **locked** and the page treats that as done | On his `elders` row set `stage` to `"onboarding"`, connect again in the **same browser** (the token is in localStorage `fp-session`), then section 4.1. Another browser, or site data cleared (token lost)? Sign up again with a new phone |
| Website: too many tries | 5 tries an hour per sign-up and per handle, 5 s apart | Wait |
| Website: "already signed up" | That phone is in `elders` | Use a new number |
| `seedEndedCall`: "This fixture could post publicly…" | `AUTO_POST` isn't `off` | `npx convex env set AUTO_POST off` (or add `allowPost:true`) |
| Post `failed`: "Nowhere to post…", Bluesky row `skipped`: "His Bluesky account isn't connected." | No usable login: not connected, account `invalid`, `ACCOUNTS_ENC_KEY` changed (logs: `Bluesky secret could not be read (check ACCOUNTS_ENC_KEY)`), or Path B without `DEMO_ACCOUNT_FALLBACK=on` + both env vars | Fix the login, then run `publish:publishPost` again (`failed` can be re-run) |
| Bluesky row `failed`, `elderAccounts.status: "invalid"` | Bluesky refused the login (app password revoked) | Reconnect (see the "locked" row above) |
| `needs_review`, `/posts` says "Held by fact-check" + issues | The fact-check found claims not in the call | Read the issues. `publish:approvePost` posts it as is |
| Fact-check issue "OPENAI_API_KEY is not set in Convex…" | Missing key | Set it. Click "Fact-check now" on `/posts`, then `publish:approvePost` |
| `needs_review`, "Held: below the quality bar" | Score under 75 (or one criterion under 5) after 1 rewrite | `publish:approvePost` (fact-checks first), or seed again |
| `needs_review`, "Held: too long for a Bluesky thread" | Can't fit 5 posts of 300 characters (AI line included) | Shorten `posts.text` in the dashboard (keep the paragraphs), then `publish:approvePost`. It refuses until the text fits |
| `publishPost`: "Held for review. Read it, then run publish:approvePost." | Post is `needs_review` | Use `approvePost` |
| Bluesky row `maybe_posted` | Timeout after the request went out | Check his profile, then `npx convex run publish:retryPublication "{publicationId:'<id>',approve:true}"` |
| Call row `process_failed`, "story steps failed: post" | Usually OpenAI (key, model, timeout) | `npx convex logs`, then `npx convex run pipeline:processCall "{callId:'<calls id>'}"` (safe: memories and the post are reused) |
| Call `done` but no `posts` row | The writer found no story and declined (the reason isn't logged) | Check the transcript. Seed again |
| `/posts` returns 404 | `POSTS_PAGE_KEY` unset or the wrong key | `npx convex env get POSTS_PAGE_KEY` |
| Real call is an onboarding call (no post) | Elder not `active`, or no `industry`/`specialty` | Section 4.1 |
| `startCall`: "No Cartesia agent for character…" / "… is not set" | Agents not synced, or missing Cartesia env | Section 9 |
| `scrapeForElder` returns `threads: 0` | No `posted` Bluesky row in the last 30 days (removed rows aren't read) | Post again (section 8) |
| He called in, but it was an onboarding call | His onboarding call wasn't processed yet, was too short, or left no `industry`/`specialty` | Wait a minute after the first call; check `stage` and `profile` on his `elders` row |
| The next call didn't mention the reply | He called before the refresh finished (about a minute after the reply), or `engagement` has no new comment | Check `questionBankMeta.refreshedAt` and `feedbackLine`, then call again |

## 11. Cleanup

1. Make sure nothing posts by itself:

   ```bash
   npx convex env set AUTO_POST off
   ```

2. Take down every test post. Find them on `/posts` or with `npx convex data posts`, then:

   ```bash
   npx convex run undo:removePost "{postId:'$POST_ID'}"
   ```

3. Stop the test elder's weekly call. Website sign-ups get a slot for tomorrow at 10:00 local,
   and the hourly cron calls `active` elders. On his `elders` row, delete `callDay`, or delete
   the row.
4. Path A: drop the saved app password, then revoke it in Bluesky (Settings → App passwords):

   ```bash
   npx convex run accounts:disconnect "{elderId:'$ELDER_ID',platform:'bluesky'}"
   ```

5. Path B: turn the demo account off:

   ```bash
   npx convex env remove DEMO_ACCOUNT_FALLBACK
   ```

6. Leave `ACCOUNTS_ENC_KEY` as it is.
