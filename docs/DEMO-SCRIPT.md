# Front Porch: demo video script

Two minutes for Devpost, plus a 30-second cut. Everything shown here is built. Record it
ahead of time; don't count on a live call at the judging table.

**Cast:** "Walter", an older professional (a real relative who has agreed to be filmed and
posted, or a teammate playing him), and a family member helping him sign up. Use his real
first name in the recording; "Walter" is a placeholder.

**Voice-over:** calm and unhurried, about 2.5 words a second. Let Pip's and Walter's own voices
carry the middle of the video.

---

## Demo flow (no terminal)

The whole loop runs by itself once the env below is set. Nobody types a command during the demo.

1. **Sign up** on the website: who → name → language + host (Daniel, Oscar, Victoria; Diana in
   Spanish) → day + time → Review **"Looks right. Continue"** → step 6: Bluesky handle + app
   password → **"Finish and call now"**. The host calls. This is the **onboarding** call (get
   to know him, no post). Talk for a couple of minutes (more than 30 words from him), then hang
   up. About a minute later he is `stage: "active"` with a profile, and his question bank is filled.
   - If he hangs up too soon (no real conversation) or the profile comes out empty, he stays in
     onboarding, and his next call (an inbound one too) is another onboarding call.
2. **He calls the Front Porch number himself.** The inbound agent looks him up
   (`/cartesia/inbound-lookup`) and runs a **story** call with today's plan: the bank's top
   question, his memories, the latest feedback line. Wait a minute after step 1 before calling,
   or it's still the onboarding call.
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
| `ACCOUNTS_ENC_KEY` | set once, never changed (docs/LIVE-TEST-BLUESKY.md, section 1) |
| `OPENAI_API_KEY` | set |
| `PUBLIC_CALLS` + `CALL_ALLOWLIST` | `on` + the demo phone in E.164 (`+1415...`; comma-separated for more) |
| `SIGNUP_SITE_URL` | the sign-up site URL (where Threads / X connect sends him back) |
| `CARTESIA_API_KEY`, `CARTESIA_FROM_NUMBER_ID` | set (outbound calls) |
| `CARTESIA_INBOUND_AGENT_ID`, `CARTESIA_LOOKUP_TOOL_ID`, `CARTESIA_TOOL_SECRET` | the inbound agent, its lookup tool, and the tool's bearer secret |

The Front Porch number must route its inbound calls to the inbound agent in Cartesia (in the
Cartesia dashboard, or once with `cartesiaAgents:syncAgent "{inbound:true,assignNumber:true}"`;
see docs/LIVE-TEST-BLUESKY.md, section 9). The host agents and the inbound agent must be synced
with the current prompts (same section).

If something looks stuck, check in the Convex dashboard (Data): `calls` (the newest row reaches
`done`), `posts` / `postPublications` (`posted`, with the `url`), `engagement` (the reply in
`comments`), `questionBankMeta` (`feedbackLine`, `refreshedAt`) and `questionBank` (a `queued`
row with `source: "reader"` on top).

The script below predates the current hosts and timing: "Pip" is now one of Daniel, Oscar or
Victoria (English) and "Juanito" is Diana (Spanish); "Call me now" is "Finish and call now";
and replies are read within a minute, not once a day.

---

## 2-minute version

