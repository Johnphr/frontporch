// His X login (lib/xLogin.ts) with a fake ctx + fake X: refresh near expiry, rotation saved,
// two refreshes racing, a refused refresh, a missing key. No network, no database.
import { test } from "node:test";
import assert from "node:assert/strict";
import { getFunctionName } from "convex/server";

import { decryptSecret, encryptSecret, loadAccountKey, type SealedSecret } from "../convex/lib/accountCrypto.ts";
import { X_PLATFORM, xLoginForElder, type XAccountForLogin } from "../convex/lib/xLogin.ts";
import { XAuthError, makeXAdapter, tokensFromJson, tokensToJson, type FetchFn, type OAuthAdapter } from "../convex/lib/xOAuth.ts";
import { X_SAVE_STATUSES, canSaveRefreshed } from "../convex/lib/tokenSave.ts";
import { NOW } from "./helpers.ts";

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const env = { ACCOUNTS_ENC_KEY: KEY };
const ELDER = "elder1";

async function seal(t: { accessToken: string; refreshToken?: string }): Promise<SealedSecret> {
  return encryptSecret(await loadAccountKey(KEY), tokensToJson(t), ELDER, X_PLATFORM);
}

async function open(s: SealedSecret) {
  return tokensFromJson(await decryptSecret(await loadAccountKey(KEY), s, ELDER, X_PLATFORM));
}

/** A fake ctx over one elderAccounts row. `beforeSave` runs inside the save (to simulate a race). */
function fakeCtx(row: NonNullable<XAccountForLogin>, hooks: { beforeSave?: () => Promise<void>; saveThrows?: boolean } = {}) {
  const log: string[] = [];
  const ctx = {
    row,
    log,
    runQuery: async (ref: any) => {
      log.push(getFunctionName(ref));
      return ctx.row ? { ...ctx.row } : null;
    },
    runMutation: async (ref: any, args: any) => {
      const name = getFunctionName(ref);
      log.push(name);
      if (name === "xAuth:saveRefreshedTokens") {
        await hooks.beforeSave?.();
        if (hooks.saveThrows) throw new Error("database down");
        // The same rule as xAuth.saveRefreshedTokens.
        if (!canSaveRefreshed(ctx.row, args.expectedIv, X_SAVE_STATUSES)) return { saved: false };
        ctx.row = { ...ctx.row, status: "connected", secret: args.secret, tokenExpiresAt: args.tokenExpiresAt };
        return { saved: true };
      }
      if (name === "xAuth:markInvalid") {
        if (ctx.row.secret?.iv === args.expectedIv) ctx.row = { ...ctx.row, status: "invalid" };
        return null;
      }
      throw new Error(`unexpected ${name}`);
    },
  };
  return ctx;
}

async function connectedRow(expiresIn: number, t = { accessToken: "AT1", refreshToken: "RT1" }): Promise<NonNullable<XAccountForLogin>> {
  return { status: "connected", handle: "joe", externalUserId: "42", secret: await seal(t), tokenExpiresAt: NOW + expiresIn };
}

function adapterWith(responses: { status: number; body: unknown }[]): { adapter: OAuthAdapter; forms: URLSearchParams[] } {
  const forms: URLSearchParams[] = [];
  const fetchFn: FetchFn = async (_url, init) => {
    forms.push(new URLSearchParams(init?.body));
    const r = responses.shift() ?? { status: 500, body: {} };
    return { ok: r.status < 300, status: r.status, json: async () => r.body };
  };
  const adapter = makeXAdapter(() => ({ clientId: "c", clientSecret: "s" }), () => NOW);
  return { adapter: { ...adapter, refresh: (_f, t) => adapter.refresh(fetchFn, t) }, forms };
}

const opts = (adapter: OAuthAdapter, sleep: (ms: number) => Promise<void> = async () => {}) => ({
  env,
  now: () => NOW,
  adapter,
  sleep,
  fetchFn: (async () => { throw new Error("no network"); }) as FetchFn,
});

