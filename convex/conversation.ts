// The question planner: decides what Pip talks about next (stub, nothing exported yet).
//
// Planned: planNextCall = internalAction({ elderId }) -> CallPlan
//   onboarding (elder.stage === "onboarding"):
//     knownBackground from the LinkedIn profile scrape (apify.scrapeProfile), if any.
//   story call:
//     1. profile                       elders.profile
//     2. memories                      internal.memories.search(elderId, recent topics, k = 5)
//     3. feedback                      internal.engagement.recentFeedback(elderId)
//                                      -> internal.llm.summarizeFeedback (what resonated,
//                                         reader questions worth answering)
//     4. internal.llm.planQuestions    -> mainQuestion + 2-3 backup threads, following
//                                         vapi/conversation-guide.md; avoid topics already
//                                         covered (memories) unless a reader asked
//
//   type CallPlan = {
//     kind: "onboarding" | "story";
//     mainQuestion?: string;
//     threads: string[];
//     memories: string[];
//     feedback?: string;          // one short line Pip can read out
//     knownBackground?: string;   // onboarding only
//   };
//
// Owner: Core: Brain.

export {};
