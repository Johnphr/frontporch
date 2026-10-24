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
  status: v.string(), // published | draft | failed | skipped | needs_review
  url: v.optional(v.string()),
  draftText: v.optional(v.string()),
  error: v.optional(v.string()),
});

// Per-platform post texts written by backend/app/services/post_writer.py
// (disclosure line already included).
export const postVariants = v.object({
  bluesky: v.optional(v.string()),
  linkedin: v.optional(v.string()),
  reddit: v.optional(v.string()),
  quora: v.optional(v.string()),
  discourse: v.optional(v.string()),
});

// Faithfulness check: did each text stick to what the elder actually said?
export const postQuality = v.array(
  v.object({
    platform: v.string(), // feed | bluesky | linkedin | reddit | quora | discourse
    passed: v.boolean(),
    issues: v.array(v.string()),
  }),
);

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
    variants: v.optional(postVariants),
    quality: v.optional(postQuality),
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
