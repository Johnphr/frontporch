# Onboarding slice: implementation notes

Only what the diff doesn't show. Plan: `ARCHITECTURE.md` → Build order, slice 1.

## Decisions outside the spec
- Dynamic variables use Cartesia's `{{snake_case}}` syntax (docs: letters, digits,
  underscores). Every variable is always sent; empty values become "none" so the
  prompt never shows a raw `{{...}}`.

## Deviations

## Gotchas

## Deferred

## Open questions (verify on the first real call)
- Exact transcript `role` values and terminal `status` values from `GET /agents/calls/{id}`.
- Whether Managed Agents expose turn-detection settings (`end_timeout_ms`).
