# Pip / Juanito: weekly story call

The prompt lives in code: **`convex/lib/prompts/story.ts`** (`storyAgent(lang)`: Pip in English,
Juanito in Spanish), with the shared parts in `convex/lib/prompts/principles.ts`. It's pushed to
Cartesia with `npx convex run cartesiaAgents:syncAgent` (ids in `CARTESIA_STORY_AGENT_ID` and
`CARTESIA_STORY_AGENT_ID_ES`).

Edit it there, then re-sync. Rules behind it: `../conversation-guide.md`.

One goal per call: a story that starts from `{{question}}`. Variables (Cartesia
`dynamic_variables`, built by `conversation.planNextCall`): `{{first_name}}`, `{{profile}}`,
`{{memories}}`, `{{feedback}}`, `{{question}}`. `tests/story.test.ts` checks the prompt uses exactly these.
