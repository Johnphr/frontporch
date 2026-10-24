// Onboarding slice: pure logic (no Convex), unit-tested in tests/onboarding.test.ts.
//
// Progressive by design: he gets onboarding calls until his profile is usable,
// then story calls (slice 2) that build on everything learned so far.

import { templateVariables } from "./cartesia.ts";

export type Profile = {
  industry?: string;
  specialty?: string;
  careerSummary?: string;
  topics?: string[];        // also feeds apify deriveKeywords (audience questions)
  storySeeds?: string[];    // stories he hinted at, for later calls
  topicsToAvoid?: string[];
};

export type CallPlan = { kind: "onboarding" } | { kind: "story" };

/** A queued / in_progress call younger than this blocks a new one (no double ringing). */
export const OPEN_CALL_WINDOW_MS = 60 * 60_000;
/** A processing claim older than this is assumed crashed and can be retaken. */
export const STALE_PROCESSING_MS = 15 * 60_000;

const LIMITS = {
  scalar: 200,
  careerSummary: 1200,
  item: 200,
  topics: 8,
  storySeeds: 12,
  topicsToAvoid: 10,
} as const;

const LIST_KEYS = ["topics", "storySeeds", "topicsToAvoid"] as const;

export function isProfileUsable(profile: Profile | undefined): boolean {
  return Boolean(profile?.industry || profile?.specialty);
}

export function planNextCall(elder: { stage?: string; profile?: Profile }): CallPlan {
  return elder.stage === "active" && isProfileUsable(elder.profile) ? { kind: "story" } : { kind: "onboarding" };
}

export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || "friend";
}

export function buildOnboardingVariables(elder: { name: string }, knownBackground: string | undefined) {
  return templateVariables({
    first_name: firstName(elder.name),
    known_background: knownBackground ?? "",
  });
}

function cleanString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim().slice(0, max);
  return text || undefined;
}

function cleanList(value: unknown, maxItems: number): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const text = cleanString(item, LIMITS.item);
    if (!text || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    out.push(text);
    if (out.length >= maxItems) break;
  }
  return out.length ? out : undefined;
}

function compact(profile: Profile): Profile {
  const out: Profile = {};
  for (const [key, value] of Object.entries(profile)) {
    if (value !== undefined) (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

/** Claude's output (or anything else) -> a profile with only valid, bounded fields. */
export function normalizeProfile(raw: unknown): Profile {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>;
  return compact({
    industry: cleanString(r.industry, LIMITS.scalar),
    specialty: cleanString(r.specialty, LIMITS.scalar),
    careerSummary: cleanString(r.careerSummary, LIMITS.careerSummary),
    topics: cleanList(r.topics, LIMITS.topics),
    storySeeds: cleanList(r.storySeeds, LIMITS.storySeeds),
    topicsToAvoid: cleanList(r.topicsToAvoid, LIMITS.topicsToAvoid),
  });
}

/** Re-onboarding never loses what an earlier call learned: new scalars win, lists are unioned. */
export function mergeProfile(old: Profile | undefined, next: Profile): Profile {
  const base = old ?? {};
  const merged: Profile = {
    industry: next.industry ?? base.industry,
    specialty: next.specialty ?? base.specialty,
    careerSummary: next.careerSummary ?? base.careerSummary,
  };
  for (const key of LIST_KEYS) {
    merged[key] = cleanList([...(base[key] ?? []), ...(next[key] ?? [])], LIMITS[key]);
  }
  return compact(merged);
}

export function canClaimProcessing(
  call: { processingAt?: number; processedAt?: number },
  now: number,
): { ok: true } | { ok: false; reason: string } {
  if (call.processedAt) return { ok: false, reason: "Call already processed" };
  if (call.processingAt && now - call.processingAt < STALE_PROCESSING_MS) {
    return { ok: false, reason: "Call is being processed" };
  }
  return { ok: true };
}

export function hasOpenCall(calls: { status: string; _creationTime: number }[], now: number): boolean {
  return calls.some(
    (c) => (c.status === "queued" || c.status === "in_progress") && now - c._creationTime < OPEN_CALL_WINDOW_MS,
  );
}
