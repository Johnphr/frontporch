// LinkedIn post formatting: pure functions, no imports, so Node can unit-test
// this file directly (`node --test tests/`).
//
// LinkedAPI types the text into LinkedIn's composer as-is, so anything that
// looks like markdown would show up raw. This file turns whatever the post
// writer produced into clean LinkedIn text:
//   - plain text (no **bold**, # headings, - bullets -> "•")
//   - at most 3 hashtags
//   - the AI disclosure line exactly once, at the end (code adds it, not the AI)
//   - 3,000 characters max, never cutting the disclosure
//   - a warning when the first line is longer than LinkedIn's "...see more" fold

export const LINKEDIN_MAX_CHARS = 3000; // st.createPost `text` limit
export const FOLD_CHARS = 140; // roughly what shows before "...see more"
export const MAX_HASHTAGS = 3;

// Posted on his own account, so it's in his voice.
export const DEFAULT_DISCLOSURE =
  "I told this story in a phone interview with Front Porch. It was written up with AI from my own words.";

export type Turn = { role: string; text: string };

export type PrepareOptions = {
  disclosure?: string;
  maxChars?: number;
  maxHashtags?: number;
};

export type PreparedPost = { text: string; warnings: string[] };

export type GuardMode = "enforce" | "warn" | "off";

// Lines that already disclose AI help (e.g. the writer added its own). We drop
// them and append ours, so the disclosure appears exactly once.
const DISCLOSURE_LINE =
  /\b(written|drafted|transcribed|edited|created|generated|composed)\b.{0,80}\b(AI|A\.I\.)(?![A-Za-z])|\bAI[- ](assisted|generated|written|drafted)\b/i;

const HASHTAG = /(^|\s)#([\p{L}\p{N}_]+)/gu;

/** POST_GUARD_MODE env value -> mode. Anything unknown means "enforce". */
export function parseGuardMode(value: string | undefined): GuardMode {
  const v = (value ?? "").trim().toLowerCase();
  if (v === "warn" || v === "off") return v;
  return "enforce";
}

/** Only what the elder said, one turn per line. Accepts Vapi-style roles too. */
export function elderWords(turns: Turn[]): string {
  return turns
    .filter((t) => ["elder", "user", "customer"].includes((t.role ?? "").toLowerCase()))
    .map((t) => (t.text ?? "").trim())
    .filter(Boolean)
    .join("\n");
}

/** Cut to `limit` characters on a word boundary, adding an ellipsis. */
export function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  if (limit <= 1) return text.slice(0, Math.max(0, limit));
  const slice = text.slice(0, limit - 1);
  const lastSpace = slice.search(/\s\S*$/);
  const cut = (lastSpace > 0 && lastSpace >= slice.length * 0.5 ? slice.slice(0, lastSpace) : slice).replace(/[\s,.;:—-]+$/u, "");
  return cut + "…";
}

export function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/ /g, " ")
    .replace(/\t/g, " ")
    .split("\n")
    .map((line) => line.replace(/ {2,}/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Remove markdown that LinkedIn would show as literal characters. */
export function stripMarkdown(text: string): string {
  return text
    .replace(/```[a-z]*\n?/gi, "") // code fences
    .replace(/`([^`]+)`/g, "$1") // inline code
    .replace(/^\s{0,3}#{1,6}\s+/gm, "") // headings ("# Title"), not hashtags ("#tag")
    .replace(/^\s{0,3}>\s?/gm, "") // blockquotes
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "$1 ($2)") // [text](url)
    .replace(/\*\*(.+?)\*\*/g, "$1") // **bold**
    .replace(/__(.+?)__/g, "$1") // __bold__
    .replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)\*(?![\w*])/g, "$1$2") // *italic*
    .replace(/^\s*[-*+]\s+/gm, "• "); // bullets
}

/** Keep the first `max` distinct hashtags, drop the rest. */
export function capHashtags(text: string, max: number): { text: string; removed: string[] } {
  const seen = new Set<string>();
  const removed: string[] = [];
  const out = text.replace(HASHTAG, (match, lead: string, tag: string) => {
    const key = tag.toLowerCase();
    if (seen.has(key) || seen.size >= max) {
      removed.push(`#${tag}`);
      return lead;
    }
    seen.add(key);
    return match;
  });
  return { text: out, removed };
}

export function removeDisclosureLines(text: string): string {
  return text
    .split("\n")
    .filter((line) => !DISCLOSURE_LINE.test(line))
    .join("\n");
}

/** Turn the post writer's text into the exact text to post on LinkedIn. */
export function prepareLinkedInText(raw: string, opts: PrepareOptions = {}): PreparedPost {
  const maxChars = opts.maxChars ?? LINKEDIN_MAX_CHARS;
  const maxHashtags = opts.maxHashtags ?? MAX_HASHTAGS;
  const disclosure = normalizeWhitespace(opts.disclosure ?? DEFAULT_DISCLOSURE);
  const warnings: string[] = [];

  let body = normalizeWhitespace(removeDisclosureLines(stripMarkdown(raw ?? "")));
  const capped = capHashtags(body, maxHashtags);
  if (capped.removed.length) {
    warnings.push(`Removed ${capped.removed.length} extra hashtag(s): ${capped.removed.join(" ")}`);
  }
  body = normalizeWhitespace(capped.text);
  if (!body) throw new Error("Post text is empty");

  const sep = "\n\n";
  const budget = maxChars - disclosure.length - sep.length;
  if (budget <= 0) throw new Error("Disclosure line is longer than the post limit");
  if (body.length > budget) {
    body = truncate(body, budget);
    warnings.push(`Shortened the post to fit LinkedIn's ${maxChars}-character limit`);
  }

  const firstLine = body.split("\n")[0];
  if (firstLine.length > FOLD_CHARS) {
    warnings.push(
      `First line is ${firstLine.length} characters; LinkedIn shows about ${FOLD_CHARS} before "...see more"`,
    );
  }

  return { text: body + sep + disclosure, warnings };
}

/** Delay before polling a LinkedAPI workflow again. */
export function pollDelayMs(attempt: number, pendingReason?: string | null): number {
  if (pendingReason === "outsideWorkingHours") return 30 * 60 * 1000;
  return Math.min(20_000 * (attempt + 1), 5 * 60 * 1000);
}

// ~2 hours of checks with the backoff above (longer if outside working hours).
export const MAX_POLL_ATTEMPTS = 30;
