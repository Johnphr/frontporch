// The Cartesia agents, defined in code and pushed by one command: one agent per character
// (lib/characters.ts), each with its own voice, language and personality. The prompt is the
// same template for all (lib/prompts/agent.ts); each call fills in its goal and context.
//
//   npx convex run cartesiaAgents:syncAgent                            every character (create if missing)
//   npx convex run cartesiaAgents:syncAgent '{"characterId":"oscar"}'  one character
//   npx convex run cartesiaAgents:syncAgent '{"inbound":true,"assignNumber":true}'
//                                    inbound agent + lookup_caller tool (create if missing), and
//                                    route the number's inbound calls to it (lib/prompts/inbound.ts)
//
// Agent ids live in the characterAgents table (written here, read by cartesia.startCall), so
// a new agent needs no env change. Non-English characters need their voice env var set (a
// voice in their language; never an English one).
// The inbound agent is ONE host for every caller (a Cartesia agent has one voice, and there is
// no mid-call voice change or agent hand-off): CARTESIA_INBOUND_HOST (a character id, default
// daniel; diana implies Spanish) sets its voice, language and persona. Its voice: that host's
// voice env var, else copied from that host's synced agent. Callers with another host get a
// callback from their host (inbound.ts). Re-sync '{"inbound":true}' after changing it.
// Env: CARTESIA_API_KEY, CARTESIA_MODEL (optional), each character's voiceEnv; inbound:
//      CARTESIA_TOOL_SECRET, CARTESIA_INBOUND_AGENT_ID + CARTESIA_LOOKUP_TOOL_ID (printed on create),
//      CARTESIA_INBOUND_HOST (optional, character id), CARTESIA_INBOUND_LANGUAGE (optional, en|es;
//      only picks the default host when CARTESIA_INBOUND_HOST is unset), CARTESIA_FROM_NUMBER_ID
//      (assignNumber), INBOUND_SITE_URL (only if CONVEX_SITE_URL is unavailable). Owner: Voice + Brain.

import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { buildAgentConfig, classifyHttp } from "./lib/cartesia";
import { cartesiaFetch, httpError, requireEnv } from "./lib/cartesiaHttp";
import { CHARACTERS, getCharacter, type CharacterConfig } from "./lib/characters";
import { buildLookupTool, inboundHost, inboundHostProblem, inboundSyncMode, lookupUrl } from "./lib/inbound";
import { characterAgent } from "./lib/prompts/agent";
import { inboundAgent } from "./lib/prompts/inbound";

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
function agentSettings(c: CharacterConfig, existing: string | undefined) {
  const voiceId = process.env[c.voiceEnv];
  // Without a voice a new agent gets Cartesia's default, which is English. An existing agent
  // keeps the voice it has (no voice is sent), so linked agents need no env var.
  if (!existing && c.language !== "en" && !voiceId) {
    throw new Error(`${c.voiceEnv} is not set (needed for ${c.id}'s ${c.language} voice)`);
  }
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
    body: buildAgentConfig(agentSettings(c, existing)),
  });
  const label = `${c.id} agent`;
  if (classifyHttp(res.status) !== "ok") throw new Error(`${label}: ${httpError(res, true)}`);
  const agentId = existing ?? res.json?.id ?? res.json?.agent_id;
  if (!agentId) throw new Error(`Cartesia created the ${label} but returned no id; copy it from the dashboard`);
  if (!existing) console.log(`cartesiaAgents.syncAgent: created ${label} ${agentId}`);
  return { agentId, created: !existing };
}

type InboundResult = { toolId: string; agentId: string; created: string[]; numberAssigned?: boolean };

/**
 * The line host's voice: the host's voice env var, else the voice on the host's synced agent
 * (GET), so the inbound agent sounds exactly like that host. Undefined only if neither exists.
 */
async function inboundVoice(host: CharacterConfig, hostAgentId: string | undefined): Promise<string | undefined> {
  const fromEnv = process.env[host.voiceEnv];
  if (fromEnv || !hostAgentId) return fromEnv;
  const res = await cartesiaFetch(`/v1/agents/${hostAgentId}`, { method: "GET" });
  if (classifyHttp(res.status) !== "ok") throw new Error(`${host.id} agent: ${httpError(res, true)}`);
  const cfg = res.json?.config ?? res.json;
  const voiceId = cfg?.audio?.output?.voice_id ?? cfg?.voice_id;
  return typeof voiceId === "string" && voiceId ? voiceId : undefined;
}

/**
 * The inbound agent + its lookup_caller tool (lib/inbound.ts, lib/prompts/inbound.ts). Created
 * only when asked ('{"inbound":true}'); a plain sync updates them once their ids are set.
 * `assignNumber` routes CARTESIA_FROM_NUMBER_ID's inbound calls to this agent (outbound calls
 * from the number keep working: docs.cartesia.ai phone-numbers).
 */
