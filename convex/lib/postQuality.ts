// Story post quality: the rubric, the pass bar, the code-side checks that need no AI, and the
// draft -> judge -> rewrite loop (runQualityLoop). The post is platform-neutral: a short story
// in paragraphs whose first line works as a post on its own, short enough to become a thread
// of at most 5 Bluesky posts (MAX_TOTAL_CHARS).
// llm.writePost writes 3 drafts (ANGLES), a judge scores each one against CRITERIA, the best
// goes through up to MAX_REWRITE_ROUNDS critique -> rewrite rounds, and a post that still
// doesn't clear the bar is held as `needs_review` (pipeline.ts) instead of auto-posting.
// No runtime imports: unit-tested directly with Node (tests/postQuality.test.ts).
//
// Tuning: change the weights, PASS_SCORE or MIN_CRITERION here and re-run `npm test`.

// ---------- rubric ----------

/** What the judge scores, 0-10 each. */
export const CRITERIA = ["hook", "story", "voice", "lesson", "question", "clarity"] as const;
export type Criterion = (typeof CRITERIA)[number];
export type CriterionScores = Record<Criterion, number>;

/** How much each criterion counts (sums to 1). The story and the hook matter most. */
export const WEIGHTS: CriterionScores = {
  hook: 0.22, // the first line works as a standalone opening post and makes you want to read on
  story: 0.24, // one concrete story with his specifics: names, places, numbers, what he did
  voice: 0.18, // sounds like him, his phrases, his register; not like an AI or a press release
  lesson: 0.14, // a clear takeaway, in his words where possible
  question: 0.1, // ends with one real question readers want to answer
  clarity: 0.12, // short paragraphs, plain words, no filler, no clichés
};

/** A post passes at this score (0-100) or above... */
export const PASS_SCORE = 75;
/** ...and only if no single criterion is below this (a great story can't hide a dead hook). */
export const MIN_CRITERION = 5;
/** Points taken off per minor code-side issue (major issues block a pass outright). */
export const MINOR_PENALTY = 5;
/** Critique -> rewrite rounds on the best draft, at most. */
export const MAX_REWRITE_ROUNDS = 2;

// Time: writePost runs inside pipeline.processCall, and Convex actions stop at 10 minutes
// (ACTION_LIMIT_MS). The memories step runs first (extractKnowledge: up to 2 x 120 s, plus
// embeddings), so the post step gets what's left: postBudgetMs() = the smaller of
// QUALITY_BUDGET_MS and (10 min - time already used - ACTION_SAFETY_MS for saving the post and
// scheduling the next steps). runQualityLoop never starts a model call past that deadline and
// caps each call's timeout to the time left. Worst case inside the budget: drafts (parallel)
// 75 s + judges (parallel) 45 s + 2 s + a 45 s judge retry = 167 s, then a rewrite round
// (75 s + 45 s) only if it fits. So processCall ends by about 10 min - ACTION_SAFETY_MS.
// With less than MIN_POST_BUDGET_MS left, the post step fails instead of starting
// (process_failed; a retry is safe, see pipeline.ts).
export const DRAFT_TIMEOUT_MS = 75_000;
export const JUDGE_TIMEOUT_MS = 45_000;
export const REWRITE_TIMEOUT_MS = 75_000;
/** A failed judge call is retried once, after this pause, if time allows. */
export const JUDGE_RETRY_DELAY_MS = 2_000;
export const ROUND_COST_MS = REWRITE_TIMEOUT_MS + JUDGE_TIMEOUT_MS;
export const QUALITY_BUDGET_MS = 240_000;
export const ACTION_LIMIT_MS = 600_000;
export const ACTION_SAFETY_MS = 60_000;
/** Enough for the drafts and one judge pass. */
export const MIN_POST_BUDGET_MS = DRAFT_TIMEOUT_MS + JUDGE_TIMEOUT_MS;
/** Don't start a model call with less time than this left. */
export const MIN_CALL_MS = 10_000;

/** Time the post step may use, given when processCall started. Under MIN_POST_BUDGET_MS = don't start. */
export function postBudgetMs(startedAt: number, now: number): number {
  return Math.max(0, Math.min(QUALITY_BUDGET_MS, ACTION_LIMIT_MS - (now - startedAt) - ACTION_SAFETY_MS));
}

