// OAuth platforms he connects with a "Connect" button (Threads now, X later): one adapter per
// platform, built from env, plus the registry. Pure HTTP with an injected fetch
// (tests/oauth.test.ts drives it with fakes). Errors carry steps and HTTP statuses only,
// never a token, a code or the app secret.
//
// Threads (Meta docs, developers.facebook.com/documentation/threads):
//   authorize   https://threads.com/oauth/authorize?client_id&redirect_uri&scope(comma)&response_type=code&state
//   exchange    POST https://graph.threads.com/oauth/access_token -> { access_token, user_id } (short-lived)
//   long-lived  GET  https://graph.threads.com/access_token?grant_type=th_exchange_token -> { access_token, expires_in } (60 days)
//   refresh     GET  https://graph.threads.com/refresh_access_token?grant_type=th_refresh_token
//               (token at least 24 h old and not expired; restarts the 60 days)
//   profile     GET  https://graph.threads.com/v1.0/me?fields=id,username
// No PKCE on Threads. Env: THREADS_APP_ID, THREADS_APP_SECRET, THREADS_KEYWORD_SEARCH (adds the scope).

import type { FetchFn } from "./blueskyClient.ts";

export type OAuthPlatform = "threads" | "x";
export type OAuthEnv = Record<string, string | undefined>;

/** What we keep (encrypted) after a connect or a refresh. */
export type OAuthTokens = {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number; // epoch ms
  userId: string;
  username?: string;
  issuedAt?: number; // epoch ms; the refresh rule needs the token's age
};

export interface OAuthAdapter {
  platform: OAuthPlatform;
  scopes: string[];
  /** Where the "Connect" button sends him. */
  authorizeUrl(state: string, redirectUri: string, codeChallenge?: string): string;
  /** The ?code from the callback -> his tokens (long-lived on Threads) and who he is. */
  exchangeCode(fetchFn: FetchFn, code: string, redirectUri: string, codeVerifier?: string): Promise<OAuthTokens>;
  /** A fresh access token (same user). */
  refresh(fetchFn: FetchFn, tokens: OAuthTokens): Promise<OAuthTokens>;
}

/** A failed OAuth HTTP step. No token, code or secret in the message. */
export class OAuthHttpError extends Error {
  readonly step: string;
  readonly status: number; // 0 = no response (network, timeout)
  readonly errorType?: string;
  constructor(step: string, status: number, errorType?: string) {
    super(`${step} ${status ? `HTTP ${status}` : "network error"}${errorType ? ` (${errorType})` : ""}`);
    this.name = "OAuthHttpError";
    this.step = step;
    this.status = status;
    this.errorType = errorType;
  }
}

const isOn = (value: string | undefined) => ["on", "true", "1", "yes"].includes((value ?? "").trim().toLowerCase());

// ---------- Threads ----------

export const THREADS_AUTHORIZE_URL = "https://threads.com/oauth/authorize";
export const THREADS_GRAPH = "https://graph.threads.com";
export const THREADS_API = `${THREADS_GRAPH}/v1.0`;
export const THREADS_CALLBACK_PATH = "/oauth/threads/callback";

/** Post, chain replies under his own post, read replies, likes/reposts, delete (undo). */
export const THREADS_SCOPES = [
  "threads_basic",
  "threads_content_publish",
  "threads_manage_replies",
  "threads_read_replies",
  "threads_manage_insights",
  "threads_delete",
];
/** Only with THREADS_KEYWORD_SEARCH=on: needs Meta app review before it finds strangers' posts. */
export const THREADS_KEYWORD_SCOPE = "threads_keyword_search";

/** THREADS_KEYWORD_SEARCH: off unless "on". */
export function threadsKeywordSearchOn(env: OAuthEnv): boolean {
  return isOn(env.THREADS_KEYWORD_SEARCH);
}

export function threadsScopes(env: OAuthEnv): string[] {
  return threadsKeywordSearchOn(env) ? [...THREADS_SCOPES, THREADS_KEYWORD_SCOPE] : [...THREADS_SCOPES];
}

/** Meta appends "#_" to the redirect; it isn't part of the code. */
export function cleanAuthCode(code: string): string {
  return code.trim().replace(/#_?$/, "");
}

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);
const str = (x: unknown): string => (typeof x === "string" ? x : typeof x === "number" && Number.isFinite(x) ? String(x) : "");

/** Graph error type, e.g. "OAuthException" (short and safe), from either error shape Meta uses. */
function errorTypeOf(json: unknown): string | undefined {
  if (!isObj(json)) return undefined;
  const inner = isObj(json.error) ? json.error : json;
  const type = str(inner.type) || str(inner.error_type);
  return /^[A-Za-z_]{1,40}$/.test(type) ? type : undefined;
}

async function getJson(fetchFn: FetchFn, step: string, url: string, init?: Parameters<FetchFn>[1]): Promise<Obj> {
  let res: Awaited<ReturnType<FetchFn>>;
  try {
    res = await fetchFn(url, init);
  } catch {
    throw new OAuthHttpError(step, 0);
  }
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new OAuthHttpError(step, res.status, errorTypeOf(json));
  if (!isObj(json)) throw new OAuthHttpError(step, res.status, "bad_json");
  return json;
}

