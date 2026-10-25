// Audience questions: real questions people in his field ask online.
// The call planner can turn one into a story prompt ("A young engineer asked
// how you handled your first big mistake...").
//
// This file holds the source list plus every pure step of the pipeline:
// build Actor input -> normalize raw items -> filter -> fingerprint -> rank.
// Fetching and saving live in convex/apify.ts. No runtime imports on purpose:
// tests run this file directly with Node.

import { cleanText, hash16, isRecord, parseTimestamp, pick, pickNumber } from "./text.ts";

export type SourceKind = "apify" | "stackexchange_api" | "discourse_json" | "bluesky_search";

export type FieldMap = {
  title: string[];
  body: string[];
  url: string[];
  id: string[];
  community: string[];
  score: string[];
  answers: string[];
  postedAt: string[];
  tags: string[];
};

export type SourceConfig = {
  name: string;
  label: string;
  kind: SourceKind;
  /** stored on each question: reddit | quora | stackexchange | discourse */
  source: string;
  enabled: boolean;
  /** Apify Actor id "owner/name" (kind "apify") */
  actor?: string;
  /** "search": keyword search; "communities": newest posts in matching subreddits */
  mode?: "search" | "communities";
  maxQuestions: number;
  /** null = no age limit (Quora questions stay relevant for years) */
  maxAgeDays: number | null;
  /** drop items whose title doesn't read like a question */
  requireQuestion: boolean;
  /** Discourse forums to search (kind "discourse_json") */
  forumUrls?: string[];
  fields?: Partial<FieldMap>;
};

export type AudienceQuestion = {
  source: string;
  title: string;
  body?: string;
  url: string;
  community?: string;
  score?: number;
  answerCount?: number;
  postedAt?: number;
  fingerprint: string;
  priority: number;
  keywords: string[];
  /** Bluesky only: the post's at:// uri, so a reply can be threaded under it */
  atUri?: string;
};

export type RawItem = Record<string, unknown>;

// ---------- sources ----------

/**
 * Edit this list to add/remove sources. Quora and Discourse start disabled:
 * the Quora Actor has few ratings (test it first) and Discourse needs real
 * forum URLs for his industry.
 */
export const SOURCES: SourceConfig[] = [
  {
    name: "reddit-search",
    label: "Reddit · keyword search",
    kind: "apify",
    source: "reddit",
    enabled: true,
    actor: "trudax/reddit-scraper-lite",
    mode: "search",
    maxQuestions: 25,
    maxAgeDays: 60,
    requireQuestion: true,
  },
  {
    name: "reddit-communities",
    label: "Reddit · subreddits for his field",
    kind: "apify",
    source: "reddit",
    enabled: true,
    actor: "trudax/reddit-scraper-lite",
    mode: "communities",
    maxQuestions: 25,
    maxAgeDays: 30,
    requireQuestion: true,
  },
  {
    name: "quora-search",
    label: "Quora · keyword search (test before enabling)",
    kind: "apify",
    source: "quora",
    enabled: false,
    actor: "blackfalcondata/quora-scraper",
    mode: "search",
    maxQuestions: 15,
    maxAgeDays: null,
    requireQuestion: false,
    fields: {
      title: ["title"],
      url: ["url"],
      id: ["questionId", "url"],
      score: ["followerCount"],
      answers: ["answerCount"],
      postedAt: ["creationTime"],
    },
  },
  {
    name: "stackexchange-search",
    label: "Stack Exchange · official API (The Workplace, DIY, Cooking, ...)",
    kind: "stackexchange_api",
    source: "stackexchange",
    enabled: true,
    maxQuestions: 20,
    maxAgeDays: null,
    requireQuestion: false,
  },
  {
    // His Bluesky session searches (the public AppView refuses unauthenticated search).
    // Only runs when BLUESKY_HANDLE + BLUESKY_APP_PASSWORD are set (convex/apify.ts).
    name: "bluesky-search",
    label: "Bluesky · recent posts by keyword (needs his BLUESKY_HANDLE + app password)",
    kind: "bluesky_search",
    source: "bluesky",
    enabled: true,
    maxQuestions: 15,
    maxAgeDays: 30,
    requireQuestion: true,
  },
  {
    name: "discourse-search",
    label: "Discourse forums · /search.json (add forums for his field first)",
    kind: "discourse_json",
    source: "discourse",
    enabled: false,
    forumUrls: [],
    maxQuestions: 10,
    maxAgeDays: 120,
    requireQuestion: true,
  },
];

