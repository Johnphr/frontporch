"""Question sourcing: adapters, normalize, filters, dedupe, ranking, refresh.

No network: Stack Exchange and Discourse use httpx.MockTransport, Apify is
replaced by fixture items in backend/tests/fixtures/.
"""

import asyncio
import json
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from fastapi.testclient import TestClient

import app.deps as deps
from app.config import Settings, get_settings
from app.llm import LLM, TriageItem, TriageResult
from app.services import questions as q
from app.services.publishers.discourse import topic_id
from app.services.sources import discourse, stackexchange

FIXTURES = Path(__file__).parent / "fixtures"
NOW_MS = datetime(2026, 10, 24, 12, tzinfo=timezone.utc).timestamp() * 1000


def load(name: str):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def repo_source(name: str) -> dict:
    return next(s for s in q.all_sources(Settings()) if s["name"] == name)


def run(coro):
    return asyncio.run(coro)


def fake_adapter(items):
    async def fetch(source, settings):
        return [dict(i) for i in items]
    return fetch


# ---------- Reddit (Apify) ----------


def test_reddit_filters_and_keeps_real_questions(monkeypatch):
    monkeypatch.setitem(q.ADAPTERS, "apify", fake_adapter(load("reddit_items.json")))
    kept, report = run(q._fetch_source(repo_source("reddit-advice"), Settings(), None, NOW_MS))
    assert [x["externalId"] for x in kept] == ["reddit-advice:iron", "reddit-advice:aaa111"]
    assert report["fetched"] == 8 and report["kept"] == 2 and report["filtered"] == 6
    assert report["reasons"] == {
        "no title": 1, "removed": 1, "nsfw": 1, "not a question": 1, "too old": 1,
        "needs a professional": 1,
    }


def test_reddit_fields_are_floats_for_convex(monkeypatch):
    monkeypatch.setitem(q.ADAPTERS, "apify", fake_adapter(load("reddit_items.json")))
    kept, _ = run(q._fetch_source(repo_source("reddit-askoldpeople"), Settings(), None, NOW_MS))
    first = next(x for x in kept if x["externalId"].endswith("aaa111"))
    assert first["community"] == "AskOldPeople"
    assert first["score"] == 45.0 and first["answerCount"] == 2.0
    for key in ("score", "answerCount", "postedAt", "priority"):
        assert isinstance(first[key], float), key  # Convex v.number() rejects Python ints


def test_limit_caps_questions_per_source(monkeypatch):
    monkeypatch.setitem(q.ADAPTERS, "apify", fake_adapter(load("reddit_items.json")))
    kept, report = run(q._fetch_source(repo_source("reddit-advice"), Settings(), 1, NOW_MS))
    assert len(kept) == 1 and report["kept"] == 1
    assert kept[0]["externalId"].endswith("iron")  # highest priority survives


# ---------- Quora (Apify) ----------


def test_quora_keeps_question_records_with_no_age_limit(monkeypatch):
    monkeypatch.setitem(q.ADAPTERS, "apify", fake_adapter(load("quora_items.json")))
    kept, report = run(q._fetch_source(repo_source("quora-life-advice"), Settings(), None, NOW_MS))
    ids = {x["externalId"] for x in kept}
    assert ids == {"quora-life-advice:2628", "quora-life-advice:9001"}
    assert report["reasons"] == {"no title": 1}  # the answer record
    hinge = next(x for x in kept if x["externalId"].endswith("9001"))
    assert hinge["answerCount"] == 0.0 and hinge["source"] == "quora"


# ---------- Stack Exchange (official API) ----------


def test_stackexchange_adapter_calls_api_and_respects_backoff(monkeypatch):
    calls, sleeps = [], []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(dict(request.url.params))
        return httpx.Response(200, json=load("stackexchange_diy.json"))

    async def fake_sleep(seconds):
        sleeps.append(seconds)

    monkeypatch.setattr(stackexchange.asyncio, "sleep", fake_sleep)
    source = {"name": "se", "kind": "stackexchange_api", "sites": ["diy", "cooking"],
              "pageSize": 15}

    async def go():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await stackexchange.fetch(source, Settings(), client)

    items = run(go())
    assert [c["site"] for c in calls] == ["diy", "cooking"]
    assert calls[0]["sort"] == "creation" and calls[0]["filter"] == "withbody"
    assert calls[0]["pagesize"] == "15" and "key" not in calls[0]
    assert sleeps == [2.0]  # backoff honored between sites, not after the last
    assert len(items) == 4 and items[0]["site"] == "diy"


