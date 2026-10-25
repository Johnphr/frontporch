# Call loop + call feedback (feat/call-loop, off main 1b15958)

## Plan

### A. Repeating calls, interval in minutes (user: "a variable we can change in minutes")
- Env `CALL_INTERVAL_MINUTES` (Convex dashboard → Environment Variables). Unset / 0 / invalid = loop off
  (weekly `schedule.tick` by callDay/callHour keeps working as today). E.g. 5 for fast iteration, 10080 = weekly.
- The clock starts when a call ENDS, never while one is running (user rule): next call is due at
  `endedAt(latest call) + interval`. While his latest call is open (queued / in_progress / start_unknown /
  ended-awaiting-processing, the same OPEN_STATUSES + 90-min window as hasOpenCall), the loop waits.
  If processing takes longer than the interval, the next call starts right after it's processed.
- New cron `crons.interval("call loop", { minutes: 1 }, internal.callLoop.tick)`. Reads the env each run, so
  a change applies within a minute (no redeploy, no stale scheduled jobs).
- Who: elders with stage onboarding|active that already had at least one call (the first call stays user-started
  via "Call me now" or by hand). Inbound calls count as calls (they're rows too).
- Stop spamming a dead line: after 3 calls in a row without a conversation (no_conversation / failed /
  start_unknown / poll_error / poll_timeout) the loop skips him (log only) until a call with a conversation
  happens (e.g. he taps "Call me now" or one is started by hand).
- Double-start guard: tick stamps `elders.loopRequestedAt`; skips an elder stamped < 3 min ago. reserveCall's
  open-call guard still stops two rings.
- `calls.endedAt` (new optional field): set when the poll sees the call finished / fatal / timeout
  (planPollUpdate) and when a start fails (markStartFailed). Pure helper `callEndedAt(call)` falls back to
  lastPolledAt, then _creationTime, for old rows.
- Pure decisions in `convex/lib/callLoop.ts` (tested): parseIntervalMinutes, callEndedAt, loopDecision
  (wait_open | wait_interval {dueAt} | paused | due | off | never_called).

### B. Faster, friendlier call feedback in the sign-up page (frontend/onboarding-ui)
- Faster first polls so failures surface in ~1-2 min, not 2+: every 20 s for the first 3 min, then every
  60 s; total budget still ~61 min (MAX_POLL_ATTEMPTS adjusted).
- Store Cartesia's live status (`created` / `started`, the documented values) on the call as `liveStatus`
  while pending.
- Public query `signup.callStatus({ elderId })` → `{ state, nextCallAt? }`, ids/timestamps only, no transcript.
  Pure mapping `lib/callStatus.ts` from documented Cartesia end_reason values + our statuses:
  - none · dialing (queued / created) · in_call (started) · wrapping_up (ended, being processed) · done
  - no_answer (dial_no_answer, dial_timeout) · busy (dial_busy) · voicemail (voicemail_detected)
  - unreachable (dial_failed) · ended_early (no_conversation from a hang-up / too few words)
  - busy_lines (concurrency_limit) · start_failed (failed) · unsure (start_unknown)
  - trouble (poll_error / poll_timeout / config_error / network_error / agent_error / error)
  - process_failed → shown as done (the call itself went fine; we retry the write-up).
- UI: after "Call me now" succeeds, a status panel polls every 4 s and shows a friendly es/en message per
  state, with "Try again" for retryable failures and "Your next call: in N minutes / on <date>" when known.
  Stops polling at a final state. New file `src/CallStatus.jsx` (App.jsx is already 611 lines).
  `callAlreadyDone` copy no longer claims weekly calls are scheduled unless nextCallAt is known.
- Copy is plain, warm, short; no jargon; tells the person what to do next.

### Out of scope
- prepareCall (audience questions + web research ~1h before) is not run by the loop.
- No per-elder interval (one global env var).

## Revision 1 (audit round 1)
- R1 Retry: `callStatus` returns `canRetry` (+ `retryAt`) from the same rules requestCall uses
  (onboarding only, callRateLimit, no open call). The page shows "Try again" only when allowed;
  otherwise "We'll try again later" (loop) / plain message. Never for `unsure` (90-min block).
  Only a by-hand `cartesia:startCall` (or a real conversation) un-pauses an active elder.
- R2 Loop safety: the loop calls only numbers in CALL_ALLOWLIST unless `CALL_LOOP=all` (Twilio trial =
  verified numbers anyway). Due elders are staggered `runAfter(i * 30 s)`. No quiet hours (iteration
  tool; documented). Stop someone: remove his number from CALL_ALLOWLIST.
- R3 Posting: loop is off while AUTO_POST isn't off and the interval is under 1 day (see R3').
- R4 No-row failures (startCall throws before reserving / refused): the cooldown is
  max(3 min, interval), so a broken agent retries once per interval, not every minute.
