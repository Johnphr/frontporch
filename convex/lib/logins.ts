// The ONE place that reads his Bluesky / Reddit login. Thread replies (convex/threadReplies.ts)
// and the Bluesky question search (convex/apify.ts) both go through these.
//
// Today: the demo account from Convex env. Next: each elder's own account from sign-up
// (internal.accounts.getBlueskyLogin / getRedditAuth); only these two functions change.
// Never log what they return.
//
// Env: BLUESKY_HANDLE, BLUESKY_APP_PASSWORD, BLUESKY_SERVICE (optional), REDDIT_POSTING,
//      REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, REDDIT_USERNAME, REDDIT_PASSWORD, REDDIT_USER_AGENT.

import { blueskyService } from "./blueskyClient.ts";

declare const process: { env: Record<string, string | undefined> };

export type Env = Record<string, string | undefined>;

export type BlueskyLogin = { service: string; identifier: string; password: string };

export type RedditLogin = {
  clientId: string;
  clientSecret: string;
  username: string;
  password: string;
  userAgent: string;
};

/** His Bluesky login, or null when it isn't set up. `elderId` is unused until per-elder accounts. */
export async function blueskyLoginForElder(_elderId: string | null, env: Env = process.env): Promise<BlueskyLogin | null> {
  const identifier = env.BLUESKY_HANDLE?.trim();
  const password = env.BLUESKY_APP_PASSWORD;
  if (!identifier || !password) return null;
  return { service: blueskyService(env.BLUESKY_SERVICE), identifier, password };
}

/**
 * His Reddit login, or null when it isn't set up OR posting is switched off (REDDIT_POSTING,
 * off by default while the Reddit API approval is pending).
 */
export async function redditLoginForElder(_elderId: string | null, env: Env = process.env): Promise<RedditLogin | null> {
  if (!["on", "true", "1", "yes"].includes((env.REDDIT_POSTING ?? "").trim().toLowerCase())) return null;
  const { REDDIT_CLIENT_ID: clientId, REDDIT_CLIENT_SECRET: clientSecret, REDDIT_USERNAME: username, REDDIT_PASSWORD: password } = env;
  if (!clientId || !clientSecret || !username || !password) return null;
  return { clientId, clientSecret, username, password, userAgent: env.REDDIT_USER_AGENT || `web:frontporch:v1 (by /u/${username})` };
}
