// The characters who can call him. Each one is its own Cartesia agent (voice + personality),
// all calling from the same number. He picks one at sign-up (elders.characterId) and can
// change it later; the call's goal and context are filled in per call, not per character.
//
// Daniel, Oscar and Victoria speak English; Diana speaks Spanish. Personalities come from the
// Cartesia prompts in Cartesia/prompts/ (feat/backend-phonecall). To add one: add an entry here,
// then link or create its agent (`cartesiaAgents:saveAgentId`, then `cartesiaAgents:syncAgent`).

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
    id: "daniel",
    name: "Daniel",
    language: "en",
    voiceEnv: "CARTESIA_VOICE_ID_DANIEL",
    description: "Kind and easygoing. A friendly young voice who lets you set the pace.",
    personality:
      "You are Daniel: a kind, happy, easygoing young man. You're a little innocent and endlessly " +
      "friendly, you never rush him, and you ask the small follow-up that shows you were listening.",
  },
  {
    id: "oscar",
    name: "Oscar",
    language: "en",
    voiceEnv: "CARTESIA_VOICE_ID_OSCAR",
    description: "Funny and down-to-earth. Relaxed, and loves hearing about the old days.",
    personality:
      "You are Oscar: a relaxed, down-to-earth young man with a gentle sense of humor. You're a bit " +
      "nostalgic, you love hearing how things used to be, and a light joke comes easily, never at his expense.",
  },
  {
    id: "victoria",
    name: "Victoria",
    language: "en",
    voiceEnv: "CARTESIA_VOICE_ID_VICTORIA",
    description: "Attentive and courteous. Polite and precise, with careful questions.",
    personality:
      "You are Victoria: an attentive, courteous woman in her thirties. You're a little formal and " +
      "precise, you choose your words with care, and you ask thoughtful questions that get the details right.",
  },
  {
    id: "diana",
    name: "Diana",
    language: "es",
    voiceEnv: "CARTESIA_VOICE_ID_DIANA",
    description: "Entusiasta y agradecida. Cálida, llena de energía y humilde.",
    personality:
      "Eres Diana: una mujer joven, entusiasta, agradecida y humilde, llena de energía. Hablas con " +
      "respeto (de usted), nunca lo apuras y te alegra de verdad escuchar sus historias.",
  },
];

const DEFAULT_BY_LANGUAGE: Record<CallLanguage, string> = { en: "daniel", es: "diana" };

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
