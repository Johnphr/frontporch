// Post-call pipeline (stub, nothing exported yet).
//
// Planned: processCall = internalAction(CallResult), scheduled by vapi.webhook.
//
//   type CallResult = {
//     vapiCallId: string;
//     elderId: Id<"elders">;
//     kind: "onboarding" | "story";
//     turns: { role: "pip" | "elder"; text: string }[];
//     summary?: string;        // Vapi analysis summary
//     endedReason: string;     // e.g. "customer-ended-call", "voicemail"
//   };
//
// Steps, each in its own try/catch so one failure doesn't stop the rest:
//   1. save transcript + summary on the calls row
//   2. internal.llm.extractMemories -> internal.memories.add
//   3. onboarding: internal.llm.extractProfile -> elders.profile, stage -> "active"
//   4. story call: internal.llm.writePost -> posts row -> internal.linkedapi.createPost
//      (auto-post, no approval)
// Skip 2-4 on voicemail or when he said almost nothing.
//
// Owner: Core: Brain.

export {};
