// Vapi: start the weekly call + receive server events (stub, nothing exported yet).
//
// Planned:
//   startWeeklyCall = internalAction({ elderId }):
//     1. question = family question first, else online question (questions.nextForElder)
//     2. memories = internal.memories.search(elderId, question text, k = 5)
//     3. fetch("https://api.vapi.ai/call", POST, Bearer VAPI_API_KEY) with
//        assistantId, phoneNumberId, customer.number,
//        assistantOverrides.variableValues { firstName, question, memories, language }
//        and metadata { elderId, questionId }
//     4. insert calls row { provider: "vapi", vapiCallId, status: "queued" }
//
//   webhook = httpAction (routed in http.ts as POST /vapi/webhook):
//     check secret header == VAPI_WEBHOOK_SECRET, return 200 fast, and on
//     "end-of-call-report" schedule internal.pipeline.processCall with a CallResult
//     (ctx.scheduler.runAfter(0, ...)). Verify payload field names at
//     docs.vapi.ai/server-url and commit one real payload to fixtures/ (repo root).
//
// Env: VAPI_API_KEY, VAPI_ASSISTANT_ID, VAPI_PHONE_NUMBER_ID, VAPI_WEBHOOK_SECRET
// Owner: Voice.

export {};
