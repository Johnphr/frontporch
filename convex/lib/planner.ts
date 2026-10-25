// The question planner's pure logic: ranking the question bank, building the
// CallPlan, turning it into the Cartesia dynamic variables, and small call checks.
// Only imports other pure lib files, so `npm test` runs it directly in Node.
//
// The LLM writes the questions and the "why"; this file decides the order, so the
// ranking is predictable and easy to tune.

import { formatMemoriesForPrompt } from "./memoryText.ts";
import { firstName, type Profile } from "./onboarding.ts";
import { callContext, callGoal, type CallVariables } from "./prompts/agent.ts";
import type { CallLanguage } from "./prompts/principles.ts";

export type CandidateSource = "open_thread" | "reader" | "recent_topic" | "audience" | "memory" | "profile";

export const CANDIDATE_SOURCES: CandidateSource[] = [
  "open_thread",
  "reader",
  "recent_topic",
  "audience",
  "memory",
  "profile",
];

export type Candidate = {
  question: string;
  why: string;
  source: CandidateSource;
  sourceRef?: string;
  topicKey: string;
  /** epoch ms when this question first entered the bank (drives age decay) */
  firstSeenAt?: number;
};

export type RankedCandidate = Candidate & { priority: number; firstSeenAt: number };

/** Open threads first, then reader questions, then fresh online topics, then story seeds
 *  (a reader question from the last 48h goes above all: FRESH_READER_WEIGHT). */
export const SOURCE_WEIGHTS: Record<CandidateSource, number> = {
  open_thread: 100,
  reader: 80,
  recent_topic: 60,
  audience: 55,
  memory: 40,
  profile: 30,
};

/** A reader question first seen after RankOptions.freshReaderSince: above open threads, so the
 *  next call asks it. Even at 48h old (decay ~0.9) it beats a brand new open thread (max 105). */
export const FRESH_READER_WEIGHT = 130;
export const FRESH_READER_MS = 48 * 60 * 60 * 1000;

/** A queued question loses half its weight every two weeks it sits unused. */
export const HALF_LIFE_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

const STOPWORDS = new Set(
  (
    "a an and are as at be been but by can could did do does for from had has have he her his how i if in " +
    "into is it its just like me more most my no not of on or our out she so some than that the their them " +
    "then there they this those to up us was we were what when where which who why will with would you your " +
    "about after again any back because before being both each ever few first got here him himself much " +
    "never now off once only other over own same should still such tell through too under until very well " +
    "while yes yet remember told talk talked story stories time times day days thing things really"
  ).split(" "),
);

