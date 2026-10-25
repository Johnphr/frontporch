// Run: npm test
// Per-elder accounts: encryption, handle / app-password checks, login lookup, connect rules.
// Fakes only: no network, no database, no real accounts.
import { test } from "node:test";
import assert from "node:assert/strict";

import { AccountKeyError, decryptSecret, encryptSecret, loadAccountKey } from "../convex/lib/accountCrypto.ts";
import { connectBlueskyAccount, loginErrorCode, sessionScope, shortAccountError, type ConnectDeps } from "../convex/lib/accountConnect.ts";
import { BlueskyHttpError, type FetchFn } from "../convex/lib/blueskyClient.ts";
import { blueskyLoginForElder, isBlueskyLoginRefused, redditLoginForElder, reportBlueskyLoginError } from "../convex/lib/logins.ts";
import {
  CONNECT_ATTEMPTS_PER_HOUR,
  CONNECT_COOLDOWN_MS,
  connectRateLimit,
  isBlueskyHandle,
  normalizeAppPassword,
  normalizeBlueskyHandle,
  recordAttempt,
} from "../convex/lib/signupRules.ts";
import { NOW } from "./helpers.ts";

// Test keys only (32 bytes each, base64).
const KEY = Buffer.alloc(32, 7).toString("base64");
const OTHER_KEY = Buffer.alloc(32, 9).toString("base64");
const APP_PASSWORD = "abcd-efgh-ijkl-mnop";

// ---------- crypto ----------

test("crypto: round trip, and a fresh IV each time", async () => {
  const key = await loadAccountKey(KEY);
  const a = await encryptSecret(key, APP_PASSWORD, "e1", "bluesky");
  const b = await encryptSecret(key, APP_PASSWORD, "e1", "bluesky");
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.ciphertext, b.ciphertext);
  assert.ok(!a.ciphertext.includes(APP_PASSWORD) && !Buffer.from(a.ciphertext, "base64").toString().includes(APP_PASSWORD));
  assert.equal(await decryptSecret(key, a, "e1", "bluesky"), APP_PASSWORD);
});

test("crypto: a wrong key fails", async () => {
  const sealed = await encryptSecret(await loadAccountKey(KEY), APP_PASSWORD, "e1", "bluesky");
  await assert.rejects(decryptSecret(await loadAccountKey(OTHER_KEY), sealed, "e1", "bluesky"), /could not be decrypted/);
});

test("crypto: a ciphertext moved to another elder or platform fails", async () => {
  const key = await loadAccountKey(KEY);
  const sealed = await encryptSecret(key, APP_PASSWORD, "e1", "bluesky");
  await assert.rejects(decryptSecret(key, sealed, "e2", "bluesky"), /could not be decrypted/);
  await assert.rejects(decryptSecret(key, sealed, "e1", "reddit"), /could not be decrypted/);
});

test("crypto: an edited ciphertext or bad base64 fails", async () => {
  const key = await loadAccountKey(KEY);
  const sealed = await encryptSecret(key, APP_PASSWORD, "e1", "bluesky");
  const bytes = Buffer.from(sealed.ciphertext, "base64");
  bytes[0] ^= 1;
  await assert.rejects(decryptSecret(key, { ...sealed, ciphertext: bytes.toString("base64") }, "e1", "bluesky"));
  await assert.rejects(decryptSecret(key, { ...sealed, iv: "!!" }, "e1", "bluesky"), /malformed/);
});

test("crypto: missing or bad key is a clear error (no plaintext fallback)", async () => {
  await assert.rejects(loadAccountKey(undefined), (e) => e instanceof AccountKeyError && /not set/.test(e.message));
  await assert.rejects(loadAccountKey("  "), AccountKeyError);
  await assert.rejects(loadAccountKey(Buffer.alloc(16, 1).toString("base64")), /exactly 32 bytes/);
  await assert.rejects(loadAccountKey("not base64 at all!"), /exactly 32 bytes/);
  const err = await loadAccountKey(Buffer.alloc(31, 1).toString("base64")).catch((e: Error) => e);
  assert.ok(!(err as Error).message.includes(Buffer.alloc(31, 1).toString("base64")), "the key is never echoed");
});

// ---------- handle + app password ----------

