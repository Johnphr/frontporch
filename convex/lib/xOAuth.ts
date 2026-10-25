// X (Twitter) OAuth 2.0: Authorization Code with PKCE (S256), confidential client.
// Pure (fetch is passed in): tests/xOAuth.test.ts. xAuth.ts does the database side.
//
//   authorize  https://x.com/i/oauth2/authorize
//   token      https://api.x.com/2/oauth2/token   (Basic auth: client id + secret)
//   who        GET https://api.x.com/2/users/me
// Access tokens last about 2 hours. offline.access gives a refresh token, which rotates:
// save the new one after every refresh. The code from the callback expires in ~30 seconds.
// Env: X_CLIENT_ID, X_CLIENT_SECRET. Never log or return tokens.

declare const process: { env: Record<string, string | undefined> };

export type FetchFn = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export const X_AUTHORIZE_URL = "https://x.com/i/oauth2/authorize";
export const X_TOKEN_URL = "https://api.x.com/2/oauth2/token";
export const X_API = "https://api.x.com/2";
export const X_SCOPES = ["tweet.read", "tweet.write", "users.read", "offline.access"];
export const X_CALLBACK_PATH = "/oauth/x/callback";
/** A Connect click is good for this long. */
export const STATE_MAX_AGE_MS = 15 * 60 * 1000;
/** Refresh when the access token expires within this. */
export const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export type ExchangeResult = { accessToken: string; refreshToken?: string; expiresAt: number; userId: string; username: string; scopes?: string[] };
export type RefreshResult = { accessToken: string; refreshToken?: string; expiresAt: number; scopes?: string[] };

// Same shape as lib/oauthPlatforms.ts OAuthAdapter (Threads branch); unified at integration.
export type OAuthAdapter = {
  platform: "x";
  scopes: string[];
  authorizeUrl(state: string, redirectUri: string, codeChallenge?: string): string;
  exchangeCode(fetchFn: FetchFn, code: string, redirectUri: string, codeVerifier?: string): Promise<ExchangeResult>;
  refresh(fetchFn: FetchFn, tokens: { accessToken: string; refreshToken?: string }): Promise<RefreshResult>;
  usesPkce: true;
};

/** X said no. `code` is X's OAuth error (invalid_grant...) when it gave one. Never holds a token. */
export class XAuthError extends Error {
  status: number;
  code?: string;
  constructor(step: string, status: number, code?: string) {
    super(`X ${step} HTTP ${status}${code ? ` (${code})` : ""}`);
    this.name = "XAuthError";
    this.status = status;
    if (code) this.code = code;
  }
}

/** The refresh token was revoked or already used: he has to connect again (unless another run just refreshed). */
export function isRefreshRefused(error: unknown): boolean {
  return error instanceof XAuthError && (error.code === "invalid_grant" || error.code === "invalid_request" || error.status === 401);
}

// ---------- PKCE ----------

