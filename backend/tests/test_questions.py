import json

from app.config import Settings
from app.services import questions
from app.services.questions import load_sources, normalize, pick

SOURCE = {
    "name": "reddit-test",
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
    assert q == {
        "source": "reddit",
        "title": "How did you save money?",
        "externalId": "reddit-test:abc",
        "body": "I'm 22",
        "sourceUrl": "https://r/x",
    }


def test_normalize_drops_rows_without_title():
    assert normalize({"body": "a comment"}, SOURCE) is None


def test_normalize_falls_back_to_url_for_id_and_omits_empty_body():
    q = normalize({"title": "Q", "url": "https://x"}, SOURCE)
    assert q["externalId"] == "reddit-test:https://x"
    assert "body" not in q


def test_load_sources_keeps_only_enabled(tmp_path, monkeypatch):
    path = tmp_path / "sources.json"
    path.write_text(json.dumps([{"name": "a", "enabled": True}, {"name": "b", "enabled": False},
                                {"name": "c"}]))
    monkeypatch.setattr(questions, "BACKEND_DIR", tmp_path)
    settings = Settings(question_sources_file="sources.json")
    assert [s["name"] for s in load_sources(settings)] == ["a"]


def test_repo_sources_file_is_valid():
    sources = load_sources(Settings())
    assert sources, "question_sources.json should have at least one enabled source"
    for s in sources:
        assert s["actor"] and s["name"] and "fields" in s
