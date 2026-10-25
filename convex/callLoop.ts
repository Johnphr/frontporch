// Repeating calls for fast iteration (and, later, the real cadence). Every minute (crons.ts):
// for each elder the loop covers, call him again CALL_INTERVAL_MINUTES after his last call ENDED.
//
//   npx convex env set CALL_INTERVAL_MINUTES 5      # every 5 min after the previous call ends
//   npx convex env remove CALL_INTERVAL_MINUTES     # loop off (weekly schedule.tick as before)
//
// - Covers only CALL_ALLOWLIST numbers unless CALL_LOOP=all (lib/callLoop.loopCovers).
// - Waits while a call is ringing, talking or being written up; never starts a second one.
// - Never the first call (that's "Call me now" or a call started by hand).
// - Stops calling him after 3 missed calls in a row until he really talks (a call by hand, or
//   "Call me now" during onboarding).
// - Off with an interval under a day unless AUTO_POST=off (no public post every 5 min). While
//   blocked it logs a warning once an hour (minute 0) saying to set AUTO_POST=off.
// - Starts are spaced 30 s apart. No quiet hours: it's a testing tool, keep the list small.
// Decisions: lib/callLoop.ts (tested). Owner: Brain.

import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalMutation } from "./_generated/server";
import { blockedWarning, loopCovers, loopDecision, loopInterval, type LoopEnv } from "./lib/callLoop";

declare const process: { env: Record<string, string | undefined> };

const STAGGER_MS = 30_000;
const RECENT_CALLS = 10;

type TickResult = { off?: string; checked: number; started: Id<"elders">[]; waiting: number; paused: number };

export const tick = internalMutation({
  args: {},
  handler: async (ctx): Promise<TickResult> => {
    const env = process.env as LoopEnv;
    const interval = loopInterval(env);
    const result: TickResult = { checked: 0, started: [], waiting: 0, paused: 0 };
    const now = Date.now();
    if (interval.minutes === null) {
      const warning = blockedWarning(interval.blocked, now);
      if (warning) console.warn(warning);
      return { ...result, off: interval.blocked ?? "CALL_INTERVAL_MINUTES not set" };
    }

    const elders = await ctx.db.query("elders").collect();
    for (const elder of elders) {
      if (!loopCovers(env, elder.phone)) continue;
      result.checked += 1;
      // Most ticks just wait: decide on his latest call alone, read 10 rows only when he looks due.
      const latest = (n: number) =>
        ctx.db.query("calls").withIndex("by_elder", (q) => q.eq("elderId", elder._id)).order("desc").take(n);
      let decision = loopDecision(elder, await latest(1), now, interval.minutes);
      if (decision.action === "call") decision = loopDecision(elder, await latest(RECENT_CALLS), now, interval.minutes);
      if (decision.action === "call") {
        const startAt = now + result.started.length * STAGGER_MS;
        await ctx.scheduler.runAt(startAt, internal.cartesia.startCall, { elderId: elder._id });
        await ctx.db.patch(elder._id, { loopRequestedAt: startAt });
        result.started.push(elder._id);
      } else if (decision.action === "skip" && decision.reason === "paused") {
        result.paused += 1;
      } else {
        result.waiting += 1;
      }
    }
    if (result.started.length) console.log(`callLoop.tick: ${result.started.length} call(s) scheduled`);
    return result;
  },
});
