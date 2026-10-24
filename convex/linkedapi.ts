// LinkedIn posting via LinkedAPI (stub, nothing exported yet).
//
// Planned: createPost = internalAction({ postId }) -> { status, url?, error? }
//   POST https://api.linkedapi.io/workflows with headers linked-api-token +
//   identification-token, createPost on grandpa's own account. Workflows run
//   human-paced in a cloud browser, so poll for the result (or schedule a
//   follow-up action) instead of expecting the post URL immediately.
//   Save the post URL on the posts row: apify.scrapeEngagement matches on it.
//
// Env: LINKEDAPI_TOKEN, LINKEDAPI_ID_TOKEN
// Owner: Integrations.

export {};
