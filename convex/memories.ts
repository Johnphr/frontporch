// His long-term memory: what he told us on past calls.
//
//   addMany        after each call (pipeline.processCall): embed + store new memories,
//                  merge near-duplicates, mark finished open threads as resolved
//   search         vector search, e.g. memories related to the next call's question
//   listForElder   newest first, filtered by kind/status (open threads, people, ...)
//   resolveThreads mark open threads he finished
//
// Kinds: fact | story_seed | open_thread | person | place | topic_covered | avoid.
// Embeddings: OpenAI text-embedding-3-small (1536 dims). Env: OPENAI_API_KEY.
// Text rules (dedupe, merge, prompt formatting) live in lib/memoryText.ts.
// Owner: Core: Data.

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx, internalAction, internalMutation, internalQuery } from "./_generated/server";
import {
  MERGE_THRESHOLD,
  cosineSimilarity,
  dedupeBatch,
  differentNames,
  embeddingText,
  isMemoryKind,
  isRetryableStatus,
  mergeText,
  normalizeText,
  retryDelayMs,
  shouldMerge,
} from "./lib/memoryText";
import { memoryKind } from "./schema";

// Convex exposes deployment env vars on process.env (no @types/node here).
declare const process: { env: Record<string, string | undefined> };

const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_DIMS = 1536;
const EMBED_BATCH = 96;

/** A memory row without its embedding (what callers get back). */
export type MemoryView = Omit<Doc<"memories">, "embedding" | "elderKind">;

type Kind = Doc<"memories">["kind"];

function view(doc: Doc<"memories">): MemoryView {
  const { embedding: _e, elderKind: _k, ...rest } = doc;
  return rest;
}

function elderKindKey(elderId: Id<"elders">, kind: string): string {
  return `${elderId}|${kind}`;
}

/** Embed texts with OpenAI, in input order. */
async function embed(texts: string[]): Promise<number[][]> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    throw new Error("memories: OPENAI_API_KEY is not set. Run: npx convex env set OPENAI_API_KEY <key>");
  }
  const out: number[][] = [];
  for (let start = 0; start < texts.length; start += EMBED_BATCH) {
    const batch = texts.slice(start, start + EMBED_BATCH);
    const send = () =>
      fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: EMBEDDING_MODEL, input: batch }), signal: AbortSignal.timeout?.(8_000), // capped: can't stall a call start
      });
    let response = await send();
    if (!response.ok && isRetryableStatus(response.status)) {
      // One retry on 429 / 5xx so a blip doesn't lose every memory from the call.
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs(response.headers.get("retry-after"))));
      response = await send();
    }
    if (!response.ok) {
      // Only OpenAI's error code, never the body (it can echo part of the key).
      const body = (await response.json().catch(() => null)) as { error?: { code?: unknown; type?: unknown } } | null;
      const code = [body?.error?.code, body?.error?.type].find((c) => typeof c === "string" && /^[\w.-]{1,60}$/.test(c));
      throw new Error(`memories: OpenAI embeddings failed (HTTP ${response.status}${code ? `, ${code}` : ""})`);
    }
    const json = (await response.json()) as { data?: { index: number; embedding: number[] }[] };
    const data = [...(json.data ?? [])].sort((a, b) => a.index - b.index);
    if (data.length !== batch.length) {
      throw new Error(`memories: expected ${batch.length} embeddings, got ${data.length}`);
    }
    for (const row of data) {
      if (row.embedding.length !== EMBEDDING_DIMS) {
        throw new Error(`memories: expected ${EMBEDDING_DIMS}-dim embeddings, got ${row.embedding.length}`);
      }
      out.push(row.embedding);
    }
  }
  return out;
}

const itemValidator = v.object({ kind: memoryKind, text: v.string(), name: v.optional(v.string()) });

// ---------- write ----------

type Insert = { kind: Kind; text: string; name?: string; embedding: number[] };
type Merge = {
  id: Id<"memories">;
  text: string;
  name?: string;
  mentions: number;
  reopen: boolean;
  /** Set when the merged text is the incoming wording: re-embed with it. */
  embedding?: number[];
};

