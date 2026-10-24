// LinkedIn scraping via Apify (stub, nothing exported yet).
//
// Planned:
//   scrapeEngagement = internalAction({ elderId }), daily from crons.ts:
//     run harvestapi/linkedin-profile-posts on elders.linkedinUrl with
//     scrapeReactions + scrapeComments on (no cookies needed), then
//     internal.engagement.upsert per post
//   scrapeProfile = internalAction({ elderId }), once before the onboarding call:
//     run harvestapi/linkedin-profile-scraper -> knownBackground (work history)
//
// Use Apify REST "run-sync-get-dataset-items". LinkedIn scrapers break now and
// then, so keep a backup Actor in mind (e.g. apimaestro/linkedin-profile-posts).
// Runner pattern reference: git show 9e67aab:backend/app/services/questions.py
//
// Env: APIFY_TOKEN
// Owner: Integrations.

export {};
