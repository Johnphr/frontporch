// References to the Data stream's functions (memories.ts, engagement.ts), typed
// from the generated API so argument mismatches fail the typecheck.

import { internal } from "../_generated/api";
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

export type MemoryHit = { _id: string; kind: string; text: string; name?: string; status?: string; score: number };

export type FeedbackPost = {
  linkedinUrl: string;
  postText?: string;
  reactions: number;
  comments: { author: string; text: string }[];
  scrapedAt: number;
};

export const memoriesAddMany = internal.memories.addMany;
export const memoriesSearch = internal.memories.search;
export const memoriesListForElder = internal.memories.listForElder;
export const engagementRecentFeedback = internal.engagement.recentFeedback;