| Time | On screen | Voice-over / audio |
|---|---|---|
| 0:00–0:08 | Close-up: a phone ringing on a kitchen table. Walter picks up. | *(Call audio)* Pip: "Hi Walter, it's Pip from Front Porch. Is now a good time for a little chat?" |
| 0:08–0:18 | Walter on the call, smiling. Title card fades in: **Front Porch**. | VO: "Walter spent forty years running a bakery. People ask online every day about what he knows. He's never going to download an app to answer them." |
| 0:18–0:32 | Screen recording of the sign-up page, sped up: name + English, phone number, "Who would you like to call you?" (Pip / Juanito), Connect Bluesky with an app password, "All set", **Call me now**. His granddaughter is typing; Walter is next to her. | VO: "So his granddaughter signs him up once. His name, his number, who should call him: Pip in English, or Juanito in Spanish. His own Bluesky account, with an app password, not his real one. Then: call me now." |
| 0:32–0:42 | The page's call status: "Your phone is ringing, or you are on the call." Cut to Walter on the phone (first call). | VO: "The first call is just getting to know him: where he started, what he got good at." *(Call audio, short)* Walter: "I started sweeping floors at my uncle's bakery when I was fourteen..." |
| 0:42–0:55 | Split screen: the real online question (a Reddit or Stack Exchange post, e.g. "How do small bakeries decide what to charge?") next to Walter on the weekly call. | VO: "Every week after that, Pip calls with one good question. Often it's a real one, asked online by a stranger." *(Call audio)* Pip asks it in his own words. Walter answers. |
| 0:55–1:12 | His Bluesky profile: the new thread, post 1 then scroll through posts 2–4. Zoom on the last post's AI note: "I told this story in a phone interview with Front Porch. It was written up with AI from my own words." | VO: "After the call, his story becomes a short thread on his own account. Three drafts, a judge, a rewrite, and then a fact-check against the call: if he didn't say it, it isn't posted. And every post says it was written up with AI." |
| 1:12–1:24 | A reader's reply appears under the thread (from a second Bluesky account): "How did you price bread when flour prices jumped?" Likes ticking up. | VO: "Then people answer. Once a day, Front Porch reads the likes and the replies on his posts." |
| 1:24–1:42 | Next weekly call. Walter on the phone, listening, then laughing. | *(Call audio)* Pip: "A reader asked how you priced bread back then, when flour went up. What would you tell her?" Walter starts answering. VO (over the tail): "And the next call starts from them." |
| 1:42–1:55 | A short call. Walter: "Pip, please take my last post down." Pip: "Of course. I'll have your most recent post taken down right after our call." Cut to his Bluesky profile refreshing: the thread is gone. | VO: "And if he changes his mind, he just says so. No passwords, no menus. It comes down after the call." |
| 1:55–2:00 | End card: **Front Porch**. "He talks on the phone. His stories find readers." Small line: Convex · Cartesia · OpenAI · Bluesky. | VO: "Front Porch. His stories, in his words, on his own accounts." |

About 200 words of voice-over (about 80 seconds at an easy pace); the rest is call audio. If it runs long, trim the 0:55 line first.

**Things not to show or say:** posting to X or Reddit (X is off by default and costs per
post; Reddit waits on API approval), Threads answers to strangers (waits on Meta's app
review), or that the page verifies his phone (the SMS code screen is switched off).

---

## 30-second version

| Time | On screen | Voice-over / audio |
|---|---|---|
| 0:00–0:05 | Phone rings, Walter answers. | Pip: "Hi Walter, it's Pip from Front Porch." |
| 0:05–0:12 | Sign-up page, very fast: name, phone, Pip, Bluesky, Call me now. | VO: "Sign him up once. Then an AI host calls him every week with one good question." |
| 0:12–0:20 | His Bluesky thread, ending on the AI note. | VO: "His story becomes a fact-checked thread on his own account, in his words, marked as written with AI." |
| 0:20–0:26 | Reader reply, then Pip on the next call: "A reader asked how you priced bread back then..." | VO: "Readers' questions come back on the next call." |
| 0:26–0:30 | "Pip, please take my last post down." End card. | VO: "And he can take any story back, just by asking. Front Porch." |

Note for the last line: by phone only his **most recent** post can come down. If you want to be
exact, say "he can take his last post back, just by asking."

---

## Shot list

