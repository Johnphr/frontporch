import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildKnownBackground,
  mapApimaestroPosts,
  mapHarvestPosts,
  normalizeLinkedInUrl,
} from "../convex/lib/scrapeMapping.ts";
import { fixture } from "./helpers.ts";

test("normalizeLinkedInUrl drops query, hash and trailing slash", () => {
  assert.equal(
    normalizeLinkedInUrl("https://www.linkedin.com/posts/x_y-activity-1-AbCd/?utm_source=share#top"),
    "https://www.linkedin.com/posts/x_y-activity-1-AbCd",
  );
  assert.equal(
    normalizeLinkedInUrl("https://de.linkedin.com/posts/x-activity-1"),
    "https://www.linkedin.com/posts/x-activity-1",
  );
  assert.equal(normalizeLinkedInUrl("  "), "");
});

test("harvestapi posts map to url + reaction total + reader comments", () => {
  const posts = mapHarvestPosts(fixture<unknown[]>("linkedin_posts_harvest.json"));
  assert.equal(posts.length, 2, "post without a URL is skipped, comments/reactions aren't posts");

  const [bakery, mentors] = posts;
  assert.equal(
    bakery.linkedinUrl,
    "https://www.linkedin.com/posts/walter-baker_bakery-story-activity-7380000000000000001-AbCd",
  );
  assert.equal(bakery.reactions, 48, "sums the reaction breakdown");
  assert.deepEqual(bakery.comments, [{ author: "Maria Lopez", text: "How did you price your bread back then?" }]);
  assert.equal(bakery.postedAt, 1792500000000);

  assert.equal(mentors.reactions, 12, "falls back to likes when the breakdown is empty");
  assert.deepEqual(mentors.comments, [{ author: "Sam Chen", text: "This is so true & rare." }]);
});

test("harvestapi comments are capped per post", () => {
  const comments = Array.from({ length: 30 }, (_, i) => ({
    type: "comment",
    commentary: `comment ${i}`,
    actor: { name: `R${i}` },
  }));
  const [post] = mapHarvestPosts(
    [{ type: "post", id: "p", linkedinUrl: "https://www.linkedin.com/posts/p", engagement: { likes: 1 }, comments }],
    5,
  );
  assert.equal(post.comments.length, 5);
});

test("apimaestro backup maps counts and handles the data.posts wrapper", () => {
  const posts = mapApimaestroPosts(fixture<unknown[]>("linkedin_posts_apimaestro.json"));
  assert.equal(posts.length, 3);
  assert.equal(posts[0].reactions, 48);
  assert.equal(posts[1].reactions, 12, "sums per-type counts when total_reactions is missing");
  assert.equal(posts[2].reactions, 5);
  assert.ok(posts.every((p) => p.comments.length === 0), "backup has no comment text");
  assert.equal(posts[0].postedAt, 1792500000000);
});

test("buildKnownBackground makes a compact plain-text profile", () => {
  const [profile] = fixture<unknown[]>("linkedin_profile_harvest.json");
  const text = buildKnownBackground(profile);
  assert.match(text, /^Walter Baker — Retired master baker/);
  assert.match(text, /Location: Dayton, Ohio/);
  assert.match(text, /- Owner & Head Baker at Baker's Bread Co\. \(Mar 1968 – Jun 2006, 38 yrs\)/);
  assert.match(text, /- Apprentice Baker at Kessler's Bakery \(1960 – 1968\)/);
  assert.match(text, /- Volunteer Mentor at SCORE \(2008 – Present\)/);
  assert.match(text, /- Certificate, Culinary Arts — Dayton Vocational School \(1958 - 1960\)/);
  assert.match(text, /Skills: Artisan Bread, Small Business Management, Mentoring/);
  assert.match(text, /mentor young bakers & small business owners/);
  assert.ok(text.length <= 2000);
});

test("buildKnownBackground tolerates junk", () => {
  assert.equal(buildKnownBackground(null), "");
  assert.equal(buildKnownBackground({ experience: "nope" }), "");
});
