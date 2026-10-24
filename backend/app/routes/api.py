"""JSON API used by the React dashboard.

Reads go straight from the browser to Convex; this API handles anything that
needs a secret (writes, Apify, Twilio, publishing).
"""

import asyncio
import uuid
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..deps import Services, get_services
from ..services.questions import fetch_from_apify, route_new_questions

router = APIRouter(prefix="/api", tags=["api"])


class ElderIn(BaseModel):
    name: str
    phone: str = Field(description="E.164 format, e.g. +14155550123")
    expertise: list[str] = []
    language: str = "en-US"
    bio: str | None = None


class ManualQuestionIn(BaseModel):
    title: str
    body: str | None = None
    sourceUrl: str | None = None
    source: str = "manual"


class OutboundCallIn(BaseModel):
    elderId: str


class PublishIn(BaseModel):
    platforms: list[str]


class StatusIn(BaseModel):
    status: Literal["draft", "approved", "rejected"]


class ReplyIn(BaseModel):
    platform: str = "feed"
    author: str
    text: str


async def _publish(services: Services, answer_id: str, platforms: list[str]):
    from ..services.publishing import publish_answer

    return await publish_answer(services, answer_id, platforms)


@router.get("/health")
async def health(services: Services = Depends(get_services)):
    s = services.settings
    return {
        "integrations": {
            "convex": services.store.configured,
            "claude": services.llm.configured,
            "cartesia": services.voice.configured,
            "twilio": bool(s.twilio_account_sid and s.twilio_auth_token
                           and s.twilio_phone_number),
            "apify": bool(s.apify_token),
            "bluesky": bool(s.bluesky_handle and s.bluesky_app_password),
            "linkedin": bool(s.linkedin_access_token and s.linkedin_author_urn),
            "reddit_posting": bool(s.reddit_posting_enabled and s.reddit_client_id
                                   and s.reddit_client_secret and s.reddit_username
                                   and s.reddit_password),
            "discourse": bool(s.discourse_url and s.discourse_api_key
                              and s.discourse_username),
        },
        "defaultPlatforms": s.platforms,
        "publicBaseUrl": s.public_base_url,
    }


@router.post("/elders")
async def create_elder(body: ElderIn, services: Services = Depends(get_services)):
    fields = body.model_dump(exclude_none=True)
    return {"id": await services.store.create_elder(**fields)}


@router.post("/questions/refresh")
async def refresh_questions(services: Services = Depends(get_services)):
    questions, errors = await fetch_from_apify(services.settings)
    inserted = await services.store.upsert_questions(questions) if questions else []
    routing = await route_new_questions(services.store, services.llm)
    return {"fetched": len(questions), "inserted": len(inserted or []), "errors": errors,
            "routing": routing}


@router.post("/questions/manual")
async def add_manual_question(body: ManualQuestionIn, services: Services = Depends(get_services)):
    question = {"source": body.source, "title": body.title,
                "externalId": f"manual:{uuid.uuid4()}"}
    if body.body:
        question["body"] = body.body
    if body.sourceUrl:
        question["sourceUrl"] = body.sourceUrl
    ids = await services.store.upsert_questions([question])
    routing = await route_new_questions(services.store, services.llm)
    return {"ids": ids, "routing": routing}


@router.post("/questions/route")
async def route_questions(services: Services = Depends(get_services)):
    return await route_new_questions(services.store, services.llm)


@router.post("/calls/outbound")
async def outbound_call(body: OutboundCallIn, services: Services = Depends(get_services)):
    s = services.settings
    if not (s.twilio_account_sid and s.twilio_auth_token and s.twilio_phone_number):
        raise HTTPException(503, "Twilio is not configured (TWILIO_ACCOUNT_SID, "
                                 "TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER)")
    elder = await services.store.get_elder(body.elderId)
    if not elder:
        raise HTTPException(404, "Elder not found")

    from twilio.rest import Client

    def _call() -> str:
        client = Client(s.twilio_account_sid, s.twilio_auth_token)
        call = client.calls.create(
            to=elder["phone"], from_=s.twilio_phone_number,
            url=f"{s.public_base_url.rstrip('/')}/twilio/voice", method="POST",
        )
        return call.sid

    return {"callSid": await asyncio.to_thread(_call)}


class PublishWithForceIn(PublishIn):
    # True = "Publish anyway": post even if the quality check flagged the text.
    force: bool = False


@router.post("/answers/{answer_id}/publish")
async def publish(answer_id: str, body: PublishWithForceIn,
                  services: Services = Depends(get_services)):
    from ..services.publishing import publish_answer

    return {"publications": await publish_answer(services, answer_id, body.platforms,
                                                 force=body.force)}


@router.post("/answers/{answer_id}/status")
async def set_status(answer_id: str, body: StatusIn, services: Services = Depends(get_services)):
    await services.store.set_answer_status(answer_id, body.status)
    return {"ok": True}


@router.post("/answers/{answer_id}/replies")
async def add_reply(answer_id: str, body: ReplyIn, services: Services = Depends(get_services)):
    reply_id = await services.store.add_reply(answer_id, body.platform, body.author, body.text)
    return {"id": reply_id}


@router.post("/answers/{answer_id}/prepare")
async def prepare_posts(answer_id: str, services: Services = Depends(get_services)):
    """(Re)write every platform version and re-run the quality check."""
    from ..services.post_writer import prepare_posts as _prepare

    try:
        return await _prepare(services, answer_id)
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
