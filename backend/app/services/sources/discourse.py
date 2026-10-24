"""Discourse forums, through each forum's public JSON (no Apify needed).

  GET <forumUrl>/latest.json              newest topics on the forum
  GET <forumUrl>/c/<category>/l/latest.json   newest topics in one category

Pinned, closed and archived topics are skipped here (they're usually rules or
announcements). The topic id ends up in externalId as "discourse-topic-<id>",
which is what the Discourse publisher reads to post the reply back.
"""

from urllib.parse import urlparse

import httpx

from ...config import Settings


async def fetch(source: dict, settings: Settings, client: httpx.AsyncClient | None = None
                ) -> list[dict]:
    forum = (source.get("forumUrl") or "").rstrip("/")
    if not forum.startswith("http"):
        from . import SourceError

        raise SourceError("discourse source needs 'forumUrl'")
    category = (source.get("category") or "").strip("/")
    url = f"{forum}/c/{category}/l/latest.json" if category else f"{forum}/latest.json"
    owns_client = client is None
    client = client or httpx.AsyncClient(timeout=20, headers={"Accept": "application/json"})
    try:
        response = await client.get(url)
        response.raise_for_status()
        topics = response.json().get("topic_list", {}).get("topics", [])
    finally:
        if owns_client:
            await client.aclose()

    community = source.get("community") or urlparse(forum).netloc
    items: list[dict] = []
    for topic in topics:
        if topic.get("pinned") or topic.get("closed") or topic.get("archived"):
            continue
        if topic.get("visible") is False:
            continue
        topic_id = topic.get("id")
        slug = topic.get("slug") or "topic"
        items.append({
            **topic,
            "url": f"{forum}/t/{slug}/{topic_id}",
            "community": community,
            # posts_count includes the opening post
            "answer_count": max(0, int(topic.get("posts_count") or 1) - 1),
        })
    return items
