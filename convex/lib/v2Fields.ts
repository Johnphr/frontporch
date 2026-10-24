// Normalizes an elders row for the planner: trims strings, validates the
// profile shape and works out the call stage, so v1 rows (no v2 fields) and
// half-filled rows behave predictably. Only imports pure lib files (unit-testable).

import { isUsableProfile, type ElderProfile } from "./planner.ts";

export type ElderV2 = {
  _id: string;
  name: string;
  language?: string;
  stage?: "onboarding" | "active";
  profile?: ElderProfile;
  knownBackground?: string;
  linkedinUrl?: string;
};

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function asProfile(value: unknown): ElderProfile | undefined {
  if (!value || typeof value !== "object") return undefined;
  const p = value as Record<string, unknown>;
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((t): t is string => typeof t === "string" && t.trim() !== "") : [];
  const profile: ElderProfile = {
    industry: str(p.industry) ?? "",
    specialty: str(p.specialty) ?? "",
    careerSummary: str(p.careerSummary) ?? "",
    topics: strings(p.topics),
    storySeeds: strings(p.storySeeds),
    topicsToAvoid: strings(p.topicsToAvoid),
  };
  return profile.industry || profile.specialty || profile.careerSummary ? profile : undefined;
}

/** Read an elders row (v1 or v2 shape) without trusting the v2 fields to exist. */
export function asElderV2(doc: unknown): ElderV2 | null {
  if (!doc || typeof doc !== "object") return null;
  const d = doc as Record<string, unknown>;
  const stage = d.stage === "onboarding" || d.stage === "active" ? d.stage : undefined;
  return {
    _id: String(d._id),
    name: str(d.name) ?? "",
    ...(str(d.language) ? { language: str(d.language) } : {}),
    ...(stage ? { stage } : {}),
    ...(asProfile(d.profile) ? { profile: asProfile(d.profile) } : {}),
    ...(str(d.knownBackground) ? { knownBackground: str(d.knownBackground) } : {}),
    ...(str(d.linkedinUrl) ? { linkedinUrl: str(d.linkedinUrl) } : {}),
  };
}

/** Onboarding until the profile is usable (or stage says so explicitly). */
export function isOnboarding(elder: ElderV2): boolean {
  if (elder.stage) return elder.stage === "onboarding";
  return !isUsableProfile(elder.profile);
}
