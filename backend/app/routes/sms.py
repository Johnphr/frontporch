"""Inbound SMS from family members (stub, not wired into main.py yet).

Twilio number -> Messaging -> "A message comes in" -> POST /sms/inbound.

Flow: verify Twilio signature (reuse deps.verify_twilio) -> look up the sender
in familyMembers by phone -> unknown number: ignore -> known: save the text as
a question (source "family", assigned to their elder) -> reply with a short
confirmation via TwiML <Message>.

Owner: Integrations. See ARCHITECTURE.md "Family asks a question".
"""

from fastapi import APIRouter, Request

router = APIRouter(prefix="/sms", tags=["sms"])


@router.post("/inbound")
async def inbound(request: Request):
    # TODO: form["From"], form["Body"] -> services.sms.find_family_member -> store question.
    raise NotImplementedError
