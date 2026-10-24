// The question planner's pure logic: ranking the question bank, building the
// CallPlan, turning it into the Vapi prompt variables, and small call checks.
// No runtime imports, so `npm test` runs it directly in Node.
//
// Claude writes the questions and the "why"; this file decides the order, so the
// ranking is predictable and easy to tune.

export type Turn = { role: string; text: string };

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

/** Open threads first, then reader questions, then fresh online topics, then story seeds. */
export const SOURCE_WEIGHTS: Record<CandidateSource, number> = {
  open_thread: 100,
  reader: 80,
  recent_topic: 60,
  audience: 55,
  memory: 40,
  profile: 30,
};

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

export type RankOptions = {
  /** topics he doesn't want to discuss: always filtered out */
  avoid?: string[];
  /** topics already covered or recently asked: filtered unless an open thread or reader question */
  covered?: string[];
  now: number;
  /** drop queued questions older than this (default 45 days) */
  maxAgeDays?: number;
  limit?: number;
};

/**
 * Filter, dedupe and order candidates. Input order is Claude's own preference and
 * breaks ties (earlier = small bonus).
 */
export function rankCandidates(candidates: Candidate[], opts: RankOptions): RankedCandidate[] {
  const avoid = (opts.avoid ?? []).filter(Boolean);
  const covered = (opts.covered ?? []).filter(Boolean);
  const maxAgeMs = (opts.maxAgeDays ?? 45) * DAY_MS;
  const limit = opts.limit ?? 12;
  const n = Math.max(candidates.length, 1);

  const byKey = new Map<string, RankedCandidate>();
  candidates.forEach((c, i) => {
    const question = (c.question ?? "").trim();
    if (!question || !CANDIDATE_SOURCES.includes(c.source)) return;
    const topicKey = normalizeTopicKey(c.topicKey || question) || normalizeTopicKey(question);
    const cand = { ...c, question, topicKey };
    if (overlapsTopic(cand, avoid)) return;
    const mayRevisit = c.source === "open_thread" || c.source === "reader";
    if (!mayRevisit && overlapsTopic(cand, covered)) return;

    const firstSeenAt = typeof c.firstSeenAt === "number" && Number.isFinite(c.firstSeenAt) ? c.firstSeenAt : opts.now;
    const ageMs = Math.max(0, opts.now - firstSeenAt);
    if (ageMs > maxAgeMs) return;
    const decay = Math.pow(0.5, ageMs / (HALF_LIFE_DAYS * DAY_MS));
    const orderBonus = ((n - i) / n) * 5;
    const priority = Math.round((SOURCE_WEIGHTS[c.source] * decay + orderBonus) * 100) / 100;

    const ranked: RankedCandidate = { ...cand, priority, firstSeenAt };
    const existing = byKey.get(topicKey);
    if (!existing || ranked.priority > existing.priority) {
      // Keep the oldest firstSeenAt so a re-suggested question doesn't look brand new.
      if (existing) ranked.firstSeenAt = Math.min(existing.firstSeenAt, ranked.firstSeenAt);
      byKey.set(topicKey, ranked);
    }
  });

  return [...byKey.values()].sort((a, b) => b.priority - a.priority).slice(0, limit);
}

/** Clean Claude's planQuestions output: valid sources, trimmed text, a topicKey on every item. */
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

/** Questions we can still ask when Claude is unavailable: no invention, just the inputs. */
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

/**
 * Short bullet list for the prompt. People and places first (so Pip can use
 * names), then facts and story seeds. Topics to avoid / covered are not shown.
 */
export function formatMemoriesBrief(memories: MemoryLike[], opts: { max?: number } = {}): string {
  const max = opts.max ?? 8;
  const order: Record<string, number> = { person: 0, place: 1, open_thread: 2, fact: 3, story_seed: 4 };
  const seen = new Set<string>();
  const lines: string[] = [];
  const sorted = memories
    .filter((m) => m && typeof m.text === "string" && m.text.trim() && m.kind in order)
    .map((m, i) => ({ m, i }))
    .sort((a, b) => order[a.m.kind] - order[b.m.kind] || a.i - b.i)
    .map((x) => x.m);
  for (const m of sorted) {
    const text = m.text.trim();
    const line =
      m.name && !text.toLowerCase().includes(m.name.toLowerCase()) ? `- ${m.name}: ${text}` : `- ${text}`;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(line);
    if (lines.length >= max) break;
  }
  return lines.join("\n");
}

export type ElderProfile = {
  industry: string;
  specialty: string;
  careerSummary: string;
  topicsToAvoid: string[];
};

