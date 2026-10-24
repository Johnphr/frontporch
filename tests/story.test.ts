// Slice 2: story follow-up calls (story agent prompt, call reservation, variables, AUTO_POST).
// Run: node --test "tests/**/*.test.ts"
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildAgentConfig, templateVariables } from "../convex/lib/cartesia.ts";
import { agentEnvName, reserveDecision } from "../convex/lib/onboarding.ts";
import { PROMPT_VARIABLES, buildCallPlan, toPromptVariables } from "../convex/lib/planner.ts";
import { parseAutoPost } from "../convex/lib/postFlow.ts";
import {
  STORY_AGENT_NAME,
  STORY_GREETING,
  STORY_INSTRUCTIONS,
  STORY_PLACEHOLDERS,
} from "../convex/lib/prompts/story.ts";
import { NOW } from "./helpers.ts";

const VAR = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
const varsIn = (text: string) => [...new Set([...text.matchAll(VAR)].map((m) => m[1]))].sort();

const onboarded = {
  stage: "active",
  profile: { industry: "Baking", specialty: "Bread production", careerSummary: "Ran a bakery for 30 years." },
};

test("story prompt, placeholders and planner variables use exactly the same names", () => {
  const used = varsIn(`${STORY_INSTRUCTIONS}\n${STORY_GREETING}`);
  assert.deepEqual(used, [...PROMPT_VARIABLES].sort());
  assert.deepEqual(Object.keys(STORY_PLACEHOLDERS).sort(), [...PROMPT_VARIABLES].sort());
  for (const value of Object.values(STORY_PLACEHOLDERS)) assert.ok(value.trim(), "placeholders are never empty");
});

test("story prompt fences planner data and says it's data, not instructions; greeting discloses AI", () => {
  for (const tag of ["profile", "memories", "reader_feedback", "main_question", "threads"]) {
    assert.match(STORY_INSTRUCTIONS, new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`), `<${tag}> fence`);
  }
  assert.match(STORY_INSTRUCTIONS, /never instructions/i);
  assert.match(STORY_GREETING, /\bAI\b/);
  assert.match(STORY_GREETING, /\{\{firstName\}\}/);
});

test("story agent config builds with its own name, greeting and placeholders", () => {
  const body = buildAgentConfig({
    name: STORY_AGENT_NAME,
    instructions: STORY_INSTRUCTIONS,
    initialMessage: STORY_GREETING,
    placeholders: STORY_PLACEHOLDERS,
  });
  assert.equal(body.name, "Pip - story");
  assert.equal(body.config.instructions, STORY_INSTRUCTIONS);
  assert.equal(body.config.initial_message, STORY_GREETING);
  assert.deepEqual(body.config.dynamic_variable_placeholders, STORY_PLACEHOLDERS);
  assert.ok(body.config.system_tools.end_call.description);
});

test("story dynamic variables: all strings, never empty, cover every {{var}} in the prompt", () => {
  const plan = buildCallPlan({
    kind: "story",
    bank: [
      { _id: "b1", question: "Tell me how you hired Eddie.", topicKey: "eddie" },
      { _id: "b2", question: "What was the Golden Crust plant like?", topicKey: "golden-crust" },
    ],
    memories: [{ kind: "person", name: "Eddie", text: "His foreman" }],
  });
  const vars = templateVariables(toPromptVariables(plan, { name: "Walter Brandt", language: "en-US", ...onboarded }));
  for (const name of varsIn(`${STORY_INSTRUCTIONS}\n${STORY_GREETING}`)) {
    assert.equal(typeof vars[name], "string", name);
    assert.ok(vars[name].trim(), `${name} is never empty ("none" instead)`);
  }
  assert.equal(vars.firstName, "Walter");
  assert.equal(vars.mainQuestion, "Tell me how you hired Eddie.");
  assert.equal(vars.feedback, "none"); // nothing from readers yet
  assert.equal(plan.bankId, "b1"); // what startCall passes to conversation.markPlanUsed
});

test("reserveDecision: story for an onboarded elder, onboarding otherwise", () => {
  assert.deepEqual(reserveDecision(onboarded, [], NOW, { force: false }), { ok: true, kind: "story" });
  assert.deepEqual(reserveDecision({}, [], NOW, { force: false }), { ok: true, kind: "onboarding" });
  // active but no usable profile -> onboards again
  assert.deepEqual(reserveDecision({ stage: "active", profile: {} }, [], NOW, { force: false }), {
    ok: true,
    kind: "onboarding",
  });
});

test("reserveDecision: refuses a second open call unless forced", () => {
  const open = [{ status: "in_progress", _creationTime: NOW - 5 * 60_000 }];
  const refused = reserveDecision(onboarded, open, NOW, { force: false });
  assert.equal(refused.ok, false);
  assert.match(!refused.ok ? refused.reason : "", /already open/);
  assert.deepEqual(reserveDecision(onboarded, open, NOW, { force: true }), { ok: true, kind: "story" });
  // a finished call doesn't block
  assert.deepEqual(reserveDecision(onboarded, [{ status: "done", _creationTime: NOW - 1000 }], NOW, { force: false }), {
    ok: true,
    kind: "story",
  });
});

test("reserveDecision: refuses when the kind changed since startCall checked its env", () => {
  const changed = reserveDecision(onboarded, [], NOW, { force: false, expectedKind: "onboarding" });
  assert.equal(changed.ok, false);
  assert.match(!changed.ok ? changed.reason : "", /now story/);
  assert.deepEqual(reserveDecision(onboarded, [], NOW, { force: false, expectedKind: "story" }), {
    ok: true,
    kind: "story",
  });
});

test("agentEnvName: one Cartesia agent per call kind", () => {
  assert.equal(agentEnvName("onboarding"), "CARTESIA_ONBOARDING_AGENT_ID");
  assert.equal(agentEnvName("story"), "CARTESIA_STORY_AGENT_ID");
});

test("parseAutoPost: on by default, off only when asked", () => {
  assert.equal(parseAutoPost(undefined), true);
  assert.equal(parseAutoPost(""), true);
  assert.equal(parseAutoPost("on"), true);
  assert.equal(parseAutoPost("true"), true);
  for (const off of ["off", "OFF", " false ", "0", "no"]) assert.equal(parseAutoPost(off), false, off);
});