/** Content words of a text (lowercase, no stopwords, at least 3 letters). */
export function keywordsOf(text: string): Set<string> {
  const words = (text ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  return new Set(words);
}

/** Stable short key for a topic: its sorted content words, max 6. */
export function normalizeTopicKey(text: string): string {
  return [...keywordsOf(text)].sort().slice(0, 6).join("-");
}

/**
 * Does this candidate touch one of these topics? Exact topicKey match, or enough
 * shared content words (all of a short topic's words, or at least two of a long one's).
 */
export function overlapsTopic(candidate: Pick<Candidate, "question" | "topicKey">, topics: string[]): boolean {
  if (topics.length === 0) return false;
  const key = normalizeTopicKey(candidate.topicKey);
  const words = new Set([...keywordsOf(candidate.question), ...keywordsOf(candidate.topicKey.replace(/-/g, " "))]);
  for (const topic of topics) {
    const topicWords = keywordsOf(topic);
    if (topicWords.size === 0) continue;
    if (key && key === normalizeTopicKey(topic)) return true;
    let shared = 0;
    for (const w of topicWords) if (words.has(w)) shared++;
    if (topicWords.size <= 2 ? shared === topicWords.size : shared >= 2) return true;
  }
  return false;
}

// Words that say "he doesn't want to talk about X" rather than naming X.
const AVOID_FILLER = new Set(
  (
    "doesn didn don want wants wanted wanting discuss discussed discussing talking mention mentioned " +
    "rather prefer prefers painful topic topics subject subjects avoid avoids bring brought please asked " +
    "anything something everything anymore lately hard upset upsets sensitive private personal"
  ).split(" "),
);

/** Simple plural normalization: "deaths" -> "death", "stories" -> "story". */
function stem(word: string): string {
  if (word.endsWith("ies") && word.length > 5) return word.slice(0, -3) + "y";
  if (word.endsWith("sses")) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss") && word.length > 4) return word.slice(0, -1);
  return word;
}

/** Significant words for avoid matching: at least 4 letters, no stopwords or "doesn't want to" filler. */
export function avoidKeywordsOf(text: string): Set<string> {
  const words = (text ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/['’]s\b/g, "")
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w) && !AVOID_FILLER.has(w))
    .map(stem);
  return new Set(words);
}

/**
 * Avoid topics are strict: any shared significant word blocks the candidate, so
 * "Doesn't want to talk about his brother's death" blocks "What was your brother like?".
 */
export function overlapsAvoid(candidate: Pick<Candidate, "question" | "topicKey">, avoid: string[]): boolean {
  if (avoid.length === 0) return false;
  const words = new Set([
    ...avoidKeywordsOf(candidate.question),
    ...avoidKeywordsOf(candidate.topicKey.replace(/-/g, " ")),
  ]);
  for (const topic of avoid) {
    for (const w of avoidKeywordsOf(topic)) if (words.has(w)) return true;
  }
  return false;
}

export type RankOptions = {
  /** topics he doesn't want to discuss: always filtered out */
  avoid?: string[];
  /** topics he already covered in calls: filtered unless an open thread or reader question */
  covered?: string[];
  /** topics of questions asked in recent calls: always filtered, whatever the source */
  recentlyUsed?: string[];
  now: number;
  /** reader questions first seen at or after this (epoch ms) rank first (FRESH_READER_WEIGHT).
   *  refreshQuestionBank sets it when a reader replied in the last 48h. */
  freshReaderSince?: number;
  /** drop queued questions older than this (default 45 days) */
  maxAgeDays?: number;
  limit?: number;
};

/**
 * Filter, dedupe and order candidates. Input order is the LLM's own preference and
 * breaks ties (earlier = small bonus). A fresh reader question (opts.freshReaderSince) goes first.
 */
export function rankCandidates(candidates: Candidate[], opts: RankOptions): RankedCandidate[] {
  const avoid = (opts.avoid ?? []).filter(Boolean);
  const covered = (opts.covered ?? []).filter(Boolean);
  const recentlyUsed = (opts.recentlyUsed ?? []).filter(Boolean);
  const maxAgeMs = (opts.maxAgeDays ?? 45) * DAY_MS;
  const limit = opts.limit ?? 12;
  const n = Math.max(candidates.length, 1);

  // Pass 1: clean up, filter, and find the oldest firstSeenAt per topic so a
  // re-suggested question keeps its age whatever order the copies arrive in.
  type Prepared = { cand: Candidate & { topicKey: string; question: string }; index: number };
  const prepared: Prepared[] = [];
  const oldest = new Map<string, number>();
  candidates.forEach((c, i) => {
    const question = (c.question ?? "").trim();
    if (!question || !CANDIDATE_SOURCES.includes(c.source)) return;
    const topicKey = normalizeTopicKey(c.topicKey || question) || normalizeTopicKey(question);
    const cand = { ...c, question, topicKey };
    if (overlapsAvoid(cand, avoid)) return;
    if (overlapsTopic(cand, recentlyUsed)) return;
    const mayRevisit = c.source === "open_thread" || c.source === "reader";
    if (!mayRevisit && overlapsTopic(cand, covered)) return;
    const seenAt = typeof c.firstSeenAt === "number" && Number.isFinite(c.firstSeenAt) ? c.firstSeenAt : opts.now;
    oldest.set(topicKey, Math.min(oldest.get(topicKey) ?? seenAt, seenAt));
    prepared.push({ cand, index: i });
  });

  // Pass 2: score with the topic's oldest age, keep the best copy per topic.
  const byKey = new Map<string, RankedCandidate>();
  for (const { cand, index } of prepared) {
    const firstSeenAt = oldest.get(cand.topicKey) ?? opts.now;
    const ageMs = Math.max(0, opts.now - firstSeenAt);
    if (ageMs > maxAgeMs) continue;
    const decay = Math.pow(0.5, ageMs / (HALF_LIFE_DAYS * DAY_MS));
    const orderBonus = ((n - index) / n) * 5;
    const fresh = cand.source === "reader" && opts.freshReaderSince !== undefined && firstSeenAt >= opts.freshReaderSince;
    const weight = fresh ? FRESH_READER_WEIGHT : SOURCE_WEIGHTS[cand.source];
    const priority = Math.round((weight * decay + orderBonus) * 100) / 100;
    const ranked: RankedCandidate = { ...cand, priority, firstSeenAt };
    const existing = byKey.get(cand.topicKey);
    if (!existing || ranked.priority > existing.priority) byKey.set(cand.topicKey, ranked);
  }

  return [...byKey.values()].sort((a, b) => b.priority - a.priority).slice(0, limit);
}

/** Clean the LLM's planQuestions output: valid sources, trimmed text, a topicKey on every item. */
export function normalizePlannedCandidates(raw: unknown): Candidate[] {
  const list = raw && typeof raw === "object" && Array.isArray((raw as { candidates?: unknown }).candidates)
    ? ((raw as { candidates: unknown[] }).candidates)
    : [];
  const out: Candidate[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const question = typeof r.question === "string" ? r.question.trim().slice(0, 300) : "";
    const source = typeof r.source === "string" ? (r.source as CandidateSource) : "memory";
    if (!question || !CANDIDATE_SOURCES.includes(source)) continue;
    const topicKey = normalizeTopicKey(typeof r.topicKey === "string" && r.topicKey ? r.topicKey : question);
    out.push({
      question,
      why: typeof r.why === "string" ? r.why.trim().slice(0, 300) : "",
      source,
      ...(typeof r.sourceRef === "string" && r.sourceRef.trim() ? { sourceRef: r.sourceRef.trim() } : {}),
      topicKey: topicKey || question.toLowerCase().slice(0, 40),
    });
  }
  return out;
}

/**
 * Drop ranked items that were used while the refresh ran (same topicKey or same question), so a
 * question asked on the call that just happened never goes back in the queue.
 */
export function dropJustUsed<T extends { question: string; topicKey: string }>(
  items: T[],
  used: Array<{ question: string; topicKey: string }>,
): T[] {
  if (used.length === 0) return items;
  const keys = new Set(used.map((u) => u.topicKey));
  const questions = new Set(used.map((u) => u.question.trim().toLowerCase()));
  return items.filter((i) => !keys.has(i.topicKey) && !questions.has(i.question.trim().toLowerCase()));
}

/**
 * Refreshes can overlap (one every 30 s for a fresh post). A refresh that began before the one
 * that last wrote the bank read older replies: replaceQueued drops its write.
 */
export function isStaleRefresh(startedAt: number | undefined, lastStartedAt: number | undefined): boolean {
  return startedAt !== undefined && lastStartedAt !== undefined && startedAt < lastStartedAt;
}

/** Calls whose plan's bank row may still be marked used (ended = not processed yet). */
const PLAN_OPEN_STATUSES = new Set(["queued", "in_progress", "ended"]);

/**
 * Bank row ids that open calls' plans point at (calls.plan.bankId). replaceQueued keeps
 * those rows, so markBankRowUsed still finds them when the call is placed or processed.
 */
export function bankIdsHeldByOpenCalls(calls: Array<{ status: string; plan?: unknown }>): Set<string> {
  const ids = new Set<string>();
  for (const call of calls) {
    if (!PLAN_OPEN_STATUSES.has(call.status)) continue;
    const bankId = (call.plan as { bankId?: unknown } | null | undefined)?.bankId;
    if (typeof bankId === "string" && bankId) ids.add(bankId);
  }
  return ids;
}

/** Questions we can still ask when the LLM is unavailable: no invention, just the inputs. */
export function fallbackCandidates(input: {
  openThreads: { id: string; text: string }[];
  readerQuestions: string[];
  audienceQuestions: { id: string; title: string }[];
  recentTopics: { title: string; question: string; url: string }[];
}): Candidate[] {
  const out: Candidate[] = [];
  for (const t of input.openThreads) {
    out.push({
      question: `Last time you started telling me about ${lowerFirst(stripPeriod(t.text))}. What happened next?`,
      why: "He started this story but didn't finish it.",
      source: "open_thread",
      sourceRef: t.id,
      topicKey: normalizeTopicKey(t.text),
    });
  }
  for (const q of input.readerQuestions) {
    out.push({ question: q, why: "A reader asked this.", source: "reader", topicKey: normalizeTopicKey(q) });
  }
  for (const t of input.recentTopics) {
    out.push({ question: t.question, why: t.title, source: "recent_topic", sourceRef: t.url, topicKey: normalizeTopicKey(t.title) });
  }
  for (const a of input.audienceQuestions) {
    out.push({
      question: `People are asking: "${a.title}" What would you tell them?`,
      why: "A real question people in his field are asking online.",
      source: "audience",
      sourceRef: a.id,
      topicKey: normalizeTopicKey(a.title),
    });
  }
  return out;
}

// ---------- memories + profile text ----------

export type MemoryLike = { kind: string; text: string; name?: string };

/** Pip's {{memories}} block. Delegates to the Data side's formatter so there is one format. */
export function formatMemoriesBrief(memories: MemoryLike[], opts: { max?: number } = {}): string {
  return formatMemoriesForPrompt(memories, { max: opts.max ?? 8 });
}

/** Profile text for prompts. `extraAvoid` (avoid memories from later calls) is always included. */
export function formatProfile(profile: Profile | undefined | null, extraAvoid: string[] = []): string {
  const avoid = mergeAvoid(profile?.topicsToAvoid ?? [], extraAvoid);
  const topics = (profile?.topics ?? []).filter((t) => t?.trim());
  const parts = [
    profile?.industry && `Industry: ${profile.industry}.`,
    profile?.specialty && `Specialty: ${profile.specialty}.`,
    profile?.careerSummary && `Career: ${profile.careerSummary}`,
    topics.length ? `Topics he knows well: ${topics.join("; ")}.` : "",
    avoid.length ? `Topics to avoid: ${avoid.join("; ")}.` : "",
  ];
  return parts.filter(Boolean).join("\n");
}

/** Case-insensitive union, trailing punctuation dropped, order kept. */
export function mergeAvoid(...lists: string[][]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const raw of list) {
      const t = (raw ?? "").trim().replace(/[.!?]+$/, "");
      const key = t.toLowerCase();
      if (!t || seen.has(key)) continue;
      seen.add(key);
      out.push(t);
    }
  }
  return out;
}

