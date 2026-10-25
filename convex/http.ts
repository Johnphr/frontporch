import { httpRouter } from "convex/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { httpAction } from "./_generated/server";
import type { FetchFn } from "./lib/blueskyClient";
import {
  LOOKUP_PATH,
  inboundHost,
  lookupErrorResponse,
  lookupLogLine,
  lookupOutcome,
  parseLookupRequest,
  unknownCallerResponse,
  verifyBearer,
  type LookupOutcome,
} from "./lib/inbound";
import { finishOAuthConnect, signupRedirect } from "./lib/oauthFlow";
import { callbackPath, type OAuthPlatform } from "./lib/oauthPlatforms";
import { servePostsPage } from "./postsPage";
import { xOAuthCallback } from "./xAuth";

// Served at https://<deployment>.convex.site. Cartesia transcripts are polled (cartesia.pollCall)
// until Cartesia ships call webhooks. Routes: the inbound agent's lookup_caller tool, the
// temporary posts page, and the OAuth connect callbacks (Threads via lib/oauthFlow, X via xAuth.ts).
// This file must keep a default-exported router. Env: CARTESIA_TOOL_SECRET, SIGNUP_SITE_URL.

declare const process: { env: Record<string, string | undefined> };

const http = httpRouter();

// TEMPORARY: posts review page (convex/postsPage.ts). Remove with that file.
http.route({ path: "/posts", method: "GET", handler: servePostsPage });
http.route({ path: "/posts", method: "POST", handler: servePostsPage }); // "Fact-check now"

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// POST /cartesia/inbound-lookup  { caller_id, conversation_id? }  (Authorization: Bearer <secret>)
// -> who is calling and what to talk about (lib/inbound.ts response shapes). Exactly ONE log
// line per request, `inbound-lookup: known|unknown|error <reason>` (401 and 400 included), and
// one inboundLookups row (inbound.lastLookups). Never logs numbers, bodies or the secret.
http.route({
  path: LOOKUP_PATH,
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const seen = async (outcome: LookupOutcome, reason: string, elderId?: Id<"elders">) => {
      console.log(lookupLogLine(outcome, reason));
      await ctx.runMutation(internal.inbound.recordLookup, { outcome, reason, ...(elderId ? { elderId } : {}) }).catch(() => {});
    };
    if (!verifyBearer(request.headers.get("Authorization"), process.env.CARTESIA_TOOL_SECRET)) {
      await seen("error", process.env.CARTESIA_TOOL_SECRET ? "unauthorized" : "unauthorized:no_secret_configured");
      return json({ error: "unauthorized" }, 401);
    }
    const host = inboundHost(process.env);
    const body = await request.json().catch(() => null);
    const parsed = parseLookupRequest(body);
    if (!parsed.ok) {
      if (parsed.reason === "bad_body") {
        await seen("error", "bad_body");
        return json({ error: "caller_id missing or not a string" }, 400);
      }
      await seen("unknown", parsed.reason); // withheld / unusable number: a polite goodbye
      return json(unknownCallerResponse(host));
    }
    try {
      const { response, reason, elderId } = await ctx.runAction(internal.inbound.handleLookup, {
        callerId: parsed.callerId,
        ...(parsed.conversationId ? { conversationId: parsed.conversationId } : {}),
      });
      await seen(lookupOutcome(response), reason, elderId);
      return json(response);
    } catch {
      await seen("error", "exception");
      return json(lookupErrorResponse(host));
    }
  }),
});

// GET /oauth/x/callback?code&state: X sends him back here after Connect (xAuth.ts).
// Must match the callback URL in the X app settings: https://<deployment>.convex.site/oauth/x/callback
http.route({ path: "/oauth/x/callback", method: "GET", handler: xOAuthCallback });

// GET /oauth/<platform>/callback?code&state (or ?error=access_denied): finish an OAuth connect
// (lib/oauthFlow.finishOAuthConnect), then send him back to the sign-up site with only
// ?connected=<platform> or ?connect_error=<code>. Never a token, code, state or id.
const oauthFetch: FetchFn = async (url, init) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};

function oauthCallback(platform: OAuthPlatform) {
  return httpAction(async (ctx, request) => {
    const params = new URL(request.url).searchParams;
    let outcome;
    try {
      outcome = await finishOAuthConnect(
        {
          env: process.env,
          fetchFn: oauthFetch,
          consumeState: (state) => ctx.runMutation(internal.oauth.consumeState, { state, platform, now: Date.now() }),
          save: (a) =>
            ctx.runMutation(internal.oauth.saveTokens, { ...a, elderId: a.elderId as Id<"elders">, platform, now: Date.now(), signup: true }),
          warn: (message) => console.warn(message),
        },
        platform,
        { code: params.get("code"), state: params.get("state"), error: params.get("error") },
      );
    } catch {
      console.warn(`http: ${platform} oauth callback failed`);
      outcome = { ok: false as const, error: "failed" as const };
    }
    const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
    const location = signupRedirect(process.env.SIGNUP_SITE_URL, platform, outcome);
    if (location) return new Response(null, { status: 302, headers: { ...headers, Location: location } });
    const text = outcome.ok ? "Connected. You can close this tab and go back to the sign-up page." : "We couldn't connect your account. Please go back to the sign-up page and try again.";
    return new Response(text, { status: outcome.ok ? 200 : 400, headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" } });
  });
}

http.route({ path: callbackPath("threads"), method: "GET", handler: oauthCallback("threads") });

export default http;
