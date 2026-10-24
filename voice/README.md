# Voice: Cartesia setup

Pip's calls run on **Cartesia Managed Agents**: phone number, speech-to-text, the
in-call LLM and the Sonic voice. The agent's prompt and settings live in code
(`convex/lib/prompts/`, `convex/lib/cartesia.ts`) and are pushed to Cartesia by a
command, so the repo is the source of truth. Owner: Voice stream.

| File | What |
|---|---|
| `conversation-guide.md` | How Pip talks: research-backed rules |
| `prompts/story-call.md` | Pointer: the weekly call's prompt now lives in `convex/lib/prompts/story.ts` |

## One-time setup

1. Cartesia account → API key → `npx convex env set CARTESIA_API_KEY <key>`.
2. The phone number is already set up in Cartesia. Copy its id (starts with `ap_`) →
   `npx convex env set CARTESIA_FROM_NUMBER_ID <id>`.
3. Optional: pick a voice at play.cartesia.ai → `CARTESIA_VOICE_ID`; pick the in-call
   model (`GET /agents/models`) → `CARTESIA_MODEL` (default `claude-haiku-4.5`).
4. Create or update both agents (onboarding + story) from code:
   `npx convex run cartesia:syncAgent` (or `'{"only":"story"}'` for one)
   The first run creates each agent that has no id in env yet and prints the command, e.g.
   `npx convex env set CARTESIA_ONBOARDING_AGENT_ID <id>` and
   `npx convex env set CARTESIA_STORY_AGENT_ID <id>`. Later runs update them.

Tune in the Cartesia playground if you like, but copy the final values back into code
and run `syncAgent` again, or the next sync overwrites the playground changes.

## Dynamic variables (from Convex)

Onboarding calls use PR #7's variables (`first_name`, `known_background`, built by
`lib/onboarding.buildOnboardingVariables`). Story calls (slice 2, built): `cartesia.startCall`
runs `conversation.planNextCall` and sends its `dynamicVariables` as `dynamic_variables` on
`POST /agents/calls` with the story agent (`CARTESIA_STORY_AGENT_ID`). Every `{{name}}` in the
story prompt (`convex/lib/prompts/story.ts`) is always present (`templateVariables` turns an
empty value into `none`):

| Variable | Example |
|---|---|
| `firstName` | `Walter` |
| `language` | `Spanish` (a language name, not `es-MX`) |
| `profile` | `Industry: Baking.` / `Specialty: Production.` / `Career: ...` / `Topics he knows well: ...` / `Topics to avoid: ...` (one per line) |
| `memories` | `- People in his life: Eddie Morales (His foreman).` lines (unfinished stories and people first) |
| `feedback` | one warm sentence about reader reactions, or `none` |
| `mainQuestion` | today's question |
| `threads` | `- ...` lines, 2–3 backup questions |

Once a story call is placed, `startCall` saves the plan on the calls row and runs
`conversation.markPlanUsed` for its question-bank row. `tests/story.test.ts` and
`tests/planner.test.ts` fail if the story prompt starts using a variable Convex doesn't send.

After the call nothing extra is needed: `cartesia.applyPoll` schedules
`pipeline.processCall({ callId })`, which handles both onboarding and story calls.