test("a fresh token is returned without a refresh", async () => {
  const ctx = fakeCtx(await connectedRow(60 * 60_000));
  const { adapter, forms } = adapterWith([]);
  assert.deepEqual(await xLoginForElder(ctx, ELDER, opts(adapter)), { accessToken: "AT1", userId: "42", username: "joe" });
  assert.equal(forms.length, 0);
});

test("expiring within 5 minutes: refresh, save the rotated refresh token", async () => {
  const ctx = fakeCtx(await connectedRow(4 * 60_000));
  const { adapter, forms } = adapterWith([{ status: 200, body: { access_token: "AT2", refresh_token: "RT2", expires_in: 7200 } }]);
  assert.deepEqual(await xLoginForElder(ctx, ELDER, opts(adapter)), { accessToken: "AT2", userId: "42", username: "joe" });
  assert.equal(forms[0].get("refresh_token"), "RT1");
  assert.deepEqual(await open(ctx.row.secret!), { accessToken: "AT2", refreshToken: "RT2" });
  assert.equal(ctx.row.tokenExpiresAt, NOW + 7_200_000);
});

test("lost the race: another run saved first, we use its tokens", async () => {
  const ctx = fakeCtx(await connectedRow(0));
  const winner = await seal({ accessToken: "AT-W", refreshToken: "RT-W" });
  ctx.row = { ...ctx.row };
  const { adapter } = adapterWith([{ status: 200, body: { access_token: "AT-L", refresh_token: "RT-L", expires_in: 7200 } }]);
  const racing = fakeCtx(ctx.row, {
    beforeSave: async () => {
      racing.row = { ...racing.row, secret: winner, tokenExpiresAt: NOW + 7_200_000 };
    },
  });
  assert.deepEqual(await xLoginForElder(racing, ELDER, opts(adapter)), { accessToken: "AT-W", userId: "42", username: "joe" });
  assert.deepEqual(await open(racing.row.secret!), { accessToken: "AT-W", refreshToken: "RT-W" });
});

test("refresh refused because another run already used the token: use what it saved", async () => {
  const ctx = fakeCtx(await connectedRow(0));
  const winner = await seal({ accessToken: "AT-W", refreshToken: "RT-W" });
  const base = makeXAdapter(() => ({ clientId: "c", clientSecret: "s" }), () => NOW);
  const adapter: OAuthAdapter = {
    ...base,
    refresh: async () => {
      ctx.row = { ...ctx.row, secret: winner, tokenExpiresAt: NOW + 7_200_000 };
      throw new XAuthError("refresh", 400, "invalid_grant");
    },
  };
  assert.deepEqual(await xLoginForElder(ctx, ELDER, opts(adapter)), { accessToken: "AT-W", userId: "42", username: "joe" });
  assert.equal(ctx.row.status, "connected");
});

test("refresh refused for real: account marked invalid, null", async () => {
  const ctx = fakeCtx(await connectedRow(0));
  const { adapter } = adapterWith([{ status: 400, body: { error: "invalid_grant" } }]);
  assert.equal(await xLoginForElder(ctx, ELDER, opts(adapter)), null);
  assert.equal(ctx.row.status, "invalid");
});

test("refresh hits a network error: the old token while it still works, else null", async () => {
  const { adapter } = adapterWith([{ status: 503, body: {} }, { status: 503, body: {} }]);
  const stillOk = fakeCtx(await connectedRow(2 * 60_000));
  assert.equal((await xLoginForElder(stillOk, ELDER, opts(adapter)))?.accessToken, "AT1");
  const expired = fakeCtx(await connectedRow(-1));
  assert.equal(await xLoginForElder(expired, ELDER, opts(adapter)), null);
  assert.equal(expired.row.status, "connected");
});

