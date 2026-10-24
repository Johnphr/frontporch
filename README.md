# Front Porch

**Older adults answer real questions from the internet with a phone call. No app, no screen, no passwords.**

Millions of people ask online for advice that someone's grandparent could give in 30 seconds. Front Porch finds those questions, calls an older adult who knows the topic, and lets them answer by talking. An AI writes the answer up from their own words, reads it back, and posts it only when they say yes. When people reply, Pip, the host, reads the thank-yous to them on their next call.

Built at Cal Hacks 13.0.

## How it works

```
 Apify ──► real questions (Reddit, Quora, forums)
              │
              ▼
 Claude triage: skip unsafe ones, tag topics, match to an elder
              │
              ▼
 Twilio call ◄──► Pip (Cartesia voice)  "Someone asked... what would you tell them?"
              │        elder answers by voice (Twilio speech-to-text)
              │        Claude asks up to 2 follow-ups if a detail is missing
              ▼
 Claude drafts the post from ONLY what they said  ──►  Pip reads it back: "Should I post it?"
              │ yes
              ▼
 Publish: own feed · Bluesky · LinkedIn · drafts for Reddit / Quora / forums
              │
              ▼
 Replies come back ──► Pip reads them on the next call
```

All state lives in **Convex**, so the dashboard updates live while a call is happening.

## Stack

| Piece | Tech | Where |
|---|---|---|
| API + call flow | Python 3.11, FastAPI | `backend/app` |
| Phone calls | Twilio Voice (`<Gather input="speech">`) | `backend/app/routes/twilio.py` |
| Pip's voice | Cartesia Sonic TTS | `backend/app/voice.py` |
| Reasoning | Claude (`claude-opus-5-5`) with structured outputs | `backend/app/llm.py` |
| Finding questions | Apify Actors | `backend/app/services/questions.py`, `backend/question_sources.json` |
| Database (real-time) | Convex | `frontend/convex` |
| Publishing | Bluesky (atproto), LinkedIn Posts API, Reddit (PRAW), Discourse API | `backend/app/services/publishers` |
| Feed + dashboard | React + Vite + TypeScript | `frontend/src` |

## Where answers get posted

| Platform | Status | Why |
|---|---|---|
| Own feed | Auto-posts | Always works, no approval needed |
| Bluesky | Auto-posts | Open API, app password |
| LinkedIn | Auto-posts to the connected member's profile | Self-serve "Share on LinkedIn" product, `w_member_social` scope |
| Reddit | **Draft** (a person posts it) | Since Nov 2025, new Reddit API apps need manual approval (Responsible Builder Policy), and many subreddits ban AI-written replies. Flip `REDDIT_POSTING_ENABLED=true` only with an approved app and a subreddit that allows it |
| Quora | **Draft** | Quora has no public posting API |
| Forums (Discourse) | Auto-posts with an API key, otherwise draft | Per-forum API keys |

Drafts show up in the dashboard with **Copy text** and **Open question** buttons. Every post ends with a disclosure line: answered over a phone call, written up with AI from the person's own words.

## Setup

### 1. Convex (database)

```bash
cd frontend
npm install
npx convex dev          # log in, create a project; writes VITE_CONVEX_URL to .env.local
npx convex env set BACKEND_SECRET <long-random-string>
```

Keep `npx convex dev` running in its own terminal.

### 2. Backend

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate          # macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
copy .env.example .env          # macOS/Linux: cp .env.example .env
```

Fill in `.env`. At minimum for a call: `ANTHROPIC_API_KEY`, `CONVEX_URL`, `CONVEX_BACKEND_SECRET` (same value as in Convex), Twilio keys, and `PUBLIC_BASE_URL`.

```bash
uvicorn app.main:app --reload --port 8000
```

API docs: http://localhost:8000/docs

> Windows note: if `pip`/`venv` fails with "path not found", your folder path is too long. Clone the repo somewhere short like `C:\dev\frontporch`.

### 3. Public tunnel (Twilio needs to reach your laptop)

```bash
ngrok http 8000
```

Put the `https://...` URL in `PUBLIC_BASE_URL` and restart the backend. Twilio signs the exact URL it calls, so they must match.

### 4. Twilio

