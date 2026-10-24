import pytest
from fastapi.testclient import TestClient

import app.deps as deps
from app.config import get_settings
from app.deps import Services
from app.llm import DraftAnswer, FollowUpDecision
from app.main import app
from app.routes import twilio as twilio_routes
from app.services.calls import SESSIONS, is_yes
from app.twiml import twilio_language

INTEGRATION_ENV = [
    "CONVEX_URL", "CONVEX_BACKEND_SECRET", "ANTHROPIC_API_KEY", "CARTESIA_API_KEY",
    "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER", "APIFY_TOKEN",
]


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    for name in INTEGRATION_ENV:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("TWILIO_VALIDATE_SIGNATURE", "false")
    get_settings.cache_clear()
    deps._services = None
    SESSIONS.clear()
    yield
    get_settings.cache_clear()
    deps._services = None
    SESSIONS.clear()


# ---------- pure helpers ----------


@pytest.mark.parametrize("speech,expected", [
    ("Yes please", True),
    ("Sí, claro.", True),
    ("okay go ahead", True),
    ("No, don't post it", False),
    ("Wait, not yet", False),
    ("hmm", None),
    ("", None),
])
def test_is_yes(speech, expected):
    assert is_yes(speech) is expected


def test_twilio_language():
    assert twilio_language("es") == "es-MX"
    assert twilio_language("es_mx") == "es-MX"
    assert twilio_language("en-GB") == "en-GB"
    assert twilio_language(None) == "en-US"
    assert twilio_language("xx") == "en-US"


# ---------- app with nothing configured ----------


def test_health_with_no_env():
    with TestClient(app) as client:
        data = client.get("/api/health").json()
    assert set(data["integrations"]) == {"convex", "claude", "cartesia", "twilio", "apify",
                                         "bluesky", "linkedin", "reddit_posting", "discourse"}
    assert data["integrations"]["convex"] is False
    assert data["integrations"]["twilio"] is False
    assert data["defaultPlatforms"] == ["feed", "bluesky"]


def test_voice_without_convex_hangs_up():
    with TestClient(app) as client:
        r = client.post("/twilio/voice", data={"CallSid": "CA1", "From": "+15550001111",
                                               "Direction": "inbound"})
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/xml")
    assert "<Hangup />" in r.text or "<Hangup/>" in r.text


def test_api_write_without_convex_is_503():
    with TestClient(app) as client:
        r = client.post("/api/elders", json={"name": "Rosa", "phone": "+15550001111"})
    assert r.status_code == 503


# ---------- full call with fakes ----------

ELDER = {"_id": "elder1", "name": "Rosa Martinez", "phone": "+15550001111",
         "language": "en-US", "expertise": ["cooking"]}
QUESTION = {"_id": "q1", "title": "How do I make rice that isn't mushy",
            "body": "Mine always ends up sticky."}


class FakeStore:
    configured = True

    def __init__(self):
        self.calls = []

    async def _log(self, name, *args, **kwargs):
        self.calls.append((name, args, kwargs))

    async def elder_by_phone(self, phone):
        return ELDER if phone == ELDER["phone"] else None

    async def next_question_for(self, elder_id):
        return QUESTION

    async def start_call(self, call_sid, elder_id, question_id):
        await self._log("start_call", call_sid, elder_id, question_id)
        return "call1"

    async def add_call_turn(self, call_id, role, text):
        await self._log("add_call_turn", call_id, role, text)

    async def set_call_status(self, call_id, status):
        await self._log("set_call_status", call_id, status)

    async def unread_replies(self, elder_id):
        return [{"_id": "r1", "author": "Jake", "text": "Your tip saved my dinner!",
                 "questionTitle": "How do I cook beans"}]

    async def mark_reply_read(self, reply_id):
        await self._log("mark_reply_read", reply_id)

    async def create_answer(self, **fields):
        await self._log("create_answer", **fields)
        return "answer1"

    async def set_answer_status(self, answer_id, status):
        await self._log("set_answer_status", answer_id, status)

    def names(self):
        return [c[0] for c in self.calls]


class FakeLLM:
    configured = True

    async def decide_follow_up(self, question, turns, follow_ups_left):
        return FollowUpDecision(action="done", follow_up_question="")

    async def draft_answer(self, question, elder, turns):
        return DraftAnswer(title="Rinse it first", body="Rinse the rice three times...",
                           short_version="Rinse rice 3x, 1:1.5 water.",
                           key_points=["Rinse", "Don't stir"],
                           readback="Rinse the rice three times and don't stir it.")


