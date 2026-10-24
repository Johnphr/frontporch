// Normalizes an elders row for the planner: trims strings and cleans the profile with
// PR #7's normalizeProfile, so v1 rows (no v2 fields) and half-filled rows behave
// predictably. The call kind comes from PR #7's lib/onboarding.planNextCall.
// Only imports pure lib files (unit-testable).

import { normalizeProfile, planNextCall, type Profile } from "./onboarding.ts";

export type ElderV2 = {
  _id: string;
  name: string;
  language?: string;
  stage?: "onboarding" | "active";
  profile?: Profile;
  knownBackground?: string;
  linkedinUrl?: string;
};

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** Read an elders row (v1 or v2 shape) without trusting the v2 fields to exist. */
export function asElderV2(doc: unknown): ElderV2 | null {
  if (!doc || typeof doc !== "object") return null;
  const d = doc as Record<string, unknown>;
  const stage = d.stage === "onboarding" || d.stage === "active" ? d.stage : undefined;
  const profile = normalizeProfile(d.profile);
  return {
    _id: String(d._id),
    name: str(d.name) ?? "",
    ...(str(d.language) ? { language: str(d.language) } : {}),
    ...(stage ? { stage } : {}),
    ...(Object.keys(profile).length ? { profile } : {}),
    ...(str(d.knownBackground) ? { knownBackground: str(d.knownBackground) } : {}),
    ...(str(d.linkedinUrl) ? { linkedinUrl: str(d.linkedinUrl) } : {}),
  };
}

/** Onboarding until PR #7's rule says story (stage "active" and a usable profile). */
export function isOnboarding(elder: ElderV2): boolean {
  return planNextCall(elder).kind === "onboarding";
}
