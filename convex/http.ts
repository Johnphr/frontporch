import { httpRouter } from "convex/server";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { LOOKUP_PATH, lookupErrorResponse, parseLookupRequest, verifyBearer } from "./lib/inbound";
import { servePostsPage } from "./postsPage";
import { xOAuthCallback } from "./xAuth";

// Served at https://<deployment>.convex.site. Cartesia transcripts are polled (cartesia.pollCall)
// until Cartesia ships call webhooks. Routes: the inbound agent's lookup_caller tool, the X
// OAuth callback and the temporary posts page. This file must keep a default-exported router. Env: CARTESIA_TOOL_SECRET.

declare const process: { env: Record<string, string | undefined> };

const http = httpRouter();

// TEMPORARY: posts review page (convex/postsPage.ts). Remove with that file.
http.route({ path: "/posts", method: "GET", handler: servePostsPage });

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// POST /cartesia/inbound-lookup  { caller_id, conversation_id }  (Authorization: Bearer <secret>)
// -> who is calling and what to talk about (lib/inbound.ts response shapes). Never logs
// numbers or bodies.
http.route({
  path: LOOKUP_PATH,
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!verifyBearer(request.headers.get("Authorization"), process.env.CARTESIA_TOOL_SECRET)) {
      return json({ error: "unauthorized" }, 401);
    }
    const body = await request.json().catch(() => null);
    const parsed = parseLookupRequest(body);
    if (!parsed) return json({ error: "caller_id or conversation_id missing or invalid" }, 400);
    try {
      const result = await ctx.runAction(internal.inbound.handleLookup, parsed);
      return json(result);
    } catch {
      console.warn("http: inbound lookup failed");
      return json(lookupErrorResponse());
    }
  }),
});

// GET /oauth/x/callback?code&state: X sends him back here after Connect (xAuth.ts).
// Must match the callback URL in the X app settings: https://<deployment>.convex.site/oauth/x/callback
http.route({ path: "/oauth/x/callback", method: "GET", handler: xOAuthCallback });

export default http;
