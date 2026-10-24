"use node";

// Post guard: a fact-check that runs right before a post goes live.
//
// Posts are auto-published with no human approval, so this is the safety net.
// Claude compares the final LinkedIn text with what he actually said on the
// call and flags anything he didn't say (facts, numbers, names, dates, places,
// advice), private details about other people, and medical/legal/financial
// advice.
//
// POST_GUARD_MODE (Convex env):
//   enforce (default)  failing posts are NOT posted; the posts row becomes needs_review
//   warn               post anyway, keep the issues on the row
//   off                skip the check
//
// Called by linkedapi.createPost / linkedapi.previewPost:
//   await ctx.runAction(internal.postGuard.checkPost, { postText, turns })
//
// Env: ANTHROPIC_API_KEY, POST_GUARD_MODE. Owner: Integrations.

import Anthropic from "@anthropic-ai/sdk";
import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { elderWords, parseGuardMode } from "./lib/linkedinPost";

// Convex exposes env vars on process.env (declared so we don't need @types/node).
declare const process: { env: Record<string, string | undefined> };

const MODEL = "claude-opus-5-5";
// Server-side fallback: if a safety classifier declines, Anthropic re-runs the
// request on its recommended fallback model inside the same call.
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

const JUDGE_SYSTEM = `You are a strict fact-checker for LinkedIn posts written from an older professional's phone interview.
You get (1) exactly what he said on the call (speech-to-text, so expect small transcription errors) and (2) the post that will be published on his own LinkedIn account in his name.

List every problem, each as one short line that quotes or paraphrases the offending part:
- Unsupported content: any fact, number, date, name, place, company, job title, event, opinion, advice or lesson in the post that he did not say or clearly imply.
- Privacy: private details about other people (health, family conflicts, money, contact details, full names of private individuals told in confidence).
- Professional advice: medical, legal, tax or investment advice presented as guidance to readers.

These are fine and are NOT problems: paraphrasing, shortening, reordering, fixing grammar or obvious transcription errors, a hook line or closing question to readers that doesn't add new facts, hashtags, and the final line disclosing the post was written up with AI.

pass must be true only when issues is empty. summary is one sentence for the person reviewing.`;

const RESULT_SCHEMA = {
  type: "object",
  properties: {
    pass: { type: "boolean" },
    issues: { type: "array", items: { type: "string" } },
    summary: { type: "string" },
  },
  required: ["pass", "issues", "summary"],
  additionalProperties: false,
};

const turnValidator = v.object({ role: v.string(), text: v.string() });

type GuardResult = {
  pass: boolean;
  issues: string[];
  summary: string;
  mode: "enforce" | "warn" | "off";
};

export const checkPost = internalAction({
  args: { postText: v.string(), turns: v.array(turnValidator) },
  handler: async (_ctx, { postText, turns }): Promise<GuardResult> => {
    const mode = parseGuardMode(process.env.POST_GUARD_MODE);
    if (mode === "off") {
      return { pass: true, issues: [], summary: "Post guard is off (POST_GUARD_MODE=off).", mode };
    }

    const words = elderWords(turns);
    if (!words.trim()) {
      return {
        pass: false,
        issues: ["The transcript has no words from him, so the post can't be checked."],
        summary: "Nothing to check against.",
        mode,
      };
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      return {
        pass: false,
        issues: ["ANTHROPIC_API_KEY is not set in Convex, so the post was not fact-checked."],
        summary: "Fact-check could not run.",
        mode,
      };
    }

    try {
      const client = new Anthropic();
      const response = await client.beta.messages.create({
        model: MODEL,
        max_tokens: 16000,
        betas: [FALLBACK_BETA],
        fallbacks: "default",
        system: JUDGE_SYSTEM,
        output_config: {
          effort: "medium",
          format: { type: "json_schema", schema: RESULT_SCHEMA },
        },
        messages: [
          {
            role: "user",
            content: `WHAT HE SAID ON THE CALL:\n${words}\n\nPOST TO CHECK:\n${postText}`,
          },
        ],
      });

      if (response.stop_reason === "refusal") {
        const category = response.stop_details?.category ?? "unknown";
        return {
          pass: false,
          issues: [`The fact-checker declined to review this post (category: ${category}).`],
          summary: "Fact-check declined.",
          mode,
        };
      }

      const textBlock = response.content.find((b) => b.type === "text");
      const raw = textBlock && textBlock.type === "text" ? textBlock.text : "";
      const parsed = JSON.parse(raw) as Partial<GuardResult>;
      const issues = Array.isArray(parsed.issues)
        ? parsed.issues.filter((i): i is string => typeof i === "string" && i.trim() !== "")
        : [];
      return {
        pass: parsed.pass === true && issues.length === 0,
        issues,
        summary: typeof parsed.summary === "string" ? parsed.summary : "",
        mode,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        pass: false,
        issues: [`Fact-check failed to run: ${message}`],
        summary: "Fact-check error.",
        mode,
      };
    }
  },
});