export const DEFAULT_FIELDS: Record<SourceKind, FieldMap> = {
  apify: {
    title: ["title", "question", "questionTitle"],
    body: ["body", "selftext", "text", "description"],
    url: ["url", "link"],
    id: ["parsedId", "questionId", "id"],
    community: ["parsedCommunityName", "communityName"],
    score: ["upVotes", "score", "followerCount"],
    answers: ["numberOfComments", "answerCount"],
    postedAt: ["createdAt", "creationTime", "askedAt"],
    tags: ["tags", "topics"],
  },
  stackexchange_api: {
    title: ["title"],
    body: ["body"],
    url: ["link"],
    id: ["question_id"],
    community: ["site"],
    score: ["score"],
    answers: ["answer_count"],
    postedAt: ["creation_date"],
    tags: ["tags"],
  },
  bluesky_search: {
    title: ["title"],
    body: [],
    url: ["url"],
    id: ["id"],
    community: ["community"],
    score: ["score"],
    answers: ["answers"],
    postedAt: ["postedAt"],
    tags: [],
  },
  discourse_json: {
    title: ["title", "fancy_title"],
    body: ["excerpt", "blurb"],
    url: ["url"],
    id: ["id"],
    community: ["community"],
    score: ["like_count"],
    answers: ["reply_count"],
    postedAt: ["created_at"],
    tags: ["tags"],
  },
};

export function fieldsFor(source: SourceConfig): FieldMap {
  return { ...DEFAULT_FIELDS[source.kind], ...(source.fields ?? {}) } as FieldMap;
}

export function enabledSources(names?: string[]): SourceConfig[] {
  if (names && names.length) return SOURCES.filter((s) => names.includes(s.name));
  return SOURCES.filter((s) => s.enabled);
}

// ---------- keywords ----------

export const GENERAL_KEYWORDS = ["career advice", "first job", "mentor", "lessons learned"];

/**
 * Keywords from whatever we know about him. Reads defensively because the v2
 * elders fields (profile.industry/specialty) may not be in the schema yet.
 */
export function deriveKeywords(elder: unknown, max = 5): string[] {
  const out: string[] = [];
  const add = (value: unknown) => {
    const text = cleanText(value).toLowerCase();
    if (text && text.length <= 60 && !out.includes(text)) out.push(text);
  };
  if (isRecord(elder)) {
    const profile = isRecord(elder.profile) ? elder.profile : {};
    add(profile.specialty);
    add(profile.industry);
    if (Array.isArray(elder.expertise)) elder.expertise.forEach(add);
    if (Array.isArray(profile.topics)) profile.topics.forEach(add);
  }
  if (out.length === 0) return GENERAL_KEYWORDS.slice(0, max);
  return out.slice(0, max);
}

/** keyword fragment -> subreddits where people ask about it */
const SUBREDDITS_BY_TOPIC: [string, string[]][] = [
  ["aviation", ["aviation", "flying"]],
  ["pilot", ["flying", "aviation"]],
  ["aerospace", ["aerospace", "AskEngineers"]],
  ["engineer", ["AskEngineers", "engineering"]],
  ["manufactur", ["manufacturing", "AskEngineers"]],
  ["bak", ["Baking", "AskBaking"]],
  ["bread", ["Breadit", "Baking"]],
  ["chef", ["KitchenConfidential", "AskCulinary"]],
  ["restaurant", ["KitchenConfidential", "restaurantowners"]],
  ["cook", ["AskCulinary", "Cooking"]],
  ["teach", ["Teachers", "teaching"]],
  ["school", ["Teachers"]],
  ["construct", ["Construction", "HomeImprovement"]],
  ["carpent", ["Carpentry", "woodworking"]],
  ["wood", ["woodworking"]],
  ["electric", ["electricians"]],
  ["plumb", ["Plumbing"]],
  ["farm", ["farming", "agriculture"]],
  ["garden", ["gardening"]],
  ["mechanic", ["MechanicAdvice"]],
  ["auto", ["MechanicAdvice", "cars"]],
  ["truck", ["Truckers"]],
  ["military", ["Military", "Veterans"]],
  ["software", ["cscareerquestions", "ExperiencedDevs"]],
  ["program", ["cscareerquestions", "ExperiencedDevs"]],
  ["sales", ["sales"]],
  ["marketing", ["marketing"]],
  ["manag", ["managers", "Leadership"]],
  ["leader", ["Leadership", "managers"]],
  ["business", ["smallbusiness", "Entrepreneur"]],
  ["entrepreneur", ["Entrepreneur", "smallbusiness"]],
  ["retail", ["retail", "smallbusiness"]],
  ["journal", ["Journalism"]],
  ["architect", ["architecture"]],
  ["design", ["graphic_design", "Design"]],
  ["real estate", ["realtors"]],
];

