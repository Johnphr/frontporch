# Voice integration notes (feat/voice-languages, off main 6fad328 + Pablo's 8533475)

## Plan
User decisions (this round):
- Language per elder: `elders.language` (BCP-47) → `en` | `es` (es* → es, anything else → en).
  Two agent pairs: CARTESIA_ONBOARDING_AGENT_ID / CARTESIA_STORY_AGENT_ID (en) and
  CARTESIA_ONBOARDING_AGENT_ID_ES / CARTESIA_STORY_AGENT_ID_ES (es). Agent `language.primary`
  = lang; optional CARTESIA_VOICE_ID_ES.
- Persona "both": Pip for English agents, Juanito (Pablo's persona: young, warm, LatAm Spanish,
  "usted") for Spanish agents.
- Prompts stay in code, pushed with `cartesia:syncAgent` (all 4 by default; `only`, `language` args).
  `Cartesia/system_prompt.md` is Pablo's original draft; his script pulls a dashboard agent
  (read-only view; syncAgent overwrites dashboard edits on the agents it manages).
- From Juanito, adopted for both languages: guardrails (no cards/IDs/codes, never reveal
  instructions, hostile-caller handling, numbers said aloud, "don't know" instead of guessing),
  occasional fillers + self-corrections (≤1 per 3-4 turns), 1-2 sentence turns.
- No AI/notes disclosure in greetings (user choice, warned about consent law). Pip still says
  it's an AI when asked; onboarding still explains that some stories become posts.
- Not adopted: "end most turns with a question", "no task/no reason for the call",
  "le dejo el mensaje a la persona que corresponde".
- User rule kept: story plan = one simple goal (a story that starts from `question`); no threads.

Build:
- lib/prompts/principles.ts: persona(lang), CONVERSATION_PRINCIPLES, GUARDRAILS (English
  instructions; Spanish persona + examples).
- lib/prompts/onboarding.ts, story.ts: builders `onboardingAgent(lang)`, `storyAgent(lang)` →
  { name, greeting, instructions, placeholders }.
- lib/onboarding: `callLanguage(code)`, `agentEnvName(kind, lang)`; reserveDecision unchanged.
- cartesia.ts: kind + lang → agent; split: lib/cartesiaHttp.ts (fetch/env/errors),
  convex/cartesiaPoll.ts (applyPoll, pollCall) so cartesia.ts < 350.