async function syncInbound(mayCreate: boolean, assignNumber: boolean, agentIds: Record<string, string>): Promise<InboundResult | null> {
  const toolEnv = "CARTESIA_LOOKUP_TOOL_ID";
  const agentEnv = "CARTESIA_INBOUND_AGENT_ID";
  const existingTool = process.env[toolEnv];
  const existingAgent = process.env[agentEnv];
  if (inboundSyncMode(mayCreate, existingAgent, existingTool) === "skip") {
    if (existingAgent || existingTool) {
      console.log("cartesiaAgents.syncAgent: inbound skipped (set both CARTESIA_INBOUND_AGENT_ID and CARTESIA_LOOKUP_TOOL_ID, or run {\"inbound\":true})");
    }
    return null;
  }
  const { CARTESIA_TOOL_SECRET: secret } = requireEnv(["CARTESIA_TOOL_SECRET"]);
  const created: string[] = [];

  // 1. The webhook tool (shared resource; the agent references it by id).
  const toolBody = buildLookupTool({ url: lookupUrl(process.env.INBOUND_SITE_URL ?? process.env.CONVEX_SITE_URL), secret });
  const toolRes = await cartesiaFetch(existingTool ? `/v1/agents/tools/${existingTool}` : "/v1/agents/tools", {
    method: existingTool ? "PATCH" : "POST",
    body: existingTool ? { ...toolBody, type: undefined } : toolBody,
  });
  if (classifyHttp(toolRes.status) !== "ok") {
    // Cartesia's validation message says what to fix; blank the secret in case it's echoed.
    const detail = JSON.stringify(toolRes.json ?? null).split(secret).join("***").slice(0, 500);
    throw new Error(`lookup tool: ${httpError(toolRes)} ${detail}`);
  }
  const toolId = existingTool ?? toolRes.json?.id ?? toolRes.json?.tool_id;
  if (!toolId) throw new Error("Cartesia created the lookup tool but returned no id; copy it from the dashboard");
  if (!existingTool) created.push(`npx convex env set ${toolEnv} ${toolId}`);

  // 2. The agent, with the tool attached. It IS one host (CARTESIA_INBOUND_HOST): that host's
  //    voice, language (one primary language per Cartesia agent) and persona.
  const hostProblem = inboundHostProblem(process.env);
  if (hostProblem) throw new Error(hostProblem);
  const host = inboundHost(process.env);
  const voiceId = await inboundVoice(host, agentIds[host.id]);
  if (!voiceId) {
    // The whole point of the host setting is the voice: refuse rather than sync a mismatched one.
    if (process.env.CARTESIA_INBOUND_HOST) throw new Error(`No voice for ${host.name}: set ${host.voiceEnv} or sync that host's agent first`);
    console.warn(`cartesiaAgents.syncAgent: ${host.voiceEnv} is not set; the inbound agent keeps its current voice`);
  }
  const prompt = inboundAgent(host);
  const agentRes = await cartesiaFetch(existingAgent ? `/v1/agents/${existingAgent}` : "/v1/agents", {
    method: existingAgent ? "PATCH" : "POST",
    body: buildAgentConfig({
      name: prompt.name,
      instructions: prompt.instructions,
      initialMessage: prompt.greeting,
      placeholders: prompt.placeholders,
      language: host.language,
      model: process.env.CARTESIA_MODEL,
      voiceId,
      tools: [toolId],
    }),
  });
  console.log(`cartesiaAgents.syncAgent: inbound agent speaks as ${host.id} (${host.language})`);
  if (classifyHttp(agentRes.status) !== "ok") throw new Error(`inbound agent: ${httpError(agentRes, true)}`);
  const agentId = existingAgent ?? agentRes.json?.id ?? agentRes.json?.agent_id;
  if (!agentId) throw new Error("Cartesia created the inbound agent but returned no id; copy it from the dashboard");
  if (!existingAgent) created.push(`npx convex env set ${agentEnv} ${agentId}`);

  // 3. Optional: route the number's inbound calls to it.
  let numberAssigned: boolean | undefined;
  if (assignNumber) {
    const { CARTESIA_FROM_NUMBER_ID: numberId } = requireEnv(["CARTESIA_FROM_NUMBER_ID"]);
    const res = await cartesiaFetch(`/agents/phone-numbers/${numberId}`, { method: "PATCH", body: { agent_id: agentId } });
    if (classifyHttp(res.status) !== "ok") throw new Error(`assign number: ${httpError(res)}`);
    numberAssigned = true;
  }
  for (const line of created) console.log(`cartesiaAgents.syncAgent: created inbound piece. Run: ${line}`);
  return { toolId, agentId, created, ...(numberAssigned ? { numberAssigned } : {}) };
}

/**
 * Push the agents from code. Every character is attempted even if one fails, so a Spanish
 * voice problem never blocks Pip's update (and vice versa).
 */
export const syncAgent = internalAction({
  args: { characterId: v.optional(v.string()), inbound: v.optional(v.boolean()), assignNumber: v.optional(v.boolean()) },
  handler: async (ctx, { characterId, inbound, assignNumber }): Promise<{ agents: SyncResult[]; inbound?: InboundResult }> => {
    requireEnv(["CARTESIA_API_KEY"]);
    if (inbound) {
      const ids = await ctx.runQuery(internal.cartesiaAgents.agentIds, {});
      const result = await syncInbound(true, assignNumber ?? false, ids);
      return { agents: [], ...(result ? { inbound: result } : {}) };
    }
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
    // A plain sync (no characterId) also updates the inbound agent + tool once both ids are set.
    let inboundResult: InboundResult | null = null;
    if (!characterId) {
      try {
        inboundResult = await syncInbound(false, false, ids);
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }
    if (errors.length) throw new Error(`cartesiaAgents.syncAgent: ${errors.join("; ")}`);
    return { agents, ...(inboundResult ? { inbound: inboundResult } : {}) };
  },
});