export const addMany = internalAction({
  args: {
    elderId: v.id("elders"),
    callId: v.optional(v.id("calls")),
    items: v.array(itemValidator),
    resolveThreadIds: v.optional(v.array(v.id("memories"))),
  },
  handler: async (ctx, args): Promise<{ inserted: number; merged: number; resolved: number }> => {
    const items = dedupeBatch(args.items);
    const resolveIds = args.resolveThreadIds ?? [];
    // Idempotency: memories already stored for this call means it was processed
    // before (e.g. the pipeline re-ran). applyChanges re-checks inside its
    // transaction; pipeline.processCall also guards with calls.processedAt.
    if (args.callId && (await ctx.runQuery(internal.memories.hasCallMemories, { callId: args.callId }))) {
      return { inserted: 0, merged: 0, resolved: 0 };
    }
    if (items.length === 0) {
      const resolved: number = resolveIds.length
        ? await ctx.runMutation(internal.memories.resolveThreads, { ids: resolveIds, elderId: args.elderId })
        : 0;
      return { inserted: 0, merged: 0, resolved };
    }

    const vectors = await embed(items.map(embeddingText));
    const named: MemoryView[] = await ctx.runQuery(internal.memories.namedForElder, { elderId: args.elderId });

    const inserts: Insert[] = [];
    const merges = new Map<string, Merge>();
    const addMerge = (target: MemoryView, item: { text: string; name?: string; kind: string }, vector: number[]) => {
      const prev = merges.get(target._id);
      const base = prev?.text ?? target.text;
      const text = mergeText(base, item.text);
      const tookIncoming = text !== base.trim() && text === item.text.trim();
      const embedding = tookIncoming ? vector : prev?.embedding;
      merges.set(target._id, {
        id: target._id,
        text,
        ...((target.name ?? item.name) ? { name: target.name ?? item.name } : {}),
        mentions: (prev?.mentions ?? 0) + 1,
        reopen: (prev?.reopen ?? false) || item.kind === "open_thread",
        ...(embedding ? { embedding } : {}),
      });
    };

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const vector = vectors[i];

      // 1. People and places with the same name are the same memory.
      if ((item.kind === "person" || item.kind === "place") && item.name) {
        const sameName = named.find(
          (m) => m.kind === item.kind && m.name && normalizeText(m.name) === normalizeText(item.name),
        );
        if (sameName) {
          addMerge(sameName, item, vector);
          continue;
        }
      }

      // 2. A very similar stored memory of the same kind.
      const hits = await ctx.vectorSearch("memories", "by_embedding", {
        vector,
        limit: 3,
        filter: (q) => q.eq("elderKind", elderKindKey(args.elderId, item.kind)),
      });
      const close = hits.filter((h) => h._score >= MERGE_THRESHOLD);
      let mergedIntoStored = false;
      if (close.length > 0) {
        const docs: MemoryView[] = await ctx.runQuery(internal.memories.getMany, { ids: close.map((h) => h._id) });
        for (const hit of close) {
          const doc = docs.find((d) => d._id === hit._id);
          if (doc && shouldMerge(doc, item, hit._score)) {
            addMerge(doc, item, vector);
            mergedIntoStored = true;
            break;
          }
        }
      }
      if (mergedIntoStored) continue;

      // 3. A very similar item earlier in this same batch (never across two different names).
      const twin = inserts.find(
        (ins) =>
          ins.kind === item.kind &&
          !differentNames(ins, item) &&
          cosineSimilarity(ins.embedding, vector) >= MERGE_THRESHOLD,
      );
      if (twin) {
        const text = mergeText(twin.text, item.text);
        if (text !== twin.text.trim() && text === item.text.trim()) twin.embedding = vector;
        twin.text = text;
        if (!twin.name && item.name) twin.name = item.name;
        continue;
      }

      inserts.push({
        kind: item.kind as Kind,
        text: item.text,
        ...(item.name ? { name: item.name } : {}),
        embedding: vector,
      });
    }

    return await ctx.runMutation(internal.memories.applyChanges, {
      elderId: args.elderId,
      ...(args.callId ? { callId: args.callId } : {}),
      inserts,
      merges: [...merges.values()],
      resolveIds,
    });
  },
});