export function formatProfile(profile: ElderProfile | undefined | null): string {
  if (!profile) return "";
  const parts = [
    profile.industry && `Industry: ${profile.industry}.`,
    profile.specialty && `Specialty: ${profile.specialty}.`,
    profile.careerSummary && `Career: ${profile.careerSummary}`,
    profile.topicsToAvoid?.length ? `Avoid: ${profile.topicsToAvoid.join(", ")}.` : "",
  ];
  return parts.filter(Boolean).join("\n");
}

// ---------- call plan + Vapi variables ----------

export type CallKind = "onboarding" | "story";

/** ARCHITECTURE.md "Contracts": conversation.planNextCall -> vapi.startCall. */
export type CallPlan = {
  kind: CallKind;
  mainQuestion?: string;
  threads: string[];
  memories: string[];
  feedback?: string;
  knownBackground?: string;
  /** questionBank row behind mainQuestion; pass to conversation.markPlanUsed once the call starts */
  bankId?: string;
};

export const FALLBACK_MAIN_QUESTION = "Tell me about a day at work you'll never forget.";

export function buildCallPlan(input: {
  kind: CallKind;
  bank?: { _id: string; question: string; topicKey: string }[];
  memories?: MemoryLike[];
  feedbackLine?: string;
  knownBackground?: string;
}): CallPlan {
  if (input.kind === "onboarding") {
    return {
      kind: "onboarding",
      threads: [],
      memories: [],
      ...(input.knownBackground?.trim() ? { knownBackground: input.knownBackground.trim() } : {}),
    };
  }
  const bank = (input.bank ?? []).filter((b) => b.question?.trim());
  const main = bank[0];
  const usedKeys = new Set(main ? [main.topicKey] : []);
  const threads: string[] = [];
  for (const b of bank.slice(1)) {
    if (threads.length >= 3) break;
    if (usedKeys.has(b.topicKey)) continue;
    usedKeys.add(b.topicKey);
    threads.push(b.question.trim());
  }
  const memoryLines = formatMemoriesBrief(input.memories ?? [], { max: 6 })
    .split("\n")
    .map((l) => l.replace(/^- /, ""))
    .filter(Boolean);
  return {
    kind: "story",
    mainQuestion: main ? main.question.trim() : FALLBACK_MAIN_QUESTION,
    threads,
    memories: memoryLines,
    ...(input.feedbackLine?.trim() ? { feedback: input.feedbackLine.trim() } : {}),
    ...(main ? { bankId: main._id } : {}),
  };
}

/** The {{variables}} used by vapi/prompts/onboarding.md and story-call.md. */
export const PROMPT_VARIABLES = [
  "firstName",
  "language",
  "profile",
  "memories",
  "feedback",
  "mainQuestion",
  "threads",
  "knownBackground",
] as const;

export type PromptVariables = Record<(typeof PROMPT_VARIABLES)[number], string>;

const LANGUAGE_NAMES: Record<string, string> = {
  en: "English",
  es: "Spanish",
  fr: "French",
  pt: "Portuguese",
  de: "German",
  it: "Italian",
  zh: "Chinese",
  ja: "Japanese",
  ko: "Korean",
  hi: "Hindi",
  ar: "Arabic",
};

/** "es-MX" -> "Spanish". Unknown codes are returned as they are. */
export function languageName(code: string | undefined): string {
  const base = (code ?? "en").split(/[-_]/)[0].toLowerCase();
  return LANGUAGE_NAMES[base] ?? (code || "English");
}

/** Every variable is always present (empty string when unused) so both assistants get a full set. */
export function toPromptVariables(
  plan: CallPlan,
  elder: { name: string; language?: string; profile?: ElderProfile | null },
): PromptVariables {
  return {
    firstName: (elder.name ?? "").trim().split(/\s+/)[0] ?? "",
    language: languageName(elder.language),
    profile: formatProfile(elder.profile),
    memories: plan.memories.map((m) => `- ${m}`).join("\n"),
    feedback: plan.feedback ?? "",
    mainQuestion: plan.mainQuestion ?? "",
    threads: plan.threads.map((t) => `- ${t}`).join("\n"),
    knownBackground: plan.knownBackground ?? "",
  };
}

// ---------- call checks + pipeline step runner ----------

/** Fewer than `minWords` words from him: not enough to write anything from. */
export function isNearSilentCall(turns: Turn[], minWords = 25): boolean {
  let words = 0;
  for (const t of turns ?? []) {
    const role = (t.role ?? "").toLowerCase();
    if (role !== "elder" && role !== "user" && role !== "customer") continue;
    words += (t.text ?? "").split(/\s+/).filter(Boolean).length;
    if (words >= minWords) return false;
  }
  return true;
}

/** Voicemail / nobody picked up. Vapi endedReason strings vary, so match loosely. */
export function isNoConversation(endedReason: string | undefined): boolean {
  return /voicemail|no-answer|did-not-answer|busy|failed-to-connect|silence-timed-out/i.test(endedReason ?? "");
}

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
