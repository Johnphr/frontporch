// Fast posts (FAST_POST=on) and the timing of the "call ended -> posted" path. Pure helpers,
// no Convex imports (tests/fastPost.test.ts).
//
//   FAST_POST=on   poll every 3 s (lib/cartesia.ts), one draft with no judge or rewrite
//                  (lib/postQuality.runFastPost), the fact-check with a short timeout
//                  (publish.ts). Off (default): poll every 15 s, the full quality loop.
//   Both modes     the post is written while the memories are saved (runStepGroups), and
//                  posts.timings records each stage (timingSummary, shown on /posts).

import type { Step, StepReport } from "./planner.ts";
import { isSwitchOn } from "./postFlow.ts";

export function fastPostOn(env: Record<string, string | undefined>): boolean {
  return isSwitchOn(env.FAST_POST);
}

/**
 * Groups run one after another; the steps inside a group run at the same time. Like
 * lib/planner.runSteps, a failing step never stops the others, and the reports come back in
 * the order the steps were given.
 */
export async function runStepGroups(groups: Step[][]): Promise<StepReport[]> {
  const reports: StepReport[] = [];
  for (const group of groups) {
    const done = await Promise.all(
      group.map(async (s): Promise<StepReport> => {
        if (s.skip) return { step: s.step, status: "skipped", detail: s.skip };
        try {
          const detail = await s.run();
          return { step: s.step, status: "ok", ...(detail ? { detail } : {}) };
        } catch (err) {
          return { step: s.step, status: "failed", detail: err instanceof Error ? err.message : String(err) };
        }
      }),
    );
    reports.push(...done);
  }
  return reports;
}

// ---------- timings (posts.timings, epoch ms) ----------

export type PostTimings = {
  endedAt?: number; // he hung up (Cartesia's end_time; else when we saw it)
  detectedAt?: number; // our poll saw the call was over
  writtenAt?: number; // the post was saved
  checkedAt?: number; // the fact-check answered
  postedAt?: number; // the first platform finished posting
};

/** posts.timings for a new post: from the call row (hungUpAt / endedAt) and now. */
export function initialTimings(call: { hungUpAt?: number; endedAt?: number } | null, now: number): PostTimings {
  const detectedAt = call?.endedAt;
  const endedAt = call?.hungUpAt ?? detectedAt;
  return { ...(endedAt !== undefined ? { endedAt } : {}), ...(detectedAt !== undefined ? { detectedAt } : {}), writtenAt: now };
}

const STAGES = [
  ["detect", "endedAt", "detectedAt"],
  ["write", "detectedAt", "writtenAt"],
  ["check", "writtenAt", "checkedAt"],
  ["post", "checkedAt", "postedAt"],
] as const;

const secs = (ms: number) => Math.round(ms / 100) / 10;

/**
 * Seconds per stage (only stages with both ends) and the total from hang-up to posted.
 * A held post has no postedAt, so no total.
 */
export function timingSummary(t: PostTimings | undefined): { stages: { stage: string; seconds: number }[]; totalSeconds?: number } {
  if (!t) return { stages: [] };
  const stages = STAGES.flatMap(([stage, from, to]) => {
    const a = t[from];
    const b = t[to];
    return a !== undefined && b !== undefined ? [{ stage, seconds: secs(b - a) }] : [];
  });
  const total = t.endedAt !== undefined && t.postedAt !== undefined ? { totalSeconds: secs(t.postedAt - t.endedAt) } : {};
  return { stages, ...total };
}

/** One log line, no text: "detect 2.1s, write 9.8s, check 5.2s, post 4s; 21.1s after hang-up". */
export function timingLine(t: PostTimings | undefined): string {
  const s = timingSummary(t);
  const parts = s.stages.map((x) => `${x.stage} ${x.seconds}s`).join(", ") || "no timings";
  return s.totalSeconds !== undefined ? `${parts}; ${s.totalSeconds}s after hang-up` : parts;
}
