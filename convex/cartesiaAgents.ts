// The Cartesia agents, defined in code and pushed by one command: one agent per character
// (lib/characters.ts), each with its own voice, language and personality. The prompt is the
// same template for all (lib/prompts/agent.ts); each call fills in its goal and context.
//
//   npx convex run cartesiaAgents:syncAgent                            every character (create if missing)
//   npx convex run cartesiaAgents:syncAgent '{"characterId":"pip"}'    one character
//
// Agent ids live in the characterAgents table (written here, read by cartesia.startCall), so
// a new agent needs no env change. Non-English characters need their voice env var set (a
// voice in their language; never Pip's English one).
// Env: CARTESIA_API_KEY, CARTESIA_MODEL (optional), each character's voiceEnv. Owner: Voice + Brain.

import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { buildAgentConfig, classifyHttp } from "./lib/cartesia";
import { cartesiaFetch, httpError, requireEnv } from "./lib/cartesiaHttp";
import { CHARACTERS, getCharacter, type CharacterConfig } from "./lib/characters";
import { characterAgent } from "./lib/prompts/agent";

declare const process: { env: Record<string, string | undefined> };

/** characterId -> Cartesia agent id, for every character synced so far. */
export const agentIds = internalQuery({
  args: {},
  handler: async (ctx): Promise<Record<string, string>> => {
    const rows = await ctx.db.query("characterAgents").collect();
    return Object.fromEntries(rows.map((r) => [r.characterId, r.agentId]));
  },
});

export const saveAgentId = internalMutation({
  args: { characterId: v.string(), agentId: v.string() },
  handler: async (ctx, { characterId, agentId }) => {
    const row = await ctx.db
      .query("characterAgents")
      .withIndex("by_character", (q) => q.eq("characterId", characterId))
      .first();
    if (row) await ctx.db.patch(row._id, { agentId, syncedAt: Date.now() });
    else await ctx.db.insert("characterAgents", { characterId, agentId, syncedAt: Date.now() });
  },
});

/** Prompt + settings for one character's agent. Same in-call model for all. */
function agentSettings(c: CharacterConfig) {
  const voiceId = process.env[c.voiceEnv];
  // Without a voice Cartesia uses its default, which is English.
  if (c.language !== "en" && !voiceId) throw new Error(`${c.voiceEnv} is not set (needed for ${c.id}'s ${c.language} voice)`);
  const prompt = characterAgent(c);
  return {
    name: prompt.name,
    instructions: prompt.instructions,
    initialMessage: prompt.greeting,
    placeholders: prompt.placeholders,
    language: c.language,
    model: process.env.CARTESIA_MODEL,
    voiceId,
  };
}

type SyncResult = { characterId: string; agentId: string; created: boolean };

/** Create the character's agent (no id stored yet) or update it from code. */
async function syncOne(c: CharacterConfig, existing: string | undefined): Promise<{ agentId: string; created: boolean }> {
  const res = await cartesiaFetch(existing ? `/v1/agents/${existing}` : "/v1/agents", {
    method: existing ? "PATCH" : "POST",
    body: buildAgentConfig(agentSettings(c)),
  });
  const label = `${c.id} agent`;
  if (classifyHttp(res.status) !== "ok") throw new Error(`${label}: ${httpError(res, true)}`);
  const agentId = existing ?? res.json?.id ?? res.json?.agent_id;
  if (!agentId) throw new Error(`Cartesia created the ${label} but returned no id; copy it from the dashboard`);
  if (!existing) console.log(`cartesiaAgents.syncAgent: created ${label} ${agentId}`);
  return { agentId, created: !existing };
}

/**
 * Push the agents from code. Every character is attempted even if one fails, so a Spanish
 * voice problem never blocks Pip's update (and vice versa).
 */
export const syncAgent = internalAction({
  args: { characterId: v.optional(v.string()) },
  handler: async (ctx, { characterId }): Promise<{ agents: SyncResult[] }> => {
    requireEnv(["CARTESIA_API_KEY"]);
    if (characterId && !getCharacter(characterId)) throw new Error(`Unknown character "${characterId}" (see lib/characters.ts)`);
    const targets = CHARACTERS.filter((c) => !characterId || c.id === characterId);
    const ids = await ctx.runQuery(internal.cartesiaAgents.agentIds, {});
    const agents: SyncResult[] = [];
    const errors: string[] = [];
    for (const c of targets) {
      try {
        const { agentId, created } = await syncOne(c, ids[c.id]);
        // Saved right away, so a later character's failure never loses a new agent's id.
        await ctx.runMutation(internal.cartesiaAgents.saveAgentId, { characterId: c.id, agentId });
        agents.push({ characterId: c.id, agentId, created });
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }
    if (errors.length) throw new Error(`cartesiaAgents.syncAgent: ${errors.join("; ")}`);
    return { agents };
  },
});
