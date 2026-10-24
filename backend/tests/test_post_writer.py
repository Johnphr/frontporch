"""Per-platform post versions + faithfulness check, with a fake LLM (no network)."""

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace

import httpx

from app.config import Settings
from app.services import post_writer, publishing
from app.services.post_writer import (LIMITS, PlatformCheck, PostVariants, QualityReport,
                                      build_posts, elder_words_from_transcript)
from app.services.publishers import bluesky, linkedin
from app.services.publishers.base import PublishContext

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "sample_call.json")
                     .read_text(encoding="utf-8"))
QUESTION, ELDER, TURNS, DRAFT = (FIXTURE["question"], FIXTURE["elder"], FIXTURE["turns"],
                                 FIXTURE["draft"])
SETTINGS = Settings(_env_file=None, frontend_url="https://porch.example")


def words(n: int, word: str = "word") -> str:
    return " ".join([word] * n)


GOOD = {
    "bluesky": "52 years married: don't go to bed angry, cook together on Sundays, laugh.",
    "linkedin": words(150),
    "reddit": words(120),
    "quora": words(150),
    "discourse": words(100),
}


class FakeLLM:
    """Returns queued PostVariants for variant calls and a canned QualityReport."""

    configured = True

    def __init__(self, variants: list[dict], failing: dict[str, list[str]] | None = None,
                 skip: tuple[str, ...] = ()):
        self.variants = list(variants)
        self.failing = failing or {}
        self.skip = skip
        self.calls: list[str] = []

    async def _parse(self, *, system, user, schema, effort, max_tokens):
        self.calls.append(schema.__name__)
        if schema is PostVariants:
            data = self.variants.pop(0) if len(self.variants) > 1 else self.variants[0]
            return PostVariants(**data)
        assert schema is QualityReport
        platforms = [line[1:-1] for line in user.splitlines()
                     if line.startswith("[") and line.endswith("]")]
        return QualityReport(checks=[
            PlatformCheck(platform=p, passed=p not in self.failing,
                          issues=self.failing.get(p, []))
            for p in platforms if p not in self.skip
        ])


def run(coro):
    return asyncio.run(coro)


def ctx_for(answer: dict, **settings) -> PublishContext:
    s = Settings(_env_file=None, frontend_url="https://porch.example", **settings)
    return PublishContext(settings=s, answer=answer, question=QUESTION, elder=ELDER)


# ---------- build_posts ----------


def test_build_posts_appends_disclosure_by_code_and_checks_every_platform():
    llm = FakeLLM([GOOD])
    variants, quality = run(build_posts(llm, QUESTION, ELDER, TURNS, DRAFT, settings=SETTINGS))
    assert set(variants) == set(post_writer.VARIANT_PLATFORMS)
    for platform, text in variants.items():
        assert "written up with AI" in text, platform
        assert "Rosa" in text, platform
    assert {q["platform"] for q in quality} == set(post_writer.CHECKED_PLATFORMS)
    assert all(q["passed"] for q in quality)
    assert llm.calls == ["PostVariants", "QualityReport"]


def test_bluesky_final_post_fits_300_with_link_label():
    llm = FakeLLM([{**GOOD, "bluesky": "x" * 400}])  # too long twice -> truncated
    variants, _ = run(build_posts(llm, QUESTION, ELDER, TURNS, DRAFT, settings=SETTINGS))
    body, label = bluesky.build_post_text(ctx_for({"_id": "a1", "variants": variants}))
    assert len(body) + len(label) <= bluesky.POST_LIMIT
    assert body.startswith("x") and "written up with AI" in body


def test_rewrite_once_then_keep_good_versions():
    too_short = {**GOOD, "linkedin": words(10)}
    llm = FakeLLM([too_short, {**GOOD, "linkedin": words(160, "fixed")}])
    variants, _ = run(build_posts(llm, QUESTION, ELDER, TURNS, DRAFT, settings=SETTINGS))
    assert llm.calls == ["PostVariants", "PostVariants", "QualityReport"]
    assert variants["linkedin"].startswith("fixed")
    assert variants["reddit"].startswith("word")  # untouched platforms keep the first version


def test_hard_limits_are_truncated_after_retry():
    huge = {**GOOD, "reddit": words(2000)}
    llm = FakeLLM([huge])  # the rewrite returns the same oversize text
    variants, _ = run(build_posts(llm, QUESTION, ELDER, TURNS, DRAFT, settings=SETTINGS))
    ai_part = variants["reddit"].split("\n\n— ")[0]
    assert len(ai_part.split()) <= LIMITS["reddit"]["max_words"]
    assert len(ai_part) <= LIMITS["reddit"]["max_chars"]


def test_judge_flags_and_missing_results_fail():
    llm = FakeLLM([GOOD], failing={"linkedin": ["Says 60 years; she said 52"]},
                  skip=("quora",))
    _, quality = run(build_posts(llm, QUESTION, ELDER, TURNS, DRAFT, settings=SETTINGS))
    by = {q["platform"]: q for q in quality}
    assert by["linkedin"] == {"platform": "linkedin", "passed": False,
                              "issues": ["Says 60 years; she said 52"]}
    assert by["quora"]["passed"] is False  # the judge skipped it: not let through
    assert by["reddit"]["passed"] is True


