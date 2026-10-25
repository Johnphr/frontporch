// X post text: the weighted length (twitter-text v3 rules) and the story split. Pure: tests/xText.test.ts.
//
// A post holds 280 weighted characters. After NFC: code points in U+0000-U+10FF (Latin,
// accents, Greek, Cyrillic, Hebrew, Arabic, Indic...), U+2000-U+200D, U+2010-U+201F and
// U+2032-U+2037 count 1; everything else (CJK, most symbols) counts 2; an emoji (even a
// ZWJ family or a flag) counts 2; every URL counts 23, whatever its length.
//
//   thread mode   the Bluesky splitter (lib/blueskyThread.ts) at a smaller limit until every
//                 post fits 280 weighted: hook first, AI note at the end of the last post. 2-5 posts.
//   single mode   one post: the hook, then as many next sentences as fit, then the AI note.

import { cleanStoryBody, splitBlueskyThread, threadLang, type ThreadSplit } from "./blueskyThread.ts";
import { disclosureFor } from "./linkedinPost.ts";

export const X_MAX_WEIGHTED = 280;
export const X_URL_WEIGHT = 23;
export const X_MAX_THREAD_POSTS = 5;
export const X_MIN_THREAD_POSTS = 2;

const LIGHT_RANGES: [number, number][] = [
  [0x0000, 0x10ff],
  [0x2000, 0x200d],
  [0x2010, 0x201f],
  [0x2032, 0x2037],
];

// http(s) links, and bare domains on common TLDs (twitter-text links those too).
const URL_RE =
  /https?:\/\/[^\s<>"]+|(?<![@\w.\/-])(?:www\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.(?:com|net|org|io|ai|co|app|dev|edu|gov|me|us|uk|ca|info|ly|tv|xyz|news|blog)\b(?:\/[^\s<>"]*)?/gi;
const TRAILING = /[.,!?:;)\]'"’”…]+$/u;
const EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣|️/u;

function codePointWeight(cp: number): number {
  return LIGHT_RANGES.some(([a, b]) => cp >= a && cp <= b) ? 1 : 2;
}

function segments(text: string): string[] {
  const Seg = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: string }) => { segment(s: string): Iterable<{ segment: string }> } }).Segmenter;
  if (!Seg) return Array.from(text);
  return Array.from(new Seg(undefined, { granularity: "grapheme" }).segment(text), (s) => s.segment);
}

function plainWeight(text: string): number {
  let n = 0;
  for (const g of segments(text)) {
    const cps = Array.from(g, (c) => c.codePointAt(0) ?? 0);
    // An emoji grapheme counts 2 once. A plain © or ® (no emoji selector) is Latin-1: 1.
    if (EMOJI.test(g) && (cps.length > 1 || cps[0] > 0x10ff)) n += 2;
    else for (const cp of cps) n += codePointWeight(cp);
  }
  return n;
}

/** The URLs in the text (trailing punctuation not included). */
export function findUrls(text: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  for (const m of text.matchAll(URL_RE)) {
    const url = m[0].replace(TRAILING, "");
    if (url) out.push({ start: m.index ?? 0, end: (m.index ?? 0) + url.length });
  }
  return out;
}

/** Does the post have a link? (X charges ~$0.20 for a post with a URL vs ~$0.015 without.) */
export function hasUrl(text: string): boolean {
  return findUrls(text.normalize("NFC")).length > 0;
}

/** The post's length as X counts it. */
export function weightedLength(raw: string): number {
  const text = raw.normalize("NFC");
  let n = 0;
  let at = 0;
  for (const u of findUrls(text)) {
    n += plainWeight(text.slice(at, u.start)) + X_URL_WEIGHT;
    at = u.end;
  }
  return n + plainWeight(text.slice(at));
}

export const fitsX = (text: string, max = X_MAX_WEIGHTED) => weightedLength(text) <= max;

const fail = (reason: string): ThreadSplit => ({ ok: false, reason });

/**
 * The story as an X self-thread. Same result shape as splitBlueskyThread. The Bluesky splitter
 * counts graphemes, so we shrink its limit until every post fits 280 weighted (CJK and emoji
 * count double).
 */
export function splitXThread(raw: string, lang: string | undefined): ThreadSplit {
  let limit = X_MAX_WEIGHTED;
  for (let tries = 0; tries < 10; tries++) {
    const split = splitBlueskyThread(raw, lang, { limit, maxPosts: X_MAX_THREAD_POSTS, minPosts: X_MIN_THREAD_POSTS });
    if (!split.ok) return fail(split.reason.replace(/characters/g, "X characters"));
    const worst = Math.max(...split.posts.map((p) => weightedLength(p)));
    if (worst <= X_MAX_WEIGHTED) return split;
    const next = Math.min(limit - 1, Math.floor((limit * X_MAX_WEIGHTED) / worst) - 1);
    if (next < 70) break;
    limit = next;
  }
  return fail(`It doesn't fit ${X_MAX_THREAD_POSTS} X posts of ${X_MAX_WEIGHTED} characters.`);
}

function sentencesOf(paragraph: string): string[] {
  return paragraph
    .split(/(?<=[.!?…]["'”’»)\]]*)\s+|\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Cut at a word so `text…` fits `budget` weighted characters ("" if not even one word fits). */
function cutToWeight(text: string, budget: number): string {
  let out = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = out ? `${out} ${word}` : word;
    if (weightedLength(`${next}…`) > budget) break;
    out = next;
  }
  return out ? `${out.replace(/[\s,.;:—-]+$/u, "")}…` : "";
}

/** One X post: hook + the next sentences that fit + the AI note. Same result shape as splitXThread. */
export function singleXPost(raw: string, lang: string | undefined): ThreadSplit {
  const disclosure = disclosureFor(threadLang(lang));
  const body = cleanStoryBody(raw);
  if (!body) return fail("The post is empty.");
  const budget = X_MAX_WEIGHTED - weightedLength(`\n\n${disclosure}`);

  const paragraphs = body.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  let text = "";
  outer: for (const [pi, p] of paragraphs.entries()) {
    for (const [si, s] of sentencesOf(p).entries()) {
      const sep = !text ? "" : si === 0 && pi > 0 ? "\n\n" : " ";
      const next = text + sep + s;
      if (weightedLength(next) > budget) {
        if (!text) text = cutToWeight(s, budget);
        break outer;
      }
      text = next;
    }
  }
  if (!text) return fail("The opening line has no words that fit one X post.");
  const post = `${text}\n\n${disclosure}`;
  return { ok: true, posts: [post], hook: text, body, disclosure, langs: [threadLang(lang)] };
}
