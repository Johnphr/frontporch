# Hackathon log: Best Use of Cartesia

- **Project:** MEMORIA (Cal Hacks 13.0)
- **What it does:** An AI phone host calls older professionals and turns their stories into posts on their own accounts; readers' replies come back on the next call.
- **Live app:** https://onboarding-ui-delta.vercel.app · **Repo:** https://github.com/Johnphr/frontporch
- **Cartesia features used:** Managed Agents (4 agents, one per host), outbound calls API, inbound phone number routed to an agent, a webhook tool with system dynamic variables (`system__caller_id`, `system__conversation_id`), dynamic variables per call, `initial_message`, `end_call` system tool, voicemail detection, bilingual agents (en/es). In-call model `claude-haiku-4.5`.
- **Code:** `convex/cartesiaAgents.ts` (creates/updates agents and the tool from code), `convex/cartesia.ts` (start calls, poll, transcripts), `convex/inbound.ts` + `convex/lib/inbound.ts` (lookup tool), `convex/lib/prompts/agent.ts`, `inbound.ts`, `principles.ts` (prompts), `convex/lib/characters.ts` (hosts).

## How we use Cartesia
- **Four hosts:** Daniel, Oscar, Victoria (English) and Diana (Spanish) are separate Managed Agents with their own voice and persona, built from one shared prompt (`lib/prompts/agent.ts`) and synced by `cartesiaAgents:syncAgent`.
- **Each call is personal:** `conversation.planNextCall` fills `first_name`, `goal` and `context` (his memories, reader feedback, today's question) as dynamic variables on `POST /agents/calls` (`convex/cartesia.ts`).
- **He can call us:** the number routes to an inbound agent whose webhook tool sends `system__caller_id`; our HTTP action verifies the live call with Cartesia, finds him, and returns his name, host and plan so the host greets him by name and continues (`convex/inbound.ts`).
- **Posts seconds after hang-up:** `pollCall` checks the call every 3 s (`FAST_POST`) and hands the transcript to the pipeline the moment Cartesia reports the call ended.
- **Voice safety:** the host says it's an AI when asked, never gives medical/legal/financial advice, and has one fixed take-down line that the pipeline recognises to remove a post (`lib/prompts/principles.ts`, `lib/undo.ts`).

## Log
- 2026-10-24 `59404de` onboarding call; `6fad328` story call (convex/cartesia.ts)
- 2026-10-24 `9918cec` Spanish agent; `942397b` characters (convex/lib/characters.ts)
- 2026-10-24 `1b15958` inbound calls + lookup tool (convex/inbound.ts, http.ts)
- 2026-10-24 `0957adf` ring 60 s for international calls; `f2618e7` repeat-call loop for testing
- 2026-10-24 `c933e8d` four hosts; `53c5092` inbound host voice + lookup log
- 2026-10-25 `7cffe62` inbound callback; `3c2580c` host cites where the question came from
