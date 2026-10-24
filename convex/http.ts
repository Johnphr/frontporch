import { httpRouter } from "convex/server";

// Webhooks, served at https://<deployment>.convex.site (dev deployments too,
// so no tunnel is needed). Planned routes:
//   POST /vapi/webhook  -> vapi.ts  Vapi server events        owner: Voice
//   POST /sms/inbound   -> sms.ts   family texts a question    owner: Core: Pipeline
// Add each with http.route({ path, method: "POST", handler }) in the PR that
// implements it. This file must keep a default-exported router.
const http = httpRouter();

export default http;
