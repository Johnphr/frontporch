// Run: npm test
// OAuth connect (Threads): state rules, the adapter's URLs and exchange parsing, the refresh
// rule, the start step, and the callback (never a token in the redirect). Fakes only.
import { test } from "node:test";
import assert from "node:assert/strict";

import type { FetchFn } from "../convex/lib/blueskyClient.ts";
import {
  STATE_TTL_MS,
  checkState,
  codeChallengeS256,
  finishOAuthConnect,
  isStateShape,
  newOAuthState,
  openTokens,
  sealTokens,
  signupRedirect,
  startOAuthConnectFlow,
  startXConnectFlow,
  xConnectConfigured,
  type CallbackDeps,
  type SaveArgs,
} from "../convex/lib/oauthFlow.ts";
import {
  MIN_TOKEN_AGE_MS,
  OAuthHttpError,
  THREADS_SCOPES,
  cleanAuthCode,
  oauthAdapter,
  redirectUriFor,
  shouldRefresh,
  threadsAdapter,
} from "../convex/lib/oauthPlatforms.ts";
import { loadAccountKey } from "../convex/lib/accountCrypto.ts";
import { NOW } from "./helpers.ts";

const KEY = Buffer.alloc(32, 7).toString("base64");
const ENV = {
  THREADS_APP_ID: "app123",
  THREADS_APP_SECRET: "app-secret-xyz",
  CONVEX_SITE_URL: "https://happy-otter-123.convex.site",
  SIGNUP_SITE_URL: "https://frontporch.example/",
  ACCOUNTS_ENC_KEY: KEY,
};
const DAY = 86_400_000;
const SHORT_TOKEN = "SHORT-TOKEN-aaaa";
const LONG_TOKEN = "LONG-TOKEN-bbbb";

type Call = { url: string; init?: Parameters<FetchFn>[1] };

function fakeFetch(routes: (url: string, init?: Parameters<FetchFn>[1]) => { status?: number; body: unknown } | "throw") {
  const calls: Call[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    calls.push({ url, init });
    const r = routes(url, init);
    if (r === "throw") throw new TypeError("network");
    const status = r.status ?? 200;
    return { ok: status >= 200 && status < 300, status, json: async () => r.body };
  };
  return { fetchFn, calls };
}

/** Meta's happy path: code -> short token -> long-lived token -> profile. */
function metaOk() {
  return fakeFetch((url) => {
    if (url.startsWith("https://graph.threads.com/oauth/access_token")) return { body: { access_token: SHORT_TOKEN, user_id: 17841400000000001, token_type: "bearer" } };
    if (url.startsWith("https://graph.threads.com/access_token?")) return { body: { access_token: LONG_TOKEN, token_type: "bearer", expires_in: 5183944 } };
    if (url.startsWith("https://graph.threads.com/v1.0/me?")) return { body: { id: "17841400000000001", username: "walter.builds" } };
    return { status: 404, body: {} };
  });
}

// ---------- state ----------

test("state: random 43-char base64url, different every time", () => {
  const a = newOAuthState();
  const b = newOAuthState();
  assert.ok(isStateShape(a) && isStateShape(b));
  assert.notEqual(a, b);
  assert.equal(isStateShape("short"), false);
  assert.equal(isStateShape(null), false);
});

test("state: single use, 15 minutes, same platform", () => {
  const row = { platform: "threads", createdAt: NOW };
  assert.deepEqual(checkState(row, "threads", NOW + 60_000), { ok: true });
  assert.deepEqual(checkState(row, "threads", NOW + STATE_TTL_MS), { ok: true });
  assert.deepEqual(checkState(row, "threads", NOW + STATE_TTL_MS + 1), { ok: false, error: "state_expired" });
  assert.deepEqual(checkState({ ...row, usedAt: NOW + 1 }, "threads", NOW + 2), { ok: false, error: "state_used" });
  assert.deepEqual(checkState(row, "x", NOW), { ok: false, error: "invalid_state" });
  assert.deepEqual(checkState(null, "threads", NOW), { ok: false, error: "invalid_state" });
});