def test_elder_words_from_transcript():
    transcript = "PIP: Hi there\nELDER: First line\nPIP: More?\nELDER: Second line"
    assert elder_words_from_transcript(transcript) == "First line\nSecond line"
    assert elder_words_from_transcript("no labels here") == "no labels here"


# ---------- text_for / publishers ----------


def test_text_for_uses_variant_and_linkedapi_alias():
    answer = {"_id": "a1", "body": "base body", "keyPoints": [],
              "variants": {"linkedin": "LinkedIn version", "reddit": "Reddit version"}}
    ctx = ctx_for(answer)
    assert ctx.text_for("reddit") == "Reddit version"
    assert ctx.text_for("linkedapi") == "LinkedIn version"
    fallback = ctx.text_for("quora")
    assert fallback.startswith("base body") and "written up with AI" in fallback


def test_linkedin_variant_still_escaped_when_sent(monkeypatch):
    sent = {}

    class FakeClient:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, url, headers=None, json=None):
            sent.update(json)
            return httpx.Response(201, headers={"x-restli-id": "urn:li:share:1"})

    monkeypatch.setattr(linkedin.httpx, "AsyncClient", FakeClient)
    answer = {"_id": "a1", "variants": {"linkedin": "Tip (1): cook #together"}}
    out = run(linkedin.publish(ctx_for(answer, linkedin_access_token="t",
                                       linkedin_author_urn="urn:li:person:x")))
    assert out["status"] == "published"
    assert sent["commentary"].startswith("Tip \\(1\\): cook \\#together")


# ---------- publish_answer gating ----------


class Store:
    def __init__(self, answer: dict):
        self.answer = answer
        self.publications: list[dict] = []
        self.answer_status = None
        self.saved_posts = None

    async def get_answer(self, answer_id):
        return self.answer

    async def get_question(self, question_id):
        return QUESTION

    async def get_elder(self, elder_id):
        return ELDER

    async def set_publication(self, answer_id, pub):
        self.publications.append(pub)

    async def set_answer_status(self, answer_id, status):
        self.answer_status = status

    async def set_question_status(self, question_id, status):
        pass

    async def set_posts(self, answer_id, variants, quality):
        self.saved_posts = (variants, quality)
        self.answer = {**self.answer, "variants": variants, "quality": quality}


BASE_ANSWER = {"_id": "a1", "elderId": ELDER["_id"], "questionId": QUESTION["_id"],
               "transcript": "PIP: q\nELDER: an answer", "title": DRAFT["title"],
               "body": DRAFT["body"], "shortVersion": DRAFT["shortVersion"],
               "keyPoints": DRAFT["keyPoints"], "status": "draft", "publications": []}


def test_needs_review_blocks_and_force_overrides():
    answer = {**BASE_ANSWER, "variants": {"reddit": "r text", "quora": "q text"},
              "quality": [{"platform": "feed", "passed": False, "issues": ["Invented a date"]},
                          {"platform": "reddit", "passed": True, "issues": []},
                          {"platform": "quora", "passed": False, "issues": ["Made up a name"]}]}
    store = Store(answer)
    services = SimpleNamespace(settings=SETTINGS, store=store, llm=None)
    pubs = run(publishing.publish_answer(services, "a1", ["feed", "reddit", "quora"]))
    by = {p["platform"]: p for p in pubs}
    assert by["feed"]["status"] == "needs_review" and "Invented a date" in by["feed"]["error"]
    assert by["quora"]["status"] == "needs_review" and by["quora"]["draftText"] == "q text"
    assert by["reddit"]["status"] == "draft"
    assert store.answer_status is None  # nothing was actually posted

    forced = run(publishing.publish_answer(services, "a1", ["feed"], force=True))
    assert forced[0]["status"] == "published" and store.answer_status == "published"


def test_publish_generates_missing_versions_first():
    store = Store(dict(BASE_ANSWER))
    llm = FakeLLM([GOOD], failing={"bluesky": ["Claims 60 years"]})
    services = SimpleNamespace(settings=SETTINGS, store=store, llm=llm)
    pubs = run(publishing.publish_answer(services, "a1", ["bluesky", "reddit"]))
    assert store.saved_posts is not None
    by = {p["platform"]: p for p in pubs}
    assert by["bluesky"]["status"] == "needs_review"
    assert by["reddit"]["status"] == "draft"
    assert by["reddit"]["draftText"].startswith("word")  # used the reddit version


def test_prepare_posts_saves_clean_payload():
    store = Store(dict(BASE_ANSWER))
    services = SimpleNamespace(settings=SETTINGS, store=store, llm=FakeLLM([GOOD]))
    out = run(post_writer.prepare_posts(services, "a1"))
    variants, quality = store.saved_posts
    assert out["variants"] == variants and set(variants) == set(post_writer.VARIANT_PLATFORMS)
    assert all(set(q) == {"platform", "passed", "issues"} for q in quality)
    assert all(v is not None for v in variants.values())


def test_schedule_prepare_never_raises_and_wait_for_returns():
    class BrokenLLM:
        configured = True

        async def _parse(self, **kwargs):
            raise RuntimeError("no network")

    async def scenario():
        services = SimpleNamespace(settings=SETTINGS, store=Store(dict(BASE_ANSWER)),
                                   llm=BrokenLLM())
        post_writer.schedule_prepare(services, "a9", QUESTION, ELDER, TURNS, DRAFT)
        await post_writer.wait_for("a9", timeout=5)
        assert "a9" not in post_writer._IN_FLIGHT

    run(scenario())
