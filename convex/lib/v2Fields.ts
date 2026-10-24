// ONE place for the v2 fields that feat/memory-data adds to `elders` and `calls`
// (stage, profile, knownBackground, kind, vapiCallId, summary, plan, endedReason).
// They aren't in this branch's schema yet, so we read them defensively and write
// them through two loosely typed helpers.
//
// TODO after feat/memory-data merges: delete the casts here and use the real
// schema types (Doc<"elders">, Doc<"calls">) and ctx.db.patch / insert directly.
// No runtime imports (unit-testable).

import type { ElderProfile } from "./planner.ts";

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
  const profile: ElderProfile = {
    industry: str(p.industry) ?? "",
    specialty: str(p.specialty) ?? "",
    careerSummary: str(p.careerSummary) ?? "",
    topicsToAvoid: Array.isArray(p.topicsToAvoid) ? p.topicsToAvoid.filter((t): t is string => typeof t === "string") : [],
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

/** Onboarding until the profile exists (or stage says so explicitly). */
export function isOnboarding(elder: ElderV2): boolean {
  if (elder.stage) return elder.stage === "onboarding";
  return !elder.profile;
}

/** A db that can patch / insert any row (structurally matches Convex's ctx.db). */
type LooseDb = {
  patch: (id: never, value: never) => Promise<void>;
  insert: (table: never, value: never) => Promise<unknown>;
};

/** Patch v2 fields onto a row. Remove once the schema has them (see TODO above). */
export async function patchLoose(db: LooseDb, id: string, fields: Record<string, unknown>): Promise<void> {
  const clean = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
  await db.patch(id as never, clean as never);
}

/** Insert a row that includes v2 fields. Remove once the schema has them. */
export async function insertLoose(db: LooseDb, table: string, fields: Record<string, unknown>): Promise<string> {
  const clean = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
  return String(await db.insert(table as never, clean as never));
}