export const applyChanges = internalMutation({
  args: {
    elderId: v.id("elders"),
    callId: v.optional(v.id("calls")),
    inserts: v.array(
      v.object({ kind: memoryKind, text: v.string(), name: v.optional(v.string()), embedding: v.array(v.float64()) }),
    ),
    merges: v.array(
      v.object({
        id: v.id("memories"),
        text: v.string(),
        name: v.optional(v.string()),
        mentions: v.number(),
        reopen: v.boolean(),
        embedding: v.optional(v.array(v.float64())),
      }),
    ),
    resolveIds: v.array(v.id("memories")),
  },
  handler: async (ctx, args): Promise<{ inserted: number; merged: number; resolved: number }> => {
    // Same idempotency check as addMany, inside the transaction: two concurrent
    // runs for one call conflict here and the retry sees the first run's rows.
    if (args.callId) {
      const callId = args.callId;
      // A call whose items all merged leaves no row with its callId, so memoriesAppliedAt marks it too.
      const already =
        Boolean((await ctx.db.get(callId))?.memoriesAppliedAt) ||
        (await ctx.db
          .query("memories")
          .withIndex("by_call", (q) => q.eq("callId", callId))
          .first()) !== null;
      if (already) return { inserted: 0, merged: 0, resolved: 0 };
    }
    const now = Date.now();
    let merged = 0;
    for (const m of args.merges) {
      const doc = await ctx.db.get(m.id);
      if (!doc || doc.elderId !== args.elderId) continue;
      const text = mergeText(doc.text, m.text);
      const reembed = Boolean(m.embedding) && text !== doc.text.trim() && text === m.text.trim();
      await ctx.db.patch(m.id, {
        text,
        ...(reembed && m.embedding ? { embedding: m.embedding } : {}),
        ...(doc.name === undefined && m.name ? { name: m.name } : {}),
        mentionCount: doc.mentionCount + Math.max(1, Math.floor(m.mentions)),
        lastMentionedAt: now,
        // He brought up an unfinished story again: it's open again.
        ...(m.reopen && doc.kind === "open_thread" && doc.status === "resolved" ? { status: "active" as const } : {}),
      });
      merged += 1;
    }
    for (const ins of args.inserts) {
      await ctx.db.insert("memories", {
        elderId: args.elderId,
        ...(args.callId ? { callId: args.callId } : {}),
        kind: ins.kind,
        text: ins.text,
        ...(ins.name ? { name: ins.name } : {}),
        status: "active",
        mentionCount: 1,
        lastMentionedAt: now,
        elderKind: elderKindKey(args.elderId, ins.kind),
        embedding: ins.embedding,
      });
    }
    const resolved = await resolveOpenThreads(ctx, args.resolveIds, args.elderId);
    if (args.callId && (await ctx.db.get(args.callId))) await ctx.db.patch(args.callId, { memoriesAppliedAt: now });
    return { inserted: args.inserts.length, merged, resolved };
  },
});

async function resolveOpenThreads(
  ctx: MutationCtx,
  ids: Id<"memories">[],
  elderId?: Id<"elders">,
): Promise<number> {
  let resolved = 0;
  for (const id of new Set(ids)) {
    const doc = await ctx.db.get(id);
    if (!doc || doc.kind !== "open_thread" || doc.status !== "active") continue;
    if (elderId && doc.elderId !== elderId) continue;
    await ctx.db.patch(id, { status: "resolved" });
    resolved += 1;
  }
  return resolved;
}

export const resolveThreads = internalMutation({
  // elderId is optional for backwards compatibility: when given, only that elder's threads.
  args: { ids: v.array(v.id("memories")), elderId: v.optional(v.id("elders")) },
  handler: async (ctx, { ids, elderId }): Promise<number> => resolveOpenThreads(ctx, ids, elderId),
});

