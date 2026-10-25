# Front Porch: Devpost submission (draft)

Cal Hacks 13.0. Submissions close **Oct 25, 9:00 AM PST**.

Everything below describes what is in the code on `feat/phase2-integration`. Anything that is
switched off or waiting on someone else's approval says so.

---

## Tagline

**He talks on the phone. His stories find readers.** (48 characters)

Alternatives:

1. A weekly phone call that becomes his own posts. (47)
2. His working life, told by phone, posted in his words. (53)
3. No app, no screen. Just a phone call and his stories. (53)

---

## Inspiration

<!-- Optional: one or two sentences about the real person who made you want to build this. Keep it true. -->

Retired bakers, engineers, nurses and shop owners know things that took them forty years to
learn. People ask about those things online every day: on Reddit, on Stack Exchange, on
Bluesky. The people who could answer best rarely do, because posting means an app, a password,
a small keyboard and a feed that moves too fast.

The one thing almost all of them are comfortable with is a phone call. So we asked: what if a
friendly voice called once a week, asked one good question, and listened? And what if the
story he told became a post, in his own words, on his own account, and the replies came back
to him on the next call?

## What it does

Front Porch is an AI phone host for older professionals. He never needs an app or a screen.

1. **Sign-up.** He, or a family member sitting with him, fills in a simple four-step page in
   Spanish or English: his name and call language, his phone number, who should call him
   (**Pip** in English or **Juanito** in Latin American Spanish), and his Bluesky account
   (an app password, never his real password). Threads and X connect with their own
   "Connect" buttons. Then "Call me now".
2. **The first call** gets to know his working life: where he started, what he specialised
   in, how his career went. That becomes his profile and a list of story ideas.
3. **Every week after that**, the call starts from one good question. Often it's a real
   question someone asked online, found before the call (Reddit and Stack Exchange through
   Apify and the Stack Exchange API, Bluesky search through his own login). Pip asks it in his
   own words, follows the tangents, and lets him talk.
4. **After the call:**
   - what he said is saved as memories (people, places, facts, open threads) in a vector
     index, so later calls can say "Last time you told me about...";
   - his story becomes a short post. The writer makes 3 drafts, a judge scores them, the best
     one gets up to 2 rewrite rounds, and then a separate fact-check compares it against the
     whole call. Anything he didn't say fails;
   - the post goes out on **his own accounts**: a 3 to 5 post Bluesky thread, a Threads
     thread when he connected Threads, X when posting is switched on, Reddit once Reddit
     approves our API access;
   - if the question came from a Bluesky thread, his answer is also posted as a reply on that
     thread, from his account, with an AI note.
5. **Readers write back.** Once a day we read the likes, reposts and replies on his posts.
   The next call opens with them: "A reader asked how you priced bread back then. What would
   you tell her?"
6. **He stays in charge.** If he says "Pip, please take my last post down", Pip says one
   fixed line, and after the call the post comes down everywhere it went, along with any
   thread replies from that call.

## How we built it

Everything on the server is in **Convex**: the tables, the vector index for memories, the
crons, and the actions that talk to other services. There is no other backend.

