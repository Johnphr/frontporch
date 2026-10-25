// A story post -> a short Bluesky thread. Pure (no runtime imports): tests/blueskyThread.test.ts.
//
//   post 1        the hook: the first paragraph, or as many of its first sentences as fit
//   posts 2..N    the story, the lesson and the question, packed by paragraph (by sentence
//                 when that needs too many posts; by word as a last resort, never inside a word)
//   last post     ends with the AI disclosure line (lib/linkedinPost.disclosureFor, EN / ES)
//
// 3-5 posts, each at most 300 graphemes (and 3,000 UTF-8 bytes, the lexicon's other limit).
// Nothing is cut or dropped: when the text can't fit, the result says why.

import { MAX_POST_GRAPHEMES, graphemeCount, type StrongRef } from "./bluesky.ts";
import { disclosureFor, normalizeWhitespace, removeDisclosureLines, stripMarkdown } from "./linkedinPost.ts";

export const MIN_THREAD_POSTS = 3;
export const MAX_THREAD_POSTS = 5;
export const MAX_POST_BYTES = 3000;

export type ThreadLang = "en" | "es";

export type ThreadSplit =
  | { ok: true; posts: string[]; hook: string; body: string; disclosure: string; langs: string[] }
  | { ok: false; reason: string };

export type ThreadOptions = { maxPosts?: number; minPosts?: number; limit?: number };

/** "es" stays Spanish; anything else is English. */
export function threadLang(lang: string | undefined): ThreadLang {
  return lang === "es" ? "es" : "en";
}

/** The writer's text as plain paragraphs, without any AI line it added (ours is added later). */
export function cleanStoryBody(raw: string): string {
  return normalizeWhitespace(removeDisclosureLines(normalizeWhitespace(stripMarkdown(raw ?? ""))).text);
}

/** UTF-8 length, by code point. */
export function utf8Length(text: string): number {
  let n = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return n;
}

// One piece of text that is never split further, and the whitespace that came before it.
type Unit = { text: string; sep: "\n\n" | "\n" | " " };

function render(units: Unit[]): string {
  return units.map((u, i) => (i === 0 ? u.text : u.sep + u.text)).join("");
}

