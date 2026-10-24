import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type AudienceQuestion,
  type SourceConfig,
  SOURCES,
  buildApifyInput,
  dedupe,
  deriveKeywords,
  discourseItemsFromSearch,
  enabledSources,
  fingerprint,
  GENERAL_KEYWORDS,
  looksLikeQuestion,
  priority,
  processItems,
  relevance,
  stackExchangeSearchUrl,
  stackExchangeSitesFor,
  subredditsFor,
} from "../convex/lib/questionSources.ts";
import { NOW, fixture } from "./helpers.ts";

const source = (name: string): SourceConfig => {
  const found = SOURCES.find((s) => s.name === name);
  assert.ok(found, `source ${name} exists`);
  return found;
};

test("source list: names unique, Quora + Discourse start disabled", () => {
  const names = SOURCES.map((s) => s.name);
  assert.equal(new Set(names).size, names.length);
  assert.equal(source("quora-search").enabled, false);
  assert.equal(source("discourse-search").enabled, false);
  assert.deepEqual(
    enabledSources().map((s) => s.name),
    ["reddit-search", "reddit-communities", "stackexchange-search"],
  );
  assert.deepEqual(enabledSources(["quora-search"]).map((s) => s.name), ["quora-search"], "explicit names win");
});

test("deriveKeywords reads profile and expertise, falls back to general", () => {
  assert.deepEqual(
    deriveKeywords({ profile: { industry: "Food & Beverage", specialty: "Artisan baking" }, expertise: ["Small business", "artisan baking"] }),
    ["artisan baking", "food & beverage", "small business"],
  );
  assert.deepEqual(deriveKeywords({ expertise: [] }), GENERAL_KEYWORDS);
  assert.deepEqual(deriveKeywords(null), GENERAL_KEYWORDS);
});

test("keyword maps pick industry subreddits and Stack Exchange sites", () => {
  const subs = subredditsFor(["artisan baking", "small business"]);
  assert.ok(subs.includes("Baking"));
  assert.ok(subs.includes("smallbusiness"));
  assert.ok(subs.includes("AskOldPeople"), "general subs always included");
  assert.ok(subs.length <= 8);
  const sites = stackExchangeSitesFor(["aerospace engineering"]);
  assert.deepEqual(sites.slice(0, 2), ["aviation", "engineering"]);
  assert.ok(sites.includes("workplace"));
  assert.ok(sites.length <= 4);
});

test("Apify inputs match each Actor's README", () => {
  const search = buildApifyInput(source("reddit-search"), ["baking"]);
  assert.deepEqual(search.searches, ["baking"]);
  assert.equal(search.searchPosts, true);
  assert.equal(search.startUrls, undefined, "startUrls would override searches");
  assert.equal(search.includeMediaLinks, true, "needed for upVotes/numberOfComments");

  const communities = buildApifyInput(source("reddit-communities"), ["baking"]);
  const urls = (communities.startUrls as { url: string }[]).map((u) => u.url);
  assert.ok(urls.includes("https://www.reddit.com/r/Baking/new/"));
  assert.equal(communities.searches, undefined);

  const quora = buildApifyInput(source("quora-search"), ["baking"]);
  assert.deepEqual(quora.searchQueries, ["baking advice", "baking career"]);
  assert.deepEqual(quora.resultTypes, ["question"]);
});

test("stackExchangeSearchUrl builds the official search/advanced call", () => {
  const url = new URL(stackExchangeSearchUrl("workplace", "first job", 500, "KEY"));
  assert.equal(url.origin + url.pathname, "https://api.stackexchange.com/2.3/search/advanced");
  assert.equal(url.searchParams.get("q"), "first job");
  assert.equal(url.searchParams.get("site"), "workplace");
  assert.equal(url.searchParams.get("filter"), "withbody");
  assert.equal(url.searchParams.get("pagesize"), "100");
  assert.equal(url.searchParams.get("key"), "KEY");
});

test("Reddit items: keep real questions, drop comments/removed/nsfw/old/medical/non-questions", () => {
  const items = fixture<unknown[]>("reddit_items.json");
  const { kept, dropped } = processItems(items, source("reddit-communities"), ["cooking"], NOW);
  const titles = kept.map((q) => q.title);
  assert.ok(titles.includes("How do you keep a cast iron pan from rusting?"));
  assert.ok(titles.includes("What did you do for fun as a teenager in the 1960s?"));
  assert.equal(dropped["not a post"], 1);
  assert.equal(dropped["removed"], 1);
  assert.equal(dropped["nsfw"], 1);
  assert.equal(dropped["too old"], 1);
  assert.equal(dropped["needs a professional"], 1);
  assert.equal(dropped["not a question"], 1);

  const iron = kept.find((q) => q.title.startsWith("How do you keep a cast iron"));
  assert.ok(iron);
  assert.equal(iron.source, "reddit");
  assert.equal(iron.community, "Cooking");
  assert.equal(iron.score, 120);
  assert.equal(iron.answerCount, 8);
  assert.equal(iron.postedAt, Date.parse("2026-10-23T20:00:00.000Z"));
  assert.deepEqual(iron.keywords, ["cooking"]);
  assert.equal(kept[0].title, iron.title, "on-topic, upvoted question ranks first");
});

