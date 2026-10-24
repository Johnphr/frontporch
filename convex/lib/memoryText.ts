// What we remember about him, as text: dedupe/merge rules and the prompt block.
// No runtime imports: unit-tested directly with Node (`npm test`).
// Used by memories.ts (merge on insert) and conversation.ts (Pip's {{memories}}).

export const MEMORY_KINDS = [
  "fact",
  "story_seed",
  "open_thread",
  "person",
  "place",
  "topic_covered",
  "avoid",
] as const;

export type MemoryKind = (typeof MEMORY_KINDS)[number];

export type MemoryItem = { kind: string; text: string; name?: string };

/**
 * Cosine similarity (Convex vector `_score`, OpenAI text-embedding-3-small) at or
 * above which a new memory merges into an existing one. Paraphrases of the same
 * fact usually land around 0.75-0.9, so 0.85 merges close rewordings without
 * gluing different facts together. TUNE on real pairs from his calls.
 */
export const MERGE_THRESHOLD = 0.85;

export function isMemoryKind(kind: string): kind is MemoryKind {
  return (MEMORY_KINDS as readonly string[]).includes(kind);
}

/** Lowercase, no punctuation, single spaces. */
export function normalizeText(text: string | undefined): string {
  return (text ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Same key = same memory. People/places are keyed by name when they have one. */
export function similarityKey(kind: string, text: string, name?: string): string {
  const named = (kind === "person" || kind === "place") && normalizeText(name);
  return `${kind}|${named || normalizeText(text)}`;
}

/** The text we embed: the name helps "Maria" match "my wife Maria". */
export function embeddingText(item: MemoryItem): string {
  const text = item.text.trim();
  const name = item.name?.trim();
  return name && !normalizeText(text).includes(normalizeText(name)) ? `${name}: ${text}` : text;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/** Both items carry a name and the names differ ("his brother Tom" vs "his brother Bill"). */
export function differentNames(a: MemoryItem, b: MemoryItem): boolean {
  const na = normalizeText(a.name);
  const nb = normalizeText(b.name);
  return Boolean(na && nb && na !== nb);
}

/**
 * Should `incoming` merge into `existing`? Kinds must match. When both have a
 * name, only the same name merges (always, whatever the score); two different
 * names never merge. Everything else needs a high similarity score.
 */
export function shouldMerge(
  existing: MemoryItem,
  incoming: MemoryItem,
  score: number,
  threshold = MERGE_THRESHOLD,
): boolean {
  if (existing.kind !== incoming.kind) return false;
  const a = normalizeText(existing.name);
  const b = normalizeText(incoming.name);
  if (a && b) return a === b;
  return score >= threshold;
}

/** Keep the more specific wording: the longer one, unless they say the same thing. */
export function mergeText(existing: string, incoming: string): string {
  const a = existing.trim();
  const b = incoming.trim();
  if (!b) return a;
  if (!a) return b;
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (na === nb) return a; // same words, different punctuation/case: keep the original
  return nb.length > na.length ? b : a;
}

/** Drop empty items and merge repeats inside one batch (same similarityKey). */
export function dedupeBatch<T extends MemoryItem>(items: T[]): T[] {
  const byKey = new Map<string, T>();
  for (const raw of items) {
    const text = (raw.text ?? "").trim();
    if (!text || !isMemoryKind(raw.kind)) continue;
    const name = raw.name?.trim() || undefined;
    const item = { ...raw, text, ...(name ? { name } : {}) } as T;
    if (!name) delete (item as MemoryItem).name;
    const key = similarityKey(item.kind, item.text, item.name);
    const prev = byKey.get(key);
    byKey.set(key, prev ? { ...prev, text: mergeText(prev.text, item.text) } : item);
  }
  return [...byKey.values()];
}

// ---------- prompt block for Pip ----------

type PromptMemory = { kind: string; text: string; name?: string; status?: string };

const GROUP_ORDER: MemoryKind[] = [
  "open_thread",
  "person",
  "place",
  "story_seed",
  "fact",
  "topic_covered",
  "avoid",
];

function sentence(text: string): string {
  const t = text.trim().replace(/\s+/g, " ");
  if (!t) return "";
  return /[.!?…]$/.test(t) ? t : `${t}.`;
}

function bare(text: string): string {
  return text.trim().replace(/\s+/g, " ").replace(/[.!?…]+$/, "");
}

function named(m: PromptMemory): string {
  const name = m.name?.trim();
  const text = bare(m.text);
  if (!name) return text;
  return normalizeText(text).startsWith(normalizeText(name)) ? text : `${name} (${text})`;
}

/**
 * Turn memories into a short block for Pip's prompt ({{memories}}). Grouped,
 * no bullets, most useful first: unfinished stories, people, places, stories,
 * facts, then what's already covered and what to avoid. Resolved open threads
 * are skipped. Returns "" when there's nothing to say.
 */
export function formatMemoriesForPrompt(memories: PromptMemory[], opts: { max?: number } = {}): string {
  const max = Math.max(1, Math.floor(opts.max ?? 12));
  const groups = new Map<MemoryKind, PromptMemory[]>();
  const seen = new Set<string>();
  for (const m of memories) {
    if (!m || !isMemoryKind(m.kind) || !(m.text ?? "").trim()) continue;
    if (m.kind === "open_thread" && m.status === "resolved") continue;
    const key = similarityKey(m.kind, m.text, m.name);
    if (seen.has(key)) continue;
    seen.add(key);
    const list = groups.get(m.kind) ?? [];
    list.push(m);
    groups.set(m.kind, list);
  }

  let budget = max;
  const take = (kind: MemoryKind): PromptMemory[] => {
    const list = (groups.get(kind) ?? []).slice(0, budget);
    budget -= list.length;
    return list;
  };

  const lines: string[] = [];
  for (const kind of GROUP_ORDER) {
    if (budget <= 0) break;
    const list = take(kind);
    if (list.length === 0) continue;
    switch (kind) {
      case "open_thread":
        for (const m of list) {
          lines.push(`He started telling you about ${bare(m.text)} but didn't finish. Ask him to finish that story.`);
        }
        break;
      case "person":
        lines.push(`People in his life: ${list.map(named).join("; ")}.`);
        break;
      case "place":
        lines.push(`Places that matter to him: ${list.map(named).join("; ")}.`);
        break;
      case "story_seed":
        lines.push(`Stories he has mentioned: ${list.map((m) => bare(m.text)).join("; ")}.`);
        break;
      case "fact":
        for (const m of list) lines.push(sentence(m.text));
        break;
      case "topic_covered":
        lines.push(`Already talked about (don't repeat unless he brings it up): ${list.map((m) => bare(m.text)).join("; ")}.`);
        break;
      case "avoid":
        lines.push(`He doesn't want to talk about: ${list.map((m) => bare(m.text)).join("; ")}.`);
        break;
    }
  }
  return lines.join("\n");
}

// ---------- OpenAI retry ----------

/** Statuses worth one retry: rate limit and server errors. */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * How long to wait before the single retry. Honors Retry-After (seconds or an
 * HTTP date) when present, capped so the action never stalls for long.
 */
export function retryDelayMs(
  retryAfter: string | null | undefined,
  nowMs = Date.now(),
  fallbackMs = 1500,
  capMs = 20_000,
): number {
  const value = (retryAfter ?? "").trim();
  if (value) {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(capMs, Math.round(seconds * 1000));
    const date = Date.parse(value);
    if (Number.isFinite(date)) return Math.min(capMs, Math.max(0, date - nowMs));
  }
  return fallbackMs;
}
