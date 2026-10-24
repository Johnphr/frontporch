import { httpRouter } from "convex/server";

// Webhooks, served at https://<deployment>.convex.site (dev deployments too,
// so no tunnel is needed). Planned route:
//   POST /vapi/webhook  -> vapi.ts  Vapi server events   owner: Voice
// Add it with http.route({ path, method: "POST", handler }) in the PR that
// implements it. This file must keep a default-exported router.
const http = httpRouter();

export default http;
