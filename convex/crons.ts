import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

// Scheduled jobs. Convex crons run in UTC; per-elder local times are handled in
// schedule.ts (lib/schedule.ts does the timezone math).
// Owner: Core: Data. This file must keep a default-exported cronJobs().
const crons = cronJobs();

// Every hour: prepare calls starting in ~1h (conversation.prepareCall) and start
// calls whose hour has begun (vapi.startCall).
crons.hourly("weekly calls", { minuteUTC: 0 }, internal.schedule.tick, {});

// Daily: reactions + comments on his LinkedIn posts (feeds the question bank).
crons.daily("scrape LinkedIn engagement", { hourUTC: 13, minuteUTC: 15 }, internal.schedule.dailyEngagement, {});

// Weekly: real questions people in his field ask online.
crons.weekly(
  "find audience questions",
  { dayOfWeek: "monday", hourUTC: 14, minuteUTC: 30 },
  internal.schedule.weeklyAudienceQuestions,
  {},
);

export default crons;