1. Buy a phone number (trial accounts can only call verified numbers, so verify your teammates' phones).
2. Phone number → Voice configuration → "A call comes in" → Webhook → `https://<your-tunnel>/twilio/voice` (HTTP POST).
3. Elders can call that number, or press **Call now** in the dashboard to have Pip call them.

### 5. Frontend

```bash
cd frontend
copy .env.example .env.local    # VITE_CONVEX_URL is already there if convex dev wrote it
npm run dev
```

- Feed: http://localhost:5173/#/
- Dashboard: http://localhost:5173/#/dashboard

### 6. Optional integrations

- **Cartesia:** without a key, Pip falls back to Twilio's built-in voice. Pick a voice at play.cartesia.ai and set `CARTESIA_VOICE_ID`.
- **Apify:** set `APIFY_TOKEN`. Sources are in `backend/question_sources.json`. Each Actor has its own input format, so check the Actor's *Input* tab in the Apify Store and adjust `input` and `fields`. The Quora source is disabled until you pick an Actor.
- **Bluesky:** create an app password (Settings → Privacy and security → App passwords).
- **LinkedIn:** create an app, add the "Share on LinkedIn" and "Sign In with LinkedIn using OpenID Connect" products, generate a token with `w_member_social`, and get your person id from `GET https://api.linkedin.com/v2/userinfo` (`sub` field) → `LINKEDIN_AUTHOR_URN=urn:li:person:<sub>`. `LINKEDIN_VERSION` is a `YYYYMM` string; LinkedIn retires versions after about a year, so update it if you get a version error.

## Demo flow (3 minutes)

1. **Dashboard → Find questions with Apify** (or type one in with the manual form as a backup). Claude assigns it to an elder.
2. **Call now.** A teammate's grandparent (or a teammate playing one) picks up. Pip asks the question; they answer out loud. The transcript appears live in the dashboard.
3. Pip reads back the summary: "Should I post it?" → "Yes."
4. The answer appears on the **Feed** and on Bluesky.
5. **Simulate a thank-you reply** in the dashboard, call again, and Pip opens with "Good news first: Jake wrote back..."

Keep a screen recording of a full run as a backup in case the venue Wi-Fi fails.

## Safety and ethics

- Claude skips questions that need a licensed professional (medical, legal, financial decisions), crisis or self-harm topics, and requests for personal info.
- The written answer uses **only what the person said**; the prompt forbids adding facts or advice.
- Nothing is posted without a spoken "yes".
- Every post discloses that it was written up with AI from a phone call.
- Elders never get DMs; public queries never expose phone numbers.

## Known limits (good first tasks)

- **Pip's spoken lines are English.** The elder's `language` sets the voice and speech recognition, but the prompts in `backend/app/routes/twilio.py` are hard-coded English. Translate them (or have Claude generate them) for Spanish-speaking elders.
- **Live call state is in memory** (`backend/app/services/calls.py`), so run one backend process. Transcripts and drafts are saved to Convex either way.
- **Twilio speech recognition suits answers of up to about a minute.** For longer stories, switch to `<Record>` plus a transcription step.
- **Replies are added by hand** in the dashboard ("Simulate a thank-you reply"). Pulling real Bluesky replies would be the next step.
- **The dashboard and API have no login.** That's fine for a demo; don't deploy it publicly as is.
- `frontend/convex/_generated` appears after your first `npx convex dev`. The frontend uses `anyApi` until then (see `frontend/src/convexApi.ts`).

## Repo layout

```
backend/
  app/
    main.py              FastAPI app
    config.py            env settings
    db.py                Convex client wrapper
    llm.py               Claude: triage, follow-ups, drafting
    voice.py             Cartesia TTS
    twiml.py             TwiML helpers
    routes/twilio.py     the phone call
    routes/api.py        dashboard API
    services/            calls, questions (Apify), publishing, publishers/
  question_sources.json  Apify sources
  tests/
frontend/
  convex/                schema + functions (database)
  src/                   React feed + dashboard
```

## Team split (suggested)

- **AI:** prompts in `backend/app/llm.py`, follow-up quality, triage rules.
- **Voice/phone:** Twilio + Cartesia setup, call pacing, voice choice.
- **Design:** feed and dashboard (`frontend/src`), Pip's character, Figma.
- **Integrations:** Apify sources, Bluesky/LinkedIn accounts, demo data.