def test_stackexchange_normalize_cleans_html_and_skips_closed():
    source = repo_source("stackexchange-everyday")
    raw = [{**i, "site": "diy"} for i in load("stackexchange_diy.json")["items"]]
    good = q.normalize(raw[0], source)
    assert good["title"] == 'How do I remove rust from "old" hand tools?'
    assert good["body"] == "I inherited my dad's hand tools & they are rusty."
    assert good["community"] == "diy" and good["tags"] == ["rust", "tools"]
    assert q.filter_reason(raw[0], good, source, NOW_MS) is None
    closed = q.normalize(raw[1], source)
    assert q.filter_reason(raw[1], closed, source, NOW_MS) == "closed"


# ---------- Discourse (public JSON) ----------


def test_discourse_adapter_skips_pinned_and_closed_and_builds_urls():
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        return httpx.Response(200, json=load("discourse_latest.json"))

    source = {"name": "garden-forum", "kind": "discourse_json", "source": "discourse",
              "forumUrl": "https://forum.example.org/", "category": "vegetables"}

    async def go():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await discourse.fetch(source, Settings(), client)

    items = run(go())
    assert seen == ["https://forum.example.org/c/vegetables/l/latest.json"]
    assert [i["id"] for i in items] == [4242]
    assert items[0]["url"] == "https://forum.example.org/t/best-way-to-start-tomatoes/4242"
    assert items[0]["answer_count"] == 2 and items[0]["community"] == "forum.example.org"

    question = q.normalize(items[0], source)
    assert question["externalId"] == "garden-forum:discourse-topic-4242"
    assert topic_id(question) == 4242  # the Discourse publisher can reply to it


# ---------- helpers ----------


@pytest.mark.parametrize("value,expected", [
    ("2026-10-24T12:00:00.000Z", NOW_MS),
    (NOW_MS / 1000, NOW_MS),
    (NOW_MS, NOW_MS),
    ("1792843200", NOW_MS),
    ("not a date", None),
    (None, None),
])
def test_parse_timestamp(value, expected):
    assert q.parse_timestamp(value) == expected


def test_fingerprint_matches_rewordings_only():
    a = q.fingerprint("How do you keep a cast iron pan from rusting?")
    b = q.fingerprint("Keep cast iron pan from rusting - how?")
    c = q.fingerprint("How do you season a new cast iron pan?")
    assert a == b and a != c


@pytest.mark.parametrize("title,expected", [
    ("What was school like in the 50s?", True),
    ("Any tips for growing basil indoors", True),
    ("Should I learn to sew", True),
    ("My first apartment, 1972", False),
])
def test_looks_like_question(title, expected):
    assert q.looks_like_question(title) is expected


def test_priority_prefers_fresh_unanswered_questions():
    fresh = {"score": 3.0, "answerCount": 0.0, "postedAt": NOW_MS - 3_600_000}
    stale = {"score": 3.0, "answerCount": 12.0, "postedAt": NOW_MS - 12 * 86_400_000}
    popular_old = {"score": 5000.0, "answerCount": 40.0, "postedAt": NOW_MS - 13 * 86_400_000}
    assert q.priority(fresh, NOW_MS) > q.priority(stale, NOW_MS)
    assert q.priority(popular_old, NOW_MS) > q.priority(stale, NOW_MS)


def test_dedupe_keeps_highest_priority_copy():
    qs = [
        {"externalId": "a:1", "fingerprint": "f", "priority": 1.0},
        {"externalId": "b:1", "fingerprint": "f", "priority": 3.0},
        {"externalId": "c:1", "fingerprint": "g", "priority": 2.0},
    ]
    unique, dropped = q.dedupe(qs)
    assert dropped == 1
    assert {x["externalId"] for x in unique} == {"b:1", "c:1"}


def test_prepare_manual_ranks_above_scraped():
    manual = q.prepare_manual({"source": "manual", "title": "How did you meet grandma?",
                               "externalId": "manual:1"})
    assert manual["priority"] == q.MANUAL_PRIORITY and manual["fingerprint"]


# ---------- fetch_questions + refresh_questions ----------


@pytest.fixture
def two_sources(tmp_path, monkeypatch):
    shared = {"title": "What's the secret to a really flaky pie crust?", "id": "dup",
              "url": "https://x/dup", "createdAt": "2026-10-23T00:00:00Z", "upVotes": 1}
    sources = [
        {"name": "reddit-a", "kind": "apify", "source": "reddit", "enabled": True,
         "actor": "x/y", "input": {}, "label": "A"},
        {"name": "other-b", "kind": "apify_b", "source": "web", "enabled": True, "label": "B"},
        {"name": "broken", "kind": "apify_broken", "source": "web", "enabled": True,
         "label": "C"},
        {"name": "off", "kind": "apify", "source": "web", "enabled": False, "label": "D"},
    ]
    (tmp_path / "s.json").write_text(json.dumps(sources))
    monkeypatch.setattr(q, "BACKEND_DIR", tmp_path)
    monkeypatch.setattr(q.time, "time", lambda: NOW_MS / 1000)

    async def broken(source, settings):
        raise RuntimeError("actor exploded")

    monkeypatch.setitem(q.ADAPTERS, "apify",
                        fake_adapter(load("reddit_items.json") + [shared]))
    monkeypatch.setitem(q.ADAPTERS, "apify_b", fake_adapter([{**shared, "upVotes": 900}]))
    monkeypatch.setitem(q.ADAPTERS, "apify_broken", broken)
    return Settings(question_sources_file="s.json")


