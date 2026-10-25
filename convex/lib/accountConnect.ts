// signup.connectBluesky's steps, with the database and fetch passed in (unit-tested with fakes).
// Check the handle and app password, reserve an attempt (rate limit + locked once active),
// log in once to Bluesky to prove it works, encrypt the app password, save.
// The password is never logged, returned or stored in the clear; results are codes only.

import { encryptSecret, loadAccountKey, type SealedSecret } from "./accountCrypto.ts";
import { BlueskyHttpError, blueskyService, createSession, type FetchFn } from "./blueskyClient.ts";
import { normalizeAppPassword, normalizeBlueskyHandle } from "./signupRules.ts";

export type ConnectError =
  | "invalid_handle" // not a Bluesky handle
  | "not_app_password" // not the xxxx-xxxx-xxxx-xxxx shape, or Bluesky says it's his main password
  | "privileged_app_password" // an app password with DM access: we ask for one without it
  | "not_found" // no such sign-up
  | "locked" // he's active: accounts change only through us
  | "rate_limited" // too many tries this hour (his, or for this handle)
  | "busy" // too many tries from everyone this hour: try later
  | "wrong_password" // Bluesky refused the handle + app password
  | "account_unavailable" // his Bluesky account is suspended or deactivated
  | "bluesky_busy" // Bluesky is down or rate-limiting us: try later
  | "failed"; // our side (e.g. ACCOUNTS_ENC_KEY missing)

export type ConnectResult = { ok: true; handle: string } | { ok: false; error: ConnectError };

export type ConnectDeps = {
  fetchFn: FetchFn;
  env: Record<string, string | undefined>;
  /** Count this attempt (handle already normalized); refuse if rate limited, active, or unknown. */
  reserve: (handle: string) => Promise<{ ok: true } | { ok: false; error: "not_found" | "locked" | "rate_limited" | "busy" }>;
  /** Save the verified account. */
  save: (account: { handle: string; did: string; secret: SealedSecret }) => Promise<{ ok: true } | { ok: false; error: "not_found" | "locked" }>;
  warn?: (message: string) => void;
};

/** A failed createSession -> what we tell him. */
export function loginErrorCode(error: unknown): ConnectError {
  if (!(error instanceof BlueskyHttpError)) return "bluesky_busy"; // network / timeout
  const name = error.xrpcError;
  if (name === "AuthFactorTokenRequired") return "not_app_password"; // email 2FA: only main passwords get it
  if (name === "AccountTakedown" || name === "AccountDeactivated") return "account_unavailable";
  if (error.status === 401 || (error.status === 400 && (name === "AuthenticationRequired" || name === "InvalidRequest"))) {
    return "wrong_password";
  }
  if (error.status === 429 || error.status >= 500) return "bluesky_busy";
  return "failed";
}

/**
 * The scope inside a session's access token: "com.atproto.appPass" (or ...Privileged) for an
 * app password, "com.atproto.access" for his main password. Undefined if it can't be read.
 */
export function sessionScope(accessJwt: string): string | undefined {
  const part = accessJwt.split(".")[1];
  if (!part) return undefined;
  try {
    const json = atob(part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "="));
    const scope = (JSON.parse(json) as { scope?: unknown } | null)?.scope;
    return typeof scope === "string" ? scope : undefined;
  } catch {
    return undefined;
  }
}

/** Log out a session we won't keep (deleteSession with its refresh token). Best effort. */
async function endSession(fetchFn: FetchFn, session: { service: string; refreshJwt?: string }): Promise<void> {
  if (!session.refreshJwt) return;
  try {
    await fetchFn(`${session.service}/xrpc/com.atproto.server.deleteSession`, {
      method: "POST",
      headers: { Authorization: `Bearer ${session.refreshJwt}` },
    });
  } catch {
    // It expires on its own; nothing was saved.
  }
}

export async function connectBlueskyAccount(
  deps: ConnectDeps,
  elderId: string,
  input: { handle: string; appPassword: string },
): Promise<ConnectResult> {
  const warn = deps.warn ?? (() => {});
  const handle = normalizeBlueskyHandle(input.handle);
  if (!handle) return { ok: false, error: "invalid_handle" };
  const password = normalizeAppPassword(input.appPassword);
  if (!password) return { ok: false, error: "not_app_password" };

  // Before anything else: without the key we couldn't save it anyway.
  let key: CryptoKey;
  try {
    key = await loadAccountKey(deps.env.ACCOUNTS_ENC_KEY);
  } catch (error) {
    warn(`connectBluesky: ${(error as Error).message}`); // names the env var, never its value
    return { ok: false, error: "failed" };
  }

  const reserved = await deps.reserve(handle);
  if (!reserved.ok) return { ok: false, error: reserved.error };

  let session;
  try {
    session = await createSession(deps.fetchFn, { service: blueskyService(deps.env.BLUESKY_SERVICE), identifier: handle, password });
  } catch (error) {
    const code = loginErrorCode(error);
    if (code === "failed" || code === "bluesky_busy") {
      warn(`connectBluesky: elder ${elderId} login check failed (${error instanceof BlueskyHttpError ? error.message : "network"})`);
    }
    return { ok: false, error: code };
  }
  // His main password, or an app password that can read his DMs: log that session out, then refuse.
  const scope = sessionScope(session.accessJwt);
  if (scope === "com.atproto.access" || scope === "com.atproto.appPassPrivileged") {
    await endSession(deps.fetchFn, session);
    return { ok: false, error: scope === "com.atproto.access" ? "not_app_password" : "privileged_app_password" };
  }

  const secret = await encryptSecret(key, password, elderId, "bluesky");
  const saved = await deps.save({ handle: session.handle.toLowerCase(), did: session.did, secret });
  if (!saved.ok) return { ok: false, error: saved.error };
  return { ok: true, handle: session.handle.toLowerCase() };
}

/** elderAccounts.lastError: short, with anything shaped like a password or token removed. */
export function shortAccountError(text: string): string {
  return text
    .replace(/\b[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}\b/gi, "[redacted]")
    .replace(/\beyJ[\w-]*\.[\w-]*\.?[\w-]*/g, "[redacted]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}
