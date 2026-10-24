// Small text helpers shared by the scrape mappers.
// No runtime imports on purpose: tests run these files directly with Node.

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
};

/** Strip HTML tags and decode entities (Stack Exchange and Discourse send HTML). */
export function cleanText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
      if (code[0] === "#") {
        const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return Number.isFinite(n) ? String.fromCodePoint(n) : match;
      }
      return ENTITIES[code.toLowerCase()] ?? match;
    })
    .replace(/\s+/g, " ")
    .trim();
}

/** Cut to `limit` characters on a word boundary, adding an ellipsis. */
export function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit - 1);
  const atSpace = cut.lastIndexOf(" ");
  return (atSpace > limit * 0.6 ? cut.slice(0, atSpace) : cut).replace(/[,.;:\s]+$/, "") + "…";
}

/** ISO string, unix seconds or unix milliseconds -> epoch milliseconds. */
export function parseTimestamp(value: unknown): number | undefined {
  if (value === null || value === undefined || typeof value === "boolean") return undefined;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return undefined;
    return value > 1e12 ? value : value * 1000;
  }
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return undefined;
    if (/^\d+(\.\d+)?$/.test(text)) return parseTimestamp(Number(text));
    // "2025-05-15 14:30:20" (no T, no zone) -> treat as UTC
    const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(text) ? text.replace(" ", "T") + "Z" : text;
    const ms = Date.parse(iso);
    return Number.isNaN(ms) ? undefined : ms;
  }
  return undefined;
}

/** First non-empty string (numbers allowed) among `keys`. */
export function pick(item: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = item[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

/** First numeric value among `keys` ("1,234" strings allowed). */
export function pickNumber(item: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = item[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const n = Number(value.replace(/,/g, ""));
      if (Number.isFinite(n)) return n;
    }
  }
  return undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Stable 16-hex-char hash (two FNV-1a 32-bit passes). Not cryptographic. */
export function hash16(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x01000197) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

/**
 * Prompt data can't open or close our fences: `<name ...>` / `</name>` (any case, any
 * attributes) become `‹name ...›`. A nested `<</name>/name>` can't rebuild a tag either.
 */
export function neutralizeFences(text: string, names: string[]): string {
  const tags = new RegExp(`<\\/?(?:${names.join("|")})\\b[^>]*>`, "gi");
  return text.replace(tags, (m) => m.replace(/</g, "‹").replace(/>/g, "›"));
}
