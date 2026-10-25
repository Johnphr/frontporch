// Sign-up page rules (signup.ts): input checks, language codes, the call and connect rate
// limits, weekly-call defaults and the sign-up token.
// No runtime imports: unit-tested directly with Node (tests/signup.test.ts).

import type { CallLanguage } from "./prompts/principles.ts";
import { WEEKDAYS, localParts, type Weekday } from "./schedule.ts";

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

// ---------- Weekly call defaults (register) ----------

export const DEFAULT_CALL_HOUR = 10;

/** Country code -> a zone when the browser didn't send a usable one. */
export function zoneFromPhone(phone: string): string {
  if (phone.startsWith("+52")) return "America/Mexico_City";
  if (phone.startsWith("+34")) return "Europe/Madrid";
  return "America/Los_Angeles";
}

/** A real IANA zone name (Intl knows it), e.g. "America/Mexico_City" or "UTC". */
export function isIanaZone(zone: string): boolean {
  if (!/^(?:UTC|[A-Za-z]+(?:\/[A-Za-z0-9_+-]+){1,2})$/.test(zone) || zone.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The browser's zone if it's real, else one from his phone's country. */
export function signupTimezone(raw: string | undefined, phone: string): string {
  const zone = (raw ?? "").trim();
  return zone && isIanaZone(zone) ? zone : zoneFromPhone(phone);
}

/**
 * Default weekly slot (lib/schedule.ts format): the day after sign-up in his zone, 10:00.
 * Tomorrow, so signing up at 9:55 never brings a surprise call five minutes later.
 */
export function defaultCallSlot(nowMs: number, timeZone: string): { callDay: Weekday; callHour: number } {
  const today = WEEKDAYS.indexOf(localParts(nowMs, timeZone).weekday);
  return { callDay: WEEKDAYS[(today + 1) % 7], callHour: DEFAULT_CALL_HOUR };
}

/**
 * May the hourly cron (schedule.runTick) ring him? A website sign-up (has signupTokenHash)
 * still in onboarding gets the same PUBLIC_CALLS gate as "Call me now": the SMS check is
 * fake, so anyone can type any number. Seeded or hand-made elders, and active ones, always may.
 */
export function cronMayCall(
  elder: { stage?: string; phone: string; signupTokenHash?: string },
  env: { PUBLIC_CALLS?: string; CALL_ALLOWLIST?: string },
): boolean {
  if (elder.stage !== "onboarding" || !elder.signupTokenHash) return true;
  return publicCallAllowed(env.PUBLIC_CALLS, env.CALL_ALLOWLIST, elder.phone);
}

// ---------- Sign-up token ----------
// register gives the browser a random token and keeps only its SHA-256 hash on his row. Every
// later sign-up step needs it, so knowing his phone number (or elderId) isn't enough to change
// his sign-up. Never logged.

/** 32 random bytes, base64url (43 chars). Make it in an action (real randomness). */
export function newSignupToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Hex SHA-256 of a well-formed token; undefined for anything else (so it never matches). */
export async function signupTokenHash(token: string): Promise<string | undefined> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time compare of two hashes (false if either is missing). */
export function sameTokenHash(stored: string | undefined, given: string | undefined): boolean {
  if (!stored || !given || stored.length !== given.length) return false;
  let diff = 0;
  for (let i = 0; i < stored.length; i++) diff |= stored.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

/** Does `token` belong to this elder row? */
export async function tokenMatches(row: { signupTokenHash?: string } | null, token: string): Promise<boolean> {
  return !!row && sameTokenHash(row.signupTokenHash, await signupTokenHash(token));
}

/** The new elders row register inserts (only ever for a new phone: existing rows are never changed). */
export function newElderFields(
  input: { name: string; phone: string; language: CallLanguage; timeZone?: string },
  nowMs: number,
  tokenHash: string,
) {
  const timezone = signupTimezone(input.timeZone, input.phone);
  return {
    name: input.name,
    phone: input.phone,
    language: languageTag(input.language),
    stage: "onboarding" as const,
    expertise: [] as string[], // v1 field, still required by the schema
    timezone,
    ...defaultCallSlot(nowMs, timezone),
    signupTokenHash: tokenHash,
  };
}