/** True if memories were already inserted for this call (addMany idempotency). */
export const hasCallMemories = internalQuery({
  args: { callId: v.id("calls") },
  handler: async (ctx, { callId }): Promise<boolean> => {
    if ((await ctx.db.get(callId))?.memoriesAppliedAt) return true;
    return (await ctx.db.query("memories").withIndex("by_call", (q) => q.eq("callId", callId)).first()) !== null;
  },
});

// ---------- read ----------

export type MemorySearchHit = {
  _id: Id<"memories">;
  kind: string;
  text: string;
  name?: string;
  status: "active" | "resolved";
  score: number;
};

export const search = internalAction({
  args: {
    elderId: v.id("elders"),
    text: v.string(),
    k: v.number(),
    kinds: v.optional(v.array(v.string())),
    /** default false: finished open threads are left out */
    includeResolved: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<MemorySearchHit[]> => {
    const text = args.text.trim();
    if (!text) return [];
    const k = Math.max(1, Math.min(Math.floor(Number.isFinite(args.k) ? args.k : 5), 50));
    const kinds = (args.kinds ?? []).filter(isMemoryKind);
    if (args.kinds && args.kinds.length > 0 && kinds.length === 0) return [];

    const [vector] = await embed([text]);
    const hits = await ctx.vectorSearch("memories", "by_embedding", {
      vector,
      limit: Math.min(256, k * 2 + 8),
      filter: (q) =>
        kinds.length === 0
          ? q.eq("elderId", args.elderId)
          : kinds.length === 1
            ? q.eq("elderKind", elderKindKey(args.elderId, kinds[0]))
            : q.or(...kinds.map((kind) => q.eq("elderKind", elderKindKey(args.elderId, kind)))),
    });
    if (hits.length === 0) return [];

    const docs: MemoryView[] = await ctx.runQuery(internal.memories.getMany, { ids: hits.map((h) => h._id) });
    const byId = new Map(docs.map((d) => [d._id as string, d]));
    const out: MemorySearchHit[] = [];
    for (const hit of hits) {
      const doc = byId.get(hit._id);
      if (!doc) continue;
      if (!args.includeResolved && doc.status === "resolved") continue;
      out.push({
        _id: doc._id,
        kind: doc.kind,
        text: doc.text,
        ...(doc.name ? { name: doc.name } : {}),
        status: doc.status,
        score: hit._score,
      });
      if (out.length >= k) break;
    }
    return out;
  },
});

export const listForElder = internalQuery({
  args: {
    elderId: v.id("elders"),
    kinds: v.optional(v.array(v.string())),
    status: v.optional(v.union(v.literal("active"), v.literal("resolved"))),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<MemoryView[]> => {
    const limit = Math.max(1, Math.min(Math.floor(args.limit ?? 50), 500));
    const kinds = args.kinds && args.kinds.length > 0 ? new Set(args.kinds) : null;
    const out: MemoryView[] = [];
    const rows = ctx.db
      .query("memories")
      .withIndex("by_elder_last", (q) => q.eq("elderId", args.elderId))
      .order("desc");
    for await (const doc of rows) {
      if (kinds && !kinds.has(doc.kind)) continue;
      if (args.status && doc.status !== args.status) continue;
      out.push(view(doc));
      if (out.length >= limit) break;
    }
    return out;
  },
});

/** Rows by id, without embeddings (used by search/addMany). */
export const getMany = internalQuery({
  args: { ids: v.array(v.id("memories")) },
  handler: async (ctx, { ids }): Promise<MemoryView[]> => {
    const docs = await Promise.all(ids.map((id) => ctx.db.get(id)));
    return docs.filter((d): d is Doc<"memories"> => d !== null).map(view);
  },
});

/** His people and places, for name-based merging. */
export const namedForElder = internalQuery({
  args: { elderId: v.id("elders") },
  handler: async (ctx, { elderId }): Promise<MemoryView[]> => {
    const out: MemoryView[] = [];
    for (const kind of ["person", "place"] as const) {
      const rows = await ctx.db
        .query("memories")
        .withIndex("by_elder_kind", (q) => q.eq("elderId", elderId).eq("kind", kind))
        .collect();
      out.push(...rows.map(view));
    }
    return out;
  },
});
