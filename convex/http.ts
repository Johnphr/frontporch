import { httpRouter } from "convex/server";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { LOOKUP_PATH, lookupErrorResponse, parseLookupRequest, verifyBearer } from "./lib/inbound";

// Webhooks, served at https://<deployment>.convex.site. Cartesia call transcripts are polled
// (cartesia.pollCall); the only route is the inbound agent's lookup_caller tool.
// This file must keep a default-exported router. Env: CARTESIA_TOOL_SECRET.

declare const process: { env: Record<string, string | undefined> };

const http = httpRouter();

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
    if (!parsed) return json({ error: "caller_id missing or invalid" }, 400);
    try {
      const result = await ctx.runAction(internal.inbound.handleLookup, parsed);
      return json(result);
    } catch {
      console.warn("http: inbound lookup failed");
      return json(lookupErrorResponse());
    }
  }),
});

export default http;
