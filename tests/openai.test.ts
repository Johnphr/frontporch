// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_MODEL, collectSourceUrls, createResponse, readOutputText } from "../convex/lib/openai.ts";

const message = (content: unknown[]) => ({ type: "message", role: "assistant", content });

test("readOutputText joins the output_text of a completed response", () => {
  const response = {
    status: "completed",
    output: [
      { type: "reasoning", summary: [] },
      message([
        { type: "output_text", text: '{"pass":', annotations: [] },
        { type: "output_text", text: "true}", annotations: [] },
      ]),
    ],
  };
  assert.equal(readOutputText(response), '{"pass":true}');
});

test("readOutputText: refusal, cut off, failed and empty answers throw fixed messages", () => {
  const secret = "Walter's words";
  assert.throws(
    () => readOutputText({ status: "completed", output: [message([{ type: "refusal", refusal: secret }])] }),
    (err: Error) => err.message === "OpenAI declined this request",
  );
  assert.throws(
    () => readOutputText({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] }),
    /OpenAI stopped early \(max_output_tokens\)/,
  );
  assert.throws(() => readOutputText({ status: "failed", output: [] }), /OpenAI response failed/);
  assert.throws(() => readOutputText({ status: "completed", output: [message([])] }), /OpenAI returned no text/);
  assert.throws(() => readOutputText(null), /no response/);
});

test("collectSourceUrls takes citations and search sources, deduped", () => {
  const response = {
    status: "completed",
    output: [
      { type: "web_search_call", action: { type: "search", sources: [{ url: "https://a.example/1" }, { url: "https://b.example/2" }] } },
      message([
        {
          type: "output_text",
          text: "notes",
          annotations: [
            { type: "url_citation", url: "https://a.example/1", title: "A" },
            { type: "url_citation", url: "https://c.example/3", title: "C" },
            { type: "file_citation", file_id: "f" },
          ],
        },
      ]),
    ],
  };
  assert.deepEqual(collectSourceUrls(response), ["https://a.example/1", "https://b.example/2", "https://c.example/3"]);
  assert.deepEqual(collectSourceUrls({ output: "junk" }), []);
});

test("default model is gpt-6-luna", () => {
  assert.equal(DEFAULT_MODEL, "gpt-6-luna");
});

// createResponse with a fake fetch: which failures retry, and what the error says.
function fakeFetch(responses: (Response | Error)[]) {
  const calls: string[] = [];
  const impl = async (url: string) => {
    calls.push(url);
    const next = responses.shift();
    if (!next || next instanceof Error) throw next ?? new Error("no more responses");
    return next;
  };
  return { calls, impl };
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

test("createResponse retries 429 (honouring Retry-After), 5xx and network errors", async () => {
  process.env.OPENAI_API_KEY = "test-key";
  const waits: number[] = [];
  const sleep = async (ms: number) => void waits.push(ms);
  const ok = { status: "completed", output: [] };

  const f1 = fakeFetch([json(429, {}, { "retry-after": "3" }), json(200, ok)]);
  assert.deepEqual(await createResponse({}, { timeoutMs: 1000, retries: 1, fetchImpl: f1.impl, sleep }), ok);
  assert.equal(f1.calls.length, 2);
  assert.deepEqual(waits, [3000]);

  const f2 = fakeFetch([new Error("network down"), json(200, ok)]);
  assert.deepEqual(await createResponse({}, { timeoutMs: 1000, retries: 1, fetchImpl: f2.impl, sleep }), ok);

  const f3 = fakeFetch([json(503, {}), json(503, {})]);
  await assert.rejects(createResponse({}, { timeoutMs: 1000, retries: 1, fetchImpl: f3.impl, sleep }), /OpenAI HTTP 503$/);
  assert.equal(f3.calls.length, 2);
});

test("createResponse: a 4xx is not retried and reports only OpenAI's code/param", async () => {
  process.env.OPENAI_API_KEY = "test-key";
  const sleep = async () => {};
  const body = { error: { code: "invalid_json_schema", param: "text.format.schema", message: "Walter said 'secret' ..." } };
  const f = fakeFetch([json(400, body)]);
  await assert.rejects(
    createResponse({}, { timeoutMs: 1000, retries: 1, fetchImpl: f.impl, sleep }),
    (err: Error) => err.message === "OpenAI HTTP 400 (invalid_json_schema, param text.format.schema)",
  );
  assert.equal(f.calls.length, 1);

  const once = fakeFetch([json(500, {})]);
  await assert.rejects(createResponse({}, { timeoutMs: 1000, retries: 0, fetchImpl: once.impl, sleep }), /HTTP 500/);
  assert.equal(once.calls.length, 1);
});
