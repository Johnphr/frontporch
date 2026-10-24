// How readers reacted to his LinkedIn posts (stub, nothing exported yet).
//
// Planned internal functions:
//   upsert({ elderId, linkedinUrl, reactions, comments[] })   called by apify.scrapeEngagement;
//       links to our posts row by URL when it matches, keeps the latest snapshot
//   recentFeedback({ elderId, sinceDays })                    -> posts with reaction counts
//       and comments since the last call, for conversation.planNextCall
//
// Owner: Core: Data.

export {};
