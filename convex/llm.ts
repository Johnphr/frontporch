// Claude jobs (stub, nothing exported yet).
//
// Planned internalActions, each returning validated structured output:
//   draftStoryPost({ question, elder, turns }) -> { title, body, shortVersion, keyPoints }
//   extractMemories({ elder, turns })          -> string[]  (1-5 short facts)
//   triageQuestions({ questions, elders })     -> per question: answerable, topics, elder
//
// Port prompts and rules from v1 backend/app/llm.py (see ARCHITECTURE.md
// "Port from v1"): only use what the elder said, skip medical/legal/financial
// and crisis questions, keep their voice.
// If @anthropic-ai/sdk needs Node APIs, put "use node" at the top of this file
// (then it may only export actions).
//
// Env: ANTHROPIC_API_KEY. Model: claude-opus-5-5.
// Owner: Core: Pipeline.

export {};
