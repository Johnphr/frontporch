# Front Porch — Architecture (v2: Convex + Vapi + SMS)

> Status: **structure only**. Stub files mark where each piece goes; none of
> the new logic is built yet. Decisions in [Open decisions](#open-decisions)
> are deliberately unlocked: each has a current leaning and an owner. Change
> them in a PR to this file.

## The idea in one line

Every week Pip calls grandpa. He answers a question (from his family first,
otherwise one found online). After the call, his answer becomes a LinkedIn
post on his own account and the family gets a text with the link. Family
members text questions to the same number. **Nobody installs anything.**

## Locked so far

| Decision | Choice |
|---|---|
| Backend | **Everything in Convex**: database, vector memory, crons, webhooks (HTTP actions), API calls (actions). No separate server, no tunnel |
| UI | None. All interaction is phone calls + SMS. Setup is by hand in the Convex dashboard |
| Call topic | Family SMS questions first; if none queued, an online question found by Apify |
| Approval | **Auto-post.** No yes/no step. Family is notified after, with the link |
| Memory | Convex vector index, embeddings from OpenAI `text-embedding-3-small` (1536 dims) |
| LLM for drafting | Claude `claude-opus-5-5` |

## System

```
                 ┌─────────────────────────────────────────────┐
                 │                   Convex                    │
                 │  tables + vector memory · crons · actions   │
                 │  http.ts:  POST /vapi/webhook               │
                 │            POST /sms/inbound                │
                 └───┬───────────▲──────────────┬──────────────┘
   weekly cron:      │           │ end-of-call  │ actions call out to:
   start call        │           │ report       │ Claude · OpenAI · Apify
              ┌──────▼───────────┴──┐           │ LinkedAPI · Twilio SMS
              │        Vapi         │           │
              │    call control     │           ▼
              └───┬────────────┬────┘       Family phones (SMS in + out)
           ┌──────▼───┐  ┌─────▼────┐
           │  Twilio  │  │ Cartesia │
           │  voice   │  │  voice   │
           └────┬─────┘  └──────────┘
             Grandpa
```

| Piece | Job |
|---|---|
| **Convex** | All state + all backend logic. Webhooks live at `https://<deployment>.convex.site/...` |
| **Vapi** | Runs the live call: speech-to-text in grandpa's language, in-call LLM, Cartesia voice, turn-taking |
| **Twilio** | One number. Voice is imported into Vapi; the Messaging webhook points at Convex `/sms/inbound` |
| **LinkedAPI** | Posts to grandpa's LinkedIn through his own account (`createPost` workflow) |
| **Apify** | Finds online fallback questions |

## Flows

### 1. Weekly call (Convex → Vapi)
1. `crons.ts` runs hourly and picks elders whose local call day and hour match.
2. `vapi.startWeeklyCall(elderId)`: next question (family first) → top-k memories
   → `POST https://api.vapi.ai/call` with `assistantOverrides.variableValues`
   (`firstName`, `question`, `memories`, `language`) and `metadata` (`elderId`, `questionId`).
3. Vapi calls grandpa with Pip's prompt from `vapi/pip-system-prompt.md`.

### 2. After the call (Vapi → Convex)
1. Vapi posts `end-of-call-report` to `/vapi/webhook` (`vapi.ts`). Return 200 fast.
2. It schedules `pipeline.processCall(CallResult)`.
3. Pipeline: save transcript → Claude drafts post → Claude extracts memories →
   embed + store → LinkedAPI posts → SMS family "Grandpa talked about the bakery
   today. Here's his post: <url>" → mark question answered.

### 3. Family asks a question (SMS → Convex)
1. Grandkid texts the number: "Ask grandpa how he met grandma".
2. Twilio → `/sms/inbound` (`sms.ts`): check signature → look up sender in
   `familyMembers` (unknown: ignore) → save question → reply "Got it!".

### 4. Online questions (Convex → Apify)
Daily cron → `apify.findQuestions` → upsert into `questions` → Claude triage
(skip unsafe, tag topics, assign elder).

## Contracts (agree on these first, then work in parallel)

**Vapi call metadata** (set at call start, read back in the webhook):
`{ "elderId": "<convex id>", "questionId": "<convex id, optional>" }`

**`CallResult`**, handed from `vapi.ts` to `pipeline.ts`:
```ts
type CallResult = {
  vapiCallId: string;
  elderId: Id<"elders">;
  questionId?: Id<"questions">;
  turns: { role: "pip" | "elder"; text: string }[];
  summary?: string;      // Vapi analysis summary
  endedReason: string;   // "customer-ended-call", "voicemail", ...
};
```

**Function names** (all `internal.*`, called only from other Convex functions):
`vapi.startWeeklyCall` · `pipeline.processCall` · `llm.draftStoryPost` ·
`llm.extractMemories` · `llm.triageQuestions` · `memories.add` · `memories.search` ·
`family.getMemberByPhone` · `family.listForElder` · `family.addQuestion` ·
`sms.sendSms` · `sms.notifyFamily` · `linkedapi.createPost` · `apify.findQuestions`

**Webhook auth**: `/vapi/webhook` checks the Vapi secret header against
`VAPI_WEBHOOK_SECRET`. `/sms/inbound` checks `X-Twilio-Signature` (`lib/twilio.ts`).

## Data model (draft, not in `schema.ts` yet)

```ts
// NEW
familyMembers: defineTable({
  elderId: v.id("elders"), name: v.string(),
  phone: v.string(),                       // E.164
  relation: v.optional(v.string()),
}).index("by_phone", ["phone"]).index("by_elder", ["elderId"]),

memories: defineTable({
  elderId: v.id("elders"), callId: v.optional(v.id("calls")),
  text: v.string(),                        // "Ran a bakery on 5th street in the 60s"
  embedding: v.array(v.float64()),
}).vectorIndex("by_embedding", {
  vectorField: "embedding", dimensions: 1536, filterFields: ["elderId"],
}),

// CHANGED
elders:    + timezone, callDay, callHour
questions: + askedByMemberId?: v.id("familyMembers")   // source: "family"
calls:     callSid -> vapiCallId, + summary, + endedReason
answers:   reused as "posts"; publications[] holds the LinkedAPI result
replies:   v1 thank-you feature, probably drop (open decision 12)
```

**Existing Convex files** (`answers.ts`, `calls.ts`, `elders.ts`, `questions.ts`,
`replies.ts`, `lib/auth.ts`) were written for the old Python server: every
function takes a `secret` argument checked by `assertBackend`, and some public
queries only fed the deleted dashboard. Core: Data converts the ones we keep
to `internalQuery`/`internalMutation` and deletes the rest.

## Repo layout

```
ARCHITECTURE.md          this file
package.json             Convex CLI only (npm run convex / npm run deploy)
vapi/                    Vapi assistant setup + Pip's prompt          Voice
convex/
  schema.ts              tables (draft changes above)                 Data
  http.ts                webhook router (empty)                       Pipeline
  crons.ts               schedules (empty)                            Data
  vapi.ts                start call + Vapi webhook          (stub)    Voice
  pipeline.ts            post-call pipeline                 (stub)    Pipeline
  llm.ts                 Claude jobs                        (stub)    Pipeline
  sms.ts                 SMS in + out                       (stub)    Pipeline
  lib/twilio.ts          Twilio signature check             (stub)    Pipeline
  memories.ts            embed + vector search              (stub)    Data
  family.ts              family members + their questions   (stub)    Data
  linkedapi.ts           LinkedIn post                      (stub)    Integrations
  apify.ts               find online questions              (stub)    Integrations
  answers.ts calls.ts elders.ts questions.ts replies.ts lib/auth.ts   v1, Data refactors
```

## Team

| # | Stream | Accounts they own | Files |
|---|---|---|---|
| 1 | **Voice** | Vapi, Twilio, Cartesia | `vapi/`, `convex/vapi.ts` |
| 2 | **Integrations** | LinkedAPI + grandpa's LinkedIn, Apify | `convex/linkedapi.ts`, `convex/apify.ts` |
| 3 | **Core: Data** | Convex project (admin), OpenAI | `schema.ts`, `family.ts`, `memories.ts`, `crons.ts`, v1 table files |
| 4 | **Core: Pipeline + live** | Anthropic | `http.ts`, `pipeline.ts`, `llm.ts`, `sms.ts`, `lib/twilio.ts`, production deploy |

### 1 · Voice (Vapi, Twilio, Cartesia)
- Buy the Twilio number (Voice + SMS). On a trial account, verify every teammate's phone.
- Import it into Vapi. Set Twilio Messaging webhook → `<convex.site>/sms/inbound`.
- Build the Pip assistant (see `vapi/README.md`): Cartesia voice, transcriber language, model.
- Write `vapi/pip-system-prompt.md`; set server URL → `<convex.site>/vapi/webhook` + secret.
- Implement `vapi.startWeeklyCall` + `vapi.webhook`.
- **Hand-off:** commit one real `end-of-call-report` JSON to `fixtures/` (repo root) early, so Pipeline can build against it.
- **Milestone:** Vapi calls your phone with a hard-coded question in Pip's voice.

### 2 · Integrations (LinkedIn, Apify)
- Start the LinkedAPI trial only when ready to build (it lasts 7 days). Connect grandpa's LinkedIn.
- Implement `linkedapi.createPost` (createPost workflow, wait for result, return URL).
- Pick Apify Actors, port the source config, implement `apify.findQuestions`.
- **Milestone:** a test action posts "hello" through LinkedAPI; Apify puts 10 fresh questions in Convex.

### 3 · Core: Data (Convex)
- **Merge schema changes first.** That unblocks everyone.
- Convert v1 table files to internal functions; make `questions.nextForElder` family-first.
- Implement `family.ts`, `memories.ts` (OpenAI embeddings + vector search), `crons.ts`.
- Seed demo grandpa + family (dashboard or a seed function).
- **Milestone:** seeded data; `memories.search` returns the right memory for a test sentence.

### 4 · Core: Pipeline + going live
- Implement `http.ts` routes, `lib/twilio.ts`, `sms.ts`.
- Implement `llm.ts` (port prompts) and `pipeline.processCall` against Voice's fixture.
- Own the production deployment and its env vars (below), and the end-to-end demo run.
- **Milestone:** run `processCall` on the fixture → post saved in Convex + SMS on your phone.

**Order:** Data schema → everyone in parallel → Pipeline wires the pieces → go live.

## Going live

1. `npm run deploy` (`npx convex deploy`) creates/updates the **production** deployment.
   Its database and env vars are separate from dev.
2. Set every env var below on production (`npx convex env set` with `--prod`).
3. Point Vapi server URL and Twilio Messaging webhook at the **production**
   `.convex.site` URL. Seed production grandpa + family.
4. Full test call → post → SMS. Record a backup video of a full run.

**During development:** every teammate gets their own dev deployment from
`npx convex dev`, but the Twilio number and Vapi can only point at one URL.
Use one shared dev deployment for webhook testing (open decision 10).

## Env vars (all in Convex)

| Var | Provided by |
|---|---|
| `VAPI_API_KEY`, `VAPI_ASSISTANT_ID`, `VAPI_PHONE_NUMBER_ID`, `VAPI_WEBHOOK_SECRET` | Voice |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER` | Voice |
| `LINKEDAPI_TOKEN`, `LINKEDAPI_ID_TOKEN`, `APIFY_TOKEN` | Integrations |
| `OPENAI_API_KEY` | Data |
| `ANTHROPIC_API_KEY` | Pipeline |

Cartesia's key goes in the Vapi dashboard (Provider Keys), not Convex.
Share keys through a password manager, never in the repo or chat.

## Open decisions

| # | Question | Leaning | Owner |
|---|---|---|---|
| 1 | Memories: prefetch at call start, or a mid-call `recall_memory` tool? | Prefetch (simpler, no mid-call latency) | Data + Pipeline |
| 2 | In-call LLM inside Vapi | Fastest Claude model Vapi offers | Voice |
| 3 | Speech-to-text provider + per-elder language | Override `transcriber.language` from `elders.language` | Voice |
| 4 | Family questions: reuse `questions` or new table? | Reuse with `source: "family"` | Data |
| 5 | Cron cadence + timezone | Hourly cron, match elder's local `callDay`/`callHour` | Data |
| 6 | Post format: length, disclosure line, hashtags | Port v1 disclosure line | Pipeline + Integrations |
| 7 | Grandpa calling in (inbound) | Same assistant, no question → free chat | Voice |
| 8 | Undo for auto-posted mistakes | Later: family texts "DELETE". Not in v1 | Pipeline |
| 9 | Voicemail / no answer | No post; retry next day once | Voice + Pipeline |
| 10 | Which deployment webhooks hit during dev | One shared dev deployment (Pipeline's) | Pipeline |
| 11 | Anthropic SDK or raw `fetch` in Convex | SDK; add `"use node"` if it needs Node | Pipeline |
| 12 | Keep `replies` table (v1 thank-yous)? | Drop | Data |
| 13 | LinkedAPI result: wait inside the action or a scheduled follow-up? | Scheduled follow-up | Integrations |

## Port from v1

The v1 Python backend and React dashboard were deleted, but a few pieces are
worth porting. View any file with `git show 9e67aab:<path>`.

| What | v1 path | Goes to |
|---|---|---|
| Claude prompts + safety rules (triage, follow-up, drafting) | `backend/app/llm.py` | `convex/llm.ts`, `vapi/pip-system-prompt.md` |
| Apify sources + field mapping | `backend/question_sources.json`, `backend/app/services/questions.py` | `convex/apify.ts` |
| Disclosure line + `truncate` | `backend/app/services/publishers/base.py` | `convex/linkedapi.ts` |
| Twilio signature check (reference) | `backend/app/deps.py` | `convex/lib/twilio.ts` |
| Call pacing lessons (silence retries, "still writing") | `backend/app/routes/twilio.py` | Vapi config |
