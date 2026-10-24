// The characters who call him, and which one (= which Cartesia agent) a call uses.
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";

import { CHARACTERS, characterFor, getCharacter, publicCharacters } from "../convex/lib/characters.ts";
import { callCharacter } from "../convex/lib/onboarding.ts";

test("characters: unique lowercase ids, one language each, a voice env var and a personality", () => {
  const ids = CHARACTERS.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, "ids are unique");
  for (const c of CHARACTERS) {
    assert.match(c.id, /^[a-z0-9_-]+$/, c.id);
    assert.ok(["en", "es"].includes(c.language), c.id);
    assert.match(c.voiceEnv, /^[A-Z0-9_]+$/, c.id);
    assert.ok(c.name.trim() && c.description.trim() && c.personality.trim(), c.id);
  }
  // no two characters share a voice
  assert.equal(new Set(CHARACTERS.map((c) => c.voiceEnv)).size, CHARACTERS.length);
});

test("characterFor: his choice, else the default for his language", () => {
  assert.equal(characterFor(undefined, "en").id, "pip");
  assert.equal(characterFor(undefined, "es").id, "juanito");
  assert.equal(characterFor("nobody", "es").id, "juanito"); // unknown id falls back
  assert.equal(characterFor("juanito", "en").id, "juanito"); // a chosen character wins
  assert.equal(characterFor("pip", "en").language, "en");
  assert.equal(characterFor("juanito", "es").language, "es");
  assert.equal(getCharacter(undefined), undefined);
});

test("callCharacter: picks the agent from elders.characterId + elders.language", () => {
  assert.equal(callCharacter({}).id, "pip");
  assert.equal(callCharacter({ language: "es-MX" }).id, "juanito");
  assert.equal(callCharacter({ language: "en-US", characterId: "juanito" }).id, "juanito");
  // the call runs in the character's language, not his elders.language
  assert.equal(callCharacter({ language: "es", characterId: "pip" }).language, "en");
  assert.equal(callCharacter({ language: "es", characterId: "gone" }).id, "juanito");
});

test("publicCharacters: no voice or prompt details for the UI", () => {
  const list = publicCharacters();
  assert.equal(list.length, CHARACTERS.length);
  for (const c of list) assert.deepEqual(Object.keys(c).sort(), ["description", "id", "language", "name"]);
});
