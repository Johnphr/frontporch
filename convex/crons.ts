import { cronJobs } from "convex/server";

// Scheduled jobs. Convex crons run in UTC. Planned:
//   hourly  call elders whose local callDay + callHour match -> internal.cartesia.startCall (slice 2)
//   daily   scrape his LinkedIn posts' reactions + comments  -> internal.apify.scrapeEngagement
//   weekly  find audience questions for each active elder    -> internal.apify.findAudienceQuestions
// Owner: Core: Data. This file must keep a default-exported cronJobs().
const crons = cronJobs();

export default crons;
