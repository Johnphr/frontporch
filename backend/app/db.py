"""Thin async wrapper around the Convex Python client.

Convex functions live in frontend/convex. Every write takes `secret`, which
Convex checks against its BACKEND_SECRET env var, so the browser can read
but only this backend can write.

Gotcha: Convex `v.number()` is a float. Python ints are sent as int64 and
fail validation, so numbers must be passed as floats.
"""

import asyncio
from typing import Any

from convex import ConvexClient

from .config import Settings


class StoreNotConfigured(RuntimeError):
    pass


class Store:
    def __init__(self, settings: Settings):
        self._secret = settings.convex_backend_secret or ""
        self._client = ConvexClient(settings.convex_url) if settings.convex_url else None

    @property
    def configured(self) -> bool:
        return self._client is not None

    def _require(self) -> ConvexClient:
        if self._client is None:
            raise StoreNotConfigured("Set CONVEX_URL and CONVEX_BACKEND_SECRET")
        return self._client

    async def _query(self, name: str, args: dict[str, Any] | None = None) -> Any:
        client = self._require()
        return await asyncio.to_thread(client.query, name, {**(args or {}), "secret": self._secret})

    async def _mutation(self, name: str, args: dict[str, Any]) -> Any:
        client = self._require()
        return await asyncio.to_thread(client.mutation, name, {**args, "secret": self._secret})

    # --- elders ---
    async def create_elder(self, **fields: Any) -> str:
        return await self._mutation("elders:create", fields)

    async def elder_by_phone(self, phone: str) -> dict | None:
        return await self._query("elders:getByPhone", {"phone": phone})

    async def get_elder(self, elder_id: str) -> dict | None:
        return await self._query("elders:getPrivate", {"elderId": elder_id})

    async def list_elders(self) -> list[dict]:
        return await self._query("elders:listPrivate")

    # --- questions ---
    async def upsert_questions(self, questions: list[dict]) -> list[str]:
        return await self._mutation("questions:upsertMany", {"questions": questions})

    async def questions_by_status(self, status: str) -> list[dict]:
        return await self._query("questions:listPrivate", {"status": status})

    async def get_question(self, question_id: str) -> dict | None:
        return await self._query("questions:getPrivate", {"questionId": question_id})

    async def assign_question(self, question_id: str, elder_id: str, topics: list[str]) -> None:
        await self._mutation(
            "questions:assign", {"questionId": question_id, "elderId": elder_id, "topics": topics}
        )

    async def skip_question(self, question_id: str, reason: str) -> None:
        await self._mutation("questions:skip", {"questionId": question_id, "reason": reason})

    async def next_question_for(self, elder_id: str) -> dict | None:
        return await self._query("questions:nextForElder", {"elderId": elder_id})

    async def set_question_status(self, question_id: str, status: str) -> None:
        await self._mutation("questions:setStatus", {"questionId": question_id, "status": status})

    # --- calls ---
    async def start_call(self, call_sid: str, elder_id: str, question_id: str | None) -> str:
        args: dict[str, Any] = {"callSid": call_sid, "elderId": elder_id}
        if question_id:
            args["questionId"] = question_id
        return await self._mutation("calls:start", args)

    async def add_call_turn(self, call_id: str, role: str, text: str) -> None:
        await self._mutation("calls:addTurn", {"callId": call_id, "role": role, "text": text})

    async def set_call_status(self, call_id: str, status: str) -> None:
        await self._mutation("calls:setStatus", {"callId": call_id, "status": status})

    # --- answers ---
    async def create_answer(self, **fields: Any) -> str:
        return await self._mutation("answers:createDraft", fields)

    async def get_answer(self, answer_id: str) -> dict | None:
        return await self._query("answers:getPrivate", {"answerId": answer_id})

    async def set_answer_status(self, answer_id: str, status: str) -> None:
        await self._mutation("answers:setStatus", {"answerId": answer_id, "status": status})

    async def set_publication(self, answer_id: str, publication: dict) -> None:
        await self._mutation(
            "answers:setPublication", {"answerId": answer_id, "publication": publication}
        )

    async def set_posts(self, answer_id: str, variants: dict, quality: list[dict]) -> None:
        """Save per-platform texts + the faithfulness check (services/post_writer.py)."""
        allowed = {"bluesky", "linkedin", "reddit", "quora", "discourse"}
        clean_variants = {k: v for k, v in variants.items() if k in allowed and v}
        clean_quality = [{"platform": str(q["platform"]), "passed": bool(q["passed"]),
                          "issues": [str(i) for i in q.get("issues") or []]} for q in quality]
        await self._mutation("answers:setPosts", {"answerId": answer_id,
                                                  "variants": clean_variants,
                                                  "quality": clean_quality})

    # --- replies (thank-yous read back to the elder) ---
    async def add_reply(self, answer_id: str, platform: str, author: str, text: str) -> str:
        return await self._mutation(
            "replies:add",
            {"answerId": answer_id, "platform": platform, "author": author, "text": text},
        )

    async def unread_replies(self, elder_id: str) -> list[dict]:
        return await self._query("replies:unreadForElder", {"elderId": elder_id})

    async def mark_reply_read(self, reply_id: str) -> None:
        await self._mutation("replies:markRead", {"replyId": reply_id})
