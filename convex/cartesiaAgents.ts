// The Cartesia agents, defined in code (lib/prompts/) and pushed by one command. Up to four:
// onboarding + story, in English (Pip) and Spanish (Juanito); elders.language picks the pair.
//
//   npx convex run cartesiaAgents:syncAgent                         English agents (create if missing)
//                                                                   + Spanish ones that already exist
//   npx convex run cartesiaAgents:syncAgent '{"language":"es"}'     Spanish agents (create if missing)
//   npx convex run cartesiaAgents:syncAgent '{"only":"story"}'      one kind
//   npx convex run cartesiaAgents:syncAgent '{"only":"inbound","assignNumber":true}'
//                                    inbound agent + lookup_caller tool (create if missing),
//                                    and route the number's inbound calls to it
//
// A created agent's id is printed with the `npx convex env set` line to run. Spanish agents
// need CARTESIA_VOICE_ID_ES (a Spanish voice; never Pip's English one).
// Env: CARTESIA_API_KEY, CARTESIA_MODEL (optional), CARTESIA_VOICE_ID (optional),
//      CARTESIA_VOICE_ID_ES (Spanish agents); inbound: CARTESIA_TOOL_SECRET,
//      CARTESIA_INBOUND_AGENT_ID, CARTESIA_LOOKUP_TOOL_ID (both printed on create),
//      CARTESIA_INBOUND_LANGUAGE (optional), CARTESIA_FROM_NUMBER_ID (assignNumber),
//      INBOUND_SITE_URL (only if CONVEX_SITE_URL is unavailable). Owner: Voice + Brain.

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { buildAgentConfig, classifyHttp } from "./lib/cartesia";
import { cartesiaFetch, httpError, requireEnv } from "./lib/cartesiaHttp";
import { buildLookupTool, inboundSyncMode, lookupUrl } from "./lib/inbound";
import { agentEnvName, type CallKind } from "./lib/onboarding";
import { inboundAgent } from "./lib/prompts/inbound";
import { onboardingAgent } from "./lib/prompts/onboarding";
import type { CallLanguage } from "./lib/prompts/principles";
import { storyAgent } from "./lib/prompts/story";

declare const process: { env: Record<string, string | undefined> };

const VOICE_ENV: Record<CallLanguage, string> = { en: "CARTESIA_VOICE_ID", es: "CARTESIA_VOICE_ID_ES" };

/** Prompt + settings for one agent. Same in-call model for all; the voice follows the language. */
function agentSettings(kind: CallKind, lang: CallLanguage) {
  const voiceId = process.env[VOICE_ENV[lang]];
  if (lang !== "en" && !voiceId) throw new Error(`${VOICE_ENV[lang]} is not set (needed for the ${lang} agents)`);
  const prompt = kind === "story" ? storyAgent(lang) : onboardingAgent(lang);
  return {
    name: prompt.name,
    instructions: prompt.instructions,
    initialMessage: prompt.greeting,
    placeholders: prompt.placeholders,
    language: lang,
    model: process.env.CARTESIA_MODEL,
    voiceId,
  };
}

type SyncResult = { kind: CallKind; language: CallLanguage; agentId?: string; created?: boolean; skipped?: string };

/** Create the agent (no id in env yet, and creating is allowed) or update it from code. */
async function syncOne(kind: CallKind, lang: CallLanguage, mayCreate: boolean): Promise<SyncResult> {
  const envName = agentEnvName(kind, lang);
  const existing = process.env[envName];
  if (!existing && !mayCreate) {
    return { kind, language: lang, skipped: `${envName} not set; create it with '{"language":"${lang}"}'` };
  }
  const res = await cartesiaFetch(existing ? `/v1/agents/${existing}` : "/v1/agents", {
    method: existing ? "PATCH" : "POST",
    body: buildAgentConfig(agentSettings(kind, lang)),
  });
  const label = `${kind} (${lang}) agent`;
  if (classifyHttp(res.status) !== "ok") throw new Error(`${label}: ${httpError(res, true)}`);
  const agentId = existing ?? res.json?.id ?? res.json?.agent_id;
  if (!agentId) throw new Error(`Cartesia created the ${label} but returned no id; copy it from the dashboard`);
  if (!existing) console.log(`cartesiaAgents.syncAgent: created ${label} ${agentId}. Run: npx convex env set ${envName} ${agentId}`);
  return { kind, language: lang, agentId, created: !existing };
}