test("pkce: S256 challenge of the RFC 7636 example", async () => {
  assert.equal(await codeChallengeS256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
});

// ---------- adapter ----------

test("threads adapter: needs app id + secret; registry has only threads", () => {
  assert.equal(threadsAdapter({}), null);
  assert.equal(threadsAdapter({ THREADS_APP_ID: "1" }), null);
  assert.ok(oauthAdapter("threads", ENV));
  assert.equal(oauthAdapter("x", ENV), null);
  assert.equal(oauthAdapter("bluesky", ENV), null);
});

test("threads adapter: authorize URL", () => {
  const adapter = threadsAdapter(ENV)!;
  const url = new URL(adapter.authorizeUrl("STATE", "https://happy-otter-123.convex.site/oauth/threads/callback"));
  assert.equal(url.origin + url.pathname, "https://threads.com/oauth/authorize");
  assert.equal(url.searchParams.get("client_id"), "app123");
  assert.equal(url.searchParams.get("redirect_uri"), "https://happy-otter-123.convex.site/oauth/threads/callback");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("state"), "STATE");
  assert.equal(url.searchParams.get("scope"), THREADS_SCOPES.join(","));
  assert.ok(!url.toString().includes("app-secret-xyz"));
  assert.ok(!url.searchParams.get("scope")!.includes("threads_keyword_search"));
  const withSearch = new URL(threadsAdapter({ ...ENV, THREADS_KEYWORD_SEARCH: "on" })!.authorizeUrl("S", "https://r"));
  assert.ok(withSearch.searchParams.get("scope")!.split(",").includes("threads_keyword_search"));
});

test("redirect URI: THREADS_REDIRECT_URI wins, else CONVEX_SITE_URL + path", () => {
  assert.equal(redirectUriFor("threads", ENV), "https://happy-otter-123.convex.site/oauth/threads/callback");
  assert.equal(redirectUriFor("threads", { CONVEX_SITE_URL: "https://a.convex.site/" }), "https://a.convex.site/oauth/threads/callback");
  assert.equal(redirectUriFor("threads", { ...ENV, THREADS_REDIRECT_URI: "https://custom/cb" }), "https://custom/cb");
  assert.equal(redirectUriFor("threads", {}), null);
});

test("threads adapter: exchange = code -> short token -> long-lived token (+ username)", async () => {
  const { fetchFn, calls } = metaOk();
  const tokens = await threadsAdapter(ENV, () => NOW)!.exchangeCode(fetchFn, "CODE123#_", "https://r/cb");
  assert.deepEqual(tokens, { accessToken: LONG_TOKEN, expiresAt: NOW + 5183944 * 1000, userId: "17841400000000001", username: "walter.builds", issuedAt: NOW });
  // 1: POST with the form body (code without "#_")
  assert.equal(calls[0].init?.method, "POST");
  const form = new URLSearchParams(calls[0].init?.body);
  assert.equal(form.get("grant_type"), "authorization_code");
  assert.equal(form.get("code"), "CODE123");
  assert.equal(form.get("redirect_uri"), "https://r/cb");
  assert.equal(form.get("client_id"), "app123");
  assert.equal(form.get("client_secret"), "app-secret-xyz");
  // 2: th_exchange_token with the short token
  const long = new URL(calls[1].url);
  assert.equal(long.pathname, "/access_token");
  assert.equal(long.searchParams.get("grant_type"), "th_exchange_token");
  assert.equal(long.searchParams.get("access_token"), SHORT_TOKEN);
});

test("threads adapter: a refused code throws a status-only error", async () => {
  const { fetchFn } = fakeFetch(() => ({ status: 400, body: { error_type: "OAuthException", code: 400, error_message: "code was used: CODE123" } }));
  await assert.rejects(threadsAdapter(ENV)!.exchangeCode(fetchFn, "CODE123", "https://r/cb"), (e: unknown) => {
    assert.ok(e instanceof OAuthHttpError);
    assert.equal(e.status, 400);
    assert.ok(!e.message.includes("CODE123"));
    return true;
  });
});