def test_fetch_questions_reports_per_source_and_dedupes(two_sources):
    questions, reports = run(q.fetch_questions(two_sources))
    assert set(reports) == {"reddit-a", "other-b", "broken"}  # disabled source not run
    assert reports["broken"]["error"] == "RuntimeError: actor exploded"
    assert reports["reddit-a"]["duplicate"] == 1  # same question also on other-b, lower score
    dup = [x for x in questions if x["fingerprint"] == q.fingerprint("What's the secret to a really flaky pie crust?")]
    assert len(dup) == 1 and dup[0]["_sourceName"] == "other-b"


def test_fetch_questions_unknown_name_is_reported(two_sources):
    _, reports = run(q.fetch_questions(two_sources, ["off", "nope"]))
    assert reports["nope"]["error"] == "no source with this name"
    assert "off" in reports  # explicitly named disabled source runs


class FakeStore:
    configured = True

    def __init__(self):
        self.upserts = []

    async def upsert_questions(self, batch):
        self.upserts.append(batch)
        return [f"id{i}" for i, _ in enumerate(batch[:1])]  # pretend only 1 is new per batch

    async def questions_by_status(self, status):
        return []

    async def list_elders(self):
        return []


def test_refresh_questions_saves_per_source_and_counts(two_sources):
    store = FakeStore()
    services = SimpleNamespace(settings=two_sources, store=store, llm=None)
    result = run(q.refresh_questions(services))
    assert result["inserted"] == 2  # one per non-empty source batch
    assert result["sources"]["reddit-a"]["inserted"] == 1
    assert result["sources"]["broken"].get("inserted") is None
    assert result["errors"] == ["broken: RuntimeError: actor exploded"]
    assert result["routing"] == {"assigned": 0, "skipped": 0, "unmatched": 0}
    for batch in store.upserts:
        for question in batch:
            assert "_sourceName" not in question and None not in question.values()


# ---------- batched triage ----------


def test_triage_runs_in_batches_with_global_indices():
    llm = LLM(Settings(anthropic_api_key=None))
    calls = []

    async def fake_parse(*, system, user, schema, effort, max_tokens):
        size = user.split("QUESTIONS:\n", 1)[1].count("\n    ")
        calls.append(size)
        items = [TriageItem(index=i, answerable=True, skip_reason="", topics=["x"],
                            elder_index=0) for i in range(size)]
        items.append(TriageItem(index=999, answerable=True, skip_reason="", topics=[],
                                elder_index=0))  # out of range: ignored
        return TriageResult(items=items)

    llm._parse = fake_parse
    questions = [{"title": f"Question {i}?", "source": "reddit", "community": "Cooking"}
                 for i in range(60)]
    result = run(llm.triage_questions(questions, [{"name": "Rosa", "expertise": ["cooking"]}]))
    assert calls == [25, 25, 10]
    assert [i.index for i in result.items] == list(range(60))


# ---------- API routes ----------


@pytest.fixture
def client(monkeypatch):
    for name in ("CONVEX_URL", "CONVEX_BACKEND_SECRET", "ANTHROPIC_API_KEY", "APIFY_TOKEN"):
        monkeypatch.delenv(name, raising=False)
    get_settings.cache_clear()
    deps._services = None
    from app.main import app

    yield TestClient(app)
    get_settings.cache_clear()
    deps._services = None


def test_sources_route_lists_config(client):
    response = client.get("/api/questions/sources")
    assert response.status_code == 200
    names = {s["name"]: s for s in response.json()}
    assert names["quora-life-advice"]["enabled"] is False
    assert names["stackexchange-everyday"]["kind"] == "stackexchange_api"


def test_refresh_route_passes_options(client, monkeypatch):
    from app.routes import api

    seen = []

    async def fake_refresh(services, sources=None, limit=None):
        seen.append((sources, limit))
        return {"ok": True}

    monkeypatch.setattr(api, "refresh_questions", fake_refresh)
    assert client.post("/api/questions/refresh",
                       json={"sources": ["reddit-advice"], "limit": 5}).json() == {"ok": True}
    assert client.post("/api/questions/refresh").status_code == 200  # body optional
    assert seen == [(["reddit-advice"], 5), (None, None)]
    assert client.post("/api/questions/refresh", json={"limit": 0}).status_code == 422
