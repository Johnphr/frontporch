# Pip: weekly story call

The prompt now lives in code: **`convex/lib/prompts/story.ts`** (`STORY_INSTRUCTIONS`,
`STORY_GREETING`, `STORY_PLACEHOLDERS`). It's pushed to Cartesia with
`npx convex run cartesia:syncAgent` (agent id in `CARTESIA_STORY_AGENT_ID`).

Edit it there, then re-sync. Rules behind it: `../conversation-guide.md`.

Variables (Cartesia `dynamic_variables`, built by `conversation.planNextCall`):
`{{first_name}}`, `{{language}}`, `{{profile}}`, `{{memories}}`, `{{feedback}}`,
`{{main_question}}`, `{{threads}}`. `tests/story.test.ts` checks the prompt uses exactly these.
