import { httpRouter } from "convex/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { httpAction } from "./_generated/server";
import type { FetchFn } from "./lib/blueskyClient";
import { LOOKUP_PATH, lookupErrorResponse, parseLookupRequest, verifyBearer } from "./lib/inbound";
import { finishOAuthConnect, signupRedirect } from "./lib/oauthFlow";
import { callbackPath, type OAuthPlatform } from "./lib/oauthPlatforms";
import { servePostsPage } from "./postsPage";

// Served at https://<deployment>.convex.site. Cartesia transcripts are polled (cartesia.pollCall)
// until Cartesia ships call webhooks. Routes: the inbound agent's lookup_caller tool and the
// temporary posts page, and the OAuth connect callbacks (Threads). This file must keep a
// default-exported router. Env: CARTESIA_TOOL_SECRET, SIGNUP_SITE_URL (+ lib/oauthPlatforms.ts).

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
