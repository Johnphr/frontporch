import assert from "node:assert/strict";
import { test } from "node:test";
import { ApifyError, actorPath, runActor } from "../convex/lib/apifyClient.ts";

type Call = { url: string; init: RequestInit };

function fakeFetch(status: number, body: unknown, calls: Call[] = []): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return new Response(text, { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

test("actorPath swaps the slash for a tilde", () => {
  assert.equal(actorPath("harvestapi/linkedin-profile-posts"), "harvestapi~linkedin-profile-posts");
});

test("runActor posts the input and returns dataset items", async () => {
  const calls: Call[] = [];
  const items = await runActor(
    "trudax/reddit-scraper-lite",
    { searches: ["baking"] },
    { token: "tok", timeoutSecs: 999, maxItems: 30, fetchImpl: fakeFetch(201, [{ title: "a" }], calls) },
  );
  assert.deepEqual(items, [{ title: "a" }]);
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, "/v2/acts/trudax~reddit-scraper-lite/run-sync-get-dataset-items");
  assert.equal(url.searchParams.get("timeout"), "300", "capped at the sync endpoint's limit");
  assert.equal(url.searchParams.get("maxItems"), "30");
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, "Bearer tok");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { searches: ["baking"] });
});

test("runActor explains a missing token", async () => {
  const saved = process.env.APIFY_TOKEN;
  delete process.env.APIFY_TOKEN;
  try {
    await assert.rejects(runActor("a/b", {}, { fetchImpl: fakeFetch(201, []) }), /APIFY_TOKEN is not set/);
  } finally {
    if (saved !== undefined) process.env.APIFY_TOKEN = saved;
  }
});

test("runActor surfaces Apify's error message and status", async () => {
  await assert.rejects(
    runActor("a/b", {}, { token: "t", fetchImpl: fakeFetch(402, { error: { message: "Not enough credit" } }) }),
    (error: unknown) =>
      error instanceof ApifyError && error.status === 402 && /HTTP 402: Not enough credit/.test(error.message),
  );
  await assert.rejects(
    runActor("a/b", {}, { token: "t", fetchImpl: fakeFetch(408, "timeout") }),
    /took longer than the timeout/,
  );
  await assert.rejects(
    runActor("a/b", {}, { token: "t", fetchImpl: fakeFetch(201, { not: "a list" }) }),
    /something other than a list/,
  );
});
