// Grandpa's long-term memory (stub, nothing exported yet).
//
// Planned (table + vectorIndex draft in ARCHITECTURE.md "Data model"):
//   add    = internalAction({ elderId, callId?, texts[] }):
//            embed with OpenAI text-embedding-3-small (1536 dims), insert rows
//   search = internalAction({ elderId, text, k }):
//            embed text, ctx.vectorSearch("memories", "by_embedding",
//            { vector, limit: k, filter: q => q.eq("elderId", elderId) })
//
// Vector search only runs inside actions, not queries or mutations.
// Env: OPENAI_API_KEY
// Owner: Core: Data.

export {};
