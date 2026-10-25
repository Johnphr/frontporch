import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

// Scheduled jobs. Convex crons run in UTC; per-elder local times are handled in
// schedule.ts (lib/schedule.ts does the timezone math):
//   hourly  prepare calls ~1h ahead + start calls whose hour began -> internal.cartesia.startCall
//   daily   scrape his LinkedIn posts' reactions + comments         -> internal.apify.scrapeEngagement
//   weekly  find audience questions for each active elder           -> internal.apify.findAudienceQuestions
//   10 min  record inbound calls the lookup tool missed             -> internal.inbound.syncInboundCalls
// Owner: Core: Data. This file must keep a default-exported cronJobs().
const crons = cronJobs();

// Every hour: prepare calls starting in ~1h (conversation.prepareCall) and start
// calls whose hour has begun (cartesia.startCall).
crons.hourly("weekly calls", { minuteUTC: 0 }, internal.schedule.tick, {});

// Daily: reactions + comments on his LinkedIn posts (feeds the question bank).
crons.daily("scrape LinkedIn engagement", { hourUTC: 13, minuteUTC: 15 }, internal.schedule.dailyEngagement, {});

// Every 10 min: inbound calls the lookup tool never recorded (inbound.syncInboundCalls).
// Does nothing until CARTESIA_INBOUND_AGENT_ID is set.
crons.interval("inbound calls backstop", { minutes: 10 }, internal.inbound.syncInboundCalls, {});

// Weekly: real questions people in his field ask online.
crons.weekly(
  "find audience questions",
  { dayOfWeek: "monday", hourUTC: 14, minuteUTC: 30 },
  internal.schedule.weeklyAudienceQuestions,
  {},
);

export default crons;
