import json

from app.config import Settings
from app.services import questions
from app.services.questions import load_sources, normalize, pick
from app.services.sources import ADAPTERS

SOURCE = {
    "name": "reddit-test",
    "kind": "apify",
    "source": "reddit",
    "fields": {
        "title": ["title"],
        "body": ["body", "selftext"],
        "url": ["url", "link"],
        "id": ["id", "parsedId"],
    },
}


def test_pick_first_non_empty():
    assert pick({"a": "", "b": "  hi "}, ["a", "b"]) == "hi"
    assert pick({"a": 42}, ["a"]) == "42"
    assert pick({"a": True}, ["a"]) == ""
    assert pick({}, ["a"]) == ""


def test_normalize_maps_fields():
    item = {"title": "How did you save money?", "selftext": "I'm 22", "link": "https://r/x",
            "parsedId": "abc"}
    q = normalize(item, SOURCE)
    assert q["source"] == "reddit"
    assert q["title"] == "How did you save money?"
    assert q["externalId"] == "reddit-test:abc"
    assert q["body"] == "I'm 22"
    assert q["sourceUrl"] == "https://r/x"
    assert len(q["fingerprint"]) == 16


def test_normalize_drops_rows_without_title():
    assert normalize({"body": "a comment"}, SOURCE) is None


def test_normalize_falls_back_to_url_for_id_and_omits_empty_fields():
    q = normalize({"title": "Q", "url": "https://x"}, SOURCE)
    assert q["externalId"] == "reddit-test:https://x"
    for key in ("body", "community", "score", "answerCount", "postedAt", "tags"):
        assert key not in q  # Convex optional fields must be omitted, never null


def test_load_sources_keeps_only_enabled(tmp_path, monkeypatch):
    path = tmp_path / "sources.json"
    path.write_text(json.dumps([{"name": "a", "enabled": True}, {"name": "b", "enabled": False},
                                {"name": "c"}]))
    monkeypatch.setattr(questions, "BACKEND_DIR", tmp_path)
    settings = Settings(question_sources_file="sources.json")
    assert [s["name"] for s in load_sources(settings)] == ["a"]
    # Naming sources explicitly runs them even when disabled (used for testing Quora).
    assert [s["name"] for s in load_sources(settings, ["b", "zzz"])] == ["b"]


def test_repo_sources_file_is_valid():
    every = questions.all_sources(Settings())
    names = [s["name"] for s in every]
    assert len(names) == len(set(names)), "source names must be unique"
    assert load_sources(Settings()), "question_sources.json should have an enabled source"
    for s in every:
        assert s.get("kind", "apify") in ADAPTERS, s["name"]
        assert s.get("source") and s.get("label")
        if s.get("kind", "apify") == "apify":
            assert s["actor"] and isinstance(s.get("input"), dict), s["name"]
    quora = next(s for s in every if s["source"] == "quora")
    assert quora["enabled"] is False, "Quora ships disabled until it's live-tested"
