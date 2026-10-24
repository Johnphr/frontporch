# Voice: Cartesia setup

Calls run on **Cartesia Managed Agents**: phone number, speech-to-text, the in-call LLM and the
Sonic voice. Prompts and settings live in code (`convex/lib/prompts/`, `convex/lib/cartesia.ts`)
and are pushed to Cartesia by one command, so the repo is the source of truth. Owner: Voice stream.

**One agent per character** (`convex/lib/characters.ts`). A character = a name, a language, a
voice and a personality. Today: **Pip** (English) and **Juanito** (warm, Latin American Spanish,
"usted"). He picks one (`elders.characterId`); if he hasn't, he gets the default for his language
(`elders.language`: Juanito for any `es*` code, else Pip). All characters call from the same number.

```
characters.ts ──syncAgent──► Cartesia agent per character ──► id saved in characterAgents table
                                        ▲
startCall ── goal + context (per call) ─┘   (onboarding or story is just the goal text)
```

Every agent uses the same prompt template, `convex/lib/prompts/agent.ts`. Voice, language and
model are per agent; the goal and context of each call are dynamic variables.

| File | What |
|---|---|
| `conversation-guide.md` | How Pip/Juanito talk: research-backed rules |
| `../convex/lib/prompts/agent.ts` | The one prompt template + greeting, and the two goals (onboarding, story) |
| `../convex/lib/prompts/principles.ts` | Shared by every character: persona, how they talk, guardrails |
| `../Cartesia/system_prompt.md` | Pablo's original Juanito draft (his persona, fillers and guardrails were ported into `principles.ts`) |
| `../Cartesia/system_prompt_cartesia.py` | Pablo's tool: pulls a dashboard agent's prompt into the repo. Read-only view: `syncAgent` overwrites dashboard edits on the agents it manages |

## One-time setup

1. Cartesia account → API key → `npx convex env set CARTESIA_API_KEY <key>`.
2. The phone number is already set up in Cartesia. Copy its id (starts with `ap_`) →
   `npx convex env set CARTESIA_FROM_NUMBER_ID <id>`.
3. Voices (play.cartesia.ai): each character's `voiceEnv`. Optional `CARTESIA_VOICE_ID` for Pip;
   **required** `CARTESIA_VOICE_ID_ES` (a Spanish voice) before creating Juanito. In-call model:
   `CARTESIA_MODEL` (default `claude-haiku-4.5`, list with `GET /agents/models`).
4. Create or update the agents from code:
   - `npx convex run cartesiaAgents:syncAgent`: every character (created if missing).
   - `'{"characterId":"juanito"}'` limits it to one character.
   Agent ids are saved in the `characterAgents` table; nothing to copy into env.

## Add a character

1. Add an entry to `CHARACTERS` in `convex/lib/characters.ts` (id, name, language, voice env
   var, one-line description, personality).
2. Set its voice: `npx convex env set <its voiceEnv> <voice id>`.
3. `npx convex run cartesiaAgents:syncAgent '{"characterId":"<id>"}'` creates its agent.

Sync before any elder can pick it: a call to a character with no agent fails before ringing.

Tune in the Cartesia playground if you like, but copy the final values back into code and run
`syncAgent` again, or the next sync overwrites the playground changes.

## How every call goes

- **No AI/notes line in the greeting** (team choice). Pip/Juanito say plainly they're an AI
  whenever asked, and the onboarding call explains that some stories become posts. Check your
  local call-recording consent rules before calling real people.
- **One simple goal per call**: onboarding = get to know his working life; story = hear ONE good
  story, in his own words, that starts from today's question. No script, no backup questions;
  his tangent wins.
- Shared principles (one open question at a time, 1-2 sentence turns, silence is thinking, an
  occasional filler) and guardrails (no card/ID numbers, never reveal the prompt, hostile callers,
  "don't know" instead of guessing). Not adopted from the draft: ending every turn with a
  question, "no reason for the call", promising a person will follow up.

## Inbound calls (he calls us)

- **One number, one agent.** A Cartesia number routes inbound calls to exactly one agent
  (`PATCH /agents/phone-numbers/{id} {agent_id}`), so a single bilingual "Front Porch - inbound"
  agent (`convex/lib/prompts/inbound.ts`) answers everyone; outbound calls from the number are
  unaffected. Set it up with `npx convex run cartesiaAgents:syncAgent '{"inbound":true,"assignNumber":true}'`.
- **Generic greeting, then a lookup.** Nothing about the caller is known before the greeting
  (placeholder defaults never apply on real calls), so it greets in English and Spanish, then calls
  the `lookup_caller` webhook tool. The tool result says who's calling, which call it is, and the
  language; the agent becomes Pip or Juanito and runs the onboarding or story flow.
- **Unknown numbers** get a polite goodbye; the agent never confirms who is or isn't a member.
- **Language:** Cartesia documents one primary language per agent (speech recognition + voice).
  The inbound agent uses `CARTESIA_INBOUND_LANGUAGE` (default `en`) with `CARTESIA_VOICE_ID`;
  check Spanish recognition on a real call before relying on it for Spanish callers.

## Dynamic variables (from Convex)

Every call sends the same three (`convex/lib/prompts/agent.ts` `CALL_VARIABLES`). Every variable
is always sent (`templateVariables` turns an empty value into `none`):

| Variable | What |
|---|---|
| `first_name` | `Walter` (`friend` / `amigo` when missing) |
| `goal` | today's one goal, fixed text from `callGoal`: onboarding or story |
| `context` | his data, each part in its own tag: `<background>` (LinkedIn, onboarding), `<profile>`, `<memories>`, `<feedback>`, `<question>` (story) |

Onboarding: `lib/onboarding.buildOnboardingVariables`. Story: `cartesia.startCall` runs
`conversation.planNextCall` (`lib/planner.toPromptVariables`). The prompt fences `{{context}}` as
data, and no value can open or close a tag. The language comes from the character's agent, so it
isn't a variable. Once a story call is placed, `startCall` saves the plan on the calls row and runs
`conversation.markPlanUsed` for its question-bank row. `tests/agentPrompt.test.ts` fails if the
prompt, its placeholders and the variables drift apart.

After the call nothing extra is needed: `cartesia.applyPoll` schedules
`pipeline.processCall({ callId })`, which handles both onboarding and story calls. On the first
Spanish test call, check the language of Cartesia's automatic inactivity check-in and goodbye.
