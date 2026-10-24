# Convex

All of Front Porch's backend: tables, vector memory, crons, webhooks and the
actions that call Claude, OpenAI, Vapi, Twilio, LinkedAPI and Apify.
See `../ARCHITECTURE.md` for flows, contracts and who owns which file.

## Run

From the repo root:

```bash
npm install
npx convex dev        # first run: log in, pick the team project
```

The first run generates `convex/_generated/`. Keys go in Convex env, never in
the repo:

```bash
npx convex env set ANTHROPIC_API_KEY <value>
```

## Notes

- Webhooks are served at `https://<deployment>.convex.site/<path>` (see `http.ts`).
- `http.ts` and `crons.ts` must keep their default exports, even when empty.
- Vector search (`ctx.vectorSearch`) only works inside actions.
- Files with `"use node"` at the top may only export actions.
- v1 files (`answers.ts`, `calls.ts`, `elders.ts`, `questions.ts`, `replies.ts`,
  `lib/auth.ts`) still use the old `secret` argument from the deleted Python
  server. They get converted to internal functions (Core: Data).