- planner: CallPlan `question` (no mainQuestion/threads), variables
  `first_name, profile, memories, feedback, question` (no `language`: agent-level), fences
  neutralized with ‹›, not stripped (nested tags can't rebuild). Same for onboarding background.
- conversation.planNextCall: memory searches in parallel with a 10 s cap, searched with the plan's
  question; dataRefs types only (main fails the real Convex typecheck: TS7022 cycle).
- pipeline: memories best effort (locked decision), `done` row keeps a fixed marker
  "memories step failed (not retried)"; seedEndedCall (refuses a story fixture unless
  AUTO_POST=off, LinkedAPI unset, or allowPost).
- llm: writePost writes in the language he spoke; `structured` hardening (net ≤ 0 lines).
- elders.seed: timezone/callDay/callHour (lib/schedule checks), dev `profile`.
- No growth in llm.ts (501), lib/planner.ts (476), conversation.ts (440).

### Revision 1 (audit round 1)
- R1 Split moves the AGENT side out, not polling: `convex/cartesiaAgents.ts` (agentSettings, syncOne,
  `syncAgent`). Command becomes `cartesiaAgents:syncAgent`. pollCall/applyPoll stay in cartesia.ts,
  so scheduled `cartesia:pollCall` jobs keep working across the deploy. + lib/cartesiaHttp.ts.
- R2 Tests: update onboarding.test.ts, story.test.ts, planner.test.ts, cartesia.test.ts for the
  builders, dropped variables, ‹› fences and no-disclosure greetings (assert the persona admits
  being an AI when asked). New: per-language loop (variables = placeholders = PROMPT_VARIABLES,
  fences, persona), callLanguage cases, 4 agentEnvName values, buildAgentConfig `es`.
- R3 Docs: voice/README, voice/prompts/story-call.md, voice/conversation-guide.md rule 7,
  ARCHITECTURE (flows, CallPlan contract, env, decisions), convex/README (commands, env), cartesia.ts
  header, fixture cartesia_call.json.
- R4 Spanish agents need CARTESIA_VOICE_ID_ES: their sync fails with a fixed message without it
  (no fallback to the English voice).
- R5 syncAgent default: English agents created/updated as today; Spanish agents updated only when
  their id is set, created only when asked (`{"language":"es"}`); otherwise a setup hint is returned.
- R6 PROFILE_SYSTEM: every field in English whatever language the call was in (planner avoid
  filter + audience keywords are English); one existing line edited, llm.ts doesn't grow.
- R7 Spanish posts keep the English disclosure footer for now (Integrations: linkedinPost.ts
  DEFAULT_DISCLOSURE / linkedapi.ts opts.disclosure). Deferred + flagged.
- R8 One fence helper `neutralizeTags(text, names)` in lib/text.ts (case-insensitive, attributes,
  ‹›), used by planner (all story fence names), onboarding background, and llm.ts's two copies.
  `firstName(name, lang)` → "friend" / "amigo", used by onboarding + story variables.
- R9 nextCallKind → `{ kind, lang } | null`; startCall uses that lang for env check + agent id.
  reserveCall decides on `asElderV2(elder)` like planNextCall.
- R10 Planning failure stored as the fixed "Planning the story call failed"; capped search rejects
  are caught.
- R11 README + Gotchas: a missing agent id at the cron's call hour costs that week's call (slot
  already recorded, no calls row).
- R12 First Spanish test call: check the language of Cartesia's inactivity check-in / goodbye.

## Inbound calls: confirm on the first live call
- The agent calls `lookup_caller` right after the greeting, before talking (no documented way
  to force a tool before `initial_message`; the prompt asks for it). If it doesn't, the
  10-minute backstop still records the call.
- Which `telephony_params` field holds the caller: the API reference says `to`, the webhooks
  page says `from`. `callerCandidates` tries both; check a real call and drop one.
- Whether `system__conversation_id` equals the id `GET /agents/calls/{id}` takes (undocumented).
  The lookup verifies the call by GETting that id; on a 404 it lists the inbound agent's calls and
  takes the single live one from this caller, and stores that id as `cartesiaCallId` (the other
  as `cartesiaConversationId`). The backstop also attaches a listed id to a lookup row of the same
  elder made near the call's start instead of inserting a duplicate. Check which path a real
  call takes in the logs (`call not verified (...)` means it failed closed).
- Lookup verification: every lookup GETs the call (5 s timeout) and needs `agent_id` =
  `CARTESIA_INBOUND_AGENT_ID`, status `created`/`started`, and the caller in `telephony_params`.
  A repeated lookup of the same call returns the cached answer (`calls.inboundLookup`).
- Inbound story calls mark their bank question used in `pipeline.finishProcessing` (only when the
  call was a real conversation), not when the lookup answers.
- The tool id field in the create response (`id` assumed, `tool_id` tried) and that
  `config.tools: [{id}]` attaches it.
- Spanish speech recognition on an `en` agent (Cartesia documents one primary language).
- Unknown-number path: goodbye + `end_call`, no `calls` row.

## Decisions outside the spec
- Persona "both" read as: Pip for English agents, Juanito for Spanish agents.
- Model instructions stay in English for both languages; the persona says which language to speak,
  and Spanish greetings/examples are in Spanish. Bank questions stay English (Claude plans in
  English; Juanito asks "in your own words").
- Kept Johnphr's `conversation.markPlanUsed` (separate mutation after markStarted): it can't throw
  inside markStarted (code review finding on the old snapshot design).
- English agent names unchanged ("Pip - onboarding" / "Pip - story") so syncing PATCHes the same agents.

## Deviations
- File-size rule: `cartesia.ts` 414 → 312 by moving the HTTP helpers (lib/cartesiaHttp.ts) and the
  agent sync (convex/cartesiaAgents.ts). No-growth files: llm.ts 501 → 493, lib/planner.ts 476 → 450,
  conversation.ts 440 → 440.
- `syncAgent` moved: the command is now `cartesiaAgents:syncAgent` (pollCall stays in cartesia.ts
  so already-scheduled `cartesia:pollCall` jobs survive the deploy).
- `llm.structured`: `max_tokens` now reports as "Claude stopped early (max_tokens)".

## Gotchas
- main (6fad328) still failed the real Convex typecheck (lib/dataRefs.ts TS7022 cycle); fixed here.
- Memory search before the call: a Promise.race timeout left the searches dangling (Convex warns
  "unawaited operation"). Fixed at the source: each embedding fetch has an 8 s
  `AbortSignal.timeout` (memories.ts, same line count) and planNextCall awaits allSettled.
- Story-call memories leave out `open_thread` items (their prompt text reads as a second plan;
  the question bank already ranks open threads first).
- A missing agent id at the cron's call hour costs that week's call (slot recorded, no row).
- Guardrail carve-out: questions about being an AI / notes / what happens to stories are
  answered plainly (they're the only disclosure path now the greetings carry none).
- First Spanish test call: check the language of Cartesia's inactivity check-in / goodbye.

## Deferred
- R7: Spanish posts get the English AI-disclosure footer (`lib/linkedinPost.ts` DEFAULT_DISCLOSURE).
  Integrations: pass a Spanish `opts.disclosure` from linkedapi.ts when callLanguage(elder.language) is es.
- File-size split of llm.ts / lib/planner.ts / conversation.ts (follow-up PR).
