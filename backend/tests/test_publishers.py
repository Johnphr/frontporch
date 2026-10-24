import asyncio
from types import SimpleNamespace

from app.config import Settings
from app.services import publishing
from app.services.publishers import bluesky, discourse, quora, reddit
from app.services.publishers.base import PublishContext, truncate
from app.services.publishers.linkedin import escape_little_text

ANSWER = {
    "_id": "ans1", "elderId": "eld1", "questionId": "q1", "transcript": "...",
    "title": "Patience fixes most bikes",
    "body": "First, check the chain. My father taught me that in 1958.",
    "shortVersion": "Check the chain first, then the brakes. " * 20,
    "keyPoints": ["Check the chain", "Be patient"], "status": "approved", "publications": [],
}
QUESTION = {"_id": "q1", "source": "reddit", "title": "How do I fix my bike?",
            "sourceUrl": "https://www.reddit.com/r/AskOldPeople/comments/abc/"}
ELDER = {"_id": "eld1", "name": "Rosa Martinez", "language": "es-MX", "expertise": ["bikes"]}


def make_ctx(**settings) -> PublishContext:
    s = Settings(_env_file=None, frontend_url="https://porch.example", **settings)
    return PublishContext(settings=s, answer=ANSWER, question=QUESTION, elder=ELDER)


def run(coro):
    return asyncio.run(coro)


def test_truncate():
    assert truncate("short", 10) == "short"
    out = truncate("the quick brown fox jumps over", 12)
    assert len(out) <= 12 and out.endswith("…")
    assert truncate("abcdefghijklmnop", 5) == "abcd…"


def test_escape_little_text():
    assert escape_little_text("Hi (there) #tag @me") == "Hi \\(there\\) \\#tag \\@me"
    assert escape_little_text("a\\b_c*d~e|f{g}h[i]j<k>") == \
        "a\\\\b\\_c\\*d\\~e\\|f\\{g\\}h\\[i\\]j\\<k\\>"
    assert escape_little_text("plain text.") == "plain text."


def test_bluesky_text_fits_limit():
    ctx = make_ctx()
    body, label = bluesky.build_post_text(ctx)
    assert len(body) + len(label) <= bluesky.POST_LIMIT
    assert "Rosa" in body


def test_bluesky_skipped_without_credentials():
    out = run(bluesky.publish(make_ctx()))
    assert out["status"] == "skipped"


def test_reddit_draft_when_posting_disabled():
    out = run(reddit.publish(make_ctx(reddit_client_id="x", reddit_client_secret="x",
                                      reddit_username="x", reddit_password="x")))
    assert out["status"] == "draft"
    assert out["url"] == QUESTION["sourceUrl"]
    assert "written up with AI" in out["draftText"]


def test_quora_always_draft_without_url_for_other_sources():
    out = run(quora.publish(make_ctx()))
    assert out["status"] == "draft" and "url" not in out


def test_discourse_topic_id_parsing():
    assert discourse.topic_id({"externalId": "forum:discourse-topic-42"}) == 42
    assert discourse.topic_id({"source": "discourse", "externalId": "forum:77"}) == 77
    assert discourse.topic_id({"source": "reddit", "externalId": "reddit:abc"}) is None


class FakeStore:
    def __init__(self):
        self.publications, self.answer_status, self.question_status = [], None, None

    async def get_answer(self, answer_id):
        return ANSWER

    async def get_question(self, question_id):
        return QUESTION

    async def get_elder(self, elder_id):
        return ELDER

    async def set_publication(self, answer_id, pub):
        self.publications.append(pub)

    async def set_answer_status(self, answer_id, status):
        self.answer_status = status

    async def set_question_status(self, question_id, status):
        self.question_status = status


def make_services(store):
    return SimpleNamespace(settings=Settings(_env_file=None), store=store)


def test_publish_answer_marks_published_and_captures_failures(monkeypatch):
    async def boom(ctx):
        raise RuntimeError("network down")

    monkeypatch.setitem(publishing.PUBLISHERS, "bluesky", boom)
    store = FakeStore()
    pubs = run(publishing.publish_answer(make_services(store), "ans1",
                                         ["feed", "bluesky", "nope"]))
    statuses = {p["platform"]: p["status"] for p in pubs}
    assert statuses == {"feed": "published", "bluesky": "failed", "nope": "skipped"}
    assert "network down" in pubs[1]["error"]
    assert store.answer_status == "published" and store.question_status == "answered"
    assert all(None not in p.values() for p in store.publications)


def test_publish_answer_drafts_only_does_not_mark_published():
    store = FakeStore()
    pubs = run(publishing.publish_answer(make_services(store), "ans1", ["quora", "reddit"]))
    assert {p["status"] for p in pubs} == {"draft"}
    assert store.answer_status is None and store.question_status is None
