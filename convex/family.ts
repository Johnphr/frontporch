// Family members and the questions they text in (stub, nothing exported yet).
//
// Planned internal functions (only called from other Convex functions):
//   getMemberByPhone({ phone })        -> familyMembers row or null
//   listForElder({ elderId })          -> who gets the post-call SMS
//   addQuestion({ memberId, text })    -> questions insert with
//        source "family", status "assigned", assignedElderId, askedByMemberId
//
// Demo setup is by hand: add grandpa + family numbers in the Convex dashboard
// (or a seed mutation). No signup flow.
// Owner: Core: Data.

export {};
