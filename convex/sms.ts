// Family SMS in and out (stub, nothing exported yet).
//
// Planned:
//   inbound = httpAction (routed in http.ts as POST /sms/inbound):
//     1. validate X-Twilio-Signature (lib/twilio.ts) against the exact
//        https://<deployment>.convex.site/sms/inbound URL
//     2. look up From in familyMembers (internal.family.getMemberByPhone);
//        unknown number -> empty TwiML, no reply
//     3. internal.family.addQuestion with Body
//     4. reply TwiML <Message>: "Got it! Pip will ask Grandpa on the next call."
//        (Content-Type: text/xml)
//   sendSms      = internalAction({ to, body })     Twilio REST, From TWILIO_PHONE_NUMBER
//   notifyFamily = internalAction({ elderId, text }) sendSms to each family member
//
// Env: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER
// Owner: Core: Pipeline.

export {};