// ---------- call plan + Cartesia dynamic variables (story call) ----------

export type CallKind = "onboarding" | "story";

/**
 * ARCHITECTURE.md "Contracts": conversation.planNextCall -> cartesia.startCall.
 * Kept simple on purpose: a story call has ONE goal, a story that starts from `question`
 * (the goal's wording is fixed in lib/prompts/agent.callGoal); the character follows him from there.
 */
export type CallPlan = {
  kind: CallKind;
  question?: string;
  memories: string[];
  feedback?: string;
  /** Readers' exact words (lib/readerSafety.quotableComments): read out only if he asks. */
  readerComments?: string;
  /** lib/readerSafety.commentKey of the comments this call shares; marked shared after a real conversation */
  commentKeys?: string[];
  knownBackground?: string;
  /** questionBank row behind `question`; pass to conversation.markPlanUsed once the call starts */
  bankId?: string;
};

export const FALLBACK_MAIN_QUESTION = "Tell me about a day at work you'll never forget.";

export function buildCallPlan(input: {
  kind: CallKind;
  bank?: { _id: string; question: string; topicKey: string }[];
  memories?: MemoryLike[];
  feedbackLine?: string;
  readerComments?: string;
  commentKeys?: string[];
  knownBackground?: string;
}): CallPlan {
  if (input.kind === "onboarding") {
    return {
      kind: "onboarding",
      memories: [],
      ...(input.knownBackground?.trim() ? { knownBackground: input.knownBackground.trim() } : {}),
    };
  }
  const main = firstBankQuestion(input.bank);
  const memoryLines = formatMemoriesBrief(input.memories ?? [], { max: 6 })
    .split("\n")
    .map((l) => l.replace(/^- /, ""))
    .filter(Boolean);
  return {
    kind: "story",
    question: main ? main.question.trim() : FALLBACK_MAIN_QUESTION,
    memories: memoryLines,
    ...(input.feedbackLine?.trim() ? { feedback: input.feedbackLine.trim() } : {}),
    ...(input.readerComments?.trim() ? { readerComments: input.readerComments.trim() } : {}),
    ...(input.commentKeys?.length ? { commentKeys: input.commentKeys } : {}),
    ...(main ? { bankId: main._id } : {}),
  };
}

