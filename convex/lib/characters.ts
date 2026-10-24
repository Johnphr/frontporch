// The characters who can call him. Each one is its own Cartesia agent (voice + personality),
// all calling from the same number. He picks one at sign-up (elders.characterId) and can
// change it later; the call's goal and context are filled in per call, not per character.
//
// Pip and Juanito are placeholders until the real characters are ready. To add one: add an
// entry here, then run `npx convex run cartesiaAgents:syncAgent` to create its agent.

import type { CallLanguage } from "./prompts/principles";

export type CharacterConfig = {
  id: string; // stable, lowercase; stored in elders.characterId and characterAgents.characterId
  name: string; // what the character calls itself on the phone
  language: CallLanguage; // one language per character (Cartesia sets language per agent)
  voiceEnv: string; // env var holding the Cartesia voice id (placeholder until real voices)
  description: string; // one line for the sign-up screen, in the character's language
  personality: string; // how this character talks; goes into the agent prompt as {{persona}}
};

/** What the UI sees (no voice or prompt details). */
export type Character = Pick<CharacterConfig, "id" | "name" | "language" | "description">;

export const CHARACTERS: readonly CharacterConfig[] = [
  {
    id: "pip",
    name: "Pip",
    language: "en",
    voiceEnv: "CARTESIA_VOICE_ID",
    description: "Warm and curious. Loves a good story and asks the follow-up question.",
    personality:
      "You are Pip: warm, unhurried, genuinely curious. You laugh easily, you never rush him, " +
      "and you ask the small follow-up that shows you were listening.",
  },
  {
    id: "juanito",
    name: "Juanito",
    language: "es",
    voiceEnv: "CARTESIA_VOICE_ID_ES",
    description: "Cálido y curioso. Le encantan las buenas historias y escucha con calma.",
    personality:
      "Eres Juanito: cálido, tranquilo, de verdad curioso. Hablas con respeto (de usted), " +
      "nunca lo apuras y haces la pregunta pequeña que muestra que estabas escuchando.",
  },
];

const DEFAULT_BY_LANGUAGE: Record<CallLanguage, string> = { en: "pip", es: "juanito" };

export function getCharacter(id: string | undefined): CharacterConfig | undefined {
  return CHARACTERS.find((c) => c.id === id);
}

/** His chosen character, or the default for his language if none (or an unknown id). */
export function characterFor(characterId: string | undefined, lang: CallLanguage): CharacterConfig {
  return getCharacter(characterId) ?? getCharacter(DEFAULT_BY_LANGUAGE[lang])!;
}

export function publicCharacters(): Character[] {
  return CHARACTERS.map(({ id, name, language, description }) => ({ id, name, language, description }));
}
