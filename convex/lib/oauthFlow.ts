// The OAuth "Connect" flow, shared by Threads and X (adapters in lib/oauthPlatforms.ts):
//
//   start     signup.startOAuthConnect: check config -> reserve an attempt (sign-up token, rate
//             limit, locked once active) -> random state (+ PKCE verifier) -> authorize URL
//   callback  http.ts GET /oauth/<platform>/callback: consume the state (single use, 15 min,
//             same platform) -> exchange the code -> encrypt the tokens -> save -> redirect to
//             SIGNUP_SITE_URL with ?connected=<platform> or ?connect_error=<code>
//
// The database and fetch are passed in (tests/oauth.test.ts). Tokens are encrypted with
// lib/accountCrypto.ts bound to elderId + platform, like the Bluesky app password. Nothing here
// returns, logs or redirects with a token, a code, a state or an id.

import { decryptSecret, encryptSecret, loadAccountKey, type Platform as CryptoPlatform, type SealedSecret } from "./accountCrypto.ts";
import type { FetchFn } from "./blueskyClient.ts";
import { OAuthHttpError, oauthAdapter, redirectUriFor, type OAuthEnv, type OAuthPlatform, type OAuthTokens } from "./oauthPlatforms.ts";

// ---------- random values ----------

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 32 random bytes, base64url (43 chars). Make it in an action (real randomness). */
export function newOAuthState(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** PKCE code verifier (43 chars, within RFC 7636's 43-128). */
export function newCodeVerifier(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** PKCE S256 challenge for a verifier. */
export async function codeChallengeS256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/** A state we made: 43 base64url chars. Anything else is never looked up. */
export function isStateShape(state: string | null | undefined): state is string {
  return typeof state === "string" && /^[A-Za-z0-9_-]{43}$/.test(state);
}

// ---------- state rules ----------

export const STATE_TTL_MS = 15 * 60_000;

export type StateRow = { platform: string; createdAt: number; usedAt?: number };
export type StateError = "invalid_state" | "state_used" | "state_expired";

/** May this state be used now? Unknown or another platform's -> invalid; used once -> used; older than 15 min -> expired. */
export function checkState(row: StateRow | null, platform: string, now: number): { ok: true } | { ok: false; error: StateError } {
  if (!row || row.platform !== platform) return { ok: false, error: "invalid_state" };
  if (row.usedAt !== undefined) return { ok: false, error: "state_used" };
  if (now - row.createdAt > STATE_TTL_MS || now < row.createdAt - 60_000) return { ok: false, error: "state_expired" };
  return { ok: true };
}

/** Old state rows are deleted after this (they're useless after 15 minutes anyway). */
export const STATE_CLEANUP_AFTER_MS = 24 * 60 * 60_000;

// ---------- sealing tokens ----------

/** What goes inside the ciphertext. Expiry and user id are on the row in the clear. */
type TokenPayload = { a: string; r?: string; i?: number };

export async function sealTokens(key: CryptoKey, tokens: OAuthTokens, elderId: string, platform: OAuthPlatform): Promise<SealedSecret> {
  const payload: TokenPayload = { a: tokens.accessToken, ...(tokens.refreshToken ? { r: tokens.refreshToken } : {}), ...(tokens.issuedAt ? { i: tokens.issuedAt } : {}) };
  // accountCrypto's Platform type predates OAuth; the AAD is just a string, so the cast is safe.
  return encryptSecret(key, JSON.stringify(payload), elderId, platform as unknown as CryptoPlatform);
}

/** Throws (fixed message) on a wrong key, another elder's ciphertext, or a bad payload. */
export async function openTokens(
  key: CryptoKey,
  sealed: SealedSecret,
  elderId: string,
  platform: OAuthPlatform,
  row: { externalUserId?: string | null; tokenExpiresAt?: number | null; handle?: string | null },
): Promise<OAuthTokens> {
  const plain = await decryptSecret(key, sealed, elderId, platform as unknown as CryptoPlatform);
  let payload: TokenPayload;
  try {
    payload = JSON.parse(plain) as TokenPayload;
  } catch {
    throw new Error("Account token payload is malformed");
  }
  if (!payload || typeof payload.a !== "string" || !payload.a) throw new Error("Account token payload is malformed");
  return {
    accessToken: payload.a,
    ...(typeof payload.r === "string" && payload.r ? { refreshToken: payload.r } : {}),
    ...(typeof payload.i === "number" ? { issuedAt: payload.i } : {}),
    expiresAt: row.tokenExpiresAt ?? 0,
    userId: row.externalUserId ?? "",
    ...(row.handle ? { username: row.handle } : {}),
  };
}

// ---------- start (signup.startOAuthConnect) ----------

export type StartError = "not_found" | "locked" | "rate_limited" | "not_configured" | "failed";
export type StartResult = { ok: true; url: string } | { ok: false; error: StartError };

export type StartDeps = {
  env: OAuthEnv;
  reserve: () => Promise<{ ok: true } | { ok: false; error: "not_found" | "locked" | "rate_limited" }>;
  createState: (row: { state: string; codeVerifier?: string }) => Promise<void>;
  warn?: (message: string) => void;
};

/** Platforms that send a PKCE challenge (X). Threads doesn't support PKCE. */
export const PKCE_PLATFORMS: ReadonlySet<string> = new Set(["x"]);

export async function startOAuthConnectFlow(deps: StartDeps, platform: OAuthPlatform): Promise<StartResult> {
  const warn = deps.warn ?? (() => {});
  const adapter = oauthAdapter(platform, deps.env);
  const redirectUri = redirectUriFor(platform, deps.env);
  if (!adapter || !redirectUri) {
    warn(`oauth: ${platform} isn't configured (app id / secret / redirect URI)`);
    return { ok: false, error: "not_configured" };
  }
  try {
    await loadAccountKey(deps.env.ACCOUNTS_ENC_KEY); // without it the callback couldn't save
  } catch (error) {
    warn(`oauth: ${(error as Error).message}`); // names the env var, never its value
    return { ok: false, error: "failed" };
  }
  const reserved = await deps.reserve();
  if (!reserved.ok) return { ok: false, error: reserved.error };
  const state = newOAuthState();
  const codeVerifier = PKCE_PLATFORMS.has(platform) ? newCodeVerifier() : undefined;
  await deps.createState({ state, ...(codeVerifier ? { codeVerifier } : {}) });
  const challenge = codeVerifier ? await codeChallengeS256(codeVerifier) : undefined;
  return { ok: true, url: adapter.authorizeUrl(state, redirectUri, challenge) };
}

// ---------- callback (http.ts) ----------

export type CallbackError =
  | "denied" // he pressed Cancel
  | StateError
  | "not_configured"
  | "exchange_failed" // the platform refused the code (or was down)
  | "not_found"
  | "locked"
  | "failed"; // our side (e.g. ACCOUNTS_ENC_KEY missing)

export type CallbackOutcome = { ok: true } | { ok: false; error: CallbackError };

export type CallbackParams = { code?: string | null; state?: string | null; error?: string | null };

export type SaveArgs = {
  elderId: string;
  handle?: string;
  externalUserId: string;
  secret: SealedSecret;
  tokenExpiresAt: number;
  scopes: string[];
};

export type CallbackDeps = {
  env: OAuthEnv;
  fetchFn: FetchFn;
  /** Mark the state used and return its elder; refuses unknown / used / expired / other platform. */
  consumeState: (state: string) => Promise<{ ok: true; elderId: string; codeVerifier?: string } | { ok: false; error: StateError }>;
  save: (args: SaveArgs) => Promise<{ ok: true } | { ok: false; error: "not_found" | "locked" }>;
  warn?: (message: string) => void;
};

export async function finishOAuthConnect(deps: CallbackDeps, platform: OAuthPlatform, params: CallbackParams): Promise<CallbackOutcome> {
  const warn = deps.warn ?? (() => {});
  const state = params.state ?? "";
  if (params.error) {
    // He said no (access_denied) or the platform sent an error: burn the state anyway.
    if (isStateShape(state)) await deps.consumeState(state).catch(() => null);
    return { ok: false, error: "denied" };
  }
  if (!isStateShape(state)) return { ok: false, error: "invalid_state" };
  const consumed = await deps.consumeState(state);
  if (!consumed.ok) return { ok: false, error: consumed.error };
  const code = (params.code ?? "").trim();
  if (!code || code.length > 2000) return { ok: false, error: "exchange_failed" };

  const adapter = oauthAdapter(platform, deps.env);
  const redirectUri = redirectUriFor(platform, deps.env);
  if (!adapter || !redirectUri) return { ok: false, error: "not_configured" };
  let key: CryptoKey;
  try {
    key = await loadAccountKey(deps.env.ACCOUNTS_ENC_KEY);
  } catch (error) {
    warn(`oauth callback: ${(error as Error).message}`);
    return { ok: false, error: "failed" };
  }

  let tokens: OAuthTokens;
  try {
    tokens = await adapter.exchangeCode(deps.fetchFn, code, redirectUri, consumed.codeVerifier);
  } catch (error) {
    warn(`oauth callback: elder ${consumed.elderId} ${platform} ${error instanceof OAuthHttpError ? error.message : "exchange error"}`);
    return { ok: false, error: "exchange_failed" };
  }
  const secret = await sealTokens(key, tokens, consumed.elderId, platform);
  const saved = await deps.save({
    elderId: consumed.elderId,
    ...(tokens.username ? { handle: tokens.username } : {}),
    externalUserId: tokens.userId,
    secret,
    tokenExpiresAt: tokens.expiresAt,
    scopes: adapter.scopes,
  });
  return saved.ok ? { ok: true } : { ok: false, error: saved.error };
}

/**
 * Where the callback sends him: SIGNUP_SITE_URL with ?connected=<platform>, or
 * ?connect_error=<code>&platform=<platform>. Only those params (any old ones are dropped).
 * Null when SIGNUP_SITE_URL isn't a usable http(s) URL.
 */
export function signupRedirect(siteUrl: string | undefined, platform: OAuthPlatform, outcome: CallbackOutcome): string | null {
  const raw = (siteUrl ?? "").trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  url.search = "";
  url.hash = "";
  if (outcome.ok) url.searchParams.set("connected", platform);
  else {
    url.searchParams.set("connect_error", outcome.error);
    url.searchParams.set("platform", platform);
  }
  return url.toString();
}