/** One instruction per parallel draft, so the 3 drafts differ in approach, not just wording. */
export const ANGLES = [
  "Angle: the turning point. Build the post around the moment things changed in his story.",
  "Angle: the hard lesson. Build the post around what went wrong or was hard, and what he learned.",
  "Angle: the surprising detail. Open with the most unexpected concrete detail he gave, then tell the story.",
] as const;

// ---------- code-side checks ----------

export const MIN_WORDS = 120;
export const MAX_WORDS = 200;
/** Far outside the target length is a blocker, not just a penalty. */
export const HARD_MIN_WORDS = 90;
export const HARD_MAX_WORDS = 260;
/** The first line is the opening post of a thread: keep it well under one post (300). */
export const MAX_HOOK_CHARS = 200;
/**
 * Hard cap on the whole text, so it splits into at most 5 Bluesky posts of 300 graphemes
 * (room left for sentence breaks and the AI note in the last post). Counted in code points,
 * which is never fewer than graphemes.
 */
export const MAX_TOTAL_CHARS = 1_250;
export const MAX_HASHTAGS = 2;

/** AI tells and stock phrases (lowercase). Includes the ones POST_SYSTEM already forbids. */
export const BANNED_PHRASES = [
  "delve",
  "it's worth noting",
  "it is worth noting",
  "bottom line:",
  "this isn't about",
  "game-changer",
  "game changer",
  "in today's fast-paced",
  "tapestry",
  "a testament to",
  "navigate the complexities",
  "let that sink in",
  "here's the thing",
  "in conclusion",
  "unlock the power",
  "leverage synergies",
  "at the end of the day",
  "cabe destacar",
  "en conclusión",
  "sin lugar a dudas",
  "en el mundo actual",
  "vale la pena mencionar",
];

export type CheckIssue = { id: string; severity: "major" | "minor"; message: string };

export type Lang = "en" | "es" | "unknown";

const EN_WORDS = new Set(["the", "and", "was", "i", "my", "to", "of", "it", "that", "we", "he", "you", "with", "for", "is", "in"]);
const ES_WORDS = new Set(["el", "la", "que", "y", "de", "mi", "en", "los", "las", "una", "un", "con", "por", "es", "fue", "yo", "para", "se"]);

/** Rough language of a text from common words. "unknown" when it can't tell. */
export function detectLanguage(text: string): Lang {
  const words = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  let en = 0;
  let es = 0;
  for (const w of words) {
    if (EN_WORDS.has(w)) en++;
    if (ES_WORDS.has(w)) es++;
  }
  // "de", "en" overlap a little with English loanwords; ask for a clear margin.
  if (en + es < 6) return "unknown";
  if (es > en * 1.5) return "es";
  if (en > es * 1.5) return "en";
  return "unknown";
}

export function wordCount(text: string): number {
  return (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0]?.trim() ?? "";
}

function lastParagraph(text: string): string {
  const parts = text.trim().split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

/** A list number: 1-2 digits ("1. ", "12) "). A year ("1987. We opened...") is not one. */
const NUMBERED_LINE = /^\s*\d{1,2}[.)]\s/;

/**
 * Bold/underline markers, a heading, a bullet line ("- ", "* ", "• "), or a numbered list
 * (2+ lines starting with a list number). One line starting with a small number isn't a list.
 */
