import { test } from "node:test";
import assert from "node:assert/strict";
import {
  elderVerdict,
  matchElderAccount,
  matchIdToken,
  parseAccountsResponse,
} from "../convex/lib/linkedapiAccounts.ts";

// Shape from linkedapi.io/docs/admin-accounts (accounts.getAll).
const SAMPLE = {
  success: true,
  result: {
    accounts: [
      {
        id: "acc_1",
        name: "Walter Smith",
        url: "https://www.linkedin.com/in/walter-smith/",
        avatarUrl: null,
        headline: "Retired baker",
        countryCode: "US",
        identificationToken: "idtok_SECRET_1",
        status: "active",
        connectedAt: "2026-10-20T10:00:00Z",
      },
      {
        id: "acc_2",
        name: "Rosa Diaz",
        url: "https://mx.linkedin.com/in/RosaDiaz?trk=x",
        avatarUrl: null,
        headline: null,
        countryCode: "MX",
        identificationToken: "idtok_SECRET_2",
        status: "reconnection_required",
        connectedAt: "2026-10-01T10:00:00Z",
        reconnectionSessionId: "sess_9",
        reconnectionLink: "https://app.linkedapi.io/reconnect/sess_9",
      },
    ],
    pendingConnectionSessions: [{ sessionId: "sess_new", status: "pending" }],
  },
};

test("parse: accounts are sanitized and tokens never appear in the safe output", () => {
  const parsed = parseAccountsResponse(200, SAMPLE);
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  assert.equal(parsed.accounts.length, 2);
  assert.equal(parsed.pendingSessions, 1);
  assert.equal(parsed.accounts[0].profileUrl, "https://www.linkedin.com/in/walter-smith");
  assert.equal(parsed.accounts[1].reconnectionLink, "https://app.linkedapi.io/reconnect/sess_9");
  assert.equal(parsed.accounts[0].reconnectionLink, undefined);
  const safe = JSON.stringify(parsed.accounts);
  assert.ok(!safe.includes("SECRET"), "identification tokens must not be in the sanitized accounts");
  assert.ok(!safe.includes("identificationToken"));
});

test("parse: bad token and failures read clearly", () => {
  const r401 = parseAccountsResponse(401, null);
  assert.equal(r401.ok, false);
  if (!r401.ok) assert.match(r401.reason, /rejected LINKEDAPI_TOKEN/);
  const fail = parseAccountsResponse(200, { success: false, error: { type: "invalidToken", message: "nope" } });
  assert.equal(fail.ok, false);
  if (!fail.ok) {
    assert.match(fail.reason, /invalidToken/);
    assert.ok(!fail.reason.includes("nope"), "upstream messages aren't echoed");
  }
  const empty = parseAccountsResponse(200, { success: true, result: {} });
  assert.ok(empty.ok);
  if (empty.ok) assert.deepEqual([empty.accounts.length, empty.pendingSessions], [0, 0]);
});

test("matchIdToken: finds the account, never returns the token", () => {
  const parsed = parseAccountsResponse(200, SAMPLE);
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  assert.equal(matchIdToken(parsed.accounts, parsed.tokens, "idtok_SECRET_1")?.id, "acc_1");
  assert.equal(matchIdToken(parsed.accounts, parsed.tokens, "wrong"), undefined);
  assert.equal(matchIdToken(parsed.accounts, parsed.tokens, undefined), undefined);
  assert.ok(!JSON.stringify(matchIdToken(parsed.accounts, parsed.tokens, "idtok_SECRET_1")).includes("SECRET"));
});

test("matchElderAccount: profile URLs match regardless of host, case, slash and query", () => {
  const parsed = parseAccountsResponse(200, SAMPLE);
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  assert.equal(matchElderAccount(parsed.accounts, "linkedin.com/in/walter-smith")?.id, "acc_1");
  assert.equal(matchElderAccount(parsed.accounts, "https://www.linkedin.com/in/rosadiaz/")?.id, "acc_2");
  assert.equal(matchElderAccount(parsed.accounts, "https://www.linkedin.com/in/someone-else"), undefined);
  assert.equal(matchElderAccount(parsed.accounts, undefined), undefined);
  assert.equal(matchElderAccount(parsed.accounts, "https://example.com/in/walter-smith"), undefined);
});

test("elderVerdict covers every case", () => {
  const parsed = parseAccountsResponse(200, SAMPLE);
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  const [walter, rosa] = parsed.accounts;
  assert.equal(elderVerdict(undefined, undefined), "his row has no linkedinUrl");
  assert.equal(elderVerdict("https://www.linkedin.com/in/someone-else", undefined), "not connected to LinkedAPI yet");
  assert.equal(elderVerdict("linkedin.com/in/walter-smith", walter), "ready to post as Walter Smith");
  assert.equal(
    elderVerdict("linkedin.com/in/rosadiaz", rosa),
    "needs reconnection: open https://app.linkedapi.io/reconnect/sess_9",
  );
  assert.match(elderVerdict("linkedin.com/in/walter-smith", { ...walter, status: "frozen" }), /frozen/);
});