export const GENERAL_SUBREDDITS = ["AskOldPeople", "careerguidance", "smallbusiness"];

export function subredditsFor(keywords: string[], max = 8): string[] {
  const subs: string[] = [];
  for (const keyword of keywords) {
    const k = keyword.toLowerCase();
    for (const [fragment, list] of SUBREDDITS_BY_TOPIC) {
      if (k.includes(fragment)) for (const s of list) if (!subs.includes(s)) subs.push(s);
    }
  }
  for (const s of GENERAL_SUBREDDITS) if (!subs.includes(s)) subs.push(s);
  return subs.slice(0, max);
}

/** keyword fragment -> Stack Exchange site slugs */
const SE_SITES_BY_TOPIC: [string, string[]][] = [
  ["manag", ["workplace", "pm"]],
  ["leader", ["workplace"]],
  ["career", ["workplace"]],
  ["hire", ["workplace"]],
  ["cook", ["cooking"]],
  ["bak", ["cooking"]],
  ["bread", ["cooking"]],
  ["chef", ["cooking"]],
  ["restaurant", ["cooking"]],
  ["construct", ["diy"]],
  ["carpent", ["diy", "woodworking"]],
  ["wood", ["woodworking"]],
  ["electric", ["diy", "electronics"]],
  ["plumb", ["diy"]],
  ["garden", ["gardening"]],
  ["farm", ["gardening"]],
  ["aviation", ["aviation"]],
  ["pilot", ["aviation"]],
  ["aerospace", ["aviation", "engineering"]],
  ["engineer", ["engineering"]],
  ["manufactur", ["engineering"]],
  ["mechanic", ["mechanics"]],
  ["auto", ["mechanics"]],
  ["teach", ["academia", "matheducators"]],
  ["software", ["softwareengineering"]],
  ["program", ["softwareengineering"]],
  ["freelanc", ["freelancing"]],
];

export const GENERAL_SE_SITES = ["workplace", "lifehacks"];

export function stackExchangeSitesFor(keywords: string[], max = 4): string[] {
  const sites: string[] = [];
  for (const keyword of keywords) {
    const k = keyword.toLowerCase();
    for (const [fragment, list] of SE_SITES_BY_TOPIC) {
      if (k.includes(fragment)) for (const s of list) if (!sites.includes(s)) sites.push(s);
    }
  }
  for (const s of GENERAL_SE_SITES) if (!sites.includes(s)) sites.push(s);
  return sites.slice(0, max);
}

// ---------- requests ----------

