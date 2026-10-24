"""Shared singletons (created once at startup) and the Twilio signature check."""

from dataclasses import dataclass

from fastapi import HTTPException, Request
from twilio.request_validator import RequestValidator

from .config import Settings, get_settings
from .db import Store
from .llm import LLM
from .voice import Voice


@dataclass
class Services:
    settings: Settings
    store: Store
    llm: LLM
    voice: Voice


_services: Services | None = None


def get_services() -> Services:
    global _services
    if _services is None:
        settings = get_settings()
        _services = Services(settings=settings, store=Store(settings), llm=LLM(settings),
                             voice=Voice(settings))
    return _services


async def verify_twilio(request: Request) -> None:
    """Reject webhook calls that weren't signed by Twilio.

    Twilio signs the exact public URL it called, so PUBLIC_BASE_URL must match
    your tunnel URL (e.g. https://abc.ngrok.app) or every request will fail.
    """
    settings = get_settings()
    if not settings.twilio_validate_signature or not settings.twilio_auth_token:
        return
    form = await request.form()
    url = settings.public_base_url.rstrip("/") + request.url.path
    if request.url.query:
        url += "?" + request.url.query
    signature = request.headers.get("X-Twilio-Signature", "")
    validator = RequestValidator(settings.twilio_auth_token)
    if not validator.validate(url, dict(form), signature):
        raise HTTPException(status_code=403, detail="Invalid Twilio signature")
