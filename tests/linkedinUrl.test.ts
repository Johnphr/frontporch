import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalLinkedInPostUrl, linkedinActivityId } from "../convex/lib/linkedinUrl.ts";

const CANON = "https://www.linkedin.com/feed/update/urn:li:activity:7380000000000000001";

test("scraper-style and LinkedAPI-style URLs for the same post match", () => {
  const scraped = "https://www.linkedin.com/posts/walter-baker_bakery-story-activity-7380000000000000001-AbCd";
  const published = "https://www.linkedin.com/feed/update/urn:li:activity:7380000000000000001/";
  assert.equal(canonicalLinkedInPostUrl(scraped), CANON);
  assert.equal(canonicalLinkedInPostUrl(published), CANON);
  assert.equal(linkedinActivityId(scraped), "7380000000000000001");
});

test("query strings, hashes, country hosts and URL-encoded URNs", () => {
  assert.equal(
    canonicalLinkedInPostUrl(
      "https://de.linkedin.com/posts/x_y-activity-7380000000000000001-AbCd/?utm_source=share&utm_medium=member_desktop#top",
    ),
    CANON,
  );
  assert.equal(
    canonicalLinkedInPostUrl("https://www.linkedin.com/feed/update/urn%3Ali%3Aactivity%3A7380000000000000001"),
    CANON,
  );
  assert.equal(canonicalLinkedInPostUrl("urn:li:activity:7380000000000000001"), CANON);
});

test("non-post URLs are only tidied, never invented", () => {
  assert.equal(linkedinActivityId("https://www.linkedin.com/in/walter-baker/"), undefined);
  assert.equal(
    canonicalLinkedInPostUrl("https://linkedin.com/in/walter-baker/?trk=x"),
    "https://www.linkedin.com/in/walter-baker",
  );
  assert.equal(canonicalLinkedInPostUrl("not a url/?x=1"), "not a url");
  assert.equal(canonicalLinkedInPostUrl("   "), "");
  assert.equal(canonicalLinkedInPostUrl(undefined), "");
  assert.equal(linkedinActivityId(null), undefined);
});

test("short numbers after 'activity' aren't treated as ids", () => {
  assert.equal(linkedinActivityId("https://www.linkedin.com/posts/x-activity-1-AbCd"), undefined);
});
