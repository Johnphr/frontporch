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
// Only short lines in the last 2 paragraphs are candidates, and the wording must
// say the text was made WITH/BY AI, so story lines like "In 1987 we created the
// first AI group at the plant" are never touched.
const AI_WORD = String.raw`(?:AI|A\.I\.|artificial intelligence|ChatGPT|Claude)(?![A-Za-z])`;
const IA_WORD = String.raw`(?:IA|I\.A\.|inteligencia artificial)(?![A-Za-z])`;
const DISCLOSURE_PATTERNS: RegExp[] = [
  new RegExp(
    String.raw`\b(?:written|drafted|transcribed|edited|created|generated|composed|made|produced|put together|polished)\b.{0,60}\b(?:with|by|using|via)\b.{0,30}\b${AI_WORD}`,
    "i",
  ),
  new RegExp(String.raw`\b(?:with|using)\s+(?:the\s+)?help\s+(?:of|from)\s+${AI_WORD}`, "i"),
  new RegExp(String.raw`\bwith\s+AI\s+(?:help|assistance)\b`, "i"),
  /\bAI[- ](?:assisted|generated|written|drafted|powered|edited)\b/i,
  new RegExp(
    String.raw`\b(?:escrito|redactado|hecho|creado|generado|transcrito|editado)\b.{0,60}\b(?:con|por|usando|mediante)\b.{0,30}\b${IA_WORD}`,
    "i",
  ),
  new RegExp(String.raw`\bcon\s+(?:la\s+)?ayuda\s+de\s+(?:la\s+)?${IA_WORD}`, "i"),
];
export const DISCLOSURE_MAX_LINE = 160;

// A hashtag must start with a letter, so "#1 in sales" is not a hashtag.
const HASHTAG = /(^|\s)#(\p{L}[\p{L}\p{N}_]*)/gu;

/** POST_GUARD_MODE env value -> mode. Anything unknown means "enforce". */
export function parseGuardMode(value: string | undefined): GuardMode {
  const v = (value ?? "").trim().toLowerCase();
  if (v === "warn" || v === "off") return v;
  return "enforce";
}

const ELDER_ROLES = ["elder", "user", "customer"];
const PIP_ROLES = ["pip", "assistant", "bot", "ai", "agent"];

/** Only what the elder said, one turn per line. Accepts Vapi-style roles too. */
export function elderWords(turns: Turn[]): string {
  return turns
    .filter((t) => ELDER_ROLES.includes((t.role ?? "").toLowerCase()))
    .map((t) => (t.text ?? "").trim())
    .filter(Boolean)
    .join("\n");
}

/** True when the elder said anything at all. */
export function hasElderSpeech(turns: Turn[]): boolean {
  return elderWords(turns).trim() !== "";
}

/** The whole conversation, one turn per line, labelled PIP (interviewer) or ELDER (him). */
export function labelledTranscript(turns: Turn[]): string {
  return turns
    .map((t) => {
      const role = (t.role ?? "").toLowerCase();
      const label = ELDER_ROLES.includes(role) ? "ELDER" : PIP_ROLES.includes(role) ? "PIP" : role.toUpperCase() || "UNKNOWN";
      const text = (t.text ?? "").trim();
      return text ? `${label}: ${text}` : "";
    })
    .filter(Boolean)
    .join("\n");
}

/** Drop a trailing lone high surrogate so a cut never leaves half an emoji. */
function dropBrokenSurrogate(text: string): string {
  if (!text) return text;
  const last = text.charCodeAt(text.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? text.slice(0, -1) : text;
}

/** Cut to `limit` characters on a word boundary, adding an ellipsis. */
export function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  if (limit <= 1) return dropBrokenSurrogate(text.slice(0, Math.max(0, limit)));
  const slice = dropBrokenSurrogate(text.slice(0, limit - 1));
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
    // [ \t] (not \s) so a match never swallows the blank line before it.
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "") // headings ("# Title"), not hashtags ("#tag")
    .replace(/^[ \t]{0,3}>[ \t]?/gm, "") // blockquotes
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "$1 ($2)") // [text](url)
    .replace(/\*\*(.+?)\*\*/g, "$1") // **bold**
    .replace(/__(.+?)__/g, "$1") // __bold__
    .replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)\*(?![\w*])/g, "$1$2") // *italic*
    .replace(/^[ \t]*[-*+][ \t]+/gm, "• "); // bullets
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

/** A short line that says the text was written with AI (English or Spanish). */
export function isDisclosureLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > DISCLOSURE_MAX_LINE) return false;
  return DISCLOSURE_PATTERNS.some((re) => re.test(trimmed));
}

/**
 * Remove existing AI-disclosure lines, but only short ones in the last 2
 * paragraphs (where writers put them). Expects normalized whitespace.
 */
export function removeDisclosureLines(text: string): { text: string; removed: string[] } {
  const paragraphs = text.split("\n\n");
  const removed: string[] = [];
  const firstChecked = Math.max(0, paragraphs.length - 2);
  const kept = paragraphs.map((paragraph, i) => {
    if (i < firstChecked) return paragraph;
    return paragraph
      .split("\n")
      .filter((line) => {
        if (!isDisclosureLine(line)) return true;
        removed.push(line.trim());
        return false;
      })
      .join("\n");
  });
  return { text: kept.filter((p) => p.trim() !== "").join("\n\n"), removed };
}

/** Turn the post writer's text into the exact text to post on LinkedIn. */
export function prepareLinkedInText(raw: string, opts: PrepareOptions = {}): PreparedPost {
  const maxChars = opts.maxChars ?? LINKEDIN_MAX_CHARS;
  const maxHashtags = opts.maxHashtags ?? MAX_HASHTAGS;
  const disclosure = normalizeWhitespace(opts.disclosure ?? DEFAULT_DISCLOSURE);
  const warnings: string[] = [];

  const stripped = removeDisclosureLines(normalizeWhitespace(stripMarkdown(raw ?? "")));
  for (const line of stripped.removed) {
    if (line === disclosure) continue; // ours, re-added below
    warnings.push(`Replaced an existing AI disclosure line with ours: "${truncate(line, 80)}"`);
  }
  let body = normalizeWhitespace(stripped.text);
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
