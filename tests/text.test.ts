import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanText, hash16, parseTimestamp, pick, pickNumber, truncate } from "../convex/lib/text.ts";

test("cleanText strips tags and decodes entities", () => {
  assert.equal(cleanText("<p>Dad&#39;s <b>tools</b> &amp; &quot;rust&quot;&#x21;</p>"), `Dad's tools & "rust"!`);
  assert.equal(cleanText(undefined), "");
  assert.equal(cleanText(42), "");
});

test("truncate cuts on a word boundary", () => {
  assert.equal(truncate("short", 10), "short");
  const out = truncate("one two three four five six seven", 20);
  assert.ok(out.length <= 20);
  assert.ok(out.endsWith("…"));
  assert.ok(!out.includes("fiv"));
});

test("parseTimestamp handles seconds, ms, ISO and space-separated dates", () => {
  assert.equal(parseTimestamp(1792670400), 1792670400000);
  assert.equal(parseTimestamp(1792670400000), 1792670400000);
  assert.equal(parseTimestamp("1792670400"), 1792670400000);
  assert.equal(parseTimestamp("2026-10-22T15:00:00.000Z"), Date.parse("2026-10-22T15:00:00.000Z"));
  assert.equal(parseTimestamp("2025-05-15 14:30:20"), Date.parse("2025-05-15T14:30:20Z"));
  assert.equal(parseTimestamp("not a date"), undefined);
  assert.equal(parseTimestamp(null), undefined);
  assert.equal(parseTimestamp(true), undefined);
});

test("pick and pickNumber take the first usable value", () => {
  assert.equal(pick({ a: "", b: "  x  ", c: "y" }, ["a", "b", "c"]), "x");
  assert.equal(pick({ id: 7 }, ["id"]), "7");
  assert.equal(pickNumber({ a: "1,234", b: 5 }, ["a", "b"]), 1234);
  assert.equal(pickNumber({ a: "n/a" }, ["a"]), undefined);
});

test("hash16 is stable and 16 hex chars", () => {
  assert.equal(hash16("abc"), hash16("abc"));
  assert.notEqual(hash16("abc"), hash16("abd"));
  assert.match(hash16(""), /^[0-9a-f]{16}$/);
});
