"""Find real questions online, clean them up, then let Claude route them to elders.

Pipeline for each refresh:
  1. fetch     run every selected source (Apify, Stack Exchange API, Discourse JSON)
  2. normalize map raw items to one question shape (see `normalize`)
  3. filter    drop non-questions, removed/NSFW posts, old posts, and topics an
               older adult shouldn't advise on (Claude triage is a second net)
  4. dedupe    same question on two sites -> keep the higher-priority copy
  5. save      Convex skips anything it already has (externalId or fingerprint)
  6. route     Claude assigns each new question to the best-matching elder

Sources live in backend/question_sources.json. See README "Finding questions".
"""

import asyncio
import hashlib
import html
import json
import math
import re
import time
from datetime import datetime
from pathlib import Path
from typing import Any

from ..config import Settings
from ..db import Store
from ..llm import LLM
from .sources import ADAPTERS, DEFAULT_FIELDS, SourceError

BACKEND_DIR = Path(__file__).resolve().parents[2]

DEFAULT_MAX_AGE_DAYS = 14
MANUAL_PRIORITY = 10.0  # questions typed in by organizers go before scraped ones

QUESTION_WORDS = (
    "how", "what", "why", "when", "where", "who", "which", "should", "would", "could",
    "can", "do", "does", "did", "is", "are", "was", "were", "have", "has", "any",
    "anyone", "anybody", "has anyone", "will",
)
ADVICE_WORDS = re.compile(r"\b(advice|tips?|recommend\w*|suggestions?|help me|wisdom|lessons?)\b",
                          re.I)

# Topics that need a licensed professional or are unsafe to crowdsource advice on.
BLOCKLIST = re.compile(
    r"\b(diagnos\w*|symptoms?|medication|dosage|prescri\w*|chemo\w*|cancer|tumou?r|"
    r"lawsuit|lawyer|attorney|sue|suing|custody|legal advice|"
    r"invest\w*|stocks?|crypto\w*|bitcoin|forex|tax return|irs|"
    r"suicid\w*|self[- ]harm|kill myself|overdose|abuse\w*)\b",
    re.I,
)
REMOVED_MARKERS = {"[removed]", "[deleted]", "[ removed by reddit ]"}
STOPWORDS = {
    "the", "and", "for", "you", "your", "with", "that", "this", "what", "how", "why", "when",
    "who", "are", "was", "were", "have", "has", "had", "does", "did", "can", "could", "would",
    "should", "any", "anyone", "there", "their", "they", "from", "about", "into", "just",
    "like", "get", "got", "its", "it's", "what's", "how's", "i'm", "our", "out", "not",
    "all", "but", "one", "some",
}
TAG_RE = re.compile(r"<[^>]+>")
SPACE_RE = re.compile(r"\s+")
WORD_RE = re.compile(r"[a-z0-9']+")


# ---------- sources ----------


def all_sources(settings: Settings) -> list[dict]:
    path = BACKEND_DIR / settings.question_sources_file
    if not path.exists():
        return []
    return json.loads(path.read_text(encoding="utf-8"))


def load_sources(settings: Settings, names: list[str] | None = None) -> list[dict]:
    """Enabled sources, or exactly the named ones (even if disabled) when `names` is given."""
    sources = all_sources(settings)
    if names:
        wanted = set(names)
        return [s for s in sources if s.get("name") in wanted]
    return [s for s in sources if s.get("enabled")]


# ---------- normalize ----------


def pick(item: dict, keys: list[str]) -> str:
    for key in keys:
        value = item.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return str(value)
    return ""


def pick_number(item: dict, keys: list[str]) -> float | None:
    for key in keys:
        value = item.get(key)
        if isinstance(value, bool):
            continue
        if isinstance(value, (int, float)):
            return float(value)
        if isinstance(value, str):
            try:
                return float(value.replace(",", ""))
            except ValueError:
                continue
    return None


def clean_text(text: str) -> str:
    """Strip HTML tags and entities (Stack Exchange and Discourse send HTML)."""
    return SPACE_RE.sub(" ", html.unescape(TAG_RE.sub(" ", text))).strip()


