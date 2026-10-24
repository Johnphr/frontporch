import { cronJobs } from "convex/server";

// Scheduled jobs. Convex crons run in UTC. Planned:
//   hourly  call elders whose local callDay + hour match -> internal.vapi.startWeeklyCall
//   daily   refresh online fallback questions            -> internal.apify.findQuestions
// Owner: Core: Data. This file must keep a default-exported cronJobs().
const crons = cronJobs();

export default crons;
