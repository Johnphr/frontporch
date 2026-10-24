// The story-call planner: decides what Pip talks about next (stub, slice 2).
//
// Slice 1 picks the call kind in lib/onboarding.planNextCall (onboarding until his
// profile is usable); cartesia.startCall uses it directly.
//
// Planned for slice 2+: planStoryCall = internalAction({ elderId }) -> story plan
//   slice 2: profile + storySeeds + recent call summaries -> internal.llm.planQuestions
//            (mainQuestion + 2-3 backup threads, following voice/conversation-guide.md)
//   slice 3: + internal.memories.search, internal.engagement.recentFeedback ->
//            internal.llm.summarizeFeedback, apify.topAudienceQuestions (reader comments first)
//
// Owner: Core: Brain.

export {};
