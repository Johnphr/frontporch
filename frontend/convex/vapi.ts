// Start the weekly Vapi call (stub, nothing exported yet).
//
// Planned:
//   startWeeklyCall = internalAction({ elderId }):
//     1. question = family question first, else Apify question (questions.nextForElder)
//     2. memories = memories.search(elderId, question text, k = 5)
//     3. fetch("https://api.vapi.ai/call", POST, Bearer VAPI_API_KEY) with
//        assistantId, phoneNumberId, customer.number,
//        assistantOverrides.variableValues { firstName, question, memories, language }
//        and metadata { elderId, questionId }
//     4. calls insert { provider: "vapi", vapiCallId, status: "queued" }
//
// Crons: add convex/crons.ts (default export cronJobs()) in the same PR.
// Don't create an empty crons.ts: Convex expects a default export there.
// Convex crons run in UTC; see ARCHITECTURE.md open decision 7.
//
// Env (Convex): VAPI_API_KEY, VAPI_ASSISTANT_ID, VAPI_PHONE_NUMBER_ID
// Owner: Voice.

export {};
