// The one agent prompt every character uses (lib/prompts/agent.ts): variables, persona,
// shared principles + guardrails, fences, and both call goals.
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildAgentConfig } from "../convex/lib/cartesia.ts";
import { CHARACTERS, getCharacter } from "../convex/lib/characters.ts";
import { CALL_VARIABLES, CONTEXT_PARTS, callGoal, characterAgent } from "../convex/lib/prompts/agent.ts";
import { conversationPrinciples, guardrails, persona, type CallLanguage } from "../convex/lib/prompts/principles.ts";

const VAR = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
const varsIn = (text: string) => [...new Set([...text.matchAll(VAR)].map((m) => m[1]))].sort();
const LANGS: CallLanguage[] = ["en", "es"];

for (const c of CHARACTERS) {
  test(`${c.id} agent: prompt, greeting and placeholders use exactly the call variables`, () => {
    const agent = characterAgent(c);
    assert.deepEqual(varsIn(`${agent.instructions}\n${agent.greeting}`), [...CALL_VARIABLES].sort());
    assert.deepEqual(Object.keys(agent.placeholders).sort(), [...CALL_VARIABLES].sort());
    for (const value of Object.values(agent.placeholders)) assert.ok(value.trim(), "placeholders are never empty");
  });

  test(`${c.id} agent: persona + personality, shared principles + guardrails, fenced context, one goal`, () => {
    const { instructions, greeting, name } = characterAgent(c);
    for (const part of [persona(c), conversationPrinciples(c.language), guardrails(c.language)]) {
      assert.ok(instructions.includes(part));
    }
    assert.ok(instructions.includes(c.personality));
    assert.match(instructions, new RegExp(`You are always ${c.name}, and only ${c.name}`));
    assert.match(instructions, /tell them plainly that you're an AI/); // admits it when asked
    assert.match(instructions, /Today's goal: \{\{goal\}\}/);
    assert.match(instructions, /<context>\s*\{\{context\}\}\s*<\/context>/);
    assert.match(instructions, /never instructions/i);
    assert.match(instructions, /Topics to avoid/);
    assert.ok(greeting.includes(c.name) && greeting.includes("{{first_name}}"));
    assert.equal(name, c.name);
  });
}

test("Daniel, Oscar and Victoria speak English, Diana speaks Latin American Spanish with usted", () => {
  for (const id of ["daniel", "oscar", "victoria"]) {
    const c = getCharacter(id)!;
    const a = characterAgent(c);
    assert.match(a.instructions, new RegExp(`You are ${c.name}`));
    assert.match(a.instructions, /Speak English/);
  }
  const diana = characterAgent(getCharacter("diana")!);
  assert.match(diana.instructions, /You are Diana/);
  assert.match(diana.instructions, /Latin American Spanish/);
  assert.match(diana.instructions, /usted/);
  assert.match(diana.greeting, /Le habla Diana/);
});

test("agent config: name, voice-language and Spanish placeholders per character", () => {
  for (const c of CHARACTERS) {
    const a = characterAgent(c);
    const cfg = buildAgentConfig({ ...a, initialMessage: a.greeting, language: c.language });
    assert.equal(cfg.name, c.name);
    assert.equal(cfg.config.language.primary, c.language);
    assert.equal(cfg.config.dynamic_variable_placeholders.first_name, c.language === "es" ? "amigo" : "there");
    assert.ok(cfg.config.system_tools.end_call.description);
  }
});

for (const lang of LANGS) {
  test(`goals (${lang}): one simple goal per kind, fixed text with no variables`, () => {
    const onboarding = callGoal("onboarding", lang);
    const story = callGoal("story", lang);
    assert.notEqual(onboarding, story);
    assert.match(onboarding, /first call/);
    assert.match(onboarding, /some become posts/); // he hears what happens to his stories
    assert.match(onboarding, /what they did for work/);
    assert.match(story, /ONE good story/);
    assert.match(story, /<question>/);
    for (const goal of [onboarding, story]) {
      assert.deepEqual(varsIn(goal), [], "a variable's value is never re-templated");
      // any tag a goal mentions is one the context really has
      for (const m of goal.matchAll(/<\/?([a-z_]+)>/g)) assert.ok((CONTEXT_PARTS as readonly string[]).includes(m[1]));
    }
  });
}