- **The call.** Each character is a **Cartesia Managed Agent** (phone number, speech-to-text,
  the in-call model and the Sonic voice). The prompt lives in our repo
  (`convex/lib/prompts/`) and is pushed to Cartesia with one command, so the code is the
  source of truth. Each call gets three variables: his first name, the call's one goal, and
  a context block (profile, memories, the reader feedback line, today's question). The
  conversation rules come from oral-history guides (Smithsonian, Oral History Association):
  one open question at a time, never fill a silence, follow his tangents.
- **After the call.** Cartesia doesn't send call webhooks yet, so Convex polls for the
  transcript, then runs isolated steps: take-down check, memories, post, question-bank
  refresh, thread reply. One step failing doesn't stop the others.
- **Planning the next call.** An LLM (OpenAI) writes 8 to 12 candidate questions from his
  profile, memories, reader comments, audience questions and recent news in his field. Plain
  code ranks them (unfinished stories first, then reader questions, then the rest). About an
  hour before each call a cron refreshes the questions and the online search.
- **Memory.** OpenAI `text-embedding-3-small` embeddings in a Convex vector index.
  Near-duplicates are merged, so "his wife Maria" is one memory, mentioned three times.
- **Posting.** The AT Protocol for Bluesky, the Threads Graph API, and the X API v2. Each
  platform gets its own splitter (Bluesky 300 graphemes, Threads 500 characters, X 280
  weighted characters) and its own row, so a post goes to each platform at most once.
- **Feedback.** A daily cron reads each thread he posted in the last 30 days and keeps only
  replies written by other people.
- **The website.** Vite, React and Tailwind, deployed on Vercel. Big type, 60px buttons,
  Spanish by default.

```
  sign-up site ──► Convex ◄── crons: hourly calls · daily feedback · weekly question search
                     │
  Reddit · Stack Exchange · Bluesky questions ──► question bank (ranked)
                     │  start call: name + one goal + context
                     ▼
        Cartesia agent (Pip / Juanito) ── phone ──► him
                     │  transcript (polled)
                     ▼
  memories (embeddings + vector index)
  post: 3 drafts ─► judge ─► rewrites ─► fact-check against the call
                     │
                     ▼
  his own accounts: Bluesky · Threads · X (off by default) · Reddit (gated)
                     │  likes + replies, read daily
                     └──────────────► next call's question and feedback line
```

## Challenges we ran into

- **Phone numbers.** Our Cartesia number is a US number, and our Spanish-speaking testers are
  in Mexico. International calls took 15 to 30 seconds just to connect, so calls ended as "no
  answer" before his phone rang. We raised the ring time to 60 seconds. Calling Mexico from a
  local number is still to do.
- **LinkedIn didn't work out.** We started with LinkedIn, where older professionals already
  are. Posting there for a person means automating his personal account through a third
  party, one connected account per person, and LinkedIn's terms don't allow that. We kept the
  code behind a switch that is off and moved to Bluesky, whose open API lets each person post
  from his own account with an app password he can revoke.
- **X changed its reply rules.** Since February 23, 2026 the X API refuses a reply unless the
  other author mentioned or quoted you. Our X threads only reply to his own posts, but X's
  docs don't promise that still works. So on X the AI note goes in the *first* post, and if X
  refuses the rest, we stop and keep what went out. We never reply to, mention or quote anyone
  else on X.
- **Keeping posts true.** An LLM loves to add a nice detail he never said. The judge gives a
  draft 0 if it has any fact that isn't in the call or his profile, and a separate fact-check
  runs before anything is posted. If either one fails, or the judge can't be reached, the post
  is held for a person to review instead of going out.
- **Posts that are good, not just safe.** One draft was usually flat. Three drafts with
  different angles, scored on hook, story, voice, lesson, closing question and clarity, plus
  code checks (length, no stock phrases, no lists, at most 2 hashtags), made a real
  difference. It all has to finish inside one Convex action's time limit, so every model call
  has a deadline.
- **His accounts, stored safely.** Every connected account (Bluesky app password, Threads and
  X tokens) is encrypted with AES-256-GCM, and each ciphertext is bound to that person and
  platform, so a copied row won't decrypt for someone else. Secrets are decrypted only inside
  the action that uses them. We refuse a main Bluesky password, and an app password that can
  read DMs. X tokens rotate on every refresh, so two runs refreshing at once had to be made
  safe.
- **Undo without false alarms.** "Take down the post on the wall" is a story, not a request.
  Matching his words alone was too risky either way. So Pip says one exact sentence when he
  clearly asks, and only that sentence, said right after he asked, deletes anything. A request
  without it holds that day's post and flags the call for family, but deletes nothing.
  "Never mind, leave it up" cancels.
- **Two languages.** Cartesia agents have one primary language, so Pip and Juanito are
  separate agents with their own voices. The AI note, the X short note, the take-down lines
  and the sign-up page all exist in both languages, and the post is written in the language
  he spoke.
- **Posting exactly once.** A timeout doesn't tell you whether a post went out. Those posts are
  marked "maybe posted" and never retried on their own; a thread that stopped halfway
  continues from where it stopped.

## Accomplishments that we're proud of

- The whole loop works in code: sign-up, first call, weekly call, memories, a fact-checked
  post as a Bluesky thread, reader replies read back, and the next call bringing them up.
- He needs nothing but his phone. No app, no password typed into our site for any network.
- Undo by voice, with a design that would rather hold a post than delete the wrong one.
- English and Spanish from the start, with two characters he can choose between.
- 567 unit tests on the pure logic (splitters, ranking, take-down detection, posting
  decisions, OAuth state), all runnable without a Convex deployment.

## What we learned

- Old oral-history advice still holds on a phone call: one short open question, then wait.
  The silence is him remembering.
- The model writing the story and the check that keeps it honest work best as separate steps.
- Every social network has its own rules about automation, replies and AI. Reading them early
  saved us from building the wrong thing twice.
- "Did that post go out?" is a harder question than "how do I post?"

## What's next

- **SMS verification** on sign-up. The code screen is built but switched off, so for now only
  numbers on an allowlist can be called from the page.
- **Reddit**, once Reddit approves our API access (built and switched off, and there is no
  per-person Reddit connect yet).
- **Threads keyword search and quote-post answers** to strangers' questions, built and
  switched off until Meta's app review. Until then, only invited Threads testers can connect.
- **Verifying the phone number** at sign-in. Today his page opens on any device with his
  phone number + the 6-digit family code setup gave him (rate limited); an SMS code would
  prove the number is his.
- **Calling Mexico from a Mexican number**, by bringing our own number into Cartesia through
  Twilio or SIP.

## Built with

`convex` · `cartesia` · `openai` · `claude-haiku` (in-call model, via Cartesia) · `apify` ·
`at-protocol` · `bluesky` · `threads-api` · `x-api` · `stack-exchange-api` · `react` · `vite` ·
`tailwindcss` · `vercel` · `typescript` · `web-crypto`

## Safety & consent

What is in place:

- **Only his words.** The writer is told never to add facts or advice. The judge scores a
  draft 0 if it has a fact that isn't in the call or his profile, and a fact-check against the
  whole call runs before anything is posted. A post that fails is held for review, never
  posted.
- **An AI note on every post.** "I told this story in a phone interview with Front Porch. It
  was written up with AI from my own words." (or the Spanish version). It goes at the end of
  a Bluesky or Threads thread, and in the first post on X. Thread replies carry a shorter AI
  line.
- **He can take it back by phone.** His most recent post comes down from Bluesky, Threads and
  X after the call, with that call's thread replies. Family can remove any post with one
  command.
- **No strangers on X.** We never reply to, mention or quote anyone else on X. On Bluesky, a
  reply only goes on the one thread whose question he answered on the call.
- **His accounts, encrypted.** App passwords and tokens are stored with AES-256-GCM, bound to
  him and the platform, and never returned by any function.
- **Pip's limits.** No medical, legal or financial advice, no pushing on painful topics, never
  asks for card numbers, passwords or ID numbers, and always says plainly that he's an AI when
  asked.
- **Costs stay off.** X posting and X reads are off by default, since X charges per post.

What is still missing (we know):

- **No recording or AI notice in the greeting.** The greeting is "Hi Walter, it's Pip from
  Front Porch. Is now a good time for a little chat?" (`convex/lib/prompts/agent.ts`). Pip
  says he's an AI when asked, and the first call explains that some stories become posts,
  but nothing says the call is recorded and transcribed. That should be added before calling
  anyone outside our test group, and checked against the call-recording consent rules where
  he lives.
- **No phone verification.** Anyone with the link could type someone else's number, which is
  why page-started calls are limited to an allowlist.
- **Family tools are commands.** Removing an older post, or reviewing a held one, is a Convex
  command, not a button.
- **The sign-up page could say more.** It tells him his stories will be posted on his own
  account, but not that they are written up with AI, that they go out after the call without
  him reading them first, or that an answer may be posted as a reply on someone else's
  Bluesky thread.
