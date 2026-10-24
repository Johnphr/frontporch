# Onboarding slice: implementation notes

Only what the diff doesn't show. Plan: `ARCHITECTURE.md` → Build order, slice 1.

## Decisions outside the spec
- Dynamic variables use Cartesia's `{{snake_case}}` syntax (docs: letters, digits,
  underscores). Every variable is always sent; empty values become "none", and the agent
  also has `dynamic_variable_placeholders` defaults, so Pip never reads a raw `{{...}}`.
- Silence settings: `turn.inactivity_check_in_secs = 30`, `inactivity_end_call_secs = 120`
  (guide rule 4: silence is thinking). Tune after real calls.
- Voicemail guard: under 30 words from him = no conversation (a greeting is ~10–20 words).
- `elders.seed` lives in Data's `elders.ts` (smallest place for it; Data may move it).

## Deviations
- Agent sync uses `/v1/agents` (Managed Agents). The older `PATCH /agents/{id}` from the
  plan only accepts flat Line SDK fields and rejected `config` with a 400.
- `conversation.ts` stays a stub; `startCall` uses `lib/onboarding.planNextCall` directly (audit).

## Code review fixes (round 1)
- Poll results go through `applyPoll`: compare-and-set on status + attempt count, next step
  scheduled in the same transaction. A duplicate chain (e.g. `pollCall` run by hand) stops.
- Dial timeout / 5xx → `start_unknown` (blocks a new call) instead of `failed`.
- No PII in logs or stored errors: scrape failures log a fixed string, call-endpoint errors keep
  only the HTTP status, Claude errors are fixed messages (`JSON.parse` errors quote the input).
- `mergeProfile` puts new list items first so full lists keep learning.
- `finishProcessing` keeps Cartesia's `error_message` (e.g. busy) on `no_conversation`.
- Open-call guard: also `ended` (awaiting processing) and `start_unknown`; 90 min window.
- LinkedIn background fenced as data in the agent prompt; fence tags stripped from it.
- `saveProfile` merges inside its transaction (concurrent processing can't drop an update).
- Not done: `convex-test` integration tests (needs vite). The transition logic is pure and
  unit-tested instead (`planPollUpdate`, `finishPatch`, `startFailureStatus`).

## Gotchas
- **Local Convex + `"use node"`**: the local backend refuses Node 26. Run local dev with
  Node 24 without installing anything: `npx -p node@24 -c 'npx convex dev'`.
  Cloud deployments are unaffected.
- `convex/_generated/` isn't committed (team convention so far); `npx convex dev` makes it.
- Never `git add -A` in a worktree with a `node_modules` symlink.

## Verified (local anonymous deployment, fake Cartesia key)
- Deploy + `--typecheck enable` clean; 96/96 tests.
- Missing env → clear error before any row is written.
- `POST /agents/calls` reachable: 401 for a fake key → row `failed` + error, no PII in logs.
- `reserveCall` refuses a second open call; `force` overrides.
- `/v1/agents` accepts the agent body (401 only on the fake key).
- `markStarted` twice → second refused; stale `applyPoll` → refused; busy call →
  `no_conversation` with Cartesia's reason kept.
- `processCall`: missing Anthropic key → `process_failed`, retry runs at once (claim released);
  voicemail-length transcript → `no_conversation`; finished call → skipped.

## Not verified yet (needs real keys)
- A real call: transcript `role` values, terminal `status` values, `end_reason` values.
- `llm.extractProfile` against real Claude output.
- Whether a network timeout on `POST /agents/calls` can still place a call (row says to
  check Cartesia's call log before retrying).

## Deferred
- Story calls, posts, memory, feedback (slices 2–3). Cron scheduling. Inbound calls.
- Replace the synthetic fixture with a real, phone-redacted call.
