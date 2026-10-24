# Convex

All of Front Porch's backend: tables, vector memory, crons, the Vapi webhook,
the question planner, the post writer, and the actions that call Claude,
OpenAI, Vapi, LinkedAPI and Apify. See `../ARCHITECTURE.md` for the loop,
contracts and who owns which file.

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

## LinkedIn posting + post guard (Integrations)

`linkedapi.createPost({ postId })` formats the post for LinkedIn, fact-checks it
against the call transcript (`postGuard.checkPost`), then posts through LinkedAPI
and polls until the post URL is saved on the `posts` row.

| Env var | Purpose |
|---|---|
| `LINKEDAPI_TOKEN`, `LINKEDAPI_ID_TOKEN` | LinkedAPI account + grandpa's connected LinkedIn |
| `ANTHROPIC_API_KEY` | Shared with Brain; the guard calls Claude |
| `POST_GUARD_MODE` | `enforce` (default: failing posts become `needs_review`, not posted) · `warn` (post anyway, keep issues) · `off` |

Try it without posting anything:

```bash
npx convex run linkedapi:previewText '{"text":"My first job...","turns":[{"role":"elder","text":"My first job was at a bakery"}]}'
npx convex run linkedapi:previewPost '{"postId":"<posts id>"}'
```

Unit tests for the formatter (no Convex needed): `node --test "tests/**/*.test.ts"`.

## Notes

- The webhook is served at `https://<deployment>.convex.site/vapi/webhook` (see `http.ts`).
- `http.ts` and `crons.ts` must keep their default exports, even when empty.
- Vector search (`ctx.vectorSearch`) only works inside actions.
- Files with `"use node"` at the top may only export actions.
- v1 leftovers: `questions.ts`, `answers.ts`, `replies.ts` get deleted;
  `elders.ts`, `calls.ts`, `lib/auth.ts` still use the old `secret` argument
  and get converted to internal functions (Core: Data).
