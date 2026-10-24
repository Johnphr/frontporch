// Scheduled work, triggered from crons.ts.
//
//   tick                      hourly: for each elder whose weekly call is about an hour
//                             away -> conversation.prepareCall; whose call hour has
//                             started -> cartesia.startCall. Each call slot is handled once.
//   dailyEngagement           daily: apify.scrapeEngagement for every active elder
//                             with a linkedinUrl (staggered)
//   weeklyAudienceQuestions   weekly: apify.findAudienceQuestions for every active elder
//
// Time math (timezones, DST) lives in lib/schedule.ts.
// Owner: Core: Data.

import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalAction, internalMutation } from "./_generated/server";
import { PREPARE_CALL_FN, START_CALL_FN, dueActions } from "./lib/schedule";

// Implemented by Core: Brain (conversation.ts, cartesia.ts). Referenced by name so
// this file doesn't depend on their generated types while all are in flight.
const prepareCall = makeFunctionReference<"action">(PREPARE_CALL_FN);
const startCall = makeFunctionReference<"action">(START_CALL_FN);

/** Space out Apify runs so they don't all start at once. */
const STAGGER_MS = 30 * 1000;

type TickResult = {
  checked: number;
  prepared: Id<"elders">[];
  started: Id<"elders">[];
  skipped: { elderId: Id<"elders">; reason: string }[];
};

/**
 * One atomic pass: read elders, claim due slots, schedule the work. Runs as a
 * mutation so a slot can never be claimed twice, even if tick runs twice.
 */
export const runTick = internalMutation({
  args: { now: v.optional(v.number()) },
  handler: async (ctx, args): Promise<TickResult> => {
    const now = args.now ?? Date.now();
    const result: TickResult = { checked: 0, prepared: [], started: [], skipped: [] };
    const elders = await ctx.db.query("elders").collect();
    for (const elder of elders) {
      if (elder.stage !== "active" && elder.stage !== "onboarding") continue;
      result.checked += 1;
      const due = dueActions(elder, now);
      if (due.skipReason) {
        result.skipped.push({ elderId: elder._id, reason: due.skipReason });
        continue;
      }
      // Schedule first, then record the slot. If scheduling throws (e.g. the target
      // function isn't deployed yet), only that elder's step is skipped and logged;
      // the rest of the tick goes on. The next tick is past that hour, so a skipped
      // slot is NOT retried: start that week's call by hand if needed.
      if (due.prepare) {
        try {
          await ctx.scheduler.runAfter(0, prepareCall, { elderId: elder._id });
          await ctx.db.patch(elder._id, { lastPreparedSlot: due.prepare.slot });
          result.prepared.push(elder._id);
        } catch (error) {
          result.skipped.push({ elderId: elder._id, reason: `prepareCall: ${String(error)}` });
        }
      }
      if (due.call) {
        try {
          await ctx.scheduler.runAfter(0, startCall, { elderId: elder._id });
          await ctx.db.patch(elder._id, { lastCallSlot: due.call.slot });
          result.started.push(elder._id);
        } catch (error) {
          result.skipped.push({ elderId: elder._id, reason: `startCall: ${String(error)}` });
        }
      }
    }
    return result;
  },
});

/** Hourly cron entry point. `now` is only for testing from the dashboard. */
export const tick = internalAction({
  args: { now: v.optional(v.number()) },
  handler: async (ctx, args): Promise<TickResult> => {
    return await ctx.runMutation(internal.schedule.runTick, args.now === undefined ? {} : { now: args.now });
  },
});

export const dailyEngagement = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ scheduled: number }> => {
    const elders = await ctx.db.query("elders").collect();
    let scheduled = 0;
    for (const elder of elders) {
      if (elder.stage !== "active" || !elder.linkedinUrl) continue;
      await ctx.scheduler.runAfter(scheduled * STAGGER_MS, internal.apify.scrapeEngagement, {
        elderId: elder._id,
      });
      scheduled += 1;
    }
    return { scheduled };
  },
});

export const weeklyAudienceQuestions = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ scheduled: number }> => {
    const elders = await ctx.db.query("elders").collect();
    let scheduled = 0;
    for (const elder of elders) {
      if (elder.stage !== "active") continue;
      await ctx.scheduler.runAfter(scheduled * STAGGER_MS, internal.apify.findAudienceQuestions, {
        elderId: elder._id,
      });
      scheduled += 1;
    }
    return { scheduled };
  },
});
