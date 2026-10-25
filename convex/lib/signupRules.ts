// Sign-up page rules (signup.ts, account.ts): input checks, language codes, the weekly call slot,
// the call and connect rate limits, weekly-call defaults and the sign-up token.
// No runtime imports: unit-tested directly with Node (tests/signup.test.ts).

import type { CallLanguage } from "./prompts/principles.ts";
import { WEEKDAYS, localParts, normalizeDay, type Weekday } from "./schedule.ts";

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

export type WeeklySlot = { callDay: Weekday; callHour: number; timezone: string };

/**
 * His weekly call slot from the web (same rules as elders.seed), or undefined if any part is off:
 * a weekday name, a whole hour 0-23, and an IANA timezone Intl knows.
 */
export function normalizeSchedule(day: string, hour: number, timezone: string): WeeklySlot | undefined {
  const callDay = normalizeDay(day);
  if (!callDay || !Number.isInteger(hour) || hour < 0 || hour > 23) return undefined;
  const tz = timezone.trim();
  if (!tz) return undefined;
  try {
    localParts(Date.now(), tz);
  } catch {
    return undefined;
  }
  return { callDay, callHour: hour, timezone: tz };
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

export const CONNECT_ATTEMPTS_PER_HOUR = 5; // per sign-up
export const HANDLE_CONNECTS_PER_HOUR = 5; // per Bluesky handle, across sign-ups
export const GLOBAL_CONNECTS_PER_HOUR = 60; // all sign-ups together
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
export function recordAttempt(attemptTimes: number[], now: number, max = CONNECT_ATTEMPTS_PER_HOUR): number[] {
  return [...attemptTimes.filter((t) => now - t < HOUR_MS), now].slice(-max);
}

/**
 * Caps on Bluesky logins through our server. register makes sign-ups freely, so the
 * per-sign-up limit alone doesn't stop guessing one handle's password from many sign-ups.
 * At most HANDLE_CONNECTS_PER_HOUR tries per handle, GLOBAL_CONNECTS_PER_HOUR in all.
 */
export function connectCaps(
  times: { handle: number[]; global: number[] },
  now: number,
): { ok: true } | { ok: false; error: "rate_limited" | "busy" } {
  const lastHour = (list: number[]) => list.filter((t) => now - t < HOUR_MS).length;
  if (lastHour(times.handle) >= HANDLE_CONNECTS_PER_HOUR) return { ok: false, error: "rate_limited" };
  if (lastHour(times.global) >= GLOBAL_CONNECTS_PER_HOUR) return { ok: false, error: "busy" };
  return { ok: true };
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
 * May the website (re)connect this platform for him? Before he's active: always. Once he's
 * active: only to replace an account that's missing, `invalid` (the platform refused it) or
 * `disconnected`; a connected account stays locked. Checked at reserve and again at save.
 */
export function connectLocked(stage: string | undefined, accountStatus: string | undefined): boolean {
  return stage === "active" && accountStatus === "connected";
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
  familyCodeHash?: string,
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
    ...(familyCodeHash ? { familyCodeHash } : {}),
  };
}

// ---------- Family code (signup.signIn, signup.startOver) ----------
// register also hands out a 6-digit family code, once; only its SHA-256 hash is stored
// (elders.familyCodeHash). Phone + code signs him in from any browser: signIn mints a new token
// (the old device's stops working). Wrong code and unknown phone both read as wrong_code, and
// tries are counted per phone (connectAttempts "signin:<phone>") whether or not it's signed up.
// Never logged.

export const FAMILY_CODE_DIGITS = 6;
export const SIGNIN_TRIES = 5; // wrong codes per phone...
export const SIGNIN_WINDOW_MS = 15 * 60_000; // ...in this window

/** A random 6-digit code as a string ("048213" keeps its leading zero). Make it in an action. */
export function newFamilyCode(): string {
  const max = 10 ** FAMILY_CODE_DIGITS;
  // Reject values past the largest multiple of `max`, so every code is equally likely.
  const limit = Math.floor(2 ** 32 / max) * max;
  for (;;) {
    const [n] = crypto.getRandomValues(new Uint32Array(1));
    if (n < limit) return String(n % max).padStart(FAMILY_CODE_DIGITS, "0");
  }
}

/** "482 917", "482-917" -> "482917"; undefined unless it's exactly 6 digits once tidied. */
export function normalizeFamilyCode(raw: string): string | undefined {
  const code = raw.replace(/[\s-]/g, "");
  return new RegExp(`^\\d{${FAMILY_CODE_DIGITS}}$`).test(code) ? code : undefined;
}

/** Hex SHA-256 of a well-formed code; undefined for anything else (so it never matches). */
export async function familyCodeHash(raw: string): Promise<string | undefined> {
  const code = normalizeFamilyCode(raw);
  if (!code) return undefined;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`family-code:${code}`));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export type SignInRefusal = "wrong_code" | "too_many_tries";

/** May this phone try a code now? `attemptTimes` = its recent wrong codes. */
export function signInRateLimit(attemptTimes: number[], now: number): { ok: true } | { ok: false; reason: "too_many_tries" } {
  return attemptTimes.filter((t) => now - t < SIGNIN_WINDOW_MS).length >= SIGNIN_TRIES ? { ok: false, reason: "too_many_tries" } : { ok: true };
}

/** The wrong-code list to store after one more: only the ones the limit still looks at. */
export function recordSignInAttempt(attemptTimes: number[], now: number): number[] {
  return [...attemptTimes.filter((t) => now - t < SIGNIN_WINDOW_MS), now].slice(-SIGNIN_TRIES);
}

/**
 * signIn / startOver's decision for a phone: the rate limit first (so a locked-out phone learns
 * nothing), then his row must exist, be live (not archived), have a code, and match it in
 * constant time. A missing row and a wrong code are the same answer.
 */
export function signInDecision(
  elder: { stage?: string; familyCodeHash?: string } | null,
  codeHash: string | undefined,
  attemptTimes: number[],
  now: number,
): { ok: true } | { ok: false; reason: SignInRefusal } {
  const limit = signInRateLimit(attemptTimes, now);
  if (!limit.ok) return limit;
  if (!elder || elder.stage === "archived" || !sameTokenHash(elder.familyCodeHash, codeHash)) return { ok: false, reason: "wrong_code" };
  return { ok: true };
}

/** The phone an archived row keeps: out of register's way (by_phone), but still readable. */
export function archivedPhone(phone: string, now: number): string {
  return `archived:${now}:${phone}`;
}

/**
 * startOver's patch for his row: archived, the number freed, and both secrets dropped so no old
 * token or code can read or change it. Posts and calls stay as history.
 */
export function archiveFields(phone: string, now: number) {
  return { stage: "archived" as const, phone: archivedPhone(phone, now), signupTokenHash: undefined, familyCodeHash: undefined };
}
