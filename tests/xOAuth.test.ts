// X OAuth (lib/xOAuth.ts) with fakes: PKCE, the authorize URL, token exchange, refresh
// rotation, the state rules and the callback. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  STATE_MAX_AGE_MS,
  X_SCOPES,
  XAuthError,
  callbackRedirect,
  checkXState,
  codeChallengeS256,
  isRefreshRefused,
  isRefreshSetupError,
  makeCodeVerifier,
  makeXAdapter,
  parseTokenResponse,
  runXCallback,
  tokensFromJson,
  tokensToJson,
  xRedirectUri,
  type CallbackDeps,
  type FetchFn,
} from "../convex/lib/xOAuth.ts";
import { NOW } from "./helpers.ts";

type Call = { url: string; method?: string; headers?: Record<string, string>; body?: string };

function fakeFetch(responses: { status: number; body: unknown }[]): { fetchFn: FetchFn; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    calls.push({ url, ...init });
    const r = responses.shift() ?? { status: 500, body: {} };
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
  };
  return { fetchFn, calls };
}

const client = () => ({ clientId: "cid", clientSecret: "secret" });
const adapter = makeXAdapter(client, () => NOW);

test("PKCE: verifier is 43-128 url-safe chars, challenge is the RFC 7636 S256 value", async () => {
  const v = makeCodeVerifier();
  assert.match(v, /^[A-Za-z0-9_-]{43,128}$/);
  assert.notEqual(makeCodeVerifier(), v);
  // Same as Node's own sha256 -> base64url.
  assert.equal(await codeChallengeS256(v), createHash("sha256").update(v).digest("base64url"));
  assert.match(await codeChallengeS256(v), /^[A-Za-z0-9_-]{43}$/);
});

test("authorize URL: x.com, code + S256, the four scopes, state and redirect", () => {
  const url = new URL(adapter.authorizeUrl("st4te", "https://d.convex.site/oauth/x/callback", "chal"));
  assert.equal(url.origin + url.pathname, "https://x.com/i/oauth2/authorize");
  const q = url.searchParams;
  assert.equal(q.get("response_type"), "code");
  assert.equal(q.get("client_id"), "cid");
  assert.equal(q.get("redirect_uri"), "https://d.convex.site/oauth/x/callback");
  assert.equal(q.get("scope"), "tweet.read tweet.write users.read offline.access");
  assert.equal(q.get("state"), "st4te");
  assert.equal(q.get("code_challenge"), "chal");
  assert.equal(q.get("code_challenge_method"), "S256");
  assert.ok(!url.toString().includes("+"), "spaces as %20");
  assert.deepEqual(adapter.scopes, X_SCOPES);
  assert.throws(() => adapter.authorizeUrl("s", "r"));
  assert.throws(() => makeXAdapter(() => null).authorizeUrl("s", "r", "c"), XAuthError);
});

test("redirect URI comes from CONVEX_SITE_URL", () => {
  assert.equal(xRedirectUri({ CONVEX_SITE_URL: "https://d.convex.site/" }), "https://d.convex.site/oauth/x/callback");
  assert.equal(xRedirectUri({}), null);
});

test("exchangeCode: Basic auth, form with verifier, then users/me", async () => {
  const { fetchFn, calls } = fakeFetch([
    { status: 200, body: { access_token: "AT", refresh_token: "RT", expires_in: 7200, scope: "tweet.read tweet.write users.read offline.access", token_type: "bearer" } },
    { status: 200, body: { data: { id: "12345", username: "grandpa_joe", name: "Joe" } } },
  ]);
  const out = await adapter.exchangeCode(fetchFn, "CODE", "https://d.convex.site/oauth/x/callback", "VERIFIER");
  assert.deepEqual(out, { accessToken: "AT", refreshToken: "RT", expiresAt: NOW + 7_200_000, scopes: X_SCOPES, userId: "12345", username: "grandpa_joe" });
  assert.equal(calls[0].url, "https://api.x.com/2/oauth2/token");
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].headers?.Authorization, `Basic ${btoa("cid:secret")}`);
  const form = new URLSearchParams(calls[0].body);
  assert.equal(form.get("grant_type"), "authorization_code");
  assert.equal(form.get("code"), "CODE");
  assert.equal(form.get("code_verifier"), "VERIFIER");
  assert.equal(form.get("redirect_uri"), "https://d.convex.site/oauth/x/callback");
  assert.equal(calls[1].url, "https://api.x.com/2/users/me");
  assert.equal(calls[1].headers?.Authorization, "Bearer AT");
});

