# Voice: Cartesia setup

Pip's calls run on **Cartesia Managed Agents**: phone number, speech-to-text, the
in-call LLM and the Sonic voice. The agent's prompt and settings live in code
(`convex/lib/prompts/`, `convex/lib/cartesia.ts`) and are pushed to Cartesia by a
command, so the repo is the source of truth. Owner: Voice stream.

| File | What |
|---|---|
| `conversation-guide.md` | How Pip talks: research-backed rules |
| `prompts/story-call.md` | Draft prompt for the weekly call (moves into code in slice 2) |

## One-time setup

1. Cartesia account → API key → `npx convex env set CARTESIA_API_KEY <key>`.
2. The phone number is already set up in Cartesia. Copy its id (starts with `ap_`) →
   `npx convex env set CARTESIA_FROM_NUMBER_ID <id>`.
3. Optional: pick a voice at play.cartesia.ai → `CARTESIA_VOICE_ID`; pick the in-call
   model (`GET /agents/models`) → `CARTESIA_MODEL` (default `claude-haiku-4.5`).
4. Create or update the agent from code:
   `npx convex run cartesia:syncAgent`
   The first run (no `CARTESIA_ONBOARDING_AGENT_ID` yet) creates the agent and prints its
   id → `npx convex env set CARTESIA_ONBOARDING_AGENT_ID <id>`. Later runs update it.

Tune in the Cartesia playground if you like, but copy the final values back into code
and run `syncAgent` again, or the next sync overwrites the playground changes.

## Dynamic variables (from Convex)

`cartesia.startCall` gets them ready-made:
`const { plan, dynamicVariables } = await ctx.runAction(internal.conversation.planNextCall, { elderId })`.
Send `dynamicVariables` as `dynamic_variables` on `POST /agents/calls` and pick the agent by
`plan.kind` (`onboarding` / `story`). Every `{{name}}` in `prompts/*.md` is always present
(empty string when unused):

| Variable | Example |
|---|---|
| `firstName` | `Walter` |
| `language` | `Spanish` (a language name, not `es-MX`) |
| `profile` | `Industry: Baking.` / `Specialty: Production.` / `Career: ...` / `Topics to avoid: ...` (one per line) |
| `memories` | `- People in his life: Eddie Morales (His foreman).` lines (unfinished stories and people first) |
| `feedback` | one warm sentence about reader reactions, or empty |
| `mainQuestion` | today's question |
| `threads` | `- ...` lines, 2–3 backup questions |
| `knownBackground` | onboarding only: his LinkedIn work history |

After the call is placed, call `internal.conversation.markPlanUsed({ elderId, bankId:
plan.bankId, callId })` (skip when `plan.bankId` is missing). A test in
`tests/planner.test.ts` fails if a prompt starts using a variable Convex doesn't send.

After the call: `cartesia.pollCall` → `internal.pipeline.recordCallResult({ cartesiaCallId,
elderId, kind, turns, summary, endReason })` (turns from `normalizeCartesiaTranscript` in
`convex/lib/cartesiaTranscript.ts`) → `internal.pipeline.processCall({ callId })`.