class FakeVoice:
    configured = False


def test_full_call_flow(monkeypatch):
    store = FakeStore()
    deps._services = Services(settings=get_settings(), store=store, llm=FakeLLM(),
                              voice=FakeVoice())
    scheduled = []
    monkeypatch.setattr(twilio_routes, "_schedule_publish",
                        lambda services, answer_id, platforms:
                        scheduled.append((answer_id, platforms)))
    call = {"CallSid": "CA42"}

    with TestClient(app) as client:
        r = client.post("/twilio/voice",
                        data={**call, "From": "+15550001111", "Direction": "inbound"})
        assert "<Say" in r.text and "Jake" in r.text
        assert "Someone asked: How do I make rice" in r.text
        assert 'action="/twilio/answer"' in r.text
        assert "mark_reply_read" in store.names()

        r = client.post("/twilio/answer",
                        data={**call, "SpeechResult": "Rinse it three times, never stir."})
        assert "/twilio/readback" in r.text

        for _ in range(20):  # the draft runs in the background; poll like Twilio would
            r = client.post("/twilio/readback", data=call)
            if "Should I post it" in r.text:
                break
        assert "Rinse the rice three times" in r.text
        assert 'action="/twilio/confirm"' in r.text

        r = client.post("/twilio/confirm", data={**call, "SpeechResult": "Yes!"})
        assert "<Hangup" in r.text

    created = [c for c in store.calls if c[0] == "create_answer"][0][2]
    assert created["elderId"] == "elder1" and created["questionId"] == "q1"
    assert created["callId"] == "call1"
    assert "ELDER: Rinse it three times" in created["transcript"]
    assert ("set_answer_status", ("answer1", "approved"), {}) in store.calls
    assert scheduled == [("answer1", ["feed", "bluesky"])]
    assert "CA42" not in SESSIONS  # session cleaned up at hangup


def test_confirm_no_does_not_publish(monkeypatch):
    store = FakeStore()
    deps._services = Services(settings=get_settings(), store=store, llm=FakeLLM(),
                              voice=FakeVoice())
    scheduled = []
    monkeypatch.setattr(twilio_routes, "_schedule_publish",
                        lambda *a: scheduled.append(a))
    call = {"CallSid": "CA7"}
    with TestClient(app) as client:
        client.post("/twilio/voice", data={**call, "From": "+15550001111",
                                           "Direction": "inbound"})
        client.post("/twilio/answer", data={**call, "SpeechResult": "Use less water."})
        for _ in range(20):
            if "Should I post it" in client.post("/twilio/readback", data=call).text:
                break
        r = client.post("/twilio/confirm", data={**call, "SpeechResult": "No, not yet"})
    assert "won't post" in r.text
    assert scheduled == []
    assert "set_answer_status" not in store.names()


def test_unknown_number_hangs_up():
    deps._services = Services(settings=get_settings(), store=FakeStore(), llm=FakeLLM(),
                              voice=FakeVoice())
    with TestClient(app) as client:
        r = client.post("/twilio/voice", data={"CallSid": "CA9", "From": "+19998887777",
                                               "Direction": "inbound"})
    assert "isn't registered" in r.text and "<Hangup" in r.text


def test_outbound_direction_uses_to_number():
    deps._services = Services(settings=get_settings(), store=FakeStore(), llm=FakeLLM(),
                              voice=FakeVoice())
    with TestClient(app) as client:
        r = client.post("/twilio/voice", data={"CallSid": "CA10", "From": "+18885550000",
                                               "To": "+15550001111",
                                               "Direction": "outbound-api"})
    assert "Hi Rosa" in r.text


def test_silence_retries_once_then_says_goodbye():
    deps._services = Services(settings=get_settings(), store=FakeStore(), llm=FakeLLM(),
                              voice=FakeVoice())
    call = {"CallSid": "CA11"}
    with TestClient(app) as client:
        client.post("/twilio/voice", data={**call, "From": "+15550001111",
                                           "Direction": "inbound"})
        r1 = client.post("/twilio/no-input", data=call)
        assert "didn't hear anything" in r1.text and "<Gather" in r1.text
        r2 = client.post("/twilio/no-input", data=call)
        assert "another time" in r2.text and "<Hangup" in r2.text