test("threads adapter: missing profile is fine; missing user_id is not", async () => {
  const noProfile = fakeFetch((url) =>
    url.includes("/oauth/access_token") ? { body: { access_token: SHORT_TOKEN, user_id: "42" } } : url.includes("/access_token?") ? { body: { access_token: LONG_TOKEN, expires_in: 100 } } : "throw",
  );
  const t = await threadsAdapter(ENV, () => NOW)!.exchangeCode(noProfile.fetchFn, "c", "https://r");
  assert.equal(t.username, undefined);
  assert.equal(t.expiresAt, NOW + 100_000);
  // A user_id too big for a JS number and no /me: we can't know his id for sure.
  const unsafeId = fakeFetch((url) =>
    url.includes("/oauth/access_token") ? { body: { access_token: SHORT_TOKEN, user_id: 17841400000000001 } } : url.includes("/access_token?") ? { body: { access_token: LONG_TOKEN, expires_in: 100 } } : "throw",
  );
  await assert.rejects(threadsAdapter(ENV)!.exchangeCode(unsafeId.fetchFn, "c", "https://r"), OAuthHttpError);
  const noUser = fakeFetch(() => ({ body: { access_token: SHORT_TOKEN } }));
  await assert.rejects(threadsAdapter(ENV)!.exchangeCode(noUser.fetchFn, "c", "https://r"), OAuthHttpError);
});

test("threads adapter: refresh calls th_refresh_token and resets the 60 days", async () => {
  const { fetchFn, calls } = fakeFetch(() => ({ body: { access_token: "NEW-TOKEN", expires_in: 5184000 } }));
  const fresh = await threadsAdapter(ENV, () => NOW)!.refresh(fetchFn, { accessToken: LONG_TOKEN, expiresAt: NOW + DAY, userId: "42", issuedAt: NOW - 59 * DAY });
  assert.deepEqual(fresh, { accessToken: "NEW-TOKEN", expiresAt: NOW + 5184000 * 1000, userId: "42", issuedAt: NOW });
  const u = new URL(calls[0].url);
  assert.equal(u.origin + u.pathname, "https://graph.threads.com/refresh_access_token");
  assert.equal(u.searchParams.get("grant_type"), "th_refresh_token");
});

test("cleanAuthCode strips Meta's #_", () => {
  assert.equal(cleanAuthCode("abc#_"), "abc");
  assert.equal(cleanAuthCode(" abc "), "abc");
});

// ---------- refresh rule ----------

test("refresh rule: under 7 days left, over 24 h old, not expired", () => {
  assert.equal(shouldRefresh({ expiresAt: NOW + 30 * DAY, issuedAt: NOW - 30 * DAY }, NOW), false); // plenty left
  assert.equal(shouldRefresh({ expiresAt: NOW + 6 * DAY, issuedAt: NOW - 54 * DAY }, NOW), true);
  assert.equal(shouldRefresh({ expiresAt: NOW + 6 * DAY, issuedAt: NOW - MIN_TOKEN_AGE_MS + 1 }, NOW), false); // too young
  assert.equal(shouldRefresh({ expiresAt: NOW - 1, issuedAt: NOW - 61 * DAY }, NOW), false); // expired: reconnect
  assert.equal(shouldRefresh({ expiresAt: NOW + DAY }, NOW), true); // age unknown
});

// ---------- tokens at rest ----------

test("sealed tokens: round trip, bound to the elder and platform", async () => {
  const key = await loadAccountKey(KEY);
  const sealed = await sealTokens(key, { accessToken: LONG_TOKEN, expiresAt: NOW, userId: "42", issuedAt: NOW - DAY }, "elder1", "threads");
  assert.ok(!sealed.ciphertext.includes(LONG_TOKEN));
  const back = await openTokens(key, sealed, "elder1", "threads", { externalUserId: "42", tokenExpiresAt: NOW + DAY, handle: "walter" });
  assert.deepEqual(back, { accessToken: LONG_TOKEN, issuedAt: NOW - DAY, expiresAt: NOW + DAY, userId: "42", username: "walter" });
  await assert.rejects(openTokens(key, sealed, "elder2", "threads", {}));
  await assert.rejects(openTokens(key, sealed, "elder1", "x", {}));
});

// ---------- start ----------

