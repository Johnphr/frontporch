import { cronJobs } from "convex/server";

// Scheduled jobs. Convex crons run in UTC. Planned:
//   hourly  call elders whose local callDay + callHour match -> internal.vapi.startCall
//   daily   scrape his LinkedIn posts' reactions + comments  -> internal.apify.scrapeEngagement
// Owner: Core: Data. This file must keep a default-exported cronJobs().
const crons = cronJobs();

export default crons;
