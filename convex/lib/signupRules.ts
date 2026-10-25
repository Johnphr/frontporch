// Sign-up page rules (signup.ts): input checks, language codes, and the call rate limit.
// No runtime imports: unit-tested directly with Node (tests/signup.test.ts).

import type { CallLanguage } from "./prompts/principles.ts";

export const MAX_NAME_CHARS = 100;
export const CALLS_PER_DAY = 3;
export const CALL_COOLDOWN_MS = 10 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

/** E.164, e.g. +14155550123 (also used by elders.seed). */
export function isE164(phone: string): boolean {
  return /^\+[1-9]\d{6,14}$/.test(phone);
}

/** "+1 (415) 555-0123" -> "+14155550123"; undefined if it isn't E.164 once tidied. */
export function normalizePhone(raw: string): string | undefined {
  const phone = raw.replace(/[\s().-]/g, "");
  return isE164(phone) ? phone : undefined;
}

/** Trimmed, single-spaced name; undefined if empty or longer than MAX_NAME_CHARS. */
export function normalizeName(raw: string): string | undefined {
  const name = raw.replace(/\s+/g, " ").trim();
  return name && name.length <= MAX_NAME_CHARS ? name : undefined;
}

/** Sign-up language -> elders.language (BCP-47; lib/onboarding.callLanguage reads it back). */
export function languageTag(lang: CallLanguage): string {
  return lang === "es" ? "es-MX" : "en-US";
}

/**
 * A LinkedIn profile URL -> https://www.linkedin.com/in/<id>, or undefined if it isn't one.
 * Accepts no scheme, country hosts (de.linkedin.com), query strings and extra path parts.
 */
export function canonicalLinkedInProfileUrl(raw: string): string | undefined {
  const text = raw.trim();
  if (!text || text.length > 300) return undefined;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  if (!/^(?:(?:www|[a-z]{2,3})\.)?linkedin\.com$/i.test(url.hostname)) return undefined;
  const match = /^\/in\/([A-Za-z0-9_%-]{2,100})(?:\/|$)/.exec(url.pathname);
  return match ? `https://www.linkedin.com/in/${match[1]}` : undefined;
}

/**
 * May the sign-up page start a call for him now? `callTimes` = _creationTime of his calls rows
 * (any status: a failed or unanswered call still counts). At most CALLS_PER_DAY in the last
 * 24h, and none in the last CALL_COOLDOWN_MS.
 */
export function callRateLimit(
  callTimes: number[],
  now: number,
): { ok: true } | { ok: false; message: string } {
  if (callTimes.some((t) => now - t < CALL_COOLDOWN_MS)) {
    return { ok: false, message: "A call was just requested. Please wait 10 minutes." };
  }
  if (callTimes.filter((t) => now - t < DAY_MS).length >= CALLS_PER_DAY) {
    return { ok: false, message: "That's the most calls for today. Please try again tomorrow." };
  }
  return { ok: true };
}

/**
 * PUBLIC_CALLS gate. "on" = only numbers in CALL_ALLOWLIST (comma-separated E.164) may be
 * called from the sign-up page; "all" = anyone (still rate limited); anything else = off.
 * Exists because the SMS check is fake: without it, anyone could make Pip ring any number.
 */
export function publicCallAllowed(mode: string | undefined, allowlist: string | undefined, phone: string): boolean {
  if (mode === "all") return true;
  if (mode !== "on") return false;
  const allowed = (allowlist ?? "").split(",").map((p) => normalizePhone(p)).filter(Boolean);
  return allowed.includes(phone);
}

// ---------- Connect Bluesky (signup.connectBluesky) ----------

export const CONNECT_ATTEMPTS_PER_HOUR = 5;
export const CONNECT_COOLDOWN_MS = 5_000;
const HOUR_MS = 60 * 60_000;

/**
 * "@Walter", "walter.bsky.social", "bsky.app/profile/walter.bsky.social" -> "walter.bsky.social".
 * No dot means a bsky.social handle. Undefined if it isn't a valid handle once tidied.
 */
export function normalizeBlueskyHandle(raw: string): string | undefined {
  let text = raw.trim().toLowerCase();
  if (!text || text.length > 300) return undefined;
  text = text.replace(/^(?:https?:\/\/)?(?:www\.)?bsky\.app\/profile\//, "").replace(/\/.*$/, "");
  text = text.replace(/^@/, "").replace(/\.$/, "");
  if (!text) return undefined;
  if (!text.includes(".")) text = `${text}.bsky.social`;
  return isBlueskyHandle(text) ? text : undefined;
}

/** atproto handle syntax: dot-separated labels (letters, digits, inner hyphens), at least two, TLD not starting with a digit. */
export function isBlueskyHandle(handle: string): boolean {
  if (handle.length > 253) return false;
  const labels = handle.split(".");
  if (labels.length < 2) return false;
  if (!labels.every((l) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l))) return false;
  return /^[a-z]/.test(labels[labels.length - 1]);
}

/**
 * A Bluesky app password ("abcd-efgh-ijkl-mnop") tidied, or undefined. We only take app
 * passwords: his real password could change or delete his account; an app password can't,
 * and he can revoke it any time in Bluesky settings.
 */
export function normalizeAppPassword(raw: string): string | undefined {
  const text = raw.replace(/\s+/g, "").toLowerCase();
  return /^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/.test(text) ? text : undefined;
}

/**
 * May he try connecting again now? `attemptTimes` = his recent connect attempts (any result).
 * At most CONNECT_ATTEMPTS_PER_HOUR in the last hour, none in the last CONNECT_COOLDOWN_MS.
 */
export function connectRateLimit(attemptTimes: number[], now: number): { ok: true } | { ok: false } {
  if (attemptTimes.some((t) => now - t < CONNECT_COOLDOWN_MS)) return { ok: false };
  if (attemptTimes.filter((t) => now - t < HOUR_MS).length >= CONNECT_ATTEMPTS_PER_HOUR) return { ok: false };
  return { ok: true };
}

/** The attempt list to store after one more attempt: only the ones the limit still looks at. */
export function recordAttempt(attemptTimes: number[], now: number): number[] {
  return [...attemptTimes.filter((t) => now - t < HOUR_MS), now].slice(-CONNECT_ATTEMPTS_PER_HOUR);
}