test("exchangeCode: X's error code is kept, never the body text", async () => {
  const { fetchFn } = fakeFetch([{ status: 400, body: { error: "invalid_request", error_description: "Value passed for the authorization code was invalid." } }]);
  await assert.rejects(adapter.exchangeCode(fetchFn, "C", "r", "v"), (e: unknown) => {
    assert.ok(e instanceof XAuthError);
    assert.equal(e.message, "X token HTTP 400 (invalid_request)");
    return true;
  });
  await assert.rejects(adapter.exchangeCode(fetchFn, "C", "r"), /verifier/);
});

test("refresh: sends the refresh token and returns the rotated one", async () => {
  const { fetchFn, calls } = fakeFetch([{ status: 200, body: { access_token: "AT2", refresh_token: "RT2", expires_in: 7200 } }]);
  const out = await adapter.refresh(fetchFn, { accessToken: "AT", refreshToken: "RT" });
  assert.deepEqual(out, { accessToken: "AT2", refreshToken: "RT2", expiresAt: NOW + 7_200_000 });
  const form = new URLSearchParams(calls[0].body);
  assert.equal(form.get("grant_type"), "refresh_token");
  assert.equal(form.get("refresh_token"), "RT");
  assert.equal(form.get("client_id"), "cid");
  await assert.rejects(adapter.refresh(fetchFn, { accessToken: "AT" }), XAuthError);
});

test("refresh refused (invalid_grant) is recognised", async () => {
  const { fetchFn } = fakeFetch([{ status: 400, body: { error: "invalid_grant" } }]);
  const err = await adapter.refresh(fetchFn, { accessToken: "a", refreshToken: "old" }).catch((e) => e);
  assert.ok(isRefreshRefused(err));
  assert.ok(!isRefreshRefused(new XAuthError("refresh", 503)));
});

test("parseTokenResponse: default 2h, needs an access token", () => {
  assert.equal(parseTokenResponse({ access_token: "a" }, NOW).expiresAt, NOW + 7_200_000);
  assert.throws(() => parseTokenResponse({}, NOW), XAuthError);
});

test("state rules: single use, 15 minutes, X only, needs a verifier", () => {
  const row = { elderId: "e1", platform: "x", codeVerifier: "v", createdAt: NOW - 60_000 };
  assert.deepEqual(checkXState(row, NOW), { ok: true });
  assert.deepEqual(checkXState(null, NOW), { ok: false, error: "unknown_state" });
  assert.deepEqual(checkXState({ ...row, usedAt: NOW - 1 }, NOW), { ok: false, error: "used_state" });
  assert.deepEqual(checkXState({ ...row, platform: "threads" }, NOW), { ok: false, error: "wrong_platform" });
  assert.deepEqual(checkXState({ ...row, createdAt: NOW - STATE_MAX_AGE_MS - 1 }, NOW), { ok: false, error: "expired_state" });
  assert.deepEqual(checkXState({ ...row, createdAt: NOW - STATE_MAX_AGE_MS }, NOW), { ok: true });
  assert.deepEqual(checkXState({ ...row, codeVerifier: undefined }, NOW), { ok: false, error: "no_verifier" });
});

function callbackDeps(over: Partial<CallbackDeps> = {}): CallbackDeps & { saved: unknown[]; consumed: string[] } {
  const saved: unknown[] = [];
  const consumed: string[] = [];
  return {
    saved,
    consumed,
    siteUrl: "https://frontporch.example/signup",
    consumeState: async (s) => {
      consumed.push(s);
      return s === "good" ? { ok: true, elderId: "e1", codeVerifier: "v" } : { ok: false, error: "unknown_state" };
    },
    exchange: async () => ({ accessToken: "AT", refreshToken: "RT", expiresAt: NOW, userId: "1", username: "joe", scopes: X_SCOPES }),
    save: async (elderId, t) => {
      saved.push({ elderId, t });
    },
    ...over,
  };
}

test("callback: success saves and redirects with connected=x, no tokens in the URL", async () => {
  const deps = callbackDeps();
  const out = await runXCallback(deps, new URLSearchParams({ state: "good", code: "C" }));
  assert.deepEqual(out, { redirect: "https://frontporch.example/signup?connected=x" });
  assert.equal(deps.saved.length, 1);
});

