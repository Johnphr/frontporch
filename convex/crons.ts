import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

// Scheduled jobs. Convex crons run in UTC; per-elder local times are handled in
// schedule.ts (lib/schedule.ts does the timezone math):
//   hourly  prepare calls ~1h ahead + start calls whose hour began -> internal.cartesia.startCall
//   daily   likes, reposts + replies on his Bluesky threads         -> internal.blueskyEngagement.scrapeForElder
//           (+ LinkedIn reactions/comments if LINKEDIN_POSTING=on)  -> internal.apify.scrapeEngagement
//   5 min   replies on his Bluesky + Threads posts (last 48h)       -> internal.schedule.recentEngagement
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

// Every 5 min: likes + replies on his Bluesky and Threads posts from the last 48h, so a reader's
// reply reaches his question bank (and the feedback line) within ~5-7 min. Never X (paid reads;
// X stays on the daily job). One indexed query when nothing was posted recently.
crons.interval("recent engagement", { minutes: 5 }, internal.schedule.recentEngagement, {});

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
