// Online fallback questions via Apify (stub, nothing exported yet).
//
// Planned: findQuestions = internalAction(), run daily from crons.ts:
//   1. for each enabled source, run the Actor (Apify REST run-sync-get-dataset-items)
//   2. map fields to { source, title, body, sourceUrl, externalId }
//   3. upsert into questions (dedupe on externalId)
//   4. internal.llm.triageQuestions -> assign to an elder or skip with a reason
//
// Port source config and field mapping from v1 backend/question_sources.json
// and backend/app/services/questions.py (see ARCHITECTURE.md "Port from v1").
//
// Env: APIFY_TOKEN
// Owner: Integrations.

export {};
