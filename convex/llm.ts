// Claude jobs (stub, nothing exported yet).
//
// Planned internalActions, each returning validated structured output:
//   writePost({ profile, turns, feedback })   -> { text, hook }
//       the content generator: hook first line, one story with concrete detail,
//       the lesson, a question to readers (comments feed the next call);
//       ONLY facts he said; ends with the AI disclosure line
//   extractMemories({ turns })                -> string[]  (1-5 short facts / story seeds)
//   extractProfile({ turns, knownBackground }) -> { industry, specialty, careerSummary,
//                                                  topicsToAvoid[] }
//   summarizeFeedback({ posts })              -> { resonated, readerQuestions[], line }
//   planQuestions({ profile, memories, feedback }) -> { mainQuestion, threads[] }
//
// Port drafting rules from v1 (git show 9e67aab:backend/app/llm.py): use only
// what he said, keep his voice and phrases, fix only speech-to-text errors.
// If @anthropic-ai/sdk needs Node APIs, put "use node" at the top of this file
// (then it may only export actions).
//
// Env: ANTHROPIC_API_KEY. Model: claude-opus-5-5.
// Owner: Core: Brain.

export {};
