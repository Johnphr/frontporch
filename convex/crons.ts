import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

// Scheduled jobs. Convex crons run in UTC; per-elder local times are handled in
// schedule.ts (lib/schedule.ts does the timezone math):
//   hourly  prepare calls ~1h ahead + start calls whose hour began -> internal.cartesia.startCall
//   daily   likes, reposts + replies on his Bluesky threads         -> internal.blueskyEngagement.scrapeForElder
//           (+ LinkedIn reactions/comments if LINKEDIN_POSTING=on)  -> internal.apify.scrapeEngagement
//   30 s    replies on his Bluesky + Threads posts (last 2h)        -> internal.schedule.recentEngagement
//   5 min   replies on his Bluesky + Threads posts (2 to 48h old)   -> internal.schedule.recentEngagement
//   weekly  find audience questions for each active elder           -> internal.apify.findAudienceQuestions
//   10 min  record inbound calls the lookup tool missed             -> internal.inbound.syncInboundCalls
//   1 min   repeat calls every CALL_INTERVAL_MINUTES (testing)      -> internal.callLoop.tick
// Owner: Core: Data. This file must keep a default-exported cronJobs().
const crons = cronJobs();

// Every hour: prepare calls starting in ~1h (conversation.prepareCall) and start
// calls whose hour has begun (cartesia.startCall).
crons.hourly("weekly calls", { minuteUTC: 0 }, internal.schedule.tick, {});

// Daily: likes, reposts + replies on his Bluesky threads, and LinkedIn reactions + comments
// when LINKEDIN_POSTING=on (feeds the question bank). Renamed from "scrape LinkedIn
// engagement": on deploy Convex drops the old job and registers this one.
crons.daily("scrape reader engagement", { hourUTC: 13, minuteUTC: 15 }, internal.schedule.dailyEngagement, {});

// Likes + replies on his Bluesky and Threads posts: every 30 s for posts from the last 2h (a
// reply reaches his question bank and feedback line in about a minute), every 5 min for posts
// 2 to 48h old. Never X (paid reads; X stays on the daily job). One indexed query when idle.
crons.interval("fresh engagement", { seconds: 30 }, internal.schedule.recentEngagement, { tier: "fast" });
crons.interval("recent engagement", { minutes: 5 }, internal.schedule.recentEngagement, { tier: "slow" });

// Every minute: repeat calls CALL_INTERVAL_MINUTES after the last one ended (callLoop.ts). Does
// nothing until CALL_INTERVAL_MINUTES is set.
crons.interval("call loop", { minutes: 1 }, internal.callLoop.tick, {});

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
