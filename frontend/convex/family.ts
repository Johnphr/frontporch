// Family members and the questions they text in (stub, nothing exported yet).
//
// Planned (backend-only, `secret` checked with assertBackend like other files):
//   getMemberByPhone({ secret, phone })        -> familyMembers row or null
//   listForElder({ secret, elderId })          -> who gets the post-call SMS
//   addQuestion({ secret, memberId, text })    -> questions insert with
//        source "family", status "assigned", assignedElderId, askedByMemberId
//
// Demo setup is by hand: seed grandpa + family numbers in the Convex dashboard
// (or a seed mutation). No signup flow.
// Owner: Data.

export {};
