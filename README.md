# Front Porch

**An AI interviews an older professional over the phone and turns their stories into LinkedIn posts. No app, no screen, no passwords.**

Pip, a warm AI phone host, calls once to get to know them: their industry,
what they specialised in, how their career went. Then it calls every week with
a few short, open questions and lets them talk. Their stories become LinkedIn
posts in their own words. Pip reads the reactions and comments those posts get
and brings them into the next call ("A reader asked how you priced bread back
then...").

Built at Cal Hacks 13.0.

> **Status:** v2 structure only. See **[ARCHITECTURE.md](ARCHITECTURE.md)** for
> the loop, contracts, data model, locked decisions and who owns what.

## Stack

| Piece | Tech |
|---|---|
| Backend, database, vector memory, crons | Convex (`convex/`) |
| Live call (number, speech-to-text, in-call LLM, voice) | Cartesia Managed Agents (`voice/`, `convex/cartesia.ts`) |
| Planning questions, writing posts, memory extraction | OpenAI `gpt-6-luna` (`OPENAI_MODEL`) |
| Embeddings | OpenAI `text-embedding-3-small` |
| Posting | LinkedAPI (their own LinkedIn account) |
| Reader feedback (reactions, comments) + profile prefill | Apify |

## Setup

```bash
npm install
npx convex dev          # log in, pick the team project; keep it running
npx convex env set OPENAI_API_KEY <value>   # repeat for each key
```

Keys: [ARCHITECTURE.md → Env vars](ARCHITECTURE.md#env-vars-all-in-convex).
Cartesia setup: [voice/README.md](voice/README.md). How Pip talks:
[voice/conversation-guide.md](voice/conversation-guide.md).
Demo data (their phone, LinkedIn URL, call time) is added by hand in the Convex dashboard.

## Accounts

Each person posts from **their own** Bluesky account, connected on the sign-up page with an
app password (never their real password). It's stored encrypted (`ACCOUNTS_ENC_KEY`, make one
with `openssl rand -base64 32`) and only decrypted inside the action that posts. Reddit is
coming soon. A shared demo account is used only with `DEMO_ACCOUNT_FALLBACK=on`. Details:
[ARCHITECTURE.md → Accounts](ARCHITECTURE.md#accounts-his-own-bluesky-from-sign-up).

## Safety

- Posts use **only what the person said**; the prompt forbids adding facts or advice.
- Pip doesn't give or ask for medical, legal or financial advice, and doesn't push on painful topics.
- Every post says it was written up with AI from a phone call.
- Posts go out automatically after a fact-check against the call. A post that fails the
  check is held as `needs_review` instead of posted; someone reviews held posts after each call.
- LinkedAPI automates a personal account, which LinkedIn's terms don't allow. Use an
  account whose owner agrees and accepts that risk.

## History

v1 (online questions answered via a Twilio `<Gather>` flow, FastAPI backend,
React dashboard) lives in commit `9e67aab`. What's worth porting is listed in
[ARCHITECTURE.md → Port from v1](ARCHITECTURE.md#port-from-v1).
