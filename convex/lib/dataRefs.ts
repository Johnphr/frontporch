// Shapes returned by the Data stream's functions (memories.ts, engagement.ts).
// Call them as internal.memories.* / internal.engagement.* directly: module-level
// consts of `internal.*` here made the generated API types circular (TS7022).

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
