"""Stack Exchange sites (Lifehacks, DIY, Cooking, Gardening, Parenting...).

Uses the free official API instead of scraping:
  GET https://api.stackexchange.com/2.3/questions?site=diy&sort=creation&filter=withbody

No key needed (300 requests/day per IP). Set STACKEXCHANGE_KEY for 10,000/day.
If a response includes "backoff", the API asks us to wait that many seconds
before calling it again, so we do.
"""

import asyncio

import httpx

from ...config import Settings

API_URL = "https://api.stackexchange.com/2.3/questions"


async def fetch(source: dict, settings: Settings, client: httpx.AsyncClient | None = None
                ) -> list[dict]:
    sites = source.get("sites") or ([source["site"]] if source.get("site") else [])
    if not sites:
        from . import SourceError

        raise SourceError("stackexchange source needs 'sites'")
    per_site = max(1, min(100, int(source.get("pageSize", source.get("maxQuestions", 20)))))
    owns_client = client is None
    client = client or httpx.AsyncClient(timeout=20)
    items: list[dict] = []
    try:
        for i, site in enumerate(sites):
            params: dict[str, str | int] = {
                "site": site,
                "sort": "creation",
                "order": "desc",
                "filter": "withbody",
                "pagesize": per_site,
            }
            if source.get("tagged"):
                params["tagged"] = source["tagged"]
            if settings.stackexchange_key:
                params["key"] = settings.stackexchange_key
            response = await client.get(API_URL, params=params)
            response.raise_for_status()
            data = response.json()
            for item in data.get("items", []):
                item["site"] = site
                items.append(item)
            backoff = data.get("backoff")
            if backoff and i < len(sites) - 1:
                await asyncio.sleep(float(backoff))
    finally:
        if owns_client:
            await client.aclose()
    return items
