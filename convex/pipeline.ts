// Post-call pipeline (stub, nothing exported yet).
//
// Planned: processCall = internalAction(CallResult), scheduled by vapi.webhook.
//
//   type CallResult = {
//     vapiCallId: string;
//     elderId: Id<"elders">;
//     questionId?: Id<"questions">;
//     turns: { role: "pip" | "elder"; text: string }[];
//     summary?: string;        // Vapi analysis summary
//     endedReason: string;     // e.g. "customer-ended-call", "voicemail"
//   };
//
// Steps, each in its own try/catch so one failure doesn't stop the rest:
//   1. save transcript + summary on the calls row
//   2. internal.llm.draftStoryPost -> answers row (use ONLY what he said)
//   3. internal.llm.extractMemories -> internal.memories.add
//   4. internal.linkedapi.createPost -> publication on the answer (auto-post)
//   5. internal.sms.notifyFamily with the post link
//   6. mark the question answered
// Skip 2-5 on voicemail or when the elder said nothing.
//
// Owner: Core: Pipeline.

export {};