/** Actor input for an Apify source. Field names are from each Actor's README. */
export function buildApifyInput(source: SourceConfig, keywords: string[]): Record<string, unknown> {
  if (source.actor === "trudax/reddit-scraper-lite") {
    const common = {
      skipComments: true,
      skipUserPosts: true,
      skipCommunity: true,
      includeNSFW: false,
      // upVotes / numberOfComments are only returned with includeMediaLinks on
      includeMediaLinks: true,
      maxItems: source.maxQuestions * 3,
    };
    if (source.mode === "communities") {
      const subs = subredditsFor(keywords);
      return {
        ...common,
        startUrls: subs.map((s) => ({ url: `https://www.reddit.com/r/${s}/new/` })),
        maxPostCount: Math.max(5, Math.ceil((source.maxQuestions * 3) / Math.max(subs.length, 1))),
      };
    }
    return {
      ...common,
      searches: keywords,
      searchPosts: true,
      searchComments: false,
      searchCommunities: false,
      searchUsers: false,
      sort: "relevance",
      time: "month",
      // maxPostCount is per search: split the total so every keyword gets results
      // (otherwise the first keyword alone can fill maxItems).
      maxPostCount: Math.max(1, Math.ceil(common.maxItems / Math.max(keywords.length, 1))),
    };
  }
  if (source.actor === "blackfalcondata/quora-scraper") {
    return {
      searchQueries: keywords.flatMap((k) => [`${k} advice`, `${k} career`]).slice(0, 6),
      resultTypes: ["question"],
      maxItems: source.maxQuestions * 3,
      includeAnswers: false,
      excludeEmptyFields: true,
      // Required by the Actor's input schema (it has a default, but be explicit).
      proxyConfiguration: { useApifyProxy: true },
    };
  }
  return {};
}

export const STACKEXCHANGE_API = "https://api.stackexchange.com/2.3/search/advanced";

export function stackExchangeSearchUrl(site: string, query: string, pageSize: number, key?: string): string {
  const params = new URLSearchParams({
    site,
    q: query,
    sort: "relevance",
    order: "desc",
    filter: "withbody",
    pagesize: String(Math.max(1, Math.min(100, pageSize))),
  });
  if (key) params.set("key", key);
  return `${STACKEXCHANGE_API}?${params.toString()}`;
}

type StackExchangeResponse = {
  items?: Record<string, unknown>[];
  backoff?: number;
  error_id?: number;
  error_name?: string;
  error_message?: string;
  quota_remaining?: number;
};

export type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * Search every site × query on the official Stack Exchange API. One failing
 * request doesn't lose the rest: errors are collected and the items fetched so
 * far are kept. Stops early on throttling / an empty quota, and waits `backoff`
 * seconds between calls when the API asks for it. `fetchFn`/`sleepFn` are
 * injected so tests can run without the network.
 */
export async function fetchStackExchange(
  sites: string[],
  queries: string[],
  opts: { key?: string; pageSize?: number; fetchFn: FetchLike; sleepFn: (ms: number) => Promise<void> },
): Promise<{ items: RawItem[]; errors: string[] }> {
  const items: RawItem[] = [];
  const errors: string[] = [];
  for (const site of sites) {
    for (const query of queries) {
      let data: StackExchangeResponse = {};
      let status = 0;
      try {
        const response = await opts.fetchFn(stackExchangeSearchUrl(site, query, opts.pageSize ?? 10, opts.key));
        status = response.status;
        data = ((await response.json()) ?? {}) as StackExchangeResponse;
        if (!response.ok || data.error_message) {
          errors.push(`Stack Exchange ${site} "${query}": ${data.error_message ?? `HTTP ${response.status}`}`);
        } else {
          for (const item of data.items ?? []) items.push({ ...item, site });
        }
      } catch (error) {
        errors.push(`Stack Exchange ${site} "${query}": ${error instanceof Error ? error.message : String(error)}`);
      }
      // 502 throttle_violation / 429 / no quota left: every further call would fail too.
      if (data.error_id === 502 || data.error_name === "throttle_violation" || status === 429) return { items, errors };
      if (data.quota_remaining === 0) return { items, errors };
      if (data.backoff) await opts.sleepFn(data.backoff * 1000);
    }
  }
  return { items, errors };
}

export function discourseSearchUrl(forumUrl: string, query: string): string {
  return `${forumUrl.replace(/\/+$/, "")}/search.json?q=${encodeURIComponent(query)}`;
}

/**
 * Discourse /search.json -> one raw item per topic, with the matching post's
 * blurb as the body. Pinned/closed/archived topics are skipped.
 */
