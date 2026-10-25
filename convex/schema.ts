import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// v1 leftovers: validators for the questions/answers tables below (drop with them).
export const questionStatus = v.union(
  v.literal("new"),
  v.literal("assigned"),
  v.literal("answered"),
  v.literal("skipped"),
);

export const answerStatus = v.union(
  v.literal("draft"),
  v.literal("approved"),
  v.literal("published"),
  v.literal("rejected"),
);

export const publication = v.object({
  platform: v.string(),
  status: v.string(), // published | draft | failed | skipped
  url: v.optional(v.string()),
  draftText: v.optional(v.string()),
  error: v.optional(v.string()),
});

// What we remember about him (memories.kind). Keep in sync with lib/memoryText.ts.
export const memoryKind = v.union(
  v.literal("fact"),
  v.literal("story_seed"),
  v.literal("open_thread"),
  v.literal("person"),
  v.literal("place"),
  v.literal("topic_covered"),
  v.literal("avoid"),
);

export const elderProfile = v.object({
  // Same shape as PR #7's elders.profile: every field optional (filled over onboarding calls).
  industry: v.optional(v.string()),
  specialty: v.optional(v.string()),
  careerSummary: v.optional(v.string()),
  topics: v.optional(v.array(v.string())), // what he can talk about
  storySeeds: v.optional(v.array(v.string())), // stories he mentioned, for later calls
  topicsToAvoid: v.optional(v.array(v.string())),
});

