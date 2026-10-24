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
from ..services.questions import (all_sources, prepare_manual, refresh_questions,
                                  route_new_questions)

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


class RefreshIn(BaseModel):
    sources: list[str] | None = Field(default=None, description="Source names; default all enabled")
    limit: int | None = Field(default=None, ge=1, le=100, description="Max questions per source")


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


@router.get("/questions/sources")
async def question_sources(services: Services = Depends(get_services)):
    """Every configured source, for the dashboard's refresh picker."""
    return [
        {"name": src.get("name"), "label": src.get("label") or src.get("name"),
         "kind": src.get("kind", "apify"), "source": src.get("source", "web"),
         "enabled": bool(src.get("enabled"))}
        for src in all_sources(services.settings)
    ]


@router.post("/questions/refresh")
async def refresh_questions_route(body: RefreshIn | None = None,
                                  services: Services = Depends(get_services)):
    body = body or RefreshIn()
    return await refresh_questions(services, body.sources, body.limit)


@router.post("/questions/manual")
async def add_manual_question(body: ManualQuestionIn, services: Services = Depends(get_services)):
    question = {"source": body.source, "title": body.title,
                "externalId": f"manual:{uuid.uuid4()}"}
    if body.body:
        question["body"] = body.body
    if body.sourceUrl:
        question["sourceUrl"] = body.sourceUrl
    ids = await services.store.upsert_questions([prepare_manual(question)])
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


@router.post("/answers/{answer_id}/publish")
async def publish(answer_id: str, body: PublishIn, services: Services = Depends(get_services)):
    return {"publications": await _publish(services, answer_id, body.platforms)}


@router.post("/answers/{answer_id}/status")
async def set_status(answer_id: str, body: StatusIn, services: Services = Depends(get_services)):
    await services.store.set_answer_status(answer_id, body.status)
    return {"ok": True}


@router.post("/answers/{answer_id}/replies")
async def add_reply(answer_id: str, body: ReplyIn, services: Services = Depends(get_services)):
    reply_id = await services.store.add_reply(answer_id, body.platform, body.author, body.text)
    return {"id": reply_id}
