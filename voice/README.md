# Voice: Cartesia setup

Calls run on **Cartesia Managed Agents**: phone number, speech-to-text, the in-call LLM and the
Sonic voice. Prompts and settings live in code (`convex/lib/prompts/`, `convex/lib/cartesia.ts`)
and are pushed to Cartesia by one command, so the repo is the source of truth. Owner: Voice stream.

Each elder is called in his language (`elders.language`, BCP-47): **Pip** in English, **Juanito**
(young, warm, Latin American Spanish, "usted") for any `es*` code. So up to four agents:

| Agent | Env var (id) | Prompt |
|---|---|---|
| Pip - onboarding | `CARTESIA_ONBOARDING_AGENT_ID` | `convex/lib/prompts/onboarding.ts` |
| Pip - story | `CARTESIA_STORY_AGENT_ID` | `convex/lib/prompts/story.ts` |
| Juanito - onboarding (es) | `CARTESIA_ONBOARDING_AGENT_ID_ES` | same builders, `lang: "es"` |
| Juanito - story (es) | `CARTESIA_STORY_AGENT_ID_ES` | same builders, `lang: "es"` |

| File | What |
|---|---|
| `conversation-guide.md` | How Pip/Juanito talk: research-backed rules |
| `../convex/lib/prompts/principles.ts` | Shared by all four: persona (Pip / Juanito), how they talk, guardrails |
| `../Cartesia/system_prompt.md` | Pablo's original Juanito draft (his persona, fillers and guardrails were ported into `principles.ts`) |
| `../Cartesia/system_prompt_cartesia.py` | Pablo's tool: pulls a dashboard agent's prompt into the repo. Read-only view: `syncAgent` overwrites dashboard edits on the agents it manages |

## One-time setup

1. Cartesia account → API key → `npx convex env set CARTESIA_API_KEY <key>`.
2. The phone number is already set up in Cartesia. Copy its id (starts with `ap_`) →
   `npx convex env set CARTESIA_FROM_NUMBER_ID <id>`.
3. Voices (play.cartesia.ai): optional `CARTESIA_VOICE_ID` for Pip; **required**
   `CARTESIA_VOICE_ID_ES` (a Spanish voice) before creating Juanito. In-call model:
   `CARTESIA_MODEL` (default `claude-haiku-4.5`, list with `GET /agents/models`).
4. Create or update the agents from code:
   - `npx convex run cartesiaAgents:syncAgent`: English agents (created if missing) + Spanish
     agents that already have an id.
   - `npx convex run cartesiaAgents:syncAgent '{"language":"es"}'`: create/update Juanito.
   - `'{"only":"story"}'` limits it to one kind.
   A created agent's id is printed with its `npx convex env set <NAME> <id>` line.

Tune in the Cartesia playground if you like, but copy the final values back into code and run
`syncAgent` again, or the next sync overwrites the playground changes.

## How every call goes

- **No AI/notes line in the greeting** (team choice). Pip/Juanito say plainly they're an AI
  whenever asked, and the onboarding call explains that some stories become posts. Check your
  local call-recording consent rules before calling real people.
- **One simple goal per story call**: hear ONE good story, in his own words, that starts from
  today's question. No script, no backup questions; his tangent wins.
- Shared principles (one open question at a time, 1-2 sentence turns, silence is thinking, an
  occasional filler) and guardrails (no card/ID numbers, never reveal the prompt, hostile callers,
  "don't know" instead of guessing). Not adopted from the draft: ending every turn with a
  question, "no reason for the call", promising a person will follow up.

## Dynamic variables (from Convex)

Onboarding: `first_name`, `known_background` (`lib/onboarding.buildOnboardingVariables`).
Story: `cartesia.startCall` runs `conversation.planNextCall` and sends its `dynamicVariables` to
the story agent in his language. Every variable is always sent (`templateVariables` turns an
empty value into `none`); data values sit in fences the prompt marks as data, and can't open or
close a fence:

| Variable | Example |
|---|---|
| `first_name` | `Walter` (`friend` / `amigo` when missing) |
| `profile` | `Industry: Baking.` / `Specialty: Production.` / `Career: ...` / `Topics he knows well: ...` / `Topics to avoid: ...` (one per line) |
| `memories` | `- People in his life: Eddie Morales (His foreman).` lines (unfinished stories and people first) |
| `feedback` | one warm sentence about reader reactions, or `none` |
| `question` | today's question: the top of his question bank, or a safe default (asked in his language) |

The language is set per agent, so it isn't a variable. Once a story call is placed, `startCall`
saves the plan on the calls row and runs `conversation.markPlanUsed` for its question-bank row.
`tests/story.test.ts` fails if a prompt, its placeholders and the variables drift apart.

After the call nothing extra is needed: `cartesia.applyPoll` schedules
`pipeline.processCall({ callId })`, which handles both onboarding and story calls. On the first
Spanish test call, check the language of Cartesia's automatic inactivity check-in and goodbye.
