"""Run an Apify Actor and return its dataset items.

Used for Reddit (trudax/reddit-scraper-lite) and Quora
(blackfalcondata/quora-scraper). Each Actor has its own input format; it lives
in the source's "input" entry in question_sources.json.
"""

import asyncio

from apify_client import ApifyClient

from ...config import Settings


def run_actor(token: str, source: dict) -> list[dict]:
    """Blocking: start the Actor, wait for it, read up to 3x maxQuestions items."""
    client = ApifyClient(token)
    run = client.actor(source["actor"]).call(run_input=source.get("input", {}))
    if run is None:
        return []
    # apify-client v3 returns an object; older versions returned a dict.
    dataset_id = getattr(run, "default_dataset_id", None) or (
        run.get("defaultDatasetId") if isinstance(run, dict) else None
    )
    if not dataset_id:
        return []
    cap = int(source.get("maxQuestions", 20)) * 3  # leave room for rows we filter out
    items: list[dict] = []
    for item in client.dataset(dataset_id).iterate_items():
        items.append(item)
        if len(items) >= cap:
            break
    return items


async def fetch(source: dict, settings: Settings) -> list[dict]:
    from . import SourceError

    if not settings.apify_token:
        raise SourceError("APIFY_TOKEN is not set")
    if not source.get("actor") or source["actor"].startswith("REPLACE"):
        raise SourceError("no Apify actor configured")
    return await asyncio.to_thread(run_actor, settings.apify_token, source)
