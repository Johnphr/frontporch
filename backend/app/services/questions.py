"""Find real questions online with Apify, then let Claude route them to elders.

Sources are defined in backend/question_sources.json. Each Apify Actor returns
items in its own shape, so every source lists which item fields hold the
title / body / url / id (first non-empty field wins).
"""

import asyncio
import json
from pathlib import Path
from typing import Any

from apify_client import ApifyClient

from ..config import Settings
from ..db import Store
from ..llm import LLM

BACKEND_DIR = Path(__file__).resolve().parents[2]


def load_sources(settings: Settings) -> list[dict]:
    path = BACKEND_DIR / settings.question_sources_file
    if not path.exists():
        return []
    return [s for s in json.loads(path.read_text(encoding="utf-8")) if s.get("enabled")]


def pick(item: dict, keys: list[str]) -> str:
    for key in keys:
        value = item.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return str(value)
    return ""


def normalize(item: dict, source: dict) -> dict | None:
    """Map one Apify dataset item to our question shape, or None to drop it."""
    fields = source.get("fields", {})
    title = pick(item, fields.get("title", ["title"]))
    if not title:
        return None  # comments, ads, empty rows
    url = pick(item, fields.get("url", ["url"]))
    raw_id = pick(item, fields.get("id", ["id"])) or url or title
    question: dict[str, Any] = {
        "source": source.get("source", "web"),
        "title": title[:300],
        "externalId": f"{source['name']}:{raw_id}"[:300],
    }
    body = pick(item, fields.get("body", ["body"]))
    if body:
        question["body"] = body[:2000]
    if url:
        question["sourceUrl"] = url
    return question


def _run_actor(token: str, source: dict) -> list[dict]:
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
    limit = int(source.get("maxQuestions", 20))
    items: list[dict] = []
    for item in client.dataset(dataset_id).iterate_items():
        items.append(item)
        if len(items) >= limit * 3:  # leave room for rows we drop
            break
    return items


async def fetch_from_apify(settings: Settings) -> tuple[list[dict], list[str]]:
    """Run every enabled source. Returns (questions, errors)."""
    if not settings.apify_token:
        return [], ["APIFY_TOKEN is not set"]
    questions: list[dict] = []
    errors: list[str] = []
    for source in load_sources(settings):
        try:
            items = await asyncio.to_thread(_run_actor, settings.apify_token, source)
        except Exception as exc:  # one broken source shouldn't stop the others
            errors.append(f"{source['name']}: {exc}")
            continue
        normalized = [q for q in (normalize(i, source) for i in items) if q]
        questions.extend(normalized[: int(source.get("maxQuestions", 20))])
    return questions, errors


async def route_new_questions(store: Store, llm: LLM) -> dict:
    """Triage every 'new' question: skip unsafe ones, assign the rest to elders."""
    new = await store.questions_by_status("new")
    elders = await store.list_elders()
    if not new or not elders:
        return {"assigned": 0, "skipped": 0, "unmatched": len(new)}
    result = await llm.triage_questions(new, elders)
    assigned = skipped = unmatched = 0
    for item in result.items:
        if not 0 <= item.index < len(new):
            continue
        question = new[item.index]
        if not item.answerable:
            await store.skip_question(question["_id"], item.skip_reason or "not suitable")
            skipped += 1
        elif 0 <= item.elder_index < len(elders):
            await store.assign_question(question["_id"], elders[item.elder_index]["_id"],
                                        item.topics)
            assigned += 1
        else:
            unmatched += 1
    return {"assigned": assigned, "skipped": skipped, "unmatched": unmatched}