test("handle: tidied, bsky.social added when there's no dot", () => {
  assert.equal(normalizeBlueskyHandle("@Walter"), "walter.bsky.social");
  assert.equal(normalizeBlueskyHandle("  walter.bsky.social "), "walter.bsky.social");
  assert.equal(normalizeBlueskyHandle("@Walter.Smith.COM"), "walter.smith.com");
  assert.equal(normalizeBlueskyHandle("https://bsky.app/profile/walter.bsky.social"), "walter.bsky.social");
  assert.equal(normalizeBlueskyHandle("bsky.app/profile/walter.bsky.social/post/abc"), "walter.bsky.social");
  assert.equal(normalizeBlueskyHandle("walter-s"), "walter-s.bsky.social");
});

test("handle: bad ones are refused", () => {
  for (const bad of ["", "@", "walter smith", "-walter", "walter-.bsky.social", "walter..social", "walter.123", "wal_ter", "a".repeat(64), "x".repeat(301)]) {
    assert.equal(normalizeBlueskyHandle(bad), undefined, bad);
  }
  assert.equal(isBlueskyHandle("walter"), false, "needs a dot");
  assert.equal(isBlueskyHandle("walter.bsky.social"), true);
});

test("app password: only the xxxx-xxxx-xxxx-xxxx shape", () => {
  assert.equal(normalizeAppPassword(" ABCD-efgh-1234-mnop "), "abcd-efgh-1234-mnop");
  assert.equal(normalizeAppPassword("abcd-efgh-ijkl-mnop"), APP_PASSWORD);
  for (const bad of ["", "hunter2", "MyRealPassword!2024", "abcd-efgh-ijkl", "abcdefghijklmnop", "abcd-efgh-ijkl-mno!", "abcd_efgh_ijkl_mnop"]) {
    assert.equal(normalizeAppPassword(bad), undefined, bad);
  }
});

test("connect rate limit: 5 s cooldown, at most 5 an hour", () => {
  assert.deepEqual(connectRateLimit([], NOW), { ok: true });
  assert.equal(connectRateLimit([NOW - 1000], NOW).ok, false);
  assert.equal(connectRateLimit([NOW - CONNECT_COOLDOWN_MS], NOW).ok, true);
  const four = [1, 2, 3, 4].map((m) => NOW - m * 60_000);
  assert.equal(connectRateLimit(four, NOW).ok, true);
  assert.equal(connectRateLimit([...four, NOW - 59 * 60_000], NOW).ok, false);
  assert.equal(connectRateLimit([...four, NOW - 60 * 60_000], NOW).ok, true, "an hour ago has dropped off");
  let times: number[] = [];
  for (let i = 0; i < 10; i++) times = recordAttempt(times, NOW - (10 - i) * 60_000);
  assert.equal(times.length, CONNECT_ATTEMPTS_PER_HOUR, "only what the limit needs is kept");
  assert.deepEqual(recordAttempt([NOW - 2 * 60 * 60_000], NOW), [NOW]);
});

// ---------- logins lookup ----------

type Row = {
  status: string;
  handle: string | null;
  did: string | null;
  secret: { ciphertext: string; iv: string } | null;
  connectedAt?: number | null;
} | null;

function fakeCtx(rows: Record<string, Row>) {
  const queries: Array<{ args: { elderId: string; platform: string } }> = [];
  return {
    queries,
    ctx: {
      runQuery: async (_ref: unknown, args: { elderId: string; platform: string }) => {
        queries.push({ args });
        return rows[`${args.elderId}/${args.platform}`] ?? null;
      },
    },
  };
}

async function connectedRow(elderId: string, password = APP_PASSWORD, key = KEY): Promise<Row> {
  const secret = await encryptSecret(await loadAccountKey(key), password, elderId, "bluesky");
  return { status: "connected", handle: "walter.bsky.social", did: "did:plc:walter", secret, connectedAt: NOW };
}

/** Run `fn` with console.warn captured. */
async function withWarnings<T>(fn: () => Promise<T>): Promise<{ result: T; warnings: string[] }> {
  const warn = console.warn;
  const warnings: string[] = [];
  console.warn = (m: string) => warnings.push(m);
  try {
    return { result: await fn(), warnings };
  } finally {
    console.warn = warn;
  }
}

const DEMO = { BLUESKY_HANDLE: "demo.bsky.social", BLUESKY_APP_PASSWORD: "demo-pass" };

test("logins: his connected account -> his login, decrypted in the action", async () => {
  const { ctx, queries } = fakeCtx({ "e1/bluesky": await connectedRow("e1") });
  const login = await blueskyLoginForElder(ctx, "e1", { ACCOUNTS_ENC_KEY: KEY, ...DEMO, DEMO_ACCOUNT_FALLBACK: "on" });
  assert.deepEqual(login, { service: "https://bsky.social", identifier: "walter.bsky.social", password: APP_PASSWORD });
  assert.deepEqual(queries[0].args, { elderId: "e1", platform: "bluesky" });
});