| # | Shot | Type | Source |
|---|---|---|---|
| 1 | Phone ringing on a table, Walter answers | Camera | Film during the first real call (shot 4) |
| 2 | Walter and his granddaughter at the laptop | Camera | Film during the sign-up (shot 3) |
| 3 | Sign-up page, all four steps + "Call me now" + call status | Screen recording | Local dev site or the Vercel deploy |
| 4 | First call (onboarding), 10 s of Walter talking about his start | Phone audio + camera | Call A |
| 5 | The online question that the weekly call starts from | Screen recording | The Reddit / Stack Exchange page from `audienceQuestions` |
| 6 | Weekly call: Pip asks the online question, Walter answers | Phone audio + camera | Call B |
| 7 | The Bluesky thread on his profile, scrolled, zoom on the AI note | Screen recording | bsky.app |
| 8 | `/posts` review page for the same post (optional B-roll: drafts, fact-check status, platform rows) | Screen recording | `https://<deployment>.convex.site/posts?key=...` |
| 9 | A reader's reply under the thread | Screen recording | A second Bluesky account |
| 10 | Next call: Pip reads the reader's question | Phone audio + camera | Call C |
| 11 | Take-down request and Pip's exact line | Phone audio + camera | Call D (or the end of call C) |
| 12 | His profile refreshed: the thread is gone | Screen recording | bsky.app |
| 13 | End card | Graphic | — |

**Recording the phone audio:** put the phone on speaker and record with a second device, or
use a call-recording app. Tell Walter the call is being recorded before each call: the agent's
greeting doesn't say it (see DEVPOST.md → Safety & consent), and some places require everyone
on the call to agree.

---

## What to record beforehand, and how to stage each shot

Commands are from `README.md`, `ARCHITECTURE.md`, `convex/README.md`,
`voice/README.md` and `frontend/onboarding-ui/README.md`. Run them from the repo root against the
deployment you'll demo on. `<id>` values come from the Convex dashboard (Data → `elders`,
`calls`, `posts`).

### 0. Once, before anything

```bash
npm install
npx convex dev                                            # keep running

# Keys (see ARCHITECTURE.md → Env vars)
npx convex env set OPENAI_API_KEY <key>
npx convex env set CARTESIA_API_KEY <key>
npx convex env set CARTESIA_FROM_NUMBER_ID <ap_...>
npx convex env set CARTESIA_VOICE_ID_ES <spanish voice id>  # required before Juanito syncs
npx convex env set APIFY_TOKEN <token>
npx convex env set STACKEXCHANGE_KEY <key>                # set it for the demo (shared IP limits)
npx convex env set ACCOUNTS_ENC_KEY "$(openssl rand -base64 32)"   # before anyone connects Bluesky
npx convex env set SIGNUP_SITE_URL <the sign-up site URL>

# Let the page ring Walter's number only
npx convex env set PUBLIC_CALLS on
npx convex env set CALL_ALLOWLIST "+1415..."              # Walter's number, E.164

# The /posts review page (shot 8)
npx convex env set POSTS_PAGE_KEY <long random string>

# One Cartesia agent per character (Pip, Juanito)
npx convex run cartesiaAgents:syncAgent
```

Leave `AUTO_POST` unset (on), so the story posts go out by themselves after the call. Leave
`CALL_INTERVAL_MINUTES` unset; start every call by hand.

**Bluesky:** make or pick Walter's Bluesky account, and a second account for the reader
(shot 9). On Walter's account: Settings → Privacy and security → App passwords → add one
**without** DM access (the page refuses one with DM access).

### Shots 2–3: the sign-up page

```bash
cd frontend/onboarding-ui
npm install
cp .env.example .env.local        # set VITE_CONVEX_URL=https://<deployment>.convex.cloud
npm run dev                       # http://localhost:5173
```

Or the Vercel deploy:
`npx vercel deploy --cwd frontend/onboarding-ui --build-env VITE_CONVEX_URL=https://<deployment>.convex.cloud`.

Pick English (or Español for Juanito), enter Walter's number (it must be in
`CALL_ALLOWLIST`), choose Pip, connect Bluesky, skip Threads/X, then **Call me now**. A number
can sign up only once: for retakes, delete his `elders` row in the dashboard first, or record
the sign-up with a throwaway allowlisted number.

