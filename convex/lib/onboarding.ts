// Onboarding slice: pure logic (no Convex), unit-tested in tests/onboarding.test.ts.
//
// Progressive by design: he gets onboarding calls until his profile is usable,
// then story calls (slice 2) that build on everything learned so far.

import { templateVariables } from "./cartesia.ts";
import { characterFor, type CharacterConfig } from "./characters.ts";
import { callContext, callGoal } from "./prompts/agent.ts";
import type { CallLanguage } from "./prompts/principles.ts";

export type Profile = {
  industry?: string;
  specialty?: string;
  careerSummary?: string;
  topics?: string[];        // also feeds apify deriveKeywords (audience questions)
  storySeeds?: string[];    // stories he hinted at, for later calls
  topicsToAvoid?: string[];
};

export type CallPlan = { kind: "onboarding" } | { kind: "story" };

/**
 * An open call younger than this blocks a new one (no double ringing). Longer than the whole
 * poll budget (~61 min), so a call still being polled always blocks.
 */
export const OPEN_CALL_WINDOW_MS = 90 * 60_000;
// queued / in_progress: in flight · start_unknown: the phone may have rung · ended: awaiting processing
const OPEN_STATUSES = new Set(["queued", "in_progress", "start_unknown", "ended"]);
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

/** His call language from elders.language (BCP-47): Spanish for any es*, else English. */
export function callLanguage(code: string | undefined): CallLanguage {
  return /^es(?:$|[-_])/i.test((code ?? "").trim()) ? "es" : "en";
}

/**
 * Who calls him: his chosen character, else the default for his language. The call runs in
 * the character's language (Cartesia sets it per agent), so use `.language` for the variables.
 */
export function callCharacter(elder: { characterId?: string; language?: string }): CharacterConfig {
  return characterFor(elder.characterId, callLanguage(elder.language));
}

export function firstName(name: string, lang: CallLanguage = "en"): string {
  return name.trim().split(/\s+/)[0] || (lang === "es" ? "amigo" : "friend");
}

export function buildOnboardingVariables(
  elder: { name: string },
  knownBackground: string | undefined,
  lang: CallLanguage = "en",
) {
  return templateVariables({
    first_name: firstName(elder.name, lang),
    goal: callGoal("onboarding", lang),
    // scraped text goes in a <background> tag; callContext keeps it from opening or closing one
    context: callContext({ background: knownBackground }),
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

/** The LLM's output (or anything else) -> a profile with only valid, bounded fields. */
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

/**
 * Re-onboarding never loses what an earlier call learned: new scalars win, lists are unioned
 * newest first, so a full list still takes in new items (the oldest drop off).
 */
export function mergeProfile(old: Profile | undefined, next: Profile): Profile {
  const base = old ?? {};
  const merged: Profile = {
    industry: next.industry ?? base.industry,
    specialty: next.specialty ?? base.specialty,
    careerSummary: next.careerSummary ?? base.careerSummary,
  };
  for (const key of LIST_KEYS) {
    merged[key] = cleanList([...(next[key] ?? []), ...(base[key] ?? [])], LIMITS[key]);
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
  return calls.some((c) => OPEN_STATUSES.has(c.status) && now - c._creationTime < OPEN_CALL_WINDOW_MS);
}

export type CallKind = CallPlan["kind"];

/**
 * reserveCall's decision, in one transaction with the insert. `expectedKind` is what startCall
 * planned for; if the elder's next call kind changed in between (e.g. onboarding just
 * finished), refuse instead of calling him with the wrong goal.
 */
export function reserveDecision(
  elder: { stage?: string; profile?: Profile },
  recentCalls: { status: string; _creationTime: number }[],
  now: number,
  opts: { force: boolean; expectedKind?: CallKind },
): { ok: true; kind: CallKind } | { ok: false; reason: string } {
  const kind = planNextCall(elder).kind;
  if (opts.expectedKind && opts.expectedKind !== kind) {
    return { ok: false, reason: `His next call is now ${kind}, not ${opts.expectedKind}; run startCall again` };
  }
  if (!opts.force && hasOpenCall(recentCalls, now)) {
    return { ok: false, reason: "A call to him is already open (pass force: true to call anyway)" };
  }
  return { ok: true, kind };
}

/**
 * calls patch when processing ends. Releases the claim; `processedAt` only when finished for
 * good. An error is written only when given, so Cartesia's own reason (e.g. busy) survives a
 * `no_conversation`; a successful `done` clears an earlier `process_failed` error.
 */
export function finishPatch(status: string, error: string | undefined, now: number): Record<string, unknown> {
  return {
    status,
    processingAt: undefined,
    ...(status !== "process_failed" ? { processedAt: now } : {}),
    ...(error !== undefined ? { error } : status === "done" ? { error: undefined } : {}),
  };
}
