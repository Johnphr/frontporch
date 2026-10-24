// References to the Data stream's functions (feat/memory-data: memories.ts,
// engagement.ts). They're built in parallel, so we reference them by name with
// fixed contracts instead of importing their generated types.
// TODO after feat/memory-data merges: switch to internal.memories.* / internal.engagement.*.

import { makeFunctionReference } from "convex/server";
import type { Id } from "../_generated/dataModel";

export type MemoryKind = "fact" | "story_seed" | "open_thread" | "person" | "place" | "topic_covered" | "avoid";

export type MemoryItem = { kind: MemoryKind; text: string; name?: string };

export type MemoryDoc = {
  _id: string;
  _creationTime: number;
  kind: MemoryKind;
  text: string;
  name?: string;
  status?: "active" | "resolved";
  lastMentionedAt?: number;
};

export type MemoryHit = { _id: string; kind: MemoryKind; text: string; name?: string; status?: string; score: number };

export type FeedbackPost = {
  linkedinUrl: string;
  postText?: string;
  reactions: number;
  comments: { author: string; text: string }[];
  scrapedAt: number;
};

export const memoriesAddMany = makeFunctionReference<
  "action",
  { elderId: Id<"elders">; callId?: Id<"calls">; items: MemoryItem[]; resolveThreadIds?: string[] },
  { inserted: number; merged: number; resolved: number }
>("memories:addMany");

export const memoriesSearch = makeFunctionReference<
  "action",
  { elderId: Id<"elders">; text: string; k: number; kinds?: MemoryKind[] },
  MemoryHit[]
>("memories:search");

export const memoriesListForElder = makeFunctionReference<
  "query",
  { elderId: Id<"elders">; kinds?: MemoryKind[]; status?: "active" | "resolved"; limit?: number },
  MemoryDoc[]
>("memories:listForElder");

export const engagementRecentFeedback = makeFunctionReference<
  "query",
  { elderId: Id<"elders">; sinceDays?: number },
  FeedbackPost[]
>("engagement:recentFeedback");