### Shots 1, 4: call A (first call)

"Call me now" places it. Let it run its course (10–20 minutes); you need about 10 seconds of
it. Afterwards, in the dashboard: the `calls` row reaches `done`, and Walter's `elders` row has
a `profile` and `stage: "active"`. If the profile was too thin, the next call onboards again:
just call once more.

### Shots 5–6: call B (weekly call from an online question)

```bash
# Find real questions in his field. Stack Exchange and Reddit get no automatic reply, so
# nothing is posted on a stranger's thread during the demo:
npx convex run apify:findAudienceQuestions '{"elderId":"<id>","keywords":["bakery","small business"],"sources":["stackexchange-search","reddit-search"]}'

npx convex run conversation:refreshQuestionBank '{"elderId":"<id>"}'
npx convex run conversation:planNextCall '{"elderId":"<id>"}'   # read plan.question
```

The ranking puts his unfinished stories first, so the online question may not be on top. If
it isn't, mark the rows above it as `dropped` in the `questionBank` table and run
`planNextCall` again until `plan.question` is the one you want. Screen-record the original
question's page for shot 5 (its link is on the `audienceQuestions` row).

If you'd rather show his answer posted as a **reply** on the question's thread, have the
reader account post the question on Bluesky, run `findAudienceQuestions` with
`"sources":["bluesky-search"]`, and the reply goes on that thread after call B.

```bash
npx convex run cartesia:startCall '{"elderId":"<id>"}'   # phone rings; {status: "started", kind: "story"}
npx convex logs                                          # watch poll -> done
```

### Shots 7–8: the Bluesky thread

Nothing to run: after call B the post is written, fact-checked and posted as a 3–5 post thread
on his account (a few minutes after the call ends). Check it on the review page:
`https://<deployment>.convex.site/posts?key=<POSTS_PAGE_KEY>`.

If it was held (`needs_review`: the quality bar, the fact-check, or too long for 5 posts), read
why on `/posts`, then:

```bash
npx convex run publish:approvePost '{"postId":"<posts id>"}'
```

### Shot 9: a reader reply

From the second Bluesky account, reply under the thread with a real question, and like it.
Then, instead of waiting for the daily cron:

```bash
npx convex run blueskyEngagement:scrapeForElder '{"elderId":"<id>"}'
npx convex run conversation:refreshQuestionBank '{"elderId":"<id>"}'
npx convex run conversation:planNextCall '{"elderId":"<id>"}'   # the feedback line is in the context
```

### Shot 10: call C (the next call brings it up)

```bash
npx convex run cartesia:startCall '{"elderId":"<id>"}'
```

Call B must be fully processed first (`startCall` refuses while a call to him is still open).
Pip shares the reader's feedback near the start of the call.

Call C also writes and posts a new story. If you want the take-down in shot 11 to remove the
**call B** thread (the one with the reader's reply), do the take-down at the end of call C:
the request also holds call C's own post, and "most recent" means his latest post from before
that call.

### Shots 11–12: undo by phone (call D, or the end of call C)

```bash
npx convex run cartesia:startCall '{"elderId":"<id>"}'
```

Walter says plainly: "Pip, please take my last post down." Pip should answer with exactly:
"Of course. I'll have your most recent post taken down right after our call." Only that line,
said right after he asked, deletes anything. A short call is fine. After the call ends and is
processed, his most recent post (and that call's thread replies) comes down from every
platform; refresh his Bluesky profile for shot 12. The `calls` row gets a `takeDown` note.

If Pip doesn't say the exact line, nothing is deleted (the call is only flagged). Retake, or
remove the post by hand for the shot:

```bash
npx convex run undo:removeLatest '{"elderId":"<id>"}'
# or any post:
npx convex run undo:removePost '{"postId":"<posts id>"}'
```

### After recording

```bash
npx convex env remove CALL_ALLOWLIST     # or narrow it again
npx convex env set PUBLIC_CALLS off
```
