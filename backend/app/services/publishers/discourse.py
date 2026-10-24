"""Discourse forums (many hobby and community forums run on it).

Replies to a topic when the forum's URL, an API key and a username are set
and the question came from that forum (externalId ends in a topic id, e.g.
"myforum:discourse-topic-1234"). Anything else becomes a copy-ready draft.
"""

import re

import httpx

from .base import PublishContext, result

TOPIC_ID = re.compile(r"(?:discourse-topic-|:)(\d+)$")


def topic_id(question: dict) -> int | None:
    external = question.get("externalId") or ""
    if "discourse-topic-" in external or question.get("source") == "discourse":
        match = TOPIC_ID.search(external)
        if match:
            return int(match.group(1))
    return None


async def publish(ctx: PublishContext) -> dict:
    s = ctx.settings
    text = ctx.text_for("discourse")
    tid = topic_id(ctx.question)
    if not (s.discourse_url and s.discourse_api_key and s.discourse_username and tid):
        return result("discourse", "draft", draftText=text, url=ctx.question.get("sourceUrl"))
    base = s.discourse_url.rstrip("/")
    async with httpx.AsyncClient(timeout=20) as client:
        response = await client.post(
            f"{base}/posts.json",
            headers={"Api-Key": s.discourse_api_key, "Api-Username": s.discourse_username},
            json={"topic_id": tid, "raw": text},
        )
    if response.status_code >= 400:
        return result("discourse", "failed", draftText=text,
                      error=f"Discourse {response.status_code}: {response.text[:300]}")
    data = response.json()
    slug = data.get("topic_slug") or str(data.get("topic_id", tid))
    url = f"{base}/t/{slug}/{data.get('topic_id', tid)}"
    if data.get("post_number"):
        url += f"/{data['post_number']}"
    return result("discourse", "published", url=url)
