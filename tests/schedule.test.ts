import assert from "node:assert/strict";
import { test } from "node:test";
import { PREPARE_CALL_FN, START_CALL_FN, dueActions, localParts, normalizeDay } from "../convex/lib/schedule.ts";

const LA = "America/Los_Angeles";
const at = (iso: string) => Date.parse(iso);
const base = { stage: "active", timezone: LA, callDay: "sunday", callHour: 10 };

test("localParts reads his local weekday, hour and date", () => {
  // 2026-10-25 17:00Z = Sunday 10:00 PDT
  assert.deepEqual(localParts(at("2026-10-25T17:00:00Z"), LA), { weekday: "sunday", hour: 10, dateKey: "2026-10-25" });
  // same instant in Tokyo is Monday 02:00
  assert.deepEqual(localParts(at("2026-10-25T17:00:00Z"), "Asia/Tokyo"), {
    weekday: "monday",
    hour: 2,
    dateKey: "2026-10-26",
  });
});

test("normalizeDay accepts full names and abbreviations", () => {
  assert.equal(normalizeDay("Sunday"), "sunday");
  assert.equal(normalizeDay(" sun "), "sunday");
  assert.equal(normalizeDay("Tues"), "tuesday");
  assert.equal(normalizeDay("su"), undefined);
  assert.equal(normalizeDay("domingo"), undefined);
  assert.equal(normalizeDay(undefined), undefined);
});

test("prepare one hour before, call at the call hour", () => {
  assert.deepEqual(dueActions(base, at("2026-10-25T16:00:00Z")), { prepare: { slot: "2026-10-25T10" } });
  assert.deepEqual(dueActions(base, at("2026-10-25T17:00:00Z")), { call: { slot: "2026-10-25T10" } });
  assert.deepEqual(dueActions(base, at("2026-10-25T18:00:00Z")), {});
  assert.deepEqual(dueActions(base, at("2026-10-24T17:00:00Z")), {}, "Saturday: nothing");
});

test("a slot already handled is not scheduled again (cron ran twice in the hour)", () => {
  const done = { ...base, lastPreparedSlot: "2026-10-25T10", lastCallSlot: "2026-10-25T10" };
  assert.deepEqual(dueActions(done, at("2026-10-25T16:00:00Z")), {});
  assert.deepEqual(dueActions(done, at("2026-10-25T17:30:00Z")), {});
  // next week's slot is new again
  assert.deepEqual(dueActions(done, at("2026-11-01T18:00:00Z")), { call: { slot: "2026-11-01T10" } });
});

test("midnight calls are prepared the evening before", () => {
  const midnight = { ...base, callHour: 0 };
  // Saturday 23:00 PDT = Sunday 06:00Z
  assert.deepEqual(dueActions(midnight, at("2026-10-25T06:00:00Z")), { prepare: { slot: "2026-10-25T00" } });
  assert.deepEqual(dueActions(midnight, at("2026-10-25T07:00:00Z")), { call: { slot: "2026-10-25T00" } });
});

test("DST fall-back: the repeated 1 a.m. hour calls only once", () => {
  // 2026-11-01: 01:00 PDT = 08:00Z, then 01:00 PST = 09:00Z
  const oneAm = { ...base, callHour: 1 };
  const first = dueActions(oneAm, at("2026-11-01T08:00:00Z"));
  assert.deepEqual(first.call, { slot: "2026-11-01T01" });
  const afterFirst = { ...oneAm, lastCallSlot: first.call!.slot, lastPreparedSlot: "2026-11-01T01" };
  assert.deepEqual(dueActions(afterFirst, at("2026-11-01T09:00:00Z")), {});
});

test("DST spring-forward: a 2 a.m. call that day doesn't exist and is skipped", () => {
  // 2026-03-08: 02:00 PST jumps to 03:00 PDT
  const twoAm = { ...base, callHour: 2 };
  for (let h = 0; h < 24; h++) {
    const now = at(`2026-03-08T${String(h).padStart(2, "0")}:00:00Z`);
    assert.equal(dueActions(twoAm, now).call, undefined, `no call at ${h}:00Z`);
  }
  // the following Sunday works normally: 02:00 PDT = 09:00Z
  assert.deepEqual(dueActions(twoAm, at("2026-03-15T09:00:00Z")).call, { slot: "2026-03-15T02" });
});

test("half-hour timezones: the hourly cron at :00 UTC still lands in his call hour", () => {
  // Monday 09:30 IST = 04:00Z
  const india = { stage: "active", timezone: "Asia/Kolkata", callDay: "monday", callHour: 9 };
  assert.deepEqual(dueActions(india, at("2026-10-26T03:00:00Z")), { prepare: { slot: "2026-10-26T09" } });
  assert.deepEqual(dueActions(india, at("2026-10-26T04:00:00Z")), { call: { slot: "2026-10-26T09" } });
});

test("skips elders that aren't set up or aren't in a calling stage", () => {
  const now = at("2026-10-25T17:00:00Z");
  assert.match(dueActions({ ...base, stage: undefined }, now).skipReason ?? "", /not onboarding or active/);
  assert.match(dueActions({ ...base, timezone: undefined }, now).skipReason ?? "", /not set/);
  assert.match(dueActions({ ...base, callDay: "someday" }, now).skipReason ?? "", /not set/);
  assert.match(dueActions({ ...base, callHour: 24 }, now).skipReason ?? "", /0-23/);
  assert.match(dueActions({ ...base, callHour: 9.5 }, now).skipReason ?? "", /0-23/);
  assert.match(dueActions({ ...base, timezone: "Mars/Olympus" }, now).skipReason ?? "", /bad timezone/);
  assert.deepEqual(dueActions({ ...base, stage: "onboarding" }, now), { call: { slot: "2026-10-25T10" } });
});

test("tick targets Cartesia for calls and the planner for prep", () => {
  assert.equal(START_CALL_FN, "cartesia:startCall");
  assert.equal(PREPARE_CALL_FN, "conversation:prepareCall");
});