test("logins: no account -> null; the demo account only with DEMO_ACCOUNT_FALLBACK=on", async () => {
  const { ctx } = fakeCtx({});
  assert.equal(await blueskyLoginForElder(ctx, "e1", { ACCOUNTS_ENC_KEY: KEY, ...DEMO }), null);
  assert.equal(await blueskyLoginForElder(ctx, "e1", { ACCOUNTS_ENC_KEY: KEY, ...DEMO, DEMO_ACCOUNT_FALLBACK: "off" }), null);
  const demo = await blueskyLoginForElder(ctx, "e1", { ...DEMO, DEMO_ACCOUNT_FALLBACK: "on" });
  assert.equal(demo?.identifier, "demo.bsky.social");
  assert.equal(await blueskyLoginForElder(null, "e1", DEMO), null, "an elder without a ctx needs the flag too");
  assert.equal((await blueskyLoginForElder(null, null, DEMO))?.identifier, "demo.bsky.social", "pure tests: no ctx, no elder");
});

test("logins: invalid or disconnected accounts aren't used, and never fall back to the demo one", async () => {
  const row = await connectedRow("e1");
  const flagOn = { ACCOUNTS_ENC_KEY: KEY, ...DEMO, DEMO_ACCOUNT_FALLBACK: "on" };
  for (const status of ["invalid", "disconnected"]) {
    const { ctx } = fakeCtx({ "e1/bluesky": { ...row!, status } });
    assert.equal(await blueskyLoginForElder(ctx, "e1", { ACCOUNTS_ENC_KEY: KEY }), null, status);
    assert.equal(await blueskyLoginForElder(ctx, "e1", flagOn), null, `${status}, flag on`);
  }
  const { ctx } = fakeCtx({ "e1/bluesky": { ...row!, secret: null } });
  assert.equal(await blueskyLoginForElder(ctx, "e1", flagOn), null);
});

test("logins: a row with only failed connect attempts (never connected) may use the demo account", async () => {
  const { ctx } = fakeCtx({ "e1/bluesky": { status: "disconnected", handle: null, did: null, secret: null, connectedAt: null } });
  assert.equal((await blueskyLoginForElder(ctx, "e1", { ...DEMO, DEMO_ACCOUNT_FALLBACK: "on" }))?.identifier, "demo.bsky.social");
  assert.equal(await blueskyLoginForElder(ctx, "e1", DEMO), null, "flag off");
});

test("logins: a secret that won't decrypt -> null, never the demo account", async () => {
  const { ctx } = fakeCtx({ "e1/bluesky": await connectedRow("e2") }); // moved from e2
  const { result, warnings } = await withWarnings(() =>
    blueskyLoginForElder(ctx, "e1", { ACCOUNTS_ENC_KEY: KEY, ...DEMO, DEMO_ACCOUNT_FALLBACK: "on" }),
  );
  assert.equal(result, null);
  assert.ok(warnings.length === 1 && !warnings[0].includes(APP_PASSWORD));
});

test("logins: missing or bad ACCOUNTS_ENC_KEY -> a fixed warning and null, not a throw, not the demo account", async () => {
  const { ctx } = fakeCtx({ "e1/bluesky": await connectedRow("e1") });
  for (const key of [undefined, "short", OTHER_KEY]) {
    const { result, warnings } = await withWarnings(() =>
      blueskyLoginForElder(ctx, "e1", { ...DEMO, DEMO_ACCOUNT_FALLBACK: "on", ...(key ? { ACCOUNTS_ENC_KEY: key } : {}) }),
    );
    assert.equal(result, null, String(key));
    assert.equal(warnings.length, 1);
    assert.ok(!warnings[0].includes(APP_PASSWORD) && !warnings[0].includes(OTHER_KEY));
  }
});

test("logins: a failed account lookup -> null, not a throw, not the demo account", async () => {
  const ctx = { runQuery: async () => Promise.reject(new Error("database said no")) };
  const { result, warnings } = await withWarnings(() => blueskyLoginForElder(ctx, "e1", { ...DEMO, DEMO_ACCOUNT_FALLBACK: "on" }));
  assert.equal(result, null);
  assert.equal(warnings.length, 1);
  assert.ok(!warnings[0].includes("database said no"));
});