/** Sentences of one paragraph, each with the whitespace before it (a line break stays a line break). */
function sentences(paragraph: string): Unit[] {
  const out: Unit[] = [];
  // Split after . ! ? … (plus closing quotes / brackets) followed by whitespace, and at line breaks.
  const re = /(?<=[.!?…]["'”’»)\]]*)\s+|\n/g;
  let last = 0;
  let sep: Unit["sep"] = "\n\n";
  for (const m of paragraph.matchAll(re)) {
    const piece = paragraph.slice(last, m.index).trim();
    if (piece) {
      out.push({ text: piece, sep });
      sep = m[0].includes("\n") ? "\n" : " ";
    }
    last = (m.index ?? 0) + m[0].length;
  }
  const tail = paragraph.slice(last).trim();
  if (tail) out.push({ text: tail, sep });
  return out;
}

/** A sentence longer than one post, as single words (packed between words). Null if one word alone is too long. */
function wordPieces(unit: Unit, limit: number): Unit[] | null {
  const words = unit.text.split(/\s+/).filter(Boolean);
  if (words.some((w) => graphemeCount(w) > limit)) return null;
  return words.map((text, i) => ({ text, sep: i === 0 ? unit.sep : " " }));
}

const fits = (text: string, limit: number) => graphemeCount(text) <= limit && utf8Length(text) <= MAX_POST_BYTES;

/** Greedy packing: keep adding units while the post fits, else start the next one. */
function pack(units: Unit[], limit: number, keepParagraphs: boolean): Unit[][] {
  const posts: Unit[][] = [];
  let current: Unit[] = [];
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    if (current.length && fits(render([...current, u]), limit)) {
      // Paragraph mode: a paragraph that would spill into the next post starts there instead,
      // when it fits a post on its own.
      if (keepParagraphs && u.sep === "\n\n") {
        let end = i + 1;
        while (end < units.length && units[end].sep !== "\n\n") end++;
        const para = units.slice(i, end);
        if (!fits(render([...current, ...para]), limit) && fits(render(para), limit)) {
          posts.push(current);
          current = [u];
          continue;
        }
      }
      current.push(u);
    } else {
      if (current.length) posts.push(current);
      current = [u];
    }
  }
  if (current.length) posts.push(current);
  return posts;
}

/** Split the longest post that has a break, at the break nearest its middle. False if none can split. */
function splitOne(posts: Unit[][], firstSplittable: number): boolean {
  let best = -1;
  for (let i = firstSplittable; i < posts.length; i++) {
    if (posts[i].length < 2) continue;
    if (best < 0 || graphemeCount(render(posts[i])) > graphemeCount(render(posts[best]))) best = i;
  }
  if (best < 0) return false;
  const units = posts[best];
  const total = graphemeCount(render(units));
  let at = 1;
  let bestGap = Infinity;
  for (let k = 1; k < units.length; k++) {
    // Prefer paragraph breaks: they count as nearer the middle.
    const gap = Math.abs(graphemeCount(render(units.slice(0, k))) - total / 2) * (units[k].sep === "\n\n" ? 0.5 : 1);
    if (gap < bestGap) {
      bestGap = gap;
      at = k;
    }
  }
  posts.splice(best, 1, units.slice(0, at), units.slice(at));
  return true;
}

const fail = (reason: string): ThreadSplit => ({ ok: false, reason });

/**
 * The story post as a Bluesky thread (see the top of this file). `lang` picks the disclosure
 * line ("es" -> Spanish). The result's `body` is the cleaned text without our disclosure
 * (what the fact-check reads).
 */
export function splitBlueskyThread(raw: string, lang: string | undefined, opts: ThreadOptions = {}): ThreadSplit {
  const limit = opts.limit ?? MAX_POST_GRAPHEMES;
  const maxPosts = opts.maxPosts ?? MAX_THREAD_POSTS;
  const minPosts = opts.minPosts ?? MIN_THREAD_POSTS;
  const disclosure = disclosureFor(threadLang(lang));
  const body = cleanStoryBody(raw);
  if (!body) return fail("The post is empty.");

  const paragraphs = body.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const all: Unit[] = [];
  for (const p of paragraphs) {
    for (const s of sentences(p)) {
      if (fits(s.text, limit)) {
        all.push(s);
        continue;
      }
      const pieces = wordPieces(s, limit);
      if (!pieces) return fail(`One word is longer than a ${limit}-character post.`);
      all.push(...pieces);
    }
  }

  // Post 1: the whole first paragraph if it fits, else its first sentences.
  const firstPara = (() => {
    let end = 1;
    while (end < all.length && all[end].sep !== "\n\n") end++;
    return end;
  })();
  let hookEnd = 0;
  while (hookEnd < firstPara && fits(render(all.slice(0, hookEnd + 1)), limit)) hookEnd++;
  if (hookEnd === 0 || (hookEnd < firstPara && all[hookEnd].sep === " " && wordSplit(all, hookEnd))) {
    const first = sentences(paragraphs[0])[0]?.text ?? paragraphs[0];
    return fail(`The opening line is ${graphemeCount(first)} characters; the first post holds ${limit}.`);
  }
  const hookUnits = all.slice(0, hookEnd);
  const rest = all.slice(hookEnd).map((u, i) => (i === 0 ? { ...u, sep: "\n\n" as const } : u));
  const withDisclosure: Unit[] = [...rest, { text: disclosure, sep: "\n\n" }];

  // Paragraphs kept whole when they fit; else sentences fill each post; last resort: words
  // (a sentence then continues in the next post, still never cut inside a word).
  let tail = pack(withDisclosure, limit, true);
  if (1 + tail.length > maxPosts) tail = pack(withDisclosure, limit, false);
  if (1 + tail.length > maxPosts) tail = pack(withDisclosure.flatMap((u) => wordPieces(u, limit) ?? [u]), limit, false);
  const posts = [hookUnits, ...tail];
  if (posts.length > maxPosts) {
    return fail(`It needs ${posts.length} posts; a thread holds at most ${maxPosts}. Shorten it by about ${overflow(posts, maxPosts, limit)} characters.`);
  }
  while (posts.length < minPosts) {
    if (!splitOne(posts, 1)) return fail(`Too short for a thread of ${minPosts} posts.`);
  }
  const texts = posts.map(render);
  return { ok: true, posts: texts, hook: texts[0], body, disclosure, langs: [threadLang(lang)] };
}

// True when the hook would end in the middle of a sentence cut between words.
function wordSplit(all: Unit[], at: number): boolean {
  const prev = all[at - 1];
  return Boolean(prev) && !/[.!?…]["'”’»)\]]*$/.test(prev.text);
}

function overflow(posts: Unit[][], maxPosts: number, limit: number): number {
  const total = posts.reduce((n, p) => n + graphemeCount(render(p)), 0);
  return Math.max(1, total - maxPosts * limit + 40);
}

/** Why the post can't be a Bluesky thread, or null when it can. */
export function threadFitProblem(raw: string, lang: string | undefined): string | null {
  const split = splitBlueskyThread(raw, lang);
  return split.ok ? null : split.reason;
}

// ---------- hashtags as links ----------

export type TagFacet = {
  index: { byteStart: number; byteEnd: number };
  features: [{ $type: "app.bsky.richtext.facet#tag"; tag: string }];
};

/** app.bsky.richtext facets so #tags in a post are clickable (offsets are UTF-8 bytes). */
export function hashtagFacets(text: string): TagFacet[] {
  const out: TagFacet[] = [];
  for (const m of text.matchAll(/(^|\s)#(\p{L}[\p{L}\p{N}_]*)/gu)) {
    const tag = m[2];
    if (graphemeCount(tag) > 64) continue;
    const byteStart = utf8Length(text.slice(0, (m.index ?? 0) + m[1].length));
    out.push({
      index: { byteStart, byteEnd: byteStart + utf8Length(`#${tag}`) },
      features: [{ $type: "app.bsky.richtext.facet#tag", tag }],
    });
  }
  return out;
}

// ---------- finding a thread an earlier run already posted ----------

export type ListedPost = { uri: string; cid: string; text: string; parentUri?: string };

/**
 * Extend `known` (the thread so far, root first) with posts of his that are already there:
 * same text, and replying to the previous post (the root: not a reply). Stops at the first gap.
 */
export function recoverThreadRecords(listed: ListedPost[], texts: string[], known: StrongRef[]): StrongRef[] {
  const out = [...known];
  for (let i = out.length; i < texts.length; i++) {
    const parent = i > 0 ? out[i - 1].uri : undefined;
    const match = listed.find((p) => p.text === texts[i] && (parent ? p.parentUri === parent : !p.parentUri));
    if (!match) break;
    out.push({ uri: match.uri, cid: match.cid });
  }
  return out;
}