/** The question a story call starts from: the first non-blank queued one. */
export function firstBankQuestion<T extends { question: string }>(bank: T[] | undefined): T | undefined {
  return (bank ?? []).find((b) => b.question?.trim());
}

/**
 * A story call's {{variables}} (lib/prompts/agent.CALL_VARIABLES, Cartesia dynamic_variables).
 * The call language is set per character agent, so it isn't a variable. Every variable is
 * always present (cartesia's templateVariables turns "" into "none"); callContext fences the data.
 */
export function toPromptVariables(
  plan: CallPlan,
  elder: { name: string; profile?: Profile | null },
  opts: { avoid?: string[]; lang?: CallLanguage } = {},
): CallVariables {
  return {
    first_name: firstName(elder.name ?? "", opts.lang),
    goal: callGoal("story", opts.lang ?? "en"),
    context: callContext({
      profile: formatProfile(elder.profile, opts.avoid ?? []),
      memories: plan.memories.map((m) => `- ${m}`).join("\n"),
      feedback: plan.feedback,
      reader_comments: plan.readerComments,
      question: plan.question,
    }),
  };
}

// ---------- pipeline step runner ----------
// (No-conversation + claim checks are PR #7's: lib/cartesia.isNoConversation,
// lib/onboarding.canClaimProcessing.)