test("Stack Exchange items: HTML cleaned, closed questions dropped", () => {
  const data = fixture<{ items: Record<string, unknown>[] }>("stackexchange_diy.json");
  const items = data.items.map((i) => ({ ...i, site: "diy" }));
  const { kept, dropped } = processItems(items, source("stackexchange-search"), ["tools"], NOW);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].title, `How do I remove rust from "old" hand tools?`);
  assert.equal(kept[0].body, "I inherited my dad's hand tools & they are rusty.");
  assert.equal(kept[0].community, "diy");
  assert.equal(kept[0].url, "https://diy.stackexchange.com/questions/301/how-do-i-remove-rust");
  assert.equal(dropped["closed"], 1);
});

test("Quora items: answer records dropped, no age limit", () => {
  const items = fixture<unknown[]>("quora_items.json");
  const { kept, dropped } = processItems(items, source("quora-search"), ["advice"], NOW);
  assert.equal(kept.length, 2, "a 2015 question is still fine");
  assert.equal(dropped["not a question record"], 1);
  const grand = kept.find((q) => q.title.includes("grandparents"));
  assert.equal(grand?.score, 10765);
  assert.equal(grand?.answerCount, 522);
});

test("Discourse search.json and latest.json both map to topic items", () => {
  const forum = "https://forum.example.com/";
  const fromSearch = discourseItemsFromSearch(fixture("discourse_search.json"), forum);
  assert.equal(fromSearch.length, 1, "pinned and closed topics skipped");
  assert.equal(fromSearch[0].url, "https://forum.example.com/t/earn-respect-family-bakery/4242");
  assert.equal(fromSearch[0].community, "forum.example.com");
  assert.equal(fromSearch[0].reply_count, 3);
  const { kept } = processItems(fromSearch, { ...source("discourse-search"), maxAgeDays: 30 }, ["bakery"], NOW);
  assert.equal(kept.length, 1);
  assert.match(kept[0].body ?? "", /took over my dad's bakery/);
  assert.equal(kept[0].score, 7);

  const fromLatest = discourseItemsFromSearch(fixture("discourse_latest.json"), forum);
  assert.equal(fromLatest.length, 1);
  assert.equal(fromLatest[0].title, "Best way to start tomatoes from seed indoors?");
});

test("fingerprint matches rewordings; dedupe keeps the higher priority copy", () => {
  assert.equal(
    fingerprint("How do you keep a cast iron pan from rusting?"),
    fingerprint("Keep cast-iron pan from rusting, how?"),
  );
  assert.notEqual(fingerprint("How do I start a bakery?"), fingerprint("How do I close a bakery?"));

  const base = { source: "reddit", url: "u", keywords: [], fingerprint: "f1" };
  const out = dedupe([
    { ...base, title: "a", priority: 1 },
    { ...base, title: "b", priority: 3, source: "stackexchange" },
    { ...base, title: "c", priority: 2, fingerprint: "f2" },
  ] as AudienceQuestion[]);
  assert.deepEqual(out.map((q) => q.title), ["b", "c"]);
});

test("priority rewards relevance, engagement and freshness", () => {
  const onTopic = { title: "How did you price bread when starting a bakery?", score: 5, postedAt: NOW - 86_400_000 };
  const offTopic = { title: "How do I fix a squeaky door?", score: 5, postedAt: NOW - 86_400_000 };
  assert.ok(priority(onTopic, ["bakery"], NOW, 30) > priority(offTopic, ["bakery"], NOW, 30));
  const stale = { ...onTopic, postedAt: NOW - 29 * 86_400_000 };
  assert.ok(priority(onTopic, ["bakery"], NOW, 30) > priority(stale, ["bakery"], NOW, 30));
  const popular = { ...onTopic, score: 500 };
  assert.ok(priority(popular, ["bakery"], NOW, 30) > priority(onTopic, ["bakery"], NOW, 30));
  assert.equal(relevance({ title: "anything" }, []), 0);
  assert.ok(relevance({ title: "Small businesses: how to hire?" }, ["small business"]) > 0);
});

test("looksLikeQuestion", () => {
  assert.ok(looksLikeQuestion("Any tips for a first-time manager"));
  assert.ok(looksLikeQuestion("Is it worth learning to bake bread"));
  assert.ok(!looksLikeQuestion("Finished my grandpa's old workbench restoration"));
});