export function hasMarkdown(text: string): boolean {
  if (/\*\*|__|^#{1,6}\s/m.test(text)) return true;
  const lines = text.split("\n");
  if (lines.some((l) => /^\s*[-*•]\s/.test(l))) return true;
  return lines.filter((l) => NUMBERED_LINE.test(l)).length >= 2;
}

/**
 * Checks code can do without AI. `expectedLang` is the language he spoke on the call
 * (detectLanguage on his words); a mismatch only counts when both are clearly detected,
 * so a Spanish post is never penalized by English-only rules.
 */
export function hardChecks(text: string, expectedLang: Lang = "unknown"): CheckIssue[] {
  const issues: CheckIssue[] = [];
  const words = wordCount(text);
  if (words < HARD_MIN_WORDS || words > HARD_MAX_WORDS) {
    issues.push({ id: "length", severity: "major", message: `${words} words; aim for ${MIN_WORDS}-${MAX_WORDS}.` });
  } else if (words < MIN_WORDS || words > MAX_WORDS) {
    issues.push({ id: "length", severity: "minor", message: `${words} words; aim for ${MIN_WORDS}-${MAX_WORDS}.` });
  }
  const chars = Array.from(text.trim()).length;
  if (chars > MAX_TOTAL_CHARS) {
    issues.push({ id: "total_length", severity: "major", message: `${chars} characters; keep it under ${MAX_TOTAL_CHARS} so it fits a short thread.` });
  }
  const hook = firstLine(text);
  const hookChars = Array.from(hook).length;
  if (hookChars > MAX_HOOK_CHARS) {
    issues.push({
      id: "hook_length",
      severity: "minor",
      message: `The first line is ${hookChars} characters; keep it under ${MAX_HOOK_CHARS} so it works as the opening post.`,
    });
  }
  const hashtags = text.match(/(^|\s)#\p{L}[\p{L}\p{N}_]*/gu) ?? [];
  if (hashtags.length > MAX_HASHTAGS) {
    issues.push({ id: "hashtags", severity: "minor", message: `${hashtags.length} hashtags; use at most ${MAX_HASHTAGS}.` });
  }
  const lower = text.toLowerCase();
  const banned = BANNED_PHRASES.filter((p) => lower.includes(p));
  if (banned.length) {
    issues.push({ id: "stock_phrases", severity: "minor", message: `Stock or AI-sounding phrases: ${banned.map((b) => `"${b}"`).join(", ")}.` });
  }
  if (hasMarkdown(text)) {
    issues.push({ id: "markdown", severity: "minor", message: "Uses markdown, bullets or a numbered list; the post reads better as plain paragraphs." });
  }
  if (!/[?¿]/.test(lastParagraph(text))) {
    issues.push({ id: "no_question", severity: "minor", message: "Doesn't end with a question to readers." });
  }
  const postLang = detectLanguage(text);
  if (expectedLang !== "unknown" && postLang !== "unknown" && postLang !== expectedLang) {
    issues.push({
      id: "language",
      severity: "major",
      message: `Written in ${postLang === "es" ? "Spanish" : "English"}, but he spoke ${expectedLang === "es" ? "Spanish" : "English"} on the call.`,
    });
  }
  return issues;
}

// ---------- combining the judge and the checks ----------

export type Judgement = {
  scores: CriterionScores;
  /** Claims, names, numbers or lessons in the post that he never said. Any one = score 0. */
  unsupportedFacts: string[];
  /** Specific things to fix, for the rewrite. */
  notes: string[];
};

export type Evaluation = {
  score: number; // 0-100
  passed: boolean;
  scores: CriterionScores;
  /** Why it didn't pass (or what's left to polish), for the rewrite and for humans. */
  notes: string[];
};

function clampScore(n: unknown): number {
  const x = typeof n === "number" && Number.isFinite(n) ? n : 0;
  return Math.max(0, Math.min(10, x));
}

/** Judge output from the model -> a safe Judgement (missing scores count as 0). */
export function normalizeJudgement(raw: unknown): Judgement {
  const r = (raw ?? {}) as Record<string, unknown>;
  const s = (r.scores ?? {}) as Record<string, unknown>;
  const scores = Object.fromEntries(CRITERIA.map((c) => [c, clampScore(s[c])])) as CriterionScores;
  const list = (x: unknown) =>
    Array.isArray(x) ? x.filter((i): i is string => typeof i === "string" && i.trim() !== "").map((i) => i.trim()) : [];
  return { scores, unsupportedFacts: list(r.unsupportedFacts ?? r.unsupported_facts), notes: list(r.notes) };
}

const ZERO_SCORES = Object.fromEntries(CRITERIA.map((c) => [c, 0])) as CriterionScores;

/**
 * One draft's score: weighted judge scores (0-100) minus MINOR_PENALTY per minor issue.
 * Unsupported facts -> 0. A major issue, any criterion under MIN_CRITERION, or a missing
 * judgement (the judge failed) -> not passed.
 */
export function evaluate(judgement: Judgement | null, issues: CheckIssue[]): Evaluation {
  const issueNotes = issues.map((i) => i.message);
  if (!judgement) {
    return { score: 0, passed: false, scores: ZERO_SCORES, notes: ["The quality check couldn't run, so it can't post on its own.", ...issueNotes] };
  }
  if (judgement.unsupportedFacts.length) {
    return {
      score: 0,
      passed: false,
      scores: judgement.scores,
      notes: [...judgement.unsupportedFacts.map((f) => `Not something he said: ${f}`), ...judgement.notes, ...issueNotes],
    };
  }
  const weighted = CRITERIA.reduce((sum, c) => sum + judgement.scores[c] * WEIGHTS[c], 0) * 10;
  const minors = issues.filter((i) => i.severity === "minor").length;
  const score = Math.max(0, Math.round(weighted - minors * MINOR_PENALTY));
  const weak = CRITERIA.filter((c) => judgement.scores[c] < MIN_CRITERION);
  const major = issues.some((i) => i.severity === "major");
  const passed = score >= PASS_SCORE && weak.length === 0 && !major;
  const notes = [
    ...weak.map((c) => `Weak ${c} (${judgement.scores[c]}/10).`),
    ...judgement.notes,
    ...issueNotes,
  ];
  return { score, passed, scores: judgement.scores, notes };
}

export type Candidate = { index: number; text: string; hook: string; evaluation: Evaluation };

/** Best draft: passed first, then the higher score, then the earlier draft (stable on ties). */
export function pickBest(candidates: Candidate[]): Candidate | null {
  if (!candidates.length) return null;
  return [...candidates].sort(
    (a, b) =>
      Number(b.evaluation.passed) - Number(a.evaluation.passed) ||
      b.evaluation.score - a.evaluation.score ||
      a.index - b.index,
  )[0];
}

/**
 * After scoring the current best: stop when it passes, rewrite while rounds and time remain,
 * otherwise hold it for a person to review.
 */
export function nextStep(a: { passed: boolean; round: number; timeLeftMs: number; roundCostMs: number }): "done" | "rewrite" | "hold" {
  if (a.passed) return "done";
  if (a.round < MAX_REWRITE_ROUNDS && a.timeLeftMs >= a.roundCostMs) return "rewrite";
  return "hold";
}

/** A rewrite replaces the best only if it's better (passes, or scores higher). */
export function keepRewrite(current: Evaluation, rewritten: Evaluation): boolean {
  if (rewritten.passed !== current.passed) return rewritten.passed;
  return rewritten.score > current.score;
}

/**
 * What the drafts decide, out of the `intended` drafts (ANGLES.length), so failed draft calls
 * never count as a skip:
 *   skip   most of the intended drafts said there's nothing worth posting (no post)
 *   write  most of them produced a post
 *   fail   too many calls failed to tell (throw: the post step fails and can be retried)
 */
export function draftOutcome(skips: number, written: number, intended: number): "skip" | "write" | "fail" {
  if (skips * 2 > intended) return "skip";
  if (written * 2 > intended) return "write";
  return "fail";
}

// ---------- what writePost returns, and what the pipeline does with it ----------

export type QualityReport = {
  score: number;
  passed: boolean;
  rounds: number; // rewrite rounds run (0-MAX_REWRITE_ROUNDS)
  notes: string[];
  scores: CriterionScores;
};

/** Keep the stored notes short (they're shown on /posts and saved on the posts row). */
export function trimNotes(notes: string[], max = 8): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of notes) {
    const t = n.trim().slice(0, 300);
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

export function qualityReport(e: Evaluation, rounds: number): QualityReport {
  return { score: e.score, passed: e.passed, rounds, notes: trimNotes(e.notes), scores: e.scores };
}

// ---------- the loop (llm.writePost injects the model calls) ----------

export type DraftResult = { skip: true; reason: string } | { skip: false; text: string; hook: string };

export type WrittenPost =
  | { skip: true; reason: string }
  | { skip: false; text: string; hook: string; quality: QualityReport; hold: boolean };

export type QualityDeps = {
  /** One draft per angle. Throwing = a failed draft (never counted as a skip). */
  draft: (angle: string, timeoutMs: number) => Promise<DraftResult>;
  /** The judge's scores. Throwing = a failed judge call (retried once, then fail closed). */
  judge: (text: string, timeoutMs: number) => Promise<Judgement>;
  /** A revision of `text` using `notes`; a skip or a throw keeps the current best. */
  rewrite: (text: string, notes: string[], timeoutMs: number) => Promise<DraftResult>;
  /** Code-side checks (hardChecks with his language). */
  checks: (text: string) => CheckIssue[];
  /** Time the whole loop may take (postBudgetMs). */
  budgetMs: number;
  angles?: readonly string[];
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Drafts (parallel, one per angle) -> skip / write / fail (draftOutcome) -> judge each draft
 * (parallel; one retry; a judge that never answers fails closed) -> best draft -> critique ->
 * rewrite rounds while below the bar and a round fits in the time left. No model call starts
 * with under MIN_CALL_MS left, and each call's timeout is capped to the time left.
 * Throws (fixed messages, no model text) when the drafts can't decide.
 */
export async function runQualityLoop(deps: QualityDeps): Promise<WrittenPost> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const angles = deps.angles ?? ANGLES;
  const deadline = now() + deps.budgetMs;
  const left = () => deadline - now();

  if (left() < MIN_POST_BUDGET_MS) throw new Error("writePost: not enough time left for the post step");

  // 1. Drafts. Leave room for one judge pass after them.
  const draftTimeout = Math.min(DRAFT_TIMEOUT_MS, left() - JUDGE_TIMEOUT_MS);
  const settled = await Promise.allSettled(angles.map((a) => deps.draft(a, draftTimeout)));
  const drafts = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
  const skips = drafts.filter((d): d is Extract<DraftResult, { skip: true }> => d.skip);
  const written = drafts.filter((d): d is Extract<DraftResult, { skip: false }> => !d.skip && d.text.trim() !== "");
  const outcome = draftOutcome(skips.length, written.length, angles.length);
  if (outcome === "skip") return { skip: true, reason: skips[0].reason };
  if (outcome === "fail") throw new Error(`writePost: too many drafts failed (${settled.length - drafts.length} of ${angles.length})`);

  // 2. Judge + checks. One retry after a short pause, only if there's time; else fail closed.
  const judgeOnce = async (text: string): Promise<Judgement | null> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) {
        if (left() < JUDGE_RETRY_DELAY_MS + MIN_CALL_MS) break;
        await sleep(JUDGE_RETRY_DELAY_MS);
      }
      if (left() < MIN_CALL_MS) break;
      try {
        return await deps.judge(text, Math.min(JUDGE_TIMEOUT_MS, left()));
      } catch {
        // retry once, then null
      }
    }
    return null;
  };
  const score = async (text: string): Promise<Evaluation> => evaluate(await judgeOnce(text), deps.checks(text));

  const evaluations = await Promise.all(written.map((d) => score(d.text)));
  let best = pickBest(written.map((d, index) => ({ index, text: d.text, hook: d.hook, evaluation: evaluations[index] })));
  if (!best) throw new Error("writePost: no draft to judge");

  // 3. Critique -> rewrite on the best, while it's below the bar and a round fits.
  let rounds = 0;
  while (nextStep({ passed: best.evaluation.passed, round: rounds, timeLeftMs: left(), roundCostMs: ROUND_COST_MS }) === "rewrite") {
    rounds++;
    let revised: DraftResult;
    try {
      revised = await deps.rewrite(best.text, best.evaluation.notes, Math.min(REWRITE_TIMEOUT_MS, left() - JUDGE_TIMEOUT_MS));
    } catch {
      continue; // a failed round still counts; the best so far stays
    }
    if (revised.skip || !revised.text.trim()) continue;
    const evaluation = await score(revised.text);
    if (keepRewrite(best.evaluation, evaluation)) best = { index: best.index, text: revised.text, hook: revised.hook, evaluation };
  }

  const quality = qualityReport(best.evaluation, rounds);
  return { skip: false, text: best.text, hook: best.hook, quality, hold: !quality.passed };
}

/**
 * Pipeline: a post below the bar is saved as `needs_review` with a short summary (the judge's
 * notes are on posts.quality, shown once on /posts) and isn't posted; `linkedapi:approvePost`
 * posts it after a human review. null = post as usual.
 */
export function holdDecision(quality: QualityReport | undefined): { status: "needs_review"; summary: string } | null {
  if (!quality || quality.passed) return null;
  return {
    status: "needs_review",
    summary: `Held by the quality check: ${quality.score}/100 (bar ${PASS_SCORE}) after ${quality.rounds} rewrite${quality.rounds === 1 ? "" : "s"}.`,
  };
}