export function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Random base64url string from `bytes` random bytes (32 -> 43 characters). */
export function randomToken(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** PKCE code verifier: 43-128 characters of [A-Za-z0-9-._~]. */
export function makeCodeVerifier(): string {
  return randomToken(48); // 64 characters
}

/** S256 challenge: base64url(sha256(verifier)). */
export async function codeChallengeS256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

// ---------- the adapter ----------

export type XClient = { clientId: string; clientSecret: string };

/** X_CLIENT_ID + X_CLIENT_SECRET, or null when either is missing. */
export function xClientFromEnv(env: Record<string, string | undefined>): XClient | null {
  const clientId = env.X_CLIENT_ID?.trim();
  const clientSecret = env.X_CLIENT_SECRET?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

/** CONVEX_SITE_URL + /oauth/x/callback (must match the callback in the X app settings exactly). */
export function xRedirectUri(env: Record<string, string | undefined>): string | null {
  const site = env.CONVEX_SITE_URL?.trim().replace(/\/+$/, "");
  return site ? `${site}${X_CALLBACK_PATH}` : null;
}

function basicAuth(c: XClient): string {
  const bytes = new TextEncoder().encode(`${encodeURIComponent(c.clientId)}:${encodeURIComponent(c.clientSecret)}`);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return `Basic ${btoa(s)}`;
}

async function errorCode(res: { json(): Promise<unknown> }): Promise<string | undefined> {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  return typeof body?.error === "string" && /^[a-z_]{1,40}$/.test(body.error) ? body.error : undefined;
}

/** The token endpoint's answer -> our shape. Throws if there's no access token. */
export function parseTokenResponse(json: unknown, now: number): RefreshResult {
  const t = (json ?? {}) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; scope?: unknown };
  if (typeof t.access_token !== "string" || !t.access_token) throw new XAuthError("token", 200, "no_access_token");
  const seconds = typeof t.expires_in === "number" && t.expires_in > 0 ? t.expires_in : 7200;
  return {
    accessToken: t.access_token,
    ...(typeof t.refresh_token === "string" && t.refresh_token ? { refreshToken: t.refresh_token } : {}),
    expiresAt: now + seconds * 1000,
    ...(typeof t.scope === "string" ? { scopes: t.scope.split(/\s+/).filter(Boolean) } : {}),
  };
}

/** GET /2/users/me -> his id and @username. */
export async function fetchMe(fetchFn: FetchFn, accessToken: string): Promise<{ userId: string; username: string }> {
  const res = await fetchFn(`${X_API}/users/me`, { method: "GET", headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new XAuthError("users/me", res.status);
  const data = ((await res.json().catch(() => null)) as { data?: { id?: unknown; username?: unknown } } | null)?.data;
  if (typeof data?.id !== "string" || typeof data.username !== "string" || !/^\d+$/.test(data.id) || !/^\w{1,15}$/.test(data.username)) {
    throw new XAuthError("users/me", res.status, "bad_user");
  }
  return { userId: data.id, username: data.username };
}

/** The X adapter for one app (client id + secret). `now` for tests. */
export function makeXAdapter(client: () => XClient | null, now: () => number = Date.now): OAuthAdapter {
  const need = (): XClient => {
    const c = client();
    if (!c) throw new XAuthError("setup", 0, "missing_client");
    return c;
  };
  const tokenCall = async (fetchFn: FetchFn, step: string, form: Record<string, string>): Promise<RefreshResult> => {
    const c = need();
    const res = await fetchFn(X_TOKEN_URL, {
      method: "POST",
      headers: { Authorization: basicAuth(c), "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...form, client_id: c.clientId }).toString(),
    });
    if (!res.ok) throw new XAuthError(step, res.status, await errorCode(res));
    return parseTokenResponse(await res.json().catch(() => null), now());
  };
  return {
    platform: "x",
    scopes: X_SCOPES,
    usesPkce: true,
    authorizeUrl(state, redirectUri, codeChallenge) {
      if (!codeChallenge) throw new Error("X needs a PKCE code challenge.");
      const q = new URLSearchParams({
        response_type: "code",
        client_id: need().clientId,
        redirect_uri: redirectUri,
        scope: X_SCOPES.join(" "),
        state,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
      });
      return `${X_AUTHORIZE_URL}?${q.toString().replace(/\+/g, "%20")}`;
    },
    async exchangeCode(fetchFn, code, redirectUri, codeVerifier) {
      if (!codeVerifier) throw new Error("X needs the PKCE code verifier.");
      const tokens = await tokenCall(fetchFn, "token", { grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: codeVerifier });
      const me = await fetchMe(fetchFn, tokens.accessToken);
      return { ...tokens, ...me };
    },
    async refresh(fetchFn, tokens) {
      if (!tokens.refreshToken) throw new XAuthError("refresh", 0, "no_refresh_token");
      return tokenCall(fetchFn, "refresh", { grant_type: "refresh_token", refresh_token: tokens.refreshToken });
    },
  };
}

/** The adapter for this deployment (X_CLIENT_ID / X_CLIENT_SECRET read when used). */
export const xAdapter: OAuthAdapter = makeXAdapter(() => xClientFromEnv(process.env));

// ---------- state rules ----------

export type OAuthStateRow = { elderId: string; platform: string; codeVerifier?: string; returnTo?: string; createdAt: number; usedAt?: number };

export type StateError = "unknown_state" | "used_state" | "expired_state" | "wrong_platform" | "no_verifier";

/** May this callback use the state row? Single use, at most 15 minutes old, X, with a verifier. */
export function checkXState(row: OAuthStateRow | null, now: number): { ok: true } | { ok: false; error: StateError } {
  if (!row) return { ok: false, error: "unknown_state" };
  if (row.usedAt !== undefined) return { ok: false, error: "used_state" };
  if (row.platform !== "x") return { ok: false, error: "wrong_platform" };
  if (now - row.createdAt > STATE_MAX_AGE_MS || now < row.createdAt - 60_000) return { ok: false, error: "expired_state" };
  if (!row.codeVerifier) return { ok: false, error: "no_verifier" };
  return { ok: true };
}

// ---------- the callback ----------

export type CallbackDeps = {
  /** Mark the state used and return it (null if unknown). Single use even when it fails. */
  consumeState(state: string): Promise<{ ok: true; elderId: string; codeVerifier: string; returnTo?: string } | { ok: false; error: StateError }>;
  exchange(code: string, codeVerifier: string): Promise<ExchangeResult>;
  /** Encrypt + save his tokens. Throws on a missing key. */
  save(elderId: string, tokens: ExchangeResult): Promise<void>;
  siteUrl: string | undefined;
};

export type CallbackResult = { redirect: string } | { text: string; status: number };

/** Where to send him: the site (or the state's returnTo when it's on the same site) + one flag. */
export function callbackRedirect(siteUrl: string | undefined, returnTo: string | undefined, flag: { connected: "x" } | { connect_error: string }): CallbackResult {
  const base = siteUrl?.trim();
  if (!base) {
    return "connected" in flag
      ? { text: "Your X account is connected. You can close this page.", status: 200 }
      : { text: `X connect failed (${flag.connect_error}). Please try again from the sign-up page.`, status: 400 };
  }
  let url: URL;
  try {
    url = new URL(base);
    if (returnTo) {
      const back = new URL(returnTo, url);
      if (back.origin === url.origin) url = back; // never an open redirect
    }
  } catch {
    return { text: "Sign-up site URL is not set correctly.", status: 500 };
  }
  url.searchParams.delete("connected");
  url.searchParams.delete("connect_error");
  if ("connected" in flag) url.searchParams.set("connected", "x");
  else url.searchParams.set("connect_error", flag.connect_error);
  return { redirect: url.toString() };
}

/**
 * GET /oauth/x/callback?code&state (or ?error&state when he said no). Redirect flags carry
 * short codes only: no tokens, ids or X's text.
 */
export async function runXCallback(deps: CallbackDeps, query: URLSearchParams): Promise<CallbackResult> {
  const state = query.get("state") ?? "";
  const code = query.get("code") ?? "";
  const denied = query.get("error");
  if (!state || state.length > 500) return callbackRedirect(deps.siteUrl, undefined, { connect_error: "bad_request" });
  const used = await deps.consumeState(state);
  if (!used.ok) return callbackRedirect(deps.siteUrl, undefined, { connect_error: used.error });
  if (denied) return callbackRedirect(deps.siteUrl, used.returnTo, { connect_error: denied === "access_denied" ? "denied" : "x_error" });
  if (!code) return callbackRedirect(deps.siteUrl, used.returnTo, { connect_error: "bad_request" });

  let tokens: ExchangeResult;
  try {
    tokens = await deps.exchange(code, used.codeVerifier);
  } catch (error) {
    const setup = error instanceof XAuthError && error.code === "missing_client";
    return callbackRedirect(deps.siteUrl, used.returnTo, { connect_error: setup ? "server_config" : "token_exchange" });
  }
  if (tokens.scopes && !tokens.scopes.includes("tweet.write")) {
    return callbackRedirect(deps.siteUrl, used.returnTo, { connect_error: "missing_scope" });
  }
  try {
    await deps.save(used.elderId, tokens);
  } catch {
    return callbackRedirect(deps.siteUrl, used.returnTo, { connect_error: "server_config" });
  }
  return callbackRedirect(deps.siteUrl, used.returnTo, { connected: "x" });
}

// ---------- the sealed token JSON (elderAccounts.secret) ----------

export type XTokens = { accessToken: string; refreshToken?: string };

export function tokensToJson(t: XTokens): string {
  return JSON.stringify({ accessToken: t.accessToken, ...(t.refreshToken ? { refreshToken: t.refreshToken } : {}) });
}

/** Null when it isn't our token JSON. */
export function tokensFromJson(text: string): XTokens | null {
  try {
    const t = JSON.parse(text) as { accessToken?: unknown; refreshToken?: unknown };
    if (typeof t.accessToken !== "string" || !t.accessToken) return null;
    return { accessToken: t.accessToken, ...(typeof t.refreshToken === "string" && t.refreshToken ? { refreshToken: t.refreshToken } : {}) };
  } catch {
    return null;
  }
}