/** { access_token, expires_in (seconds) } -> token + expiry. */
export function parseLongLived(json: Obj, now: number): { accessToken: string; expiresAt: number } {
  const accessToken = str(json.access_token);
  const seconds = typeof json.expires_in === "number" && json.expires_in > 0 ? json.expires_in : 60 * 86_400;
  if (!accessToken) throw new OAuthHttpError("threads long-lived token", 200, "no_token");
  return { accessToken, expiresAt: now + seconds * 1000 };
}

export function threadsAuthorizeUrl(appId: string, scopes: string[], state: string, redirectUri: string): string {
  const q = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    scope: scopes.join(","),
    response_type: "code",
    state,
  });
  return `${THREADS_AUTHORIZE_URL}?${q.toString()}`;
}

/** The Threads adapter, or null when THREADS_APP_ID / THREADS_APP_SECRET aren't set. */
export function threadsAdapter(env: OAuthEnv, now: () => number = Date.now): OAuthAdapter | null {
  const appId = env.THREADS_APP_ID?.trim();
  const secret = env.THREADS_APP_SECRET?.trim();
  if (!appId || !secret) return null;
  const scopes = threadsScopes(env);
  return {
    platform: "threads",
    scopes,
    authorizeUrl: (state, redirectUri) => threadsAuthorizeUrl(appId, scopes, state, redirectUri),

    async exchangeCode(fetchFn, code, redirectUri) {
      // 1. code -> short-lived token + user id
      const short = await getJson(fetchFn, "threads code exchange", `${THREADS_GRAPH}/oauth/access_token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: appId,
          client_secret: secret,
          grant_type: "authorization_code",
          redirect_uri: redirectUri,
          code: cleanAuthCode(code),
        }).toString(),
      });
      const shortToken = str(short.access_token);
      // user_id can be a JSON number above 2^53 (precision lost in JSON.parse): only trust a
      // string or a safe integer here; /me's string id below wins anyway.
      const rawId = short.user_id;
      const exchangeId = typeof rawId === "string" ? rawId : Number.isSafeInteger(rawId) ? String(rawId) : "";
      if (!shortToken || rawId === undefined || rawId === null || rawId === "") throw new OAuthHttpError("threads code exchange", 200, "no_token");

      // 2. short-lived -> long-lived (60 days)
      const long = parseLongLived(
        await getJson(
          fetchFn,
          "threads long-lived token",
          `${THREADS_GRAPH}/access_token?${new URLSearchParams({ grant_type: "th_exchange_token", client_secret: secret, access_token: shortToken })}`,
        ),
        now(),
      );

      // 3. who he is: /me gives the id as a string (exact) and his username
      let username: string | undefined;
      let userId = exchangeId;
      try {
        const me = await getJson(fetchFn, "threads profile", `${THREADS_API}/me?${new URLSearchParams({ fields: "id,username", access_token: long.accessToken })}`);
        username = str(me.username) || undefined;
        if (typeof me.id === "string" && me.id) userId = me.id;
      } catch {
        username = undefined;
      }
      if (!userId) throw new OAuthHttpError("threads profile", 0, "no_user_id");
      return { ...long, userId, ...(username ? { username } : {}), issuedAt: now() };
    },

    async refresh(fetchFn, tokens) {
      const json = await getJson(
        fetchFn,
        "threads refresh",
        `${THREADS_GRAPH}/refresh_access_token?${new URLSearchParams({ grant_type: "th_refresh_token", access_token: tokens.accessToken })}`,
      );
      return { ...tokens, ...parseLongLived(json, now()), issuedAt: now() };
    },
  };
}

// ---------- refresh rule (Threads) ----------

export const REFRESH_WITHIN_MS = 7 * 86_400_000; // refresh when it expires in under 7 days
export const MIN_TOKEN_AGE_MS = 86_400_000; // Meta refuses tokens younger than 24 h

/** Refresh now? Only a live token, at least 24 h old, expiring within 7 days. */
export function shouldRefresh(t: { expiresAt: number; issuedAt?: number }, now: number): boolean {
  if (t.expiresAt <= now) return false; // expired: can't be refreshed, he must reconnect
  if (t.expiresAt - now >= REFRESH_WITHIN_MS) return false;
  return t.issuedAt === undefined || now - t.issuedAt >= MIN_TOKEN_AGE_MS;
}

// ---------- registry ----------

/** One builder per platform. X's adapter is added here at integration. */
export const OAUTH_ADAPTERS: Partial<Record<OAuthPlatform, (env: OAuthEnv, now?: () => number) => OAuthAdapter | null>> = {
  threads: threadsAdapter,
};

/** The adapter for this platform, or null if it isn't in the registry or isn't configured. */
export function oauthAdapter(platform: string, env: OAuthEnv, now?: () => number): OAuthAdapter | null {
  const build = OAUTH_ADAPTERS[platform as OAuthPlatform];
  return build ? build(env, now) : null;
}

export function callbackPath(platform: OAuthPlatform): string {
  return `/oauth/${platform}/callback`;
}

/** The exact redirect_uri for authorize AND exchange: <PLATFORM>_REDIRECT_URI, else CONVEX_SITE_URL + path. */
export function redirectUriFor(platform: OAuthPlatform, env: OAuthEnv): string | null {
  const explicit = env[`${platform.toUpperCase()}_REDIRECT_URI`]?.trim();
  if (explicit) return explicit;
  const site = env.CONVEX_SITE_URL?.trim().replace(/\/+$/, "");
  return site ? `${site}${callbackPath(platform)}` : null;
}