export type StepStatus = "ok" | "skipped" | "failed";
export type StepReport = { step: string; status: StepStatus; detail?: string };
export type Step = { step: string; skip?: string | false; run: () => Promise<string | void> };

/** Run steps in order; one failing step never stops the rest. */
export async function runSteps(steps: Step[]): Promise<StepReport[]> {
  const reports: StepReport[] = [];
  for (const s of steps) {
    if (s.skip) {
      reports.push({ step: s.step, status: "skipped", detail: s.skip });
      continue;
    }
    try {
      const detail = await s.run();
      reports.push({ step: s.step, status: "ok", ...(detail ? { detail } : {}) });
    } catch (err) {
      reports.push({ step: s.step, status: "failed", detail: err instanceof Error ? err.message : String(err) });
    }
  }
  return reports;
}

// ---------- writePost result ----------

export type PostDraft = { skip: true; reason: string } | { skip: false; text: string; hook: string };

function looseText(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** Does `text` already open with `hook` (ignoring case, spacing and punctuation)? */
export function startsWithHook(text: string, hook: string): boolean {
  const h = looseText(hook);
  return h.length > 0 && looseText(text).startsWith(h);
}

/** Clean writePost's raw output: a skip, or the post text opening with the hook exactly once. */
export function normalizePostDraft(raw: { skip?: unknown; reason?: unknown; text?: unknown; hook?: unknown }): PostDraft {
  const text = typeof raw.text === "string" ? raw.text.trim() : "";
  const hook = typeof raw.hook === "string" ? raw.hook.trim() : "";
  if (raw.skip === true || !text) {
    const reason = typeof raw.reason === "string" && raw.reason.trim() ? raw.reason.trim() : "nothing worth posting";
    return { skip: true, reason };
  }
  const full = hook && !startsWithHook(text, hook) ? `${hook}\n\n${text}` : text;
  return { skip: false, text: full, hook: hook || full.split("\n")[0] };
}

// ---------- recent topics ----------

/** Keep only topics whose URL actually came back from web search (no invented links). */
export function filterTopicsByUrls<T extends { url: string }>(topics: T[], allowedUrls: string[]): T[] {
  const norm = (u: string) => u.trim().replace(/[?#].*$/, "").replace(/\/+$/, "").toLowerCase();
  const allowed = new Set(allowedUrls.map(norm));
  return topics.filter((t) => typeof t.url === "string" && allowed.has(norm(t.url)));
}

function stripPeriod(s: string): string {
  return s.trim().replace(/[.!]+$/, "");
}

function lowerFirst(s: string): string {
  return s ? s[0].toLowerCase() + s.slice(1) : s;
}

/**
 * rankCandidates' freshReaderSince: now - 48h when a reader commented in the last 48h (an
 * engagement row with comments that changed since then), else undefined (normal order).
 */
export function freshReaderSince(
  feedback: { changedAt: number; comments: unknown[] }[],
  nowMs: number,
  windowMs = FRESH_READER_MS,
): number | undefined {
  const since = nowMs - windowMs;
  return feedback.some((f) => f.comments.length > 0 && f.changedAt >= since) ? since : undefined;
}