export default defineSchema({
  elders: defineTable({
    name: v.string(),
    phone: v.string(), // E.164, e.g. +14155550123
    expertise: v.array(v.string()),
    language: v.string(), // BCP-47, e.g. en-US, es-MX
    bio: v.optional(v.string()),
    // ---- v2 (onboarding slice, PR #7) ----
    stage: v.optional(v.union(v.literal("onboarding"), v.literal("active"))), // missing = onboarding
    linkedinUrl: v.optional(v.string()),
    knownBackground: v.optional(v.string()), // cached apify.scrapeProfile result
    profile: v.optional(elderProfile),
    // ---- v2 (Data): scheduling + bookkeeping, all optional ----
    timezone: v.optional(v.string()), // IANA, e.g. America/Los_Angeles
    callDay: v.optional(v.string()), // sunday..saturday, his local time
    callHour: v.optional(v.number()), // 0-23, his local time
    lastPreparedSlot: v.optional(v.string()), // "YYYY-MM-DDTHH" local slot already prepared
    lastCallSlot: v.optional(v.string()), // "YYYY-MM-DDTHH" local slot already called
    lastBankRefreshAt: v.optional(v.number()), // epoch ms, debounces question-bank refreshes
    characterId: v.optional(v.string()), // who calls him (lib/characters.ts); missing = default for his language
  }).index("by_phone", ["phone"]),

  // One Cartesia agent per character (lib/characters.ts), written by cartesiaAgents.syncAgent.
  characterAgents: defineTable({
    characterId: v.string(),
    agentId: v.string(),
    syncedAt: v.number(), // epoch ms
  }).index("by_character", ["characterId"]),

  // v1 leftover (old "answer internet questions" product): no functions use it anymore.
  // Kept so a deploy can't fail on existing rows; drop the table once it's empty.
  questions: defineTable({
    source: v.string(), // reddit | quora | discourse | manual | ...
    title: v.string(),
    body: v.optional(v.string()),
    sourceUrl: v.optional(v.string()),
    externalId: v.optional(v.string()),
    topics: v.array(v.string()),
    status: questionStatus,
    assignedElderId: v.optional(v.id("elders")),
    skipReason: v.optional(v.string()),
  })
    .index("by_status", ["status"])
    .index("by_elder_status", ["assignedElderId", "status"])
    .index("by_external", ["externalId"]),

  calls: defineTable({
    callSid: v.optional(v.string()), // v1 Twilio calls only
    elderId: v.id("elders"),
    questionId: v.optional(v.id("questions")),
    // v2: queued | in_progress | ended | done | no_conversation | failed |
    //     poll_error | poll_timeout | process_failed
    status: v.string(),
    transcript: v.array(v.object({ role: v.string(), text: v.string() })),
    // ---- v2 (onboarding slice, PR #7) ----
    kind: v.optional(v.string()), // onboarding | story
    cartesiaCallId: v.optional(v.string()),
    summary: v.optional(v.string()),
    endReason: v.optional(v.string()),
    error: v.optional(v.string()),
    pollAttempts: v.optional(v.number()),
    lastPolledAt: v.optional(v.number()), // epoch ms
    processingAt: v.optional(v.number()), // epoch ms; claim, stale after 15 min
    processedAt: v.optional(v.number()), // epoch ms; set only on success
    // ---- v2 (Brain) ----
    plan: v.optional(v.any()), // CallPlan from conversation.planNextCall, for debugging
    // ---- inbound calls (inbound.ts) ----
    direction: v.optional(v.union(v.literal("outbound"), v.literal("inbound"))), // missing = outbound
    // The lookup's system__conversation_id when it differs from cartesiaCallId (the id
    // GET /agents/calls/{id} accepts). The docs don't say whether the two are the same.
    cartesiaConversationId: v.optional(v.string()),
    // The exact answer the lookup tool gave this call: a repeated lookup gets it back unchanged.
    inboundLookup: v.optional(v.any()),
  })
    .index("by_sid", ["callSid"])
    .index("by_cartesia", ["cartesiaCallId"])
    .index("by_conversation", ["cartesiaConversationId"])
    .index("by_elder", ["elderId"]),

  // ---- Data: memory ----
  // Everything he told us, one row per fact / story seed / open thread / person /
  // place / covered topic / topic to avoid. One table so one vector search covers it.
  // elderKind = `${elderId}|${kind}`: vector filters only support eq/or, so this
  // field lets a search match "this elder AND these kinds".
  memories: defineTable({
    elderId: v.id("elders"),
    callId: v.optional(v.id("calls")), // call where it was first heard
    kind: memoryKind,
    text: v.string(),
    name: v.optional(v.string()), // people and places
    status: v.union(v.literal("active"), v.literal("resolved")), // resolved = open thread he finished
    mentionCount: v.number(),
    lastMentionedAt: v.number(), // epoch ms
    elderKind: v.string(),
    embedding: v.array(v.float64()), // OpenAI text-embedding-3-small, 1536 dims
  })
    .index("by_elder_kind", ["elderId", "kind"])
    .index("by_elder_status", ["elderId", "status"])
    .index("by_elder_last", ["elderId", "lastMentionedAt"])
    .index("by_call", ["callId"])
    .vectorIndex("by_embedding", {
      vectorField: "embedding",
      dimensions: 1536,
      filterFields: ["elderId", "kind", "elderKind"],
    }),

  // ---- Data: reader engagement on his LinkedIn posts ----
  // One row per post (latest snapshot), written by apify.scrapeEngagement via
  // engagement.upsert. linkedinUrl is canonical (lib/linkedinUrl.ts) so it matches
  // posts.linkedinUrl with a plain equality check.
  engagement: defineTable({
    elderId: v.id("elders"),
    postId: v.optional(v.id("posts")),
    linkedinUrl: v.string(),
    reactions: v.number(),
    comments: v.array(v.object({ author: v.string(), text: v.string() })),
    scrapedAt: v.number(), // epoch ms, last scrape
    changedAt: v.optional(v.number()), // epoch ms, last time reactions/comments changed
  })
    .index("by_elder", ["elderId"])
    .index("by_url", ["linkedinUrl"])
    .index("by_elder_scraped", ["elderId", "scrapedAt"])
    .index("by_elder_changed", ["elderId", "changedAt"]),

  // v1 leftover (old "answer internet questions" product): no functions use it anymore.
  // Kept so a deploy can't fail on existing rows; drop the table once it's empty.
  answers: defineTable({
    elderId: v.id("elders"),
    questionId: v.id("questions"),
    callId: v.optional(v.id("calls")),
    transcript: v.string(),
    title: v.string(),
    body: v.string(),
    shortVersion: v.string(),
    keyPoints: v.array(v.string()),
    readback: v.optional(v.string()),
    status: answerStatus,
    publications: v.array(publication),
  })
    .index("by_status", ["status"])
    .index("by_elder", ["elderId"]),

  // v1 leftover (old "answer internet questions" product): no functions use it anymore.
  // Kept so a deploy can't fail on existing rows; drop the table once it's empty.
  replies: defineTable({
    answerId: v.id("answers"),
    elderId: v.id("elders"),
    platform: v.string(),
    author: v.string(),
    text: v.string(),
    readToElder: v.boolean(),
  })
    .index("by_elder_unread", ["elderId", "readToElder"])
    .index("by_answer", ["answerId"]),

  // ---- Integrations: audience questions (Data: review) ----
  // Real questions people in his field ask online (Reddit, Stack Exchange,
  // Quora, Discourse), found by apify.findAudienceQuestions and offered to
  // conversation.planNextCall via apify.topAudienceQuestions.
  audienceQuestions: defineTable({
    elderId: v.id("elders"),
    source: v.string(), // reddit | quora | stackexchange | discourse
    title: v.string(),
    body: v.optional(v.string()),
    url: v.string(),
    community: v.optional(v.string()), // subreddit, Stack Exchange site, forum host
    score: v.optional(v.number()), // upvotes / followers / likes
    answerCount: v.optional(v.number()),
    postedAt: v.optional(v.number()), // epoch ms
    fingerprint: v.string(), // normalized-title hash, dedupes across sites
    priority: v.number(), // higher = better prompt for his next call
    keywords: v.array(v.string()), // the keywords it was found with
    usedAt: v.optional(v.number()),
    usedInCallId: v.optional(v.id("calls")),
  })
    .index("by_elder_priority", ["elderId", "priority"])
    .index("by_elder_fingerprint", ["elderId", "fingerprint"]),
  // ---- end Integrations block ----

  // ---- Integrations: posts (Data: review/replace) ----
  // ARCHITECTURE.md draft, plus optional fields used by linkedapi.ts / postGuard.ts.
  // status: pending (written, or sent to LinkedAPI when workflowId is set)
  //       | posting (claimed by a run, about to be sent) | needs_review (post guard
  //       failed, not posted) | published | failed | needs_attention (sent, but
  //       status checks stopped; see error)
  // linkedinUrl is canonical (lib/linkedinUrl.ts) so engagement rows match it.
  posts: defineTable({
    elderId: v.id("elders"),
    callId: v.id("calls"),
    text: v.string(),
    status: v.string(),
    linkedinUrl: v.optional(v.string()),
    error: v.optional(v.string()),
    workflowId: v.optional(v.string()), // LinkedAPI workflow
    guardIssues: v.optional(v.array(v.string())),
    guardSummary: v.optional(v.string()),
    pollAttempts: v.optional(v.number()),
    claimedAt: v.optional(v.number()), // epoch ms; stale claims (>15 min) can be retaken
    approvedAt: v.optional(v.number()), // epoch ms; posted via approvePost (guard skipped)
    lastPolledAt: v.optional(v.number()), // epoch ms; stale polling is restarted by createPost
    maybePosted: v.optional(v.boolean()), // LinkedAPI didn't confirm the send: check before retrying
  })
    .index("by_elder", ["elderId"])
    .index("by_url", ["linkedinUrl"])
    .index("by_call", ["callId"]), // one post per call (pipeline idempotency)

  // ---- Brain: question bank (conversation.ts) ----
  // Ranked questions for his next calls, refreshed after every call, when new
  // reader comments arrive, and ~1h before each call (conversation.prepareCall).
  // planNextCall takes the top queued row; markPlanUsed flips it to used.
  questionBank: defineTable({
    elderId: v.id("elders"),
    question: v.string(),
    why: v.string(),
    source: v.string(), // open_thread | reader | recent_topic | audience | memory | profile
    sourceRef: v.optional(v.string()), // memories id, audienceQuestions id, or a URL
    topicKey: v.string(), // normalized topic words, dedupes the bank
    priority: v.number(), // higher = ask sooner (lib/planner.ts rankCandidates)
    firstSeenAt: v.number(), // epoch ms; drives age decay across refreshes
    status: v.union(v.literal("queued"), v.literal("used"), v.literal("dropped")),
    usedInCallId: v.optional(v.id("calls")),
    usedAt: v.optional(v.number()),
  })
    .index("by_elder_status_priority", ["elderId", "status", "priority"])
    .index("by_elder_status_usedAt", ["elderId", "status", "usedAt"]),
  // One row per elder: what the last bank refresh worked out, reused at call time
  // and by the post writer so they don't call the LLM again.
  questionBankMeta: defineTable({
    elderId: v.id("elders"),
    feedbackLine: v.string(), // one warm sentence Pip reads out ("" when nothing new)
    resonated: v.string(), // what readers liked lately ("" when unknown)
    refreshedAt: v.number(), // epoch ms
  }).index("by_elder", ["elderId"]),
  // ---- end Brain block ----
});