type InboundResult = { toolId: string; agentId: string; created: string[]; numberAssigned?: boolean };

/**
 * The inbound agent + its lookup_caller tool (lib/inbound.ts, lib/prompts/inbound.ts). Created
 * only when asked ('{"only":"inbound"}'); a plain sync updates them once their ids are set.
 * `assignNumber` routes CARTESIA_FROM_NUMBER_ID's inbound calls to this agent (outbound calls
 * from the number keep working: docs.cartesia.ai phone-numbers).
 */
async function syncInbound(mayCreate: boolean, assignNumber: boolean): Promise<InboundResult | null> {
  const toolEnv = "CARTESIA_LOOKUP_TOOL_ID";
  const agentEnv = "CARTESIA_INBOUND_AGENT_ID";
  const existingTool = process.env[toolEnv];
  const existingAgent = process.env[agentEnv];
  if (inboundSyncMode(mayCreate, existingAgent, existingTool) === "skip") {
    if (existingAgent || existingTool) {
      console.log("cartesiaAgents.syncAgent: inbound skipped (set both CARTESIA_INBOUND_AGENT_ID and CARTESIA_LOOKUP_TOOL_ID, or run {\"only\":\"inbound\"})");
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
  if (classifyHttp(toolRes.status) !== "ok") throw new Error(`lookup tool: ${httpError(toolRes)}`); // no detail: the body holds the secret
  const toolId = existingTool ?? toolRes.json?.id ?? toolRes.json?.tool_id;
  if (!toolId) throw new Error("Cartesia created the lookup tool but returned no id; copy it from the dashboard");
  if (!existingTool) created.push(`npx convex env set ${toolEnv} ${toolId}`);

  // 2. The agent, with the tool attached. Its language/voice: CARTESIA_INBOUND_LANGUAGE
  //    (default en; Cartesia agents have one primary language for speech recognition + voice).
  const lang: CallLanguage = process.env.CARTESIA_INBOUND_LANGUAGE === "es" ? "es" : "en";
  const prompt = inboundAgent();
  const agentRes = await cartesiaFetch(existingAgent ? `/v1/agents/${existingAgent}` : "/v1/agents", {
    method: existingAgent ? "PATCH" : "POST",
    body: buildAgentConfig({
      name: prompt.name,
      instructions: prompt.instructions,
      initialMessage: prompt.greeting,
      placeholders: prompt.placeholders,
      language: lang,
      model: process.env.CARTESIA_MODEL,
      voiceId: process.env[VOICE_ENV[lang]],
      tools: [toolId],
    }),
  });
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
 * Push the agents from code. Every agent is attempted even if one fails, so a Spanish-agent
 * problem never blocks English updates (and vice versa).
 */
export const syncAgent = internalAction({
  args: {
    only: v.optional(v.union(v.literal("onboarding"), v.literal("story"), v.literal("inbound"))),
    language: v.optional(v.union(v.literal("en"), v.literal("es"))),
    assignNumber: v.optional(v.boolean()),
  },
  handler: async (_ctx, { only, language, assignNumber }): Promise<{ agents: SyncResult[]; inbound?: InboundResult }> => {
    requireEnv(["CARTESIA_API_KEY"]);
    if (only === "inbound") {
      const inbound = await syncInbound(true, assignNumber ?? false);
      return { agents: [], ...(inbound ? { inbound } : {}) };
    }
    const kinds: CallKind[] = only ? [only] : ["onboarding", "story"];
    const langs: CallLanguage[] = language ? [language] : ["en", "es"];
    const agents: SyncResult[] = [];
    const errors: string[] = [];
    for (const lang of langs) {
      for (const kind of kinds) {
        try {
          // Without an explicit language, only English agents are created; Spanish ones only update.
          agents.push(await syncOne(kind, lang, Boolean(language) || lang === "en"));
        } catch (err) {
          errors.push(err instanceof Error ? err.message : String(err));
        }
      }
    }
    // A plain sync (no `only`) also updates the inbound agent + tool once they exist.
    let inbound: InboundResult | null = null;
    if (!only) {
      try {
        inbound = await syncInbound(false, false);
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }
    if (errors.length) throw new Error(`cartesiaAgents.syncAgent: ${errors.join("; ")}`);
    return { agents, ...(inbound ? { inbound } : {}) };
  },
});