test("callback: bad state, denial, exchange failure, missing scope, save failure (Threads' codes + platform=x)", async () => {
  const r = (deps: CallbackDeps, q: Record<string, string>) => runXCallback(deps, new URLSearchParams(q));
  assert.deepEqual(await r(callbackDeps(), { state: "nope", code: "C" }), { redirect: "https://frontporch.example/signup?connect_error=invalid_state&platform=x" });
  assert.deepEqual(await r(callbackDeps(), { code: "C" }), { redirect: "https://frontporch.example/signup?connect_error=invalid_state&platform=x" });
  const denied = callbackDeps();
  assert.deepEqual(await r(denied, { state: "good", error: "access_denied" }), { redirect: "https://frontporch.example/signup?connect_error=denied&platform=x" });
  assert.deepEqual(denied.consumed, ["good"], "a denial still burns the state");
  const failing = callbackDeps({ exchange: async () => Promise.reject(new XAuthError("token", 400, "invalid_request")) });
  assert.deepEqual(await r(failing, { state: "good", code: "C" }), { redirect: "https://frontporch.example/signup?connect_error=exchange_failed&platform=x" });
  const noWrite = callbackDeps({ exchange: async () => ({ accessToken: "A", expiresAt: 0, userId: "1", username: "j", scopes: ["tweet.read"] }) });
  assert.deepEqual(await r(noWrite, { state: "good", code: "C" }), { redirect: "https://frontporch.example/signup?connect_error=missing_scope&platform=x" });
  assert.equal(noWrite.saved.length, 0);
  const noKey = callbackDeps({ save: async () => Promise.reject(new Error("ACCOUNTS_ENC_KEY is not set")) });
  assert.deepEqual(await r(noKey, { state: "good", code: "C" }), { redirect: "https://frontporch.example/signup?connect_error=failed&platform=x" });
});

test("callback redirect: returnTo only on the same site; plain text without a site", () => {
  assert.deepEqual(callbackRedirect("https://fp.example/signup", "https://fp.example/me?x=1", { connected: "x" }), { redirect: "https://fp.example/me?x=1&connected=x" });
  assert.deepEqual(callbackRedirect("https://fp.example/signup", "https://evil.example/", { connected: "x" }), { redirect: "https://fp.example/signup?connected=x" });
  // Old flags are replaced, never doubled.
  assert.deepEqual(callbackRedirect("https://fp.example/signup?connect_error=old&platform=threads", undefined, { connect_error: "used_state" }), {
    redirect: "https://fp.example/signup?connect_error=state_used&platform=x",
  });
  assert.deepEqual(callbackRedirect("https://fp.example/signup", undefined, { connect_error: "expired_state" }), {
    redirect: "https://fp.example/signup?connect_error=state_expired&platform=x",
  });
  const plain = callbackRedirect(undefined, undefined, { connect_error: "denied" });
  assert.ok("text" in plain && plain.status === 400);
});

test("token JSON round trip", () => {
  assert.deepEqual(tokensFromJson(tokensToJson({ accessToken: "a", refreshToken: "r" })), { accessToken: "a", refreshToken: "r" });
  assert.equal(tokensFromJson("not json"), null);
  assert.equal(tokensFromJson("{}"), null);
});

test("refresh errors: only invalid_grant / invalid_request about the token are refusals; unauthorized_client is setup", async () => {
  const errOf = async (status: number, body: unknown) => {
    const { fetchFn } = fakeFetch([{ status, body }]);
    return adapter.refresh(fetchFn, { accessToken: "a", refreshToken: "old" }).catch((e) => e);
  };
  const badToken = await errOf(400, { error: "invalid_request", error_description: "Value passed for the token was invalid." });
  assert.ok(isRefreshRefused(badToken));
  assert.ok(!JSON.stringify(badToken).includes("Value passed"), "X's text isn't kept");
  assert.ok(!isRefreshRefused(await errOf(400, { error: "invalid_request", error_description: "Missing grant_type" })));
  const setup = await errOf(401, { error: "unauthorized_client", error_description: "Missing valid authorization header" });
  assert.ok(!isRefreshRefused(setup), "a 401 from our app credentials doesn't mark his account");
  assert.ok(isRefreshSetupError(setup));
  assert.ok(!isRefreshRefused(await errOf(401, {})), "a bare 401 isn't a refusal");
  assert.ok(!isRefreshSetupError(await errOf(400, { error: "invalid_grant" })));
});

test("callback: no offline.access (no refresh token, dead in 2 hours) -> missing_scope, nothing saved", async () => {
  const noOffline = callbackDeps({
    exchange: async () => ({ accessToken: "A", expiresAt: 0, userId: "1", username: "j", scopes: ["tweet.read", "tweet.write", "users.read"] }),
  });
  assert.deepEqual(await runXCallback(noOffline, new URLSearchParams({ state: "good", code: "C" })), {
    redirect: "https://frontporch.example/signup?connect_error=missing_scope&platform=x",
  });
  assert.equal(noOffline.saved.length, 0);
});
