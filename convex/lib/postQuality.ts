// LinkedIn post quality: the rubric, the pass bar and the code-side checks that need no AI.
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

/** How much each criterion counts (sums to 1). The story and the hook matter most on LinkedIn. */
export const WEIGHTS: CriterionScores = {
  hook: 0.22, // first line (~140 chars, before "...see more") makes you want to read on
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

// Time: writePost runs inside pipeline.processCall (Convex actions stop at 10 min, and
// extractKnowledge runs before it). Each quality call gets its own timeout and no retry, and a
// rewrite round only starts if it fits the budget. Worst case: drafts (parallel) 75 s + judges
// (parallel) 45 s + one 120 s round = 240 s; a second round only when the calls ran fast.
export const DRAFT_TIMEOUT_MS = 75_000;
export const JUDGE_TIMEOUT_MS = 45_000;
export const REWRITE_TIMEOUT_MS = 75_000;
export const ROUND_COST_MS = REWRITE_TIMEOUT_MS + JUDGE_TIMEOUT_MS;
export const QUALITY_BUDGET_MS = 240_000;

/** One instruction per parallel draft, so the 3 drafts differ in approach, not just wording. */
export const ANGLES = [
  "Angle: the turning point. Build the post around the moment things changed in his story.",
  "Angle: the hard lesson. Build the post around what went wrong or was hard, and what he learned.",
  "Angle: the surprising detail. Open with the most unexpected concrete detail he gave, then tell the story.",
] as const;

// ---------- code-side checks ----------

export const MIN_WORDS = 120;
export const MAX_WORDS = 250;
/** Far outside the target length is a blocker, not just a penalty. */
export const HARD_MIN_WORDS = 90;
export const HARD_MAX_WORDS = 320;
export const MAX_HOOK_CHARS = 140;
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
  const hook = firstLine(text);
  if (hook.length > MAX_HOOK_CHARS) {
    issues.push({
      id: "hook_length",
      severity: "minor",
      message: `The first line is ${hook.length} characters; LinkedIn cuts it at about ${MAX_HOOK_CHARS} ("...see more").`,
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
  if (/\*\*|__|^#{1,6}\s|^\s*[-*•]\s|^\s*\d+[.)]\s/m.test(text)) {
    issues.push({ id: "markdown", severity: "minor", message: "Uses markdown, bullets or a numbered list; LinkedIn posts read better as plain paragraphs." });
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

/** Most of the drafts say there's nothing worth posting -> skip the call (no post). */
export function shouldSkip(skips: number, drafts: number): boolean {
  return drafts > 0 && skips * 2 > drafts;
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

/**
 * Pipeline: a post below the bar is saved as `needs_review` with the judge's notes (shown on
 * /posts) and isn't sent to LinkedAPI; `linkedapi:approvePost` posts it after a human review.
 * null = post as usual.
 */
export function holdDecision(quality: QualityReport | undefined): { status: "needs_review"; summary: string; issues: string[] } | null {
  if (!quality || quality.passed) return null;
  return {
    status: "needs_review",
    summary: `Held by the quality check: ${quality.score}/100 (bar ${PASS_SCORE}) after ${quality.rounds} rewrite${quality.rounds === 1 ? "" : "s"}.`,
    issues: quality.notes,
  };
}