def parse_timestamp(value: Any) -> float | None:
    """ISO string or unix seconds/milliseconds -> epoch milliseconds (float)."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value) if value > 1e12 else float(value) * 1000.0
    if isinstance(value, str) and value.strip():
        text = value.strip()
        if text.replace(".", "", 1).isdigit():
            return parse_timestamp(float(text))
        try:
            return datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp() * 1000.0
        except ValueError:
            return None
    return None


def fingerprint(title: str) -> str:
    """Same question worded slightly differently -> same fingerprint."""
    words = WORD_RE.findall(clean_text(title).lower())
    tokens = sorted({w for w in words if len(w) > 2 and w not in STOPWORDS})
    key = " ".join(tokens) if len(tokens) >= 2 else " ".join(words)
    return hashlib.sha1(key.encode()).hexdigest()[:16]


def fields_for(source: dict) -> dict[str, list[str]]:
    base = DEFAULT_FIELDS.get(source.get("kind", "apify"), DEFAULT_FIELDS["apify"])
    return {**base, **source.get("fields", {})}


def normalize(item: dict, source: dict) -> dict | None:
    """Map one raw item to our question shape, or None if it has no title."""
    fields = fields_for(source)
    title = clean_text(pick(item, fields["title"]))
    if not title:
        return None  # comments, ads, empty rows
    url = pick(item, fields["url"])
    raw_id = pick(item, fields["id"]) or url or title
    if source.get("kind") == "discourse_json":
        raw_id = f"discourse-topic-{raw_id}"  # the Discourse publisher reads this
    question: dict[str, Any] = {
        "source": source.get("source", "web"),
        "title": title[:300],
        "externalId": f"{source['name']}:{raw_id}"[:300],
        "fingerprint": fingerprint(title),
    }
    body = clean_text(pick(item, fields["body"]))
    if body:
        question["body"] = body[:2000]
    if url:
        question["sourceUrl"] = url
    community = pick(item, fields["community"]) or source.get("community", "")
    if community:
        question["community"] = community
    score = pick_number(item, fields["score"])
    if score is not None:
        question["score"] = score
    answers = pick_number(item, fields["answers"])
    if answers is not None:
        question["answerCount"] = answers
    for key in fields["postedAt"]:
        posted = parse_timestamp(item.get(key))
        if posted is not None:
            question["postedAt"] = posted
            break
    tags = next((item[k] for k in fields["tags"] if isinstance(item.get(k), list)), None)
    if tags:
        question["tags"] = [str(t) for t in tags if isinstance(t, (str, int))][:8]
    return question


# ---------- filter + rank ----------


def looks_like_question(title: str) -> bool:
    lowered = title.lower().strip()
    if "?" in title or ADVICE_WORDS.search(title):
        return True
    return any(lowered.startswith(w + " ") for w in QUESTION_WORDS)


def filter_reason(item: dict, question: dict, source: dict, now_ms: float) -> str | None:
    """Why this question should be dropped, or None to keep it."""
    title = question["title"]
    body = question.get("body", "")
    data_type = item.get("dataType")
    if data_type and data_type != "post":
        return "not a post"
    if item.get("type") and item.get("type") != "question" and source.get("source") == "quora":
        return "not a question record"
    if title.lower() in REMOVED_MARKERS or body.lower() in REMOVED_MARKERS:
        return "removed"
    if item.get("removed") or item.get("isRemoved") or item.get("deleted"):
        return "removed"
    if item.get("closed_date") or item.get("closed"):
        return "closed"
    if item.get("over18") or item.get("over_18") or item.get("isNsfw") or item.get("nsfw") \
            or "nsfw" in title.lower():
        return "nsfw"
    if len(title) < 12:
        return "too short"
    if source.get("requireQuestion", True) and not looks_like_question(title):
        return "not a question"
    max_age = source.get("maxAgeDays", DEFAULT_MAX_AGE_DAYS)
    posted = question.get("postedAt")
    if max_age is not None and posted is not None:
        if now_ms - posted > float(max_age) * 86_400_000:
            return "too old"
    if BLOCKLIST.search(f"{title} {body[:500]}"):
        return "needs a professional"
    return None


def priority(question: dict, now_ms: float, max_age_days: float = DEFAULT_MAX_AGE_DAYS) -> float:
    """Higher = ask sooner. Engagement + freshness + 'nobody has answered well yet'."""
    score = max(question.get("score") or 0.0, 0.0)
    engagement = math.log1p(score)
    posted = question.get("postedAt")
    if posted is None:
        freshness = 1.0
    else:
        age_days = max(0.0, (now_ms - posted) / 86_400_000)
        freshness = 2.0 * max(0.0, 1.0 - age_days / max(max_age_days, 1.0))
    answers = question.get("answerCount")
    if answers is None:
        few_answers = 0.5
    elif answers == 0:
        few_answers = 1.5
    elif answers <= 2:
        few_answers = 1.0
    elif answers <= 5:
        few_answers = 0.5
    else:
        few_answers = 0.0
    return round(engagement + freshness + few_answers, 3)


def prepare_manual(question: dict) -> dict:
    """Add the computed fields to a question typed into the dashboard."""
    return {**question, "fingerprint": fingerprint(question["title"]),
            "priority": MANUAL_PRIORITY, "postedAt": time.time() * 1000.0}


# ---------- fetch ----------


async def _fetch_source(source: dict, settings: Settings, limit: int | None, now_ms: float
                        ) -> tuple[list[dict], dict]:
    report: dict[str, Any] = {"fetched": 0, "filtered": 0, "kept": 0, "reasons": {}}
    adapter = ADAPTERS.get(source.get("kind", "apify"))
    if adapter is None:
        report["error"] = f"unknown kind {source.get('kind')!r}"
        return [], report
    try:
        items = await adapter(source, settings)
    except SourceError as exc:
        report["error"] = str(exc)
        return [], report
    except Exception as exc:  # one broken source shouldn't stop the others
        report["error"] = f"{type(exc).__name__}: {exc}"
        return [], report

    report["fetched"] = len(items)
    max_age = source.get("maxAgeDays", DEFAULT_MAX_AGE_DAYS) or DEFAULT_MAX_AGE_DAYS
    kept: list[dict] = []
    for item in items:
        question = normalize(item, source)
        reason = "no title" if question is None else filter_reason(item, question, source, now_ms)
        if reason:
            report["filtered"] += 1
            report["reasons"][reason] = report["reasons"].get(reason, 0) + 1
            continue
        question["priority"] = priority(question, now_ms, float(max_age))
        kept.append(question)
    kept.sort(key=lambda q: q["priority"], reverse=True)
    kept = kept[: int(limit or source.get("maxQuestions", 20))]
    report["kept"] = len(kept)
    return kept, report


def dedupe(questions: list[dict]) -> tuple[list[dict], int]:
    """Drop cross-site duplicates (same fingerprint), keeping the highest priority."""
    best: dict[str, dict] = {}
    for q in questions:
        key = q.get("fingerprint") or q["externalId"]
        if key not in best or q.get("priority", 0) > best[key].get("priority", 0):
            best[key] = q
    unique = list(best.values())
    return unique, len(questions) - len(unique)


async def fetch_questions(settings: Settings, names: list[str] | None = None,
                          limit: int | None = None) -> tuple[list[dict], dict[str, dict]]:
    """Run the selected sources in parallel. Returns (questions, per-source report)."""
    sources = load_sources(settings, names)
    reports: dict[str, dict] = {}
    for missing in sorted(set(names or []) - {s.get("name") for s in sources}):
        reports[missing] = {"fetched": 0, "filtered": 0, "kept": 0, "reasons": {},
                            "error": "no source with this name"}
    now_ms = time.time() * 1000.0
    results = await asyncio.gather(*(_fetch_source(s, settings, limit, now_ms) for s in sources))
    merged: list[dict] = []
    for source, (questions, report) in zip(sources, results):
        reports[source["name"]] = report
        for q in questions:
            q["_sourceName"] = source["name"]
        merged.extend(questions)
    unique, _ = dedupe(merged)
    kept_ids = {id(q) for q in unique}
    for q in merged:
        if id(q) not in kept_ids:
            report = reports[q["_sourceName"]]
            report["duplicate"] = report.get("duplicate", 0) + 1
    return unique, reports


async def fetch_from_apify(settings: Settings) -> tuple[list[dict], list[str]]:
    """Legacy wrapper: all enabled sources (not only Apify). Returns (questions, errors)."""
    questions, reports = await fetch_questions(settings)
    for q in questions:
        q.pop("_sourceName", None)
    errors = [f"{name}: {r['error']}" for name, r in reports.items() if r.get("error")]
    return questions, errors


# ---------- save + route ----------


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


async def refresh_questions(services, sources: list[str] | None = None,
                            limit: int | None = None) -> dict:
    """Fetch, save and route questions. Shared by /api/questions/refresh and Convex jobs.

    `services` is app.deps.Services. `sources` picks source names (default: all
    enabled); `limit` caps questions kept per source.
    """
    questions, reports = await fetch_questions(services.settings, sources, limit)
    by_source: dict[str, list[dict]] = {}
    for q in questions:
        by_source.setdefault(q.pop("_sourceName"), []).append(q)
    inserted_total = 0
    for name, batch in by_source.items():
        ids = await services.store.upsert_questions(batch)
        inserted = len(ids or [])
        inserted_total += inserted
        report = reports[name]
        report["inserted"] = inserted
        # Already in Convex from an earlier refresh (or another site) counts as a duplicate.
        report["duplicate"] = report.get("duplicate", 0) + len(batch) - inserted
    routing = await route_new_questions(services.store, services.llm)
    errors = [f"{name}: {r['error']}" for name, r in reports.items() if r.get("error")]
    return {
        "fetched": sum(r["fetched"] for r in reports.values()),
        "kept": len(questions),
        "inserted": inserted_total,
        "errors": errors,
        "sources": reports,
        "routing": routing,
    }