export function discourseItemsFromSearch(json: unknown, forumUrl: string): RawItem[] {
  if (!isRecord(json)) return [];
  const forum = forumUrl.replace(/\/+$/, "");
  let community = forum;
  try {
    community = new URL(forum).host;
  } catch {
    // keep the raw string
  }
  const blurbs = new Map<number, { blurb: string; likes: number }>();
  if (Array.isArray(json.posts)) {
    for (const post of json.posts) {
      if (!isRecord(post) || typeof post.topic_id !== "number") continue;
      if (!blurbs.has(post.topic_id)) {
        blurbs.set(post.topic_id, {
          blurb: typeof post.blurb === "string" ? post.blurb : "",
          likes: typeof post.like_count === "number" ? post.like_count : 0,
        });
      }
    }
  }
  const topics = Array.isArray(json.topics)
    ? json.topics
    : isRecord(json.topic_list) && Array.isArray(json.topic_list.topics)
      ? json.topic_list.topics
      : [];
  const items: RawItem[] = [];
  for (const topic of topics) {
    if (!isRecord(topic) || typeof topic.id !== "number") continue;
    if (topic.pinned || topic.closed || topic.archived || topic.visible === false) continue;
    const extra = blurbs.get(topic.id);
    items.push({
      ...topic,
      url: `${forum}/t/${typeof topic.slug === "string" && topic.slug ? topic.slug : "topic"}/${topic.id}`,
      community,
      ...(extra?.blurb && !topic.excerpt ? { blurb: extra.blurb } : {}),
      ...(typeof topic.like_count !== "number" && extra ? { like_count: extra.likes } : {}),
      ...(typeof topic.reply_count !== "number" && typeof topic.posts_count === "number"
        ? { reply_count: Math.max(0, topic.posts_count - 1) }
        : {}),
    });
  }
  return items;
}

// ---------- normalize ----------

const STOPWORDS = new Set([
  "the", "and", "for", "you", "your", "with", "that", "this", "what", "how", "why", "when",
  "who", "are", "was", "were", "have", "has", "had", "does", "did", "can", "could", "would",
  "should", "any", "anyone", "there", "their", "they", "from", "about", "into", "just",
  "like", "get", "got", "its", "it's", "what's", "how's", "i'm", "our", "out",
  "all", "but", "one", "some",
]);

/** Negations flip a question's meaning, so they always count ("quit" vs "not quit"). */
const NEGATIONS = new Set(["no", "not", "never", "nor", "don't", "dont", "won't", "can't", "cannot", "shouldn't"]);

