// OpenAI Responses API (POST /v1/responses) over plain fetch, like memories.ts's embeddings.
// Used by llm.ts (planner + post jobs) and postGuard.ts (fact-check).
//
//   structuredOutput  JSON matching a schema (text.format json_schema, strict)
//   webResearch       free-text notes from the web_search tool + every source URL it saw
//
// Response parsing is pure and unit-tested (tests/openai.test.ts). Errors are fixed strings
// plus the HTTP status or OpenAI's reason code: never the model's text or our input (they can
// quote his words, and these errors end up on calls / posts rows).
//
// Env: OPENAI_API_KEY, OPENAI_MODEL (optional, default gpt-6-luna; gpt-6.1-sol or gpt-6-astra
// for better writing).

// Convex exposes env vars on process.env (declared so we don't need @types/node).
declare const process: { env: Record<string, string | undefined> };

const RESPONSES_URL = "https://api.openai.com/v1/responses";
export const DEFAULT_MODEL = "gpt-6-luna";

export type Effort = "low" | "medium" | "high";

type Json = Record<string, unknown>;
const isRecord = (x: unknown): x is Json => typeof x === "object" && x !== null && !Array.isArray(x);
const list = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);

export function openaiModel(): string {
  return process.env.OPENAI_MODEL?.trim() || DEFAULT_MODEL;
}

/** The answer text of a finished response, or a fixed-text error (refusal, cut off, failed). */
export function readOutputText(response: unknown): string {
  if (!isRecord(response)) throw new Error("OpenAI returned no response");
  const contents = list(response.output)
    .filter((item) => isRecord(item) && item.type === "message")
    .flatMap((item) => list((item as Json).content));
  if (contents.some((c) => isRecord(c) && c.type === "refusal")) throw new Error("OpenAI declined this request");
  if (response.status === "incomplete") {
    const reason = isRecord(response.incomplete_details) ? String(response.incomplete_details.reason ?? "unknown") : "unknown";
    throw new Error(`OpenAI stopped early (${reason})`);
  }
  if (response.status !== "completed") throw new Error(`OpenAI response ${String(response.status ?? "missing status")}`);
  const text = contents
    .filter((c) => isRecord(c) && c.type === "output_text" && typeof c.text === "string")
    .map((c) => (c as Json).text as string)
    .join("");
  if (!text.trim()) throw new Error("OpenAI returned no text");
  return text;
}

/** Every URL web_search cited or read: url_citation annotations + web_search_call sources. */
export function collectSourceUrls(response: unknown): string[] {
  if (!isRecord(response)) return [];
  const urls: string[] = [];
  for (const item of list(response.output)) {
    if (!isRecord(item)) continue;
    if (item.type === "web_search_call" && isRecord(item.action)) {
      for (const s of list(item.action.sources)) if (isRecord(s) && typeof s.url === "string") urls.push(s.url);
    }
    if (item.type === "message") {
      for (const c of list(item.content)) {
        if (!isRecord(c)) continue;
        for (const a of list(c.annotations)) {
          if (isRecord(a) && a.type === "url_citation" && typeof a.url === "string") urls.push(a.url);
        }
      }
    }
  }
  return [...new Set(urls)];
}

/** OpenAI's error code / param for a 4xx (identifiers only, never message text, which can quote input). */
function errorDetail(json: unknown): string {
  const err = isRecord(json) && isRecord(json.error) ? json.error : {};
  const safe = (x: unknown) => (typeof x === "string" && /^[\w.\-[\]]{1,80}$/.test(x) ? x : "");
  const parts = [safe(err.code), safe(err.param) && `param ${safe(err.param)}`].filter(Boolean);
  return parts.length ? ` (${parts.join(", ")})` : "";
}

/** Seconds from Retry-After, capped, else a short backoff. */
function retryDelayMs(retryAfter: string | null, attempt: number): number {
  const seconds = Number(retryAfter);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 10) * 1000 : 2000 * (attempt + 1);
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * POST /v1/responses with a timeout; retries 429 / 5xx / network errors up to `retries` times.
 * `fetchImpl` / `sleep` are only swapped in tests.
 */
export async function createResponse(
  body: Json,
  opts: { timeoutMs: number; retries: number; fetchImpl?: Fetch; sleep?: (ms: number) => Promise<void> },
): Promise<unknown> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not set in Convex (npx convex env set OPENAI_API_KEY <key>)");
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    let status = 0;
    let detail = "";
    let retryAfter: string | null = null;
    try {
      const res = await doFetch(RESPONSES_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      status = res.status;
      if (res.ok) return await res.json();
      retryAfter = res.headers.get("retry-after");
      // Read (and so release) the body; on a 4xx keep only OpenAI's error code / param.
      const json = await res.json().catch(() => null);
      if (status >= 400 && status < 500) detail = errorDetail(json);
    } catch {
      if (status < 300) status = 0; // timeout, network, or an unreadable 2xx body
    } finally {
      clearTimeout(timer);
    }
    const retryable = status === 0 || status === 429 || status >= 500;
    if (!retryable || attempt >= opts.retries) {
      throw new Error(status === 0 ? "OpenAI did not answer (timeout or network)" : `OpenAI HTTP ${status}${detail}`);
    }
    await sleep(retryDelayMs(retryAfter, attempt));
  }
}

/** One structured call: system + user text in, JSON matching `schema` out. */
export async function structuredOutput<T>(opts: {
  name: string;
  system: string;
  user: string;
  schema: Json;
  effort: Effort;
  maxOutputTokens?: number;
  /** Defaults: 2-minute timeout, one retry. writePost's quality loop uses shorter, no-retry calls. */
  timeoutMs?: number;
  retries?: number;
}): Promise<T> {
  const response = await createResponse(
    {
      model: openaiModel(),
      instructions: opts.system,
      input: opts.user,
      reasoning: { effort: opts.effort },
      max_output_tokens: opts.maxOutputTokens ?? 16000,
      text: { format: { type: "json_schema", name: opts.name, schema: opts.schema, strict: true } },
    },
    // 2-minute timeout, one retry: a hung request must not stall the pipeline.
    { timeoutMs: opts.timeoutMs ?? 120_000, retries: opts.retries ?? 1 },
  );
  const text = readOutputText(response);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error("OpenAI returned invalid JSON"); // a parse error quotes the output
  }
}

/** Free-text research with the web_search tool. No retry: searches run long. */
export async function webResearch(opts: { system: string; user: string; effort: Effort }): Promise<{ text: string; urls: string[] }> {
  const response = await createResponse(
    {
      model: openaiModel(),
      instructions: opts.system,
      input: opts.user,
      reasoning: { effort: opts.effort },
      tools: [{ type: "web_search" }],
      include: ["web_search_call.action.sources"],
      max_output_tokens: 16000,
    },
    { timeoutMs: 180_000, retries: 0 },
  );
  return { text: readOutputText(response), urls: collectSourceUrls(response) };
}
