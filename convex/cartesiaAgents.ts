// The Cartesia agents, defined in code (lib/prompts/) and pushed by one command. Up to four:
// onboarding + story, in English (Pip) and Spanish (Juanito); elders.language picks the pair.
//
//   npx convex run cartesiaAgents:syncAgent                         English agents (create if missing)
//                                                                   + Spanish ones that already exist
//   npx convex run cartesiaAgents:syncAgent '{"language":"es"}'     Spanish agents (create if missing)
//   npx convex run cartesiaAgents:syncAgent '{"only":"story"}'      one kind
//
// A created agent's id is printed with the `npx convex env set` line to run. Spanish agents
// need CARTESIA_VOICE_ID_ES (a Spanish voice; never Pip's English one).
// Env: CARTESIA_API_KEY, CARTESIA_MODEL (optional), CARTESIA_VOICE_ID (optional),
//      CARTESIA_VOICE_ID_ES (Spanish agents). Owner: Voice + Brain.

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { buildAgentConfig, classifyHttp } from "./lib/cartesia";
import { cartesiaFetch, httpError, requireEnv } from "./lib/cartesiaHttp";
import { agentEnvName, type CallKind } from "./lib/onboarding";
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

/**
 * Push the agents from code. Every agent is attempted even if one fails, so a Spanish-agent
 * problem never blocks English updates (and vice versa).
 */
export const syncAgent = internalAction({
  args: {
    only: v.optional(v.union(v.literal("onboarding"), v.literal("story"))),
    language: v.optional(v.union(v.literal("en"), v.literal("es"))),
  },
  handler: async (_ctx, { only, language }): Promise<{ agents: SyncResult[] }> => {
    requireEnv(["CARTESIA_API_KEY"]);
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
    if (errors.length) throw new Error(`cartesiaAgents.syncAgent: ${errors.join("; ")}`);
    return { agents };
  },
});