test("missing key, not connected, no row: null, never throws", async () => {
  const { adapter } = adapterWith([]);
  const ctx = fakeCtx(await connectedRow(60 * 60_000));
  assert.equal(await xLoginForElder(ctx, ELDER, { ...opts(adapter), env: {} }), null);
  assert.equal(await xLoginForElder(fakeCtx({ ...ctx.row, status: "invalid" }), ELDER, opts(adapter)), null);
  const none = { runQuery: async () => null, runMutation: async () => null };
  assert.equal(await xLoginForElder(none, ELDER, opts(adapter)), null);
  // Another elder's ciphertext doesn't open.
  assert.equal(await xLoginForElder(ctx, "elder2", opts(adapter)), null);
});

test("race: B's refresh is refused and B marks invalid, then A saves: A's rotated token is kept, connected again", async () => {
  const ctx = fakeCtx(await connectedRow(0));
  const { adapter: a } = adapterWith([{ status: 200, body: { access_token: "AT-A", refresh_token: "RT-A", expires_in: 7200 } }]);
  const { adapter: b } = adapterWith([{ status: 400, body: { error: "invalid_grant" } }]);
  let bResult: unknown = "not run";
  // A has refreshed; before its save lands, B (same old refresh token) runs start to finish.
  const racing = fakeCtx(ctx.row, {
    beforeSave: async () => {
      bResult = await xLoginForElder(racing, ELDER, opts(b));
    },
  });
  assert.deepEqual(await xLoginForElder(racing, ELDER, opts(a)), { accessToken: "AT-A", userId: "42", username: "joe" });
  assert.equal(bResult, null);
  assert.ok(racing.log.includes("xAuth:markInvalid"));
  assert.equal(racing.row.status, "connected");
  assert.deepEqual(await open(racing.row.secret!), { accessToken: "AT-A", refreshToken: "RT-A" });
});

test("race: B's refresh is refused while A is still saving: B waits once and uses A's token", async () => {
  const ctx = fakeCtx(await connectedRow(0));
  const winner = await seal({ accessToken: "AT-A", refreshToken: "RT-A" });
  const { adapter } = adapterWith([{ status: 400, body: { error: "invalid_grant" } }]);
  const waits: number[] = [];
  const sleep = async (ms: number) => {
    waits.push(ms);
    ctx.row = { ...ctx.row, secret: winner, tokenExpiresAt: NOW + 7_200_000 }; // A's save lands
  };
  assert.deepEqual(await xLoginForElder(ctx, ELDER, opts(adapter, sleep)), { accessToken: "AT-A", userId: "42", username: "joe" });
  assert.equal(waits.length, 1);
  assert.ok(!ctx.log.includes("xAuth:markInvalid"));
  assert.equal(ctx.row.status, "connected");
});

test("X refuses our app (401 unauthorized_client): null, his account isn't marked", async () => {
  const ctx = fakeCtx(await connectedRow(0));
  const { adapter } = adapterWith([{ status: 401, body: { error: "unauthorized_client" } }]);
  assert.equal(await xLoginForElder(ctx, ELDER, opts(adapter)), null);
  assert.equal(ctx.row.status, "connected");
  assert.ok(!ctx.log.includes("xAuth:markInvalid"));
});

test("saving fails after a good refresh: loud fixed-text error, this run still gets the new token", async (t) => {
  const errors: string[] = [];
  t.mock.method(console, "error", (m: string) => void errors.push(m));
  const ctx = fakeCtx(await connectedRow(0), { saveThrows: true });
  const { adapter } = adapterWith([{ status: 200, body: { access_token: "AT2", refresh_token: "RT2", expires_in: 7200 } }]);
  assert.equal((await xLoginForElder(ctx, ELDER, opts(adapter)))?.accessToken, "AT2");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /SAVING THE NEW TOKENS FAILED/);
  assert.ok(!errors[0].includes("AT2") && !errors[0].includes("RT2") && !errors[0].includes("database down"));
});
