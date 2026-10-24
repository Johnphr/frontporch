// Cartesia HTTP plumbing for convex/cartesia.ts: env check, fetch with a timeout, and
// error text that never echoes a phone number. No Convex imports.

import { CARTESIA_API, CARTESIA_VERSION, clip } from "./cartesia.ts";

// Convex exposes env vars on process.env (declared so we don't need @types/node).
declare const process: { env: Record<string, string | undefined> };

const REQUEST_TIMEOUT_MS = 30_000;

export function requireEnv(names: string[]): Record<string, string> {
  const missing = names.filter((n) => !process.env[n]);
  if (missing.length) {
    throw new Error(`Missing Convex env: ${missing.join(", ")} (set with: npx convex env set NAME value)`);
  }
  return Object.fromEntries(names.map((n) => [n, process.env[n] as string]));
}

export async function cartesiaFetch(
  path: string,
  init: { method: string; body?: unknown },
): Promise<{ status: number; json: any; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${CARTESIA_API}${path}`, {
      method: init.method,
      headers: {
        "X-API-Key": process.env.CARTESIA_API_KEY ?? "",
        "Cartesia-Version": CARTESIA_VERSION,
        "Content-Type": "application/json",
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: controller.signal,
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, json };
  } catch (err) {
    return { status: 0, json: null, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Short description of a failed Cartesia response. Call endpoints keep only the status: their
 * messages can echo the phone number. The agent endpoint's message is kept (it only ever sees
 * our prompt + settings) because it says what to fix.
 */
export function httpError(res: { status: number; json: any }, withDetail = false): string {
  const detail = withDetail && typeof res.json?.message === "string" ? `: ${res.json.message}` : "";
  return clip(`Cartesia HTTP ${res.status}${detail}`);
}
