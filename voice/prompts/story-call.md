# Pip / Juanito: weekly story call

There is one prompt for every character and every call: **`convex/lib/prompts/agent.ts`**
(`characterAgent(character)`), with the shared parts in `convex/lib/prompts/principles.ts`. It's
pushed to Cartesia with `npx convex run cartesiaAgents:syncAgent` (one agent per character; ids
in the `characterAgents` table).

Edit it there, then re-sync. Rules behind it: `../conversation-guide.md`.

A story call is just a goal: `callGoal("story")`, a story that starts from today's question.
Variables (Cartesia `dynamic_variables`, built by `conversation.planNextCall`): `{{first_name}}`,
`{{goal}}`, `{{context}}` (profile, memories, feedback and question, each in its own tag).
`tests/agentPrompt.test.ts` checks the prompt uses exactly these.
