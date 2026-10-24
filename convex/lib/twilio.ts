// Twilio webhook signature check (stub, nothing exported yet).
//
// Planned: validateTwilioSignature(authToken, url, params, signature): Promise<boolean>
//   expected = base64(HMAC-SHA1(authToken, url + each param key+value sorted by key))
//   Use Web Crypto (crypto.subtle), which the default Convex runtime provides.
//   url must be the exact public URL Twilio called (the .convex.site one).
//
// Owner: Core: Pipeline.

export {};
