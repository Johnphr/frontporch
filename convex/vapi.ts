// Vapi: start a call + receive server events (stub, nothing exported yet).
//
// Planned:
//   startCall = internalAction({ elderId }):
//     1. plan = internal.conversation.planNextCall(elderId)   (CallPlan, see ARCHITECTURE.md)
//     2. pick assistant by plan.kind: VAPI_ONBOARDING_ASSISTANT_ID | VAPI_STORY_ASSISTANT_ID
//     3. fetch("https://api.vapi.ai/call", POST, Bearer VAPI_API_KEY) with
//        assistantId, phoneNumberId, customer.number,
//        assistantOverrides.variableValues (the prompt variables in vapi/prompts/*.md)
//        and metadata { elderId, kind }
//     4. insert calls row { kind, vapiCallId, plan, status: "queued" }
//
//   webhook = httpAction (routed in http.ts as POST /vapi/webhook):
//     check secret header == VAPI_WEBHOOK_SECRET, return 200 fast, and on
//     "end-of-call-report" schedule internal.pipeline.processCall(CallResult)
//     via ctx.scheduler.runAfter(0, ...). Verify payload field names at
//     docs.vapi.ai/server-url and commit one real payload to fixtures/ (repo root).
//
// Env: VAPI_API_KEY, VAPI_PHONE_NUMBER_ID, VAPI_ONBOARDING_ASSISTANT_ID,
//      VAPI_STORY_ASSISTANT_ID, VAPI_WEBHOOK_SECRET
// Owner: Voice.

export {};
