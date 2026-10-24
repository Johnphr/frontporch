"""Outbound SMS + family lookups (stub).

  send_sms(to, body)                 Twilio Messaging, from TWILIO_PHONE_NUMBER
  notify_family(elder_id, text)      send_sms to every familyMembers row of the elder
  find_family_member(phone)          Convex family:getMemberByPhone, None if unknown

Owner: Integrations.
"""


async def send_sms(settings, to: str, body: str) -> str:
    """Returns the Twilio message SID."""
    raise NotImplementedError


async def notify_family(services, elder_id: str, text: str) -> None:
    raise NotImplementedError


async def find_family_member(services, phone: str) -> dict | None:
    raise NotImplementedError
