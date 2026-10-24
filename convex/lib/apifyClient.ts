// Minimal Apify REST client: run an Actor and get its dataset items in one call.
//   POST https://api.apify.com/v2/acts/<owner>~<name>/run-sync-get-dataset-items
// Apify waits up to 300 s for the run; longer runs come back as HTTP 408.
// Uses only fetch/AbortController/setTimeout, so it works in the default
// Convex runtime and in Node tests.

// Convex exposes deployment env vars on process.env (no @types/node here).
declare const process: { env: Record<string, string | undefined> };

export const APIFY_API = "https://api.apify.com/v2";

export type RunActorOptions = {
  /** seconds Apify may run the Actor (max 300 for the sync endpoint) */
  timeoutSecs?: number;
  /** cap on returned (and, for pay-per-result Actors, billed) items */
  maxItems?: number;
  token?: string;
  fetchImpl?: typeof fetch;
};

export class ApifyError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "ApifyError";
    this.status = status;
  }
}

export function actorPath(actorId: string): string {
  return actorId.trim().replace("/", "~");
}

export async function runActor(
  actorId: string,
  input: Record<string, unknown>,
  options: RunActorOptions = {},
): Promise<unknown[]> {
  const token = options.token ?? process.env.APIFY_TOKEN;
  if (!token) {
    throw new ApifyError("APIFY_TOKEN is not set. Run: npx convex env set APIFY_TOKEN <your token>");
  }
  const timeoutSecs = Math.max(10, Math.min(options.timeoutSecs ?? 240, 300));
  const params = new URLSearchParams({ timeout: String(timeoutSecs), format: "json", clean: "true" });
  if (options.maxItems) params.set("maxItems", String(options.maxItems));
  const url = `${APIFY_API}/acts/${actorPath(actorId)}/run-sync-get-dataset-items?${params.toString()}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), (timeoutSecs + 30) * 1000);
  const doFetch = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new ApifyError(`Apify ${actorId} did not answer within ${timeoutSecs + 30}s`);
    }
    throw new ApifyError(`Apify ${actorId} request failed: ${errorMessage(error)}`);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    let detail = text.slice(0, 300);
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } };
      detail = parsed.error?.message ?? detail;
    } catch {
      // not JSON, keep the raw text
    }
    const hint = response.status === 408 ? " (run took longer than the timeout; lower the item limits)" : "";
    throw new ApifyError(`Apify ${actorId} failed with HTTP ${response.status}${hint}: ${detail}`, response.status);
  }

  const data: unknown = await response.json();
  if (!Array.isArray(data)) throw new ApifyError(`Apify ${actorId} returned something other than a list`);
  return data;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
