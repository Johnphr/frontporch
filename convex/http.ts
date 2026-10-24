import { httpRouter } from "convex/server";

// Webhooks, served at https://<deployment>.convex.site. No routes yet: Cartesia
// transcripts are polled (cartesia.pollCall) until Cartesia ships call webhooks.
// Add routes with http.route({ path, method: "POST", handler }) when needed.
// This file must keep a default-exported router.
const http = httpRouter();

export default http;
