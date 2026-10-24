// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_MODEL, collectSourceUrls, openaiModel, readOutputText } from "../convex/lib/openai.ts";

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

test("openaiModel defaults to gpt-6-luna", () => {
  assert.equal(DEFAULT_MODEL, "gpt-6-luna");
  assert.equal(openaiModel(), process.env.OPENAI_MODEL?.trim() || "gpt-6-luna");
});
