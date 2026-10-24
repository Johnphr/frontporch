# Front Porch — Architecture (v2: Vapi + SMS)

> Status: **structure only**. Nothing in this doc is built yet. Files marked
> *stub* exist so each workstream has a home; they are not wired into the app.
> Decisions in [Open decisions](#open-decisions) are deliberately unlocked —
> each has a current leaning and an owner, change them in a PR to this file.

## The idea in one line

Every week Pip calls grandpa. He answers a question (from his family first,
otherwise one found online). After the call, his answer is written up as a
LinkedIn post on his own account, and the family gets a text with the link.
Family members text questions in to the same number. **Nobody installs anything.**

## Locked so far

| Decision | Choice |
|---|---|
| Call topic | Family SMS questions first; if none queued, an online question found by Apify (existing code) |
| Approval | **Auto-post.** No yes/no on the call or by SMS. Family is notified after, with the link |
| Old code | Stays. Twilio `<Gather>` flow + React dashboard keep working as a fallback demo |
| Memory | Vector memory in Convex, embeddings from OpenAI `text-embedding-3-small` (1536 dims) |
| LLM for drafting | Claude (existing `backend/app/llm.py`, `claude-opus-5-5`) |

## System

```
                ┌──────────────────────────┐
                │          Convex          │
                │ DB, memory (vector),     │
                │ cron scheduler           │
                └──┬──────────────┬────────┘
   weekly cron     │              │ triggers jobs (Apify refresh)
        ┌──────────▼───┐   ┌──────▼──────────────┐
        │     Vapi     │──►│      FastAPI        │  end-of-call-report
        │ call control │   │ memory, posts,      │
        └──┬───────┬───┘   │ Apify, LinkedAPI    │
   ┌───────▼─┐ ┌───▼─────┐ └──┬──────┬───────┬───┘
   │ Twilio  │ │Cartesia │    │      │       │
   │  voice  │ │ voice   │  Apify LinkedAPI Twilio SMS
   └────┬────┘ └─────────┘                    │
     Grandpa                               Family
```

| Piece | Job | Owner stream |
|---|---|---|
| **Vapi** | Runs the live call: speech-to-text (grandpa's language), in-call LLM, Cartesia TTS, turn-taking | Voice |
| **Twilio** | Phone number. Voice is imported into Vapi; SMS webhook points at FastAPI | Voice + Integrations |
| **Convex** | All state, vector memory, crons, starts the weekly Vapi call | Data |
| **FastAPI** | Webhooks (Vapi, SMS), post-call pipeline, Claude, Apify, LinkedAPI, sending SMS | AI + Integrations |
| **LinkedAPI** | Posts to grandpa's LinkedIn through his own account (`createPost` workflow) | Integrations |

One Twilio number, two webhooks: **voice → Vapi**, **messaging → `POST /sms/inbound`**.
The legacy Gather flow still works for *outbound* "Call now" from the dashboard,
because that call passes `/twilio/voice` as its URL explicitly.

## Flows

### 1. Weekly call (Convex → Vapi)

1. `convex/crons.ts` (to create; see note in `convex/vapi.ts`) fires weekly per elder.
2. `vapi.startWeeklyCall(elderId)` action:
   - picks the next question: family question first, else Apify question (`questions.nextForElder`, family-first ordering to add)
   - fetches top-k memories for that question (`memories.search`)
   - `POST https://api.vapi.ai/call` with `assistantId`, `phoneNumberId`,
     `customer.number`, and `assistantOverrides.variableValues`
     (`firstName`, `question`, `memories`, `language`) + `metadata`
     (`elderId`, `questionId`). *Verify field names against docs.vapi.ai/calls/outbound-calling.*
3. Vapi calls grandpa. Pip's prompt lives in `vapi/pip-system-prompt.md`.

### 2. After the call (Vapi → FastAPI)

1. Vapi sends `end-of-call-report` to `POST /vapi/webhook` (`backend/app/routes/vapi.py`, *stub*).
2. Route turns it into a `CallResult` and hands it to `services/pipeline.py` (*stub*) as a background task.
3. Pipeline, in order, each step independent so one failure doesn't stop the rest:
   1. save transcript + summary to Convex (`calls`)
   2. Claude: draft the post from **only what he said** (reuse `DRAFT_SYSTEM` rules) → `answers`
   3. Claude: extract 1–5 memories → `memories.add` (Convex embeds + stores)
   4. LinkedAPI `createPost` (`publishers/linkedapi.py`, *stub*) → publication on the answer
   5. SMS every family member: "Grandpa talked about the bakery today. Here's his post: <url>"
   6. mark question answered

### 3. Family asks a question (SMS → FastAPI)

1. Grandkid texts the number: "Ask grandpa how he met grandma".
2. Twilio → `POST /sms/inbound` (`backend/app/routes/sms.py`, *stub*), signature checked with existing `verify_twilio`.
3. Look up sender in `familyMembers` by phone. Unknown number → ignore (no reply).
4. Save as a question with `source: "family"` assigned to that elder.
5. Reply: "Got it! Pip will ask Grandpa on Sunday's call."

### 4. Online questions (Convex → FastAPI → Apify)

Existing `fetch_from_apify` + `route_new_questions`. New: a Convex cron hits
`POST /jobs/find-questions` (`backend/app/routes/jobs.py`, *stub*) instead of a dashboard button.

## Contracts (agree on these, then work in parallel)

**Vapi call metadata** (set when starting the call, read back in the webhook):
```json
{ "elderId": "<convex id>", "questionId": "<convex id or omitted>" }
```

**`CallResult`** — what the Vapi route gives the pipeline (`services/pipeline.py`):
```python
@dataclass
class CallResult:
    vapi_call_id: str
    elder_id: str
    question_id: str | None
    turns: list[dict]      # [{"role": "pip" | "elder", "text": str}], same shape as today
    summary: str | None    # Vapi analysis summary, if enabled
    ended_reason: str      # e.g. "customer-ended-call", "voicemail"
```

**New Claude jobs** (go in `backend/app/llm.py`, same `_parse` pattern):
`draft_story_post(question, elder, turns) -> DraftAnswer` · `extract_memories(elder, turns) -> list[str]`

**Webhook auth**
- `/vapi/webhook`: Vapi server secret header, checked against `VAPI_WEBHOOK_SECRET`.
- `/sms/inbound`: existing Twilio signature check (`deps.verify_twilio`).
- `/jobs/*`: `X-Backend-Secret` header = `CONVEX_BACKEND_SECRET` (Convex already knows it).

## Data model (draft — not in `schema.ts` yet)

Reuses existing tables wherever possible. Data stream owns the real edit.

```ts
// NEW
familyMembers: defineTable({
  elderId: v.id("elders"),
  name: v.string(),
  phone: v.string(),            // E.164
  relation: v.optional(v.string()),
}).index("by_phone", ["phone"]).index("by_elder", ["elderId"]),

memories: defineTable({
  elderId: v.id("elders"),
  callId: v.optional(v.id("calls")),
  text: v.string(),             // "Ran a bakery on 5th street in the 60s"
  embedding: v.array(v.float64()),
}).vectorIndex("by_embedding", {
  vectorField: "embedding", dimensions: 1536, filterFields: ["elderId"],
}),

// CHANGED (all optional so the legacy flow keeps working)
elders:    + timezone?: string, + callDay?: string, + linkedapiAccount?: string
questions: + askedByMemberId?: v.id("familyMembers")   // source: "family"
calls:     + vapiCallId?: string, + summary?: string, + provider?: "twilio" | "vapi"
```

LinkedAPI credentials go in env vars for the demo (one grandpa), not in a table.

## Repo layout (new pieces marked ✚)

```
ARCHITECTURE.md                ✚ this file
vapi/                          ✚ Vapi assistant config, owned by Voice
  README.md                    ✚ dashboard setup checklist
  pip-system-prompt.md         ✚ Pip's in-call prompt (uses {{variables}})
backend/app/
  routes/vapi.py               ✚ stub: Vapi server events
  routes/sms.py                ✚ stub: inbound family SMS
  routes/jobs.py               ✚ stub: Convex-triggered jobs
  services/pipeline.py         ✚ stub: post-call pipeline + CallResult
  services/sms.py              ✚ stub: send SMS, family lookups
  services/publishers/linkedapi.py ✚ stub
  routes/twilio.py             legacy Gather flow (unchanged)
frontend/
  convex/vapi.ts               ✚ stub: start weekly call (+ crons note)
  convex/memories.ts           ✚ stub: add (embed) + vector search
  convex/family.ts             ✚ stub: family members + family questions
  src/                         legacy dashboard (unchanged)
```

New stubs are **not** imported by `main.py` or `publishers/__init__.py`. Wire
them up in the PR that implements them.

## Workstreams

| Stream | Owns | First milestone |
|---|---|---|
| **Voice** | `vapi/`, Vapi dashboard, Twilio number import, `convex/vapi.ts` | Vapi calls a phone with a hard-coded question and Pip's voice |
| **AI** | `llm.py` new jobs, `services/pipeline.py`, `convex/memories.ts` | Paste a transcript → get a post + memories back |
| **Integrations** | `routes/sms.py`, `services/sms.py`, `publishers/linkedapi.py`, Apify cron | Text the number → question shows up in Convex; LinkedAPI posts "hello" |
| **Data** | `convex/schema.ts`, `convex/family.ts`, crons, seed script | Schema merged, demo grandpa + family seeded |

Merge order that avoids blocking: **Data schema → everyone else in parallel → `routes/vapi.py` wires pipeline last.**

## Open decisions

| # | Question | Leaning | Owner |
|---|---|---|---|
| 1 | Who starts the call: Convex action → Vapi, or Convex → FastAPI → Vapi? | Convex action (matches diagram, no extra hop) | Voice |
| 2 | Memories: prefetch at call start (`variableValues`) or a mid-call `recall_memory` tool? | Prefetch. Simpler, no latency mid-call | AI |
| 3 | Where embeddings run: Convex action or FastAPI? | Convex action, so add + search share one code path | AI + Data |
| 4 | In-call LLM inside Vapi: which model? | Fastest Claude Vapi offers (latency > quality on a call) | Voice |
| 5 | STT provider + language per elder | Override `transcriber.language` from `elders.language` at call start | Voice |
| 6 | Family questions: reuse `questions` (`source: "family"`) or a new table? | Reuse | Data |
| 7 | Cron cadence + timezone (Convex crons are UTC) | Hourly cron that calls elders whose local `callDay`/hour matches | Data |
| 8 | Post format: length, disclosure line, hashtags | Reuse `PublishContext.disclosure` wording | AI |
| 9 | Grandpa calling *in* (not just outbound) | Same Vapi assistant on inbound, no question → free chat | Voice |
| 10 | Auto-post mistakes: undo path? | Later: family texts "DELETE" → remove post. Not in v1 | Integrations |
| 11 | Voicemail / no answer | Vapi voicemail detection → no post, retry next day once | Voice |
| 12 | Legacy dashboard: show Vapi calls too? | Optional, read-only, only if time | — |

## Env vars to add (when implementing)

| Var | Where | Used by |
|---|---|---|
| `VAPI_API_KEY`, `VAPI_ASSISTANT_ID`, `VAPI_PHONE_NUMBER_ID` | Convex env | `convex/vapi.ts` |
| `VAPI_WEBHOOK_SECRET` | backend `.env` | `routes/vapi.py` |
| `OPENAI_API_KEY` | Convex env | `convex/memories.ts` |
| `LINKEDAPI_TOKEN`, `LINKEDAPI_ID_TOKEN` | backend `.env` | `publishers/linkedapi.py` |
| `BACKEND_URL` | Convex env | crons calling `/jobs/*` |

Twilio, Claude, Apify, Convex vars already exist in `backend/.env.example`.