test("logins: Reddit is per-elder coming soon: off unless REDDIT_POSTING, demo only with the flag", async () => {
  const reddit = { REDDIT_CLIENT_ID: "a", REDDIT_CLIENT_SECRET: "b", REDDIT_USERNAME: "w", REDDIT_PASSWORD: "c" };
  const { ctx } = fakeCtx({});
  assert.equal(await redditLoginForElder(ctx, "e1", { ...reddit, DEMO_ACCOUNT_FALLBACK: "on" }), null, "REDDIT_POSTING off");
  assert.equal(await redditLoginForElder(ctx, "e1", { ...reddit, REDDIT_POSTING: "on" }), null, "no per-elder Reddit yet");
  assert.equal((await redditLoginForElder(ctx, "e1", { ...reddit, REDDIT_POSTING: "on", DEMO_ACCOUNT_FALLBACK: "on" }))?.username, "w");
});

test("logins: a refused Bluesky login marks his account invalid; other errors don't", async () => {
  const calls: unknown[] = [];
  const ctx = { runMutation: async (_ref: unknown, args: unknown) => void calls.push(args) };
  const refused = new BlueskyHttpError("login", 401, "AuthenticationRequired");
  assert.equal(isBlueskyLoginRefused(refused), true);
  assert.equal(isBlueskyLoginRefused(new BlueskyHttpError("post", 401)), false, "a 401 on a post is a stale token");
  assert.equal(isBlueskyLoginRefused(new BlueskyHttpError("login", 429)), false);
  assert.equal(await reportBlueskyLoginError(ctx, "e1", new BlueskyHttpError("login", 500)), false);
  assert.equal(await reportBlueskyLoginError(ctx, null, refused), false);
  assert.equal(await reportBlueskyLoginError(ctx, "e1", refused), true);
  assert.deepEqual(calls, [{ elderId: "e1", platform: "bluesky", error: "Bluesky login HTTP 401 (AuthenticationRequired)" }]);
  const failing = { runMutation: async () => Promise.reject(new Error("boom")) };
  const { result } = await withWarnings(() => reportBlueskyLoginError(failing, "e1", refused));
  assert.equal(result, false, "a failed mark never throws");
});

// ---------- connectBluesky ----------

