// When is his weekly call? Pure time math for schedule.tick.
// No runtime imports: unit-tested directly with Node (`npm test`).
//
// Each elder has timezone (IANA, e.g. "America/Los_Angeles"), callDay ("sunday")
// and callHour (0-23, his local time). The hourly cron asks dueActions():
//   prepare  -> his call starts in about an hour   (conversation.prepareCall)
//   call     -> his call hour has started          (cartesia.startCall)
// Both return a "slot" key (his local date + hour of the call). schedule.ts stores
// the last slot handled, so a repeated hour (DST fall-back) or a second cron run in
// the same hour never schedules twice. A local hour that doesn't exist that day
// (DST spring-forward) is simply skipped that week.

export const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;

export type Weekday = (typeof WEEKDAYS)[number];

export type LocalParts = { weekday: Weekday; hour: number; dateKey: string };

export type SchedulableElder = {
  stage?: string;
  timezone?: string;
  callDay?: string;
  callHour?: number;
  lastPreparedSlot?: string;
  lastCallSlot?: string;
};

export type DueActions = {
  prepare?: { slot: string };
  call?: { slot: string };
  skipReason?: string;
};

const HOUR_MS = 60 * 60 * 1000;

/** "Sun", "sunday", "SUNDAY " -> "sunday"; anything else -> undefined. */
export function normalizeDay(day: string | undefined): Weekday | undefined {
  const d = (day ?? "").trim().toLowerCase();
  if (!d) return undefined;
  return WEEKDAYS.find((w) => w === d || (d.length >= 3 && w.startsWith(d)));
}

/** His local weekday, hour (0-23) and date at `nowMs`. Throws RangeError on a bad timezone. */
export function localParts(nowMs: number, timeZone: string): LocalParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(nowMs));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const weekday = normalizeDay(get("weekday"));
  if (!weekday) throw new RangeError(`Could not read weekday for ${timeZone}`);
  const hour = Number(get("hour")) % 24;
  return { weekday, hour, dateKey: `${get("year")}-${get("month")}-${get("day")}` };
}

export function slotKey(parts: LocalParts): string {
  return `${parts.dateKey}T${String(parts.hour).padStart(2, "0")}`;
}

function matches(parts: LocalParts, day: Weekday, hour: number): boolean {
  return parts.weekday === day && parts.hour === hour;
}

/** What the hourly cron should do for this elder right now. */
export function dueActions(elder: SchedulableElder, nowMs: number): DueActions {
  if (elder.stage !== "active" && elder.stage !== "onboarding") return { skipReason: "not onboarding or active" };
  const day = normalizeDay(elder.callDay);
  const hour = elder.callHour;
  if (!elder.timezone || !day || hour === undefined) return { skipReason: "timezone, callDay or callHour not set" };
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return { skipReason: `callHour must be 0-23, got ${hour}` };

  let now: LocalParts;
  let soon: LocalParts;
  try {
    now = localParts(nowMs, elder.timezone);
    soon = localParts(nowMs + HOUR_MS, elder.timezone);
  } catch {
    return { skipReason: `bad timezone: ${elder.timezone}` };
  }

  const out: DueActions = {};
  if (matches(now, day, hour)) {
    const slot = slotKey(now);
    if (elder.lastCallSlot !== slot) out.call = { slot };
  }
  if (matches(soon, day, hour)) {
    const slot = slotKey(soon);
    if (elder.lastPreparedSlot !== slot) out.prepare = { slot };
  }
  return out;
}

/** Functions tick schedules (referenced by name; see schedule.ts). */
export const PREPARE_CALL_FN = "conversation:prepareCall";
export const START_CALL_FN = "cartesia:startCall";
