# Front Porch

**An AI interviews an older professional over the phone and turns their stories into social posts (Bluesky threads first). No app, no screen, no passwords.**

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
| Posting | Bluesky, as a short thread on their own account (`convex/publish.ts`). Reddit, on their own profile, once Reddit approves the API (`REDDIT_POSTING`). LinkedIn (LinkedAPI) is off (`LINKEDIN_POSTING`) |
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

## X (Twitter)

Off by default: X charges for every post and every read. Code: `convex/xAuth.ts` (connect),
`convex/lib/xPublishing.ts` (posting), `convex/xEngagement.ts` (feedback). Details:
[ARCHITECTURE.md → X](ARCHITECTURE.md#x-twitter).

1. **Make the X app** at developer.x.com: User authentication settings → OAuth 2.0 on,
   type **Web App (confidential client)**, permissions **Read and write**, callback URL
   `https://<deployment>.convex.site/oauth/x/callback` (exactly), website = the sign-up site.
2. **Env:** `X_CLIENT_ID`, `X_CLIENT_SECRET`, `SIGNUP_SITE_URL` (where he lands after connecting),
   `ACCOUNTS_ENC_KEY` (already set for Bluesky). Then the switches, all off by default:
   `X_POSTING=on` (post), `X_THREAD=off` (one post instead of a thread), `X_READ_FEEDBACK=on`
   (read likes/retweets/quotes daily), `X_READ_REPLIES=on` (also read reply texts; costs more).
3. **Credits:** new apps are pay-per-use, no free tier. Buy credits in the developer console.
   Roughly $0.015 per post ($0.20 if it has a link), about $0.005 per post read. A 4-post thread is
   about $0.06. The feedback run logs its estimated reads (`estimatedReads=`).
4. **Automated label:** each person turns on X's "Automated" account label (Settings → Your
   account → Account information → Automation) and names the managing account. X requires it
   for accounts that post through an app.

**Replies.** Since 2026-02-23 the X API refuses a reply unless the post's author mentioned or
quoted you. Our threads only reply to his own posts; third-party reports say self-replies still
work, but X's docs don't say so. If X refuses one, we stop, keep what went out, and the error
says so (then use `X_THREAD=off`). We **never** reply to, mention or quote other people on X:
X's automation rules forbid unsolicited automated mentions and keyword-triggered replies.

## Safety

- Posts use **only what the person said**; the prompt forbids adding facts or advice.
- Pip doesn't give or ask for medical, legal or financial advice, and doesn't push on painful topics.
- Every post says it was written up with AI from a phone call (the last post of each Bluesky thread).
- He can take any post down by asking on the call ("Pip, please take that last post down").
  Pip never argues; it confirms which post, and right after the call the post and the thread
  replies from the same call come down from Bluesky and Reddit (LinkedIn posts are flagged for
  removal by hand). Family can do the same with
  `npx convex run undo:removePost '{"postId":"..."}'`. See ARCHITECTURE.md → Undo.
- Posts go out automatically after a fact-check against the call. A post that fails the
  check, scores below the quality bar, or doesn't fit a 5-post Bluesky thread is held as
  `needs_review` instead of posted; someone reviews held posts after each call
  (`publish:approvePost`).
- Each platform is posted at most once (one claimed row per post per platform). If we can't
  tell whether a post went out, it's marked `maybe_posted` and never retried on its own.
- A post that's taken down (`removedAt`) is never posted, and one taken down mid-post is
  removed again.
- Reddit posting stays off until Reddit approves our API use (`REDDIT_POSTING`).
- LinkedIn posting is off (`LINKEDIN_POSTING`). LinkedAPI automates a personal account,
  which LinkedIn's terms don't allow; turn it on only for an account whose owner agrees and
  accepts that risk.

## History

v1 (online questions answered via a Twilio `<Gather>` flow, FastAPI backend,
React dashboard) lives in commit `9e67aab`. What's worth porting is listed in
[ARCHITECTURE.md → Port from v1](ARCHITECTURE.md#port-from-v1).
