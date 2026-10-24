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
    // --- question sourcing (feat/question-sources). All optional so legacy
    // rows, manual questions and family questions keep working. ---
    community: v.optional(v.string()), // e.g. "AskOldPeople", "diy", forum name
    score: v.optional(v.number()), // upvotes / likes / followers on the source site
    answerCount: v.optional(v.number()), // answers or comments it already has
    postedAt: v.optional(v.number()), // epoch ms when it was posted on the source site
    tags: v.optional(v.array(v.string())),
    fingerprint: v.optional(v.string()), // normalized title, for cross-site dedupe
    priority: v.optional(v.number()), // higher = ask sooner
  })
    .index("by_status", ["status"])
    .index("by_elder_status", ["assignedElderId", "status"])
    .index("by_external", ["externalId"])
    .index("by_fingerprint", ["fingerprint"]),

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
});