- R5 schedule.runTick skips `due.call` while the loop is on (prepare still runs; harmless).
- R6 Cost: tick returns before any read when the loop is off; reads `take(3)` calls per eligible elder
  (bound: elders × 3 docs per minute, fine for tens of elders; revisit with elder-level fields later).
- R7 No per-minute logs for waiting/paused elders (only calls placed + config refusals). The failure
  streak counts only his-side outcomes: no_conversation (except concurrency_limit / config_error /
  agent_error / network_error / error), start_unknown, poll_timeout; not our-side `failed`/`poll_error`.
  Reuse hasOpenCall. Schema: calls.endedAt, calls.liveStatus, elders.loopRequestedAt.
  inbound.attachCallId re-opening a row clears endedAt.
- R8 `pollOutcome.pending` validator + PollOutcome type gain `liveStatus?`; only "created"/"started" stored,
  inside planPollUpdate's pending patch (CAS kept).
- R9 Poll: 20 s for attempts 0-8 (3 min), then 60 s; MAX_POLL_ATTEMPTS = 67 (~61 min < 90-min window).
  Tests updated (cartesia.test.ts timing + planPollUpdate deepEquals, onboarding.test.ts comment).
- R10 Privacy: `requestCall` returns `callId`; `callStatus({ callId })` answers only for a call created in the
  last 3 h; returns state + canRetry/retryAt only. No nextCallAt (dropped).
- R11 callState: an open status older than OPEN_CALL_WINDOW_MS → `trouble`. process_failed shown as done
  (comment fixed: retried by hand, not automatically). in_call copy says "ringing or on the call".
- R13 UI polling: every 4 s for 3 min, then 15 s, stop at 20 min or any non-live state, pause while the tab
  is hidden. callId kept in sessionStorage so a reload resumes the panel.
- R14 requestCall gets reason `already_onboarded` (no regex on English text).
- R15 onCall + the done screen move into `src/DoneStep.jsx` so App.jsx shrinks; i18n `status` block in es + en.

## Revision 2 (audit round 2)
- R7' Failure streak, newest first over `take(10)`: his-side rows count (no_conversation except our-side
  reasons, start_unknown, poll_timeout, poll_error: dialled but status lost); our-side rows (`failed`,
  no_conversation with concurrency_limit/config_error/agent_error/network_error/error) are skipped,
  neither counting nor resetting; a conversation (done / process_failed) ends the streak. 3 → paused.
- R2/R4' Stamp `loopRequestedAt = now + i * 30 s` (the staggered start time); skip while
  `now < loopRequestedAt + max(3 min, interval)`.
- R3' Posting gate: anything but `AUTO_POST=off` (lib/callLoop.postingMayBeLive: logins are per elder,
  so env keys can't prove nothing posts) with an interval under 1 day → loop off. While blocked, the
  tick logs one fixed warning per hour (minute 0) saying to set AUTO_POST=off; otherwise it returns counts.