test("start: not configured, key missing, reserve refusal, then a URL with a stored state", async () => {
  const states: { state: string; codeVerifier?: string }[] = [];
  const deps = (env: Record<string, string | undefined>, reserved: any = { ok: true }) => ({
    env,
    reserve: async () => reserved,
    createState: async (row: { state: string; codeVerifier?: string }) => {
      states.push(row);
    },
  });
  assert.deepEqual(await startOAuthConnectFlow(deps({}), "threads"), { ok: false, error: "not_configured" });
  assert.deepEqual(await startOAuthConnectFlow(deps({ ...ENV, ACCOUNTS_ENC_KEY: undefined }), "threads"), { ok: false, error: "failed" });
  assert.deepEqual(await startOAuthConnectFlow(deps(ENV, { ok: false, error: "locked" }), "threads"), { ok: false, error: "locked" });
  assert.deepEqual(await startOAuthConnectFlow(deps(ENV), "x"), { ok: false, error: "not_configured" });
  assert.equal(states.length, 0);
  const res = await startOAuthConnectFlow(deps(ENV), "threads");
  assert.ok(res.ok);
  assert.equal(states.length, 1);
  assert.equal(states[0].codeVerifier, undefined); // Threads: no PKCE
  assert.equal(new URL(res.url).searchParams.get("state"), states[0].state);
});

test("start X: same checks and codes, then xAuth.startConnect makes the URL (its own state + PKCE)", async () => {
  const X_ENV = { ...ENV, X_CLIENT_ID: "xid", X_CLIENT_SECRET: "xsecret" };
  const log: string[] = [];
  const deps = (env: Record<string, string | undefined>, o: { reserved?: any; start?: () => Promise<{ url: string }> } = {}) => ({
    env,
    reserve: async () => (log.push("reserve"), o.reserved ?? { ok: true }),
    start: o.start ?? (async () => (log.push("start"), { url: "https://x.com/i/oauth2/authorize?state=s" })),
  });
  assert.equal(xConnectConfigured(X_ENV), true);
  assert.equal(xConnectConfigured(ENV), false, "no X client");
  assert.equal(xConnectConfigured({ ...X_ENV, CONVEX_SITE_URL: "" }), false, "no callback URL");
  assert.deepEqual(await startXConnectFlow(deps(ENV)), { ok: false, error: "not_configured" });
  assert.deepEqual(await startXConnectFlow(deps({ ...X_ENV, ACCOUNTS_ENC_KEY: undefined })), { ok: false, error: "failed" });
  assert.deepEqual(log, [], "nothing reserved or started");
  assert.deepEqual(await startXConnectFlow(deps(X_ENV, { reserved: { ok: false, error: "rate_limited" } })), { ok: false, error: "rate_limited" });
  assert.deepEqual(log, ["reserve"], "refused: never started");
  log.length = 0;
  assert.deepEqual(await startXConnectFlow(deps(X_ENV)), { ok: true, url: "https://x.com/i/oauth2/authorize?state=s" });
  assert.deepEqual(log, ["reserve", "start"]);
  const throws = deps(X_ENV, { start: async () => Promise.reject(new Error("X connect isn't set up")) });
  assert.deepEqual(await startXConnectFlow(throws), { ok: false, error: "failed" });
  assert.deepEqual(await startXConnectFlow(deps(X_ENV, { start: async () => ({ url: "javascript:alert(1)" }) })), { ok: false, error: "failed" });
});

// ---------- callback ----------

function callbackDeps(over: Partial<CallbackDeps> = {}, fetchFn = metaOk().fetchFn) {
  const saved: SaveArgs[] = [];
  const consumed: string[] = [];
  const deps: CallbackDeps = {
    env: ENV,
    fetchFn,
    consumeState: async (state) => {
      consumed.push(state);
      return { ok: true, elderId: "elder1" };
    },
    save: async (a) => {
      saved.push(a);
      return { ok: true };
    },
    ...over,
  };
  return { deps, saved, consumed };
}

const STATE = "A".repeat(43);