function jwt(payload: object): string {
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${part({ alg: "ES256K" })}.${part(payload)}.sig`;
}

function sessionFetch(respond: () => { status: number; json?: unknown } | "throw") {
  const bodies: string[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    assert.ok(url.endsWith("/xrpc/com.atproto.server.createSession"), url);
    bodies.push(init?.body ?? "");
    const out = respond();
    if (out === "throw") throw new Error("The operation was aborted");
    return { ok: out.status >= 200 && out.status < 300, status: out.status, json: async () => out.json ?? {} };
  };
  return { fetchFn, bodies };
}

const APP_SESSION = () => ({
  status: 200,
  json: { accessJwt: jwt({ scope: "com.atproto.appPass" }), refreshJwt: "r", did: "did:plc:walter", handle: "Walter.bsky.social" },
});

function deps(over: Partial<ConnectDeps> = {}) {
  const saved: Array<{ handle: string; did: string; secret: { ciphertext: string; iv: string } }> = [];
  const warnings: string[] = [];
  let reserves = 0;
  const d: ConnectDeps = {
    fetchFn: sessionFetch(APP_SESSION).fetchFn,
    env: { ACCOUNTS_ENC_KEY: KEY },
    reserve: async () => {
      reserves++;
      return { ok: true };
    },
    save: async (account) => {
      saved.push(account);
      return { ok: true };
    },
    warn: (m) => warnings.push(m),
    ...over,
  };
  return { d, saved, warnings, reserves: () => reserves };
}

test("connect: verifies with Bluesky, saves encrypted with did + handle, returns only ok + handle", async () => {
  const f = sessionFetch(APP_SESSION);
  const { d, saved } = deps({ fetchFn: f.fetchFn });
  const out = await connectBlueskyAccount(d, "e1", { handle: "@Walter", appPassword: "ABCD-EFGH-IJKL-MNOP" });
  assert.deepEqual(out, { ok: true, handle: "walter.bsky.social" });
  assert.deepEqual(JSON.parse(f.bodies[0]), { identifier: "walter.bsky.social", password: APP_PASSWORD });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].did, "did:plc:walter");
  assert.ok(!JSON.stringify(saved).includes(APP_PASSWORD), "never stored in the clear");
  assert.equal(await decryptSecret(await loadAccountKey(KEY), saved[0].secret, "e1", "bluesky"), APP_PASSWORD);
});

test("connect: bad handle or a real password are refused before anything else", async () => {
  const { d, reserves, saved } = deps({ fetchFn: async () => assert.fail("no request") });
  assert.deepEqual(await connectBlueskyAccount(d, "e1", { handle: "walter smith", appPassword: APP_PASSWORD }), { ok: false, error: "invalid_handle" });
  assert.deepEqual(await connectBlueskyAccount(d, "e1", { handle: "walter", appPassword: "MyRealPassword!" }), { ok: false, error: "not_app_password" });
  assert.equal(reserves(), 0);
  assert.equal(saved.length, 0);
});

test("connect: rate limited, locked when active, unknown sign-up", async () => {
  for (const error of ["rate_limited", "locked", "not_found"] as const) {
    const { d, saved } = deps({ reserve: async () => ({ ok: false, error }), fetchFn: async () => assert.fail("no request") });
    assert.deepEqual(await connectBlueskyAccount(d, "e1", { handle: "walter", appPassword: APP_PASSWORD }), { ok: false, error });
    assert.equal(saved.length, 0);
  }
  const { d } = deps({ save: async () => ({ ok: false, error: "locked" }) });
  assert.deepEqual(await connectBlueskyAccount(d, "e1", { handle: "walter", appPassword: APP_PASSWORD }), { ok: false, error: "locked" }, "went active meanwhile");
});

test("connect: wrong password -> a friendly code, nothing saved, password never in the result", async () => {
  const f = sessionFetch(() => ({ status: 401, json: { error: "AuthenticationRequired", message: "Invalid identifier or password" } }));
  const { d, saved, warnings } = deps({ fetchFn: f.fetchFn });
  const out = await connectBlueskyAccount(d, "e1", { handle: "walter", appPassword: APP_PASSWORD });
  assert.deepEqual(out, { ok: false, error: "wrong_password" });
  assert.equal(saved.length, 0);
  assert.ok(![JSON.stringify(out), ...warnings].some((s) => s.includes(APP_PASSWORD)));
});

test("connect: main password session (scope com.atproto.access) is refused", async () => {
  const f = sessionFetch(() => ({ status: 200, json: { accessJwt: jwt({ scope: "com.atproto.access" }), did: "did:plc:w", handle: "walter.bsky.social" } }));
  const { d, saved } = deps({ fetchFn: f.fetchFn });
  assert.deepEqual(await connectBlueskyAccount(d, "e1", { handle: "walter", appPassword: APP_PASSWORD }), { ok: false, error: "not_app_password" });
  assert.equal(saved.length, 0);
});

test("connect: Bluesky down or slow -> bluesky_busy; missing key -> failed before any request", async () => {
  for (const respond of [() => "throw" as const, () => ({ status: 503 }), () => ({ status: 429 })]) {
    const { d } = deps({ fetchFn: sessionFetch(respond).fetchFn });
    assert.deepEqual(await connectBlueskyAccount(d, "e1", { handle: "walter", appPassword: APP_PASSWORD }), { ok: false, error: "bluesky_busy" });
  }
  const { d, warnings, reserves } = deps({ env: {}, fetchFn: async () => assert.fail("no request") });
  assert.deepEqual(await connectBlueskyAccount(d, "e1", { handle: "walter", appPassword: APP_PASSWORD }), { ok: false, error: "failed" });
  assert.equal(reserves(), 0, "a config problem doesn't use up his tries");
  assert.match(warnings[0], /ACCOUNTS_ENC_KEY/);
});

test("connect helpers: error codes, token scope, short errors", () => {
  assert.equal(loginErrorCode(new BlueskyHttpError("login", 400, "AuthFactorTokenRequired")), "not_app_password");
  assert.equal(loginErrorCode(new BlueskyHttpError("login", 400, "AccountTakedown")), "account_unavailable");
  assert.equal(loginErrorCode(new BlueskyHttpError("login", 400, "InvalidRequest")), "wrong_password");
  assert.equal(loginErrorCode(new BlueskyHttpError("login", 418)), "failed");
  assert.equal(sessionScope(jwt({ scope: "com.atproto.appPassPrivileged" })), "com.atproto.appPassPrivileged");
  assert.equal(sessionScope("not-a-jwt"), undefined);
  assert.equal(shortAccountError(`login failed for abcd-efgh-ijkl-mnop with Bearer xyz ${jwt({})}`), "login failed for [redacted] with Bearer [redacted] [redacted]");
  assert.equal(shortAccountError("x".repeat(500)).length, 120);
});
