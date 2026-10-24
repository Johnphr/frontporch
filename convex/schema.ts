import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

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

export default defineSchema({
  elders: defineTable({
    name: v.string(),
    phone: v.string(), // E.164, e.g. +14155550123
    expertise: v.array(v.string()),
    language: v.string(), // BCP-47, e.g. en-US, es-MX
    bio: v.optional(v.string()),
  }).index("by_phone", ["phone"]),

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
    callSid: v.string(),
    elderId: v.id("elders"),
    questionId: v.optional(v.id("questions")),
    status: v.string(), // in-progress | completed | failed | ...
    transcript: v.array(v.object({ role: v.string(), text: v.string() })),
  }).index("by_sid", ["callSid"]),

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
});