test("callback: success saves encrypted tokens and redirects with ?connected=threads only", async () => {
  const { deps, saved, consumed } = callbackDeps();
  const outcome = await finishOAuthConnect(deps, "threads", { code: "CODE123#_", state: STATE });
  assert.deepEqual(outcome, { ok: true });
  assert.deepEqual(consumed, [STATE]);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].externalUserId, "17841400000000001");
  assert.equal(saved[0].handle, "walter.builds");
  assert.ok(!JSON.stringify(saved[0]).includes(LONG_TOKEN));
  const key = await loadAccountKey(KEY);
  const back = await openTokens(key, saved[0].secret, "elder1", "threads", {});
  assert.equal(back.accessToken, LONG_TOKEN);
  const location = signupRedirect(ENV.SIGNUP_SITE_URL, "threads", outcome)!;
  assert.equal(location, "https://frontporch.example/?connected=threads");
});

test("callback: access_denied burns the state and redirects with connect_error=denied", async () => {
  const { deps, saved, consumed } = callbackDeps();
  const outcome = await finishOAuthConnect(deps, "threads", { error: "access_denied", state: STATE });
  assert.deepEqual(outcome, { ok: false, error: "denied" });
  assert.deepEqual(consumed, [STATE]);
  assert.equal(saved.length, 0);
  assert.equal(signupRedirect(ENV.SIGNUP_SITE_URL, "threads", outcome), "https://frontporch.example/?connect_error=denied&platform=threads");
});

test("callback: bad, used or expired state never exchanges the code", async () => {
  const meta = metaOk();
  const { deps } = callbackDeps({ consumeState: async () => ({ ok: false, error: "state_used" }) }, meta.fetchFn);
  assert.deepEqual(await finishOAuthConnect(deps, "threads", { code: "c", state: STATE }), { ok: false, error: "state_used" });
  assert.deepEqual(await finishOAuthConnect(deps, "threads", { code: "c", state: "not-a-state" }), { ok: false, error: "invalid_state" });
  assert.deepEqual(await finishOAuthConnect(deps, "threads", { code: "c" }), { ok: false, error: "invalid_state" });
  assert.equal(meta.calls.length, 0);
});

test("callback: refused exchange, missing key, locked", async () => {
  const refused = fakeFetch(() => ({ status: 400, body: { error_type: "OAuthException" } }));
  assert.deepEqual(await finishOAuthConnect(callbackDeps({}, refused.fetchFn).deps, "threads", { code: "c", state: STATE }), { ok: false, error: "exchange_failed" });
  assert.deepEqual(await finishOAuthConnect(callbackDeps({ env: { ...ENV, ACCOUNTS_ENC_KEY: "" } }).deps, "threads", { code: "c", state: STATE }), { ok: false, error: "failed" });
  assert.deepEqual(await finishOAuthConnect(callbackDeps({ save: async () => ({ ok: false, error: "locked" }) }).deps, "threads", { code: "c", state: STATE }), { ok: false, error: "locked" });
});

test("callback redirect: never a token, code, state, user id or elder id", async () => {
  const warnings: string[] = [];
  const outcomes = [
    await finishOAuthConnect({ ...callbackDeps().deps, warn: (m) => warnings.push(m) }, "threads", { code: "CODE123", state: STATE }),
    await finishOAuthConnect({ ...callbackDeps({}, fakeFetch(() => ({ status: 500, body: { error: { message: LONG_TOKEN } } })).fetchFn).deps, warn: (m) => warnings.push(m) }, "threads", { code: "CODE123", state: STATE }),
  ];
  for (const outcome of outcomes) {
    const location = signupRedirect("https://frontporch.example/signup?old=1#x", "threads", outcome)!;
    for (const secret of [LONG_TOKEN, SHORT_TOKEN, "CODE123", STATE, "17841400000000001", "elder1", "app-secret-xyz"]) {
      assert.ok(!location.includes(secret), `${secret} leaked into ${location}`);
    }
    assert.deepEqual([...new URL(location).searchParams.keys()].sort(), outcome.ok ? ["connected"] : ["connect_error", "platform"]);
  }
  for (const w of warnings) for (const secret of [LONG_TOKEN, SHORT_TOKEN, "CODE123", "app-secret-xyz"]) assert.ok(!w.includes(secret));
});

test("signupRedirect: no usable site URL -> null", () => {
  assert.equal(signupRedirect(undefined, "threads", { ok: true }), null);
  assert.equal(signupRedirect("javascript:alert(1)", "threads", { ok: true }), null);
  assert.equal(signupRedirect("not a url", "threads", { ok: true }), null);
});