/** Same question worded slightly differently -> same fingerprint. */
export function fingerprint(title: string): string {
  const words = cleanText(title).toLowerCase().match(/[a-z0-9']+/g) ?? [];
  const tokens = [
    ...new Set(words.filter((w) => NEGATIONS.has(w) || (w.length > 2 && !STOPWORDS.has(w)))),
  ].sort();
  const key = tokens.length >= 2 ? tokens.join(" ") : words.join(" ");
  return hash16(key);
}

/** One raw item -> question shape (without priority/keywords), or null if unusable. */
export function normalize(item: RawItem, source: SourceConfig): Omit<AudienceQuestion, "priority" | "keywords"> | null {
  const fields = fieldsFor(source);
  const title = cleanText(pick(item, fields.title));
  const url = pick(item, fields.url);
  if (!title || !url) return null;
  // Full title on purpose: filterReason drops titles over 300 chars, so kept ones fit.
  const question: Omit<AudienceQuestion, "priority" | "keywords"> = {
    source: source.source,
    title,
    url,
    fingerprint: fingerprint(title),
  };
  const body = cleanText(pick(item, fields.body));
  if (body) question.body = body.slice(0, 2000);
  const community = pick(item, fields.community);
  if (community) question.community = community;
  const score = pickNumber(item, fields.score);
  if (score !== undefined) question.score = score;
  const answers = pickNumber(item, fields.answers);
  if (answers !== undefined) question.answerCount = answers;
  for (const key of fields.postedAt) {
    const posted = parseTimestamp(item[key]);
    if (posted !== undefined) {
      question.postedAt = posted;
      break;
    }
  }
  if (typeof item.atUri === "string" && item.atUri.startsWith("at://")) question.atUri = item.atUri;
  return question;
}

// ---------- filter + rank ----------

const QUESTION_STARTS = [
  "how", "what", "why", "when", "where", "who", "which", "should", "would", "could", "can",
  "do", "does", "did", "is", "are", "was", "were", "have", "has", "any", "anyone", "anybody",
  "will",
];
const ADVICE_WORDS = /\b(advice|tips?|recommend\w*|suggestions?|help me|wisdom|lessons?)\b/i;

/**
 * Topics that need a licensed professional or are unsafe to crowdsource.
 * Finance terms are phrases on purpose: "chicken stock" and "investing in a
 * second oven" are fine questions for a chef or a baker.
 */
const BLOCKLIST = new RegExp(
  "\\b(medication|dosage|prescri\\w*|chemo\\w*|cancer|tumou?r|" +
    "lawsuit|lawyer|attorney|sue|suing|custody|legal advice|" +
    "stock market|stocks? and bonds|which stocks?|stock picks?|stock tips?|penny stocks?|" +
    "investment advice|investing advice|index funds?|retirement portfolio|401k|" +
    "crypto\\w*|bitcoin|forex|tax return|irs|" +
    "suicid\\w*|self[- ]harm|kill myself|overdose|abuse\\w*)\\b",
  "i",
);

/**
 * "diagnose" / "symptoms" are only medical when something medical is nearby
 * ("help diagnose this grinding noise" is a great question for a mechanic).
 */
const MEDICAL_ONLY_WORDS = /\b(diagnos\w*|symptoms?)\b/i;
const MEDICAL_CONTEXT = new RegExp(
  "\\b(doctors?|medical|medicine|disease|illness|sick|pain|rash|fever|infection|virus|pregnan\\w*|" +
    "depress\\w*|anxiety|adhd|autism|blood|heart|lungs?|skin|arthritis|diabet\\w*|covid|flu|" +
    "therap\\w*|health|hospital|nurse|my (?:son|daughter|baby|child|kid|wife|husband|mom|dad|mother|father))\\b",
  "i",
);

export function needsProfessional(text: string): boolean {
  if (BLOCKLIST.test(text)) return true;
  return MEDICAL_ONLY_WORDS.test(text) && MEDICAL_CONTEXT.test(text);
}
const REMOVED_MARKERS = new Set(["[removed]", "[deleted]", "[ removed by reddit ]"]);

export function looksLikeQuestion(title: string): boolean {
  if (title.includes("?") || ADVICE_WORDS.test(title)) return true;
  const lowered = title.toLowerCase().trim();
  return QUESTION_STARTS.some((w) => lowered.startsWith(w + " "));
}

/** Records that aren't questions at all (Reddit comments, Quora answers). */
export function recordTypeReason(item: RawItem, source: SourceConfig): string | null {
  if (typeof item.dataType === "string" && item.dataType !== "post") return "not a post";
  if (source.source === "quora" && typeof item.type === "string" && item.type !== "question") {
    return "not a question record";
  }
  return null;
}

/** Why this item should be dropped, or null to keep it. */
export function filterReason(
  item: RawItem,
  question: Omit<AudienceQuestion, "priority" | "keywords">,
  source: SourceConfig,
  nowMs: number,
): string | null {
  const title = question.title;
  const body = question.body ?? "";
  const typeReason = recordTypeReason(item, source);
  if (typeReason) return typeReason;
  if (REMOVED_MARKERS.has(title.toLowerCase()) || REMOVED_MARKERS.has(body.toLowerCase())) return "removed";
  if (item.removed || item.isRemoved || item.deleted) return "removed";
  if (item.closed_date || item.closed) return "closed";
  if (item.over18 || item.over_18 || item.isNsfw || item.nsfw || /\bnsfw\b/i.test(title)) return "nsfw";
  if (title.length < 12) return "too short";
  if (title.length > 300) return "too long";
  if (source.requireQuestion && !looksLikeQuestion(title)) return "not a question";
  if (source.maxAgeDays !== null && question.postedAt !== undefined) {
    if (nowMs - question.postedAt > source.maxAgeDays * 86_400_000) return "too old";
  }
  if (needsProfessional(`${title} ${body.slice(0, 500)}`)) return "needs a professional";
  return null;
}

/** How many of his keywords (or their words) show up in the question. 0..1 */
export function relevance(question: { title: string; body?: string }, keywords: string[]): number {
  if (keywords.length === 0) return 0;
  const text = `${question.title} ${question.body ?? ""}`.toLowerCase();
  let hits = 0;
  for (const keyword of keywords) {
    const k = keyword.toLowerCase();
    if (text.includes(k)) {
      hits += 1;
      continue;
    }
    const words = k.split(/\s+/).filter((w) => w.length > 3);
    if (words.length && words.some((w) => text.includes(w.slice(0, Math.max(4, w.length - 2))))) hits += 0.5;
  }
  return Math.min(1, hits / Math.min(keywords.length, 3));
}

/** Higher = better prompt for his next call: on-topic, people care, still fresh. */
export function priority(
  question: Pick<AudienceQuestion, "title" | "body" | "score" | "postedAt" | "answerCount">,
  keywords: string[],
  nowMs: number,
  maxAgeDays: number | null,
): number {
  const engagement = Math.log1p(Math.max(question.score ?? 0, 0));
  let freshness = 1;
  if (question.postedAt !== undefined) {
    const window = maxAgeDays ?? 365;
    const ageDays = Math.max(0, (nowMs - question.postedAt) / 86_400_000);
    freshness = 1.5 * Math.max(0, 1 - ageDays / Math.max(window, 1));
  }
  const answers = question.answerCount;
  const openness = answers === undefined ? 0.3 : answers === 0 ? 0.8 : answers <= 3 ? 0.5 : 0.2;
  const onTopic = 3 * relevance(question, keywords);
  return Math.round((engagement + freshness + openness + onTopic) * 1000) / 1000;
}

/** Longest age limit among the sources that store this `source` value (null = none). */
export function maxAgeDaysFor(sourceValue: string): number | null {
  const limits = SOURCES.filter((s) => s.source === sourceValue).map((s) => s.maxAgeDays);
  if (limits.length === 0 || limits.some((l) => l === null)) return null;
  return Math.max(...(limits as number[]));
}

type StoredQuestion = Pick<AudienceQuestion, "source" | "title" | "body" | "score" | "postedAt" | "answerCount"> & {
  keywords: string[];
};

/**
 * Priority recomputed at read time, so a question found weeks ago doesn't keep
 * its "fresh" score. Returns null when it's past its source's age limit.
 */
export function livePriority(question: StoredQuestion, nowMs: number): number | null {
  const maxAgeDays = maxAgeDaysFor(question.source);
  if (maxAgeDays !== null && question.postedAt !== undefined) {
    if (nowMs - question.postedAt > maxAgeDays * 86_400_000) return null;
  }
  return priority(question, question.keywords, nowMs, maxAgeDays);
}

export type ProcessResult = {
  kept: AudienceQuestion[];
  dropped: Record<string, number>;
};

/** normalize -> filter -> rank one source's raw items. */
export function processItems(
  items: unknown[],
  source: SourceConfig,
  keywords: string[],
  nowMs: number,
): ProcessResult {
  const kept: AudienceQuestion[] = [];
  const dropped: Record<string, number> = {};
  const drop = (reason: string) => {
    dropped[reason] = (dropped[reason] ?? 0) + 1;
  };
  for (const raw of items) {
    if (!isRecord(raw)) {
      drop("not an object");
      continue;
    }
    const typeReason = recordTypeReason(raw, source);
    if (typeReason) {
      drop(typeReason);
      continue;
    }
    const question = normalize(raw, source);
    if (!question) {
      drop("no title or url");
      continue;
    }
    const reason = filterReason(raw, question, source, nowMs);
    if (reason) {
      drop(reason);
      continue;
    }
    kept.push({ ...question, keywords, priority: priority(question, keywords, nowMs, source.maxAgeDays) });
  }
  kept.sort((a, b) => b.priority - a.priority);
  return { kept: kept.slice(0, source.maxQuestions), dropped };
}

/** Same question from two sites -> keep the higher-priority copy. */
export function dedupe(questions: AudienceQuestion[]): AudienceQuestion[] {
  const best = new Map<string, AudienceQuestion>();
  for (const q of questions) {
    const current = best.get(q.fingerprint);
    if (!current || q.priority > current.priority) best.set(q.fingerprint, q);
  }
  return [...best.values()].sort((a, b) => b.priority - a.priority);
}
