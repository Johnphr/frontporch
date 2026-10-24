"""Claude calls, each returning a validated Pydantic object.

Three jobs:
  1. triage_questions - skip unsafe questions, tag topics, pick the best elder
  2. decide_follow_up - during the call, ask one more question or finish
  3. draft_answer     - turn the elder's spoken words into a written post
"""

from typing import Literal

import anthropic
from pydantic import BaseModel, Field

from .config import Settings

FALLBACK_BETA = "server-side-fallback-2026-07-01"


class LLMRefusal(RuntimeError):
    pass


class LLMNotConfigured(RuntimeError):
    pass


# ---------- schemas ----------


class TriageItem(BaseModel):
    index: int = Field(description="Index of the question in the input list")
    answerable: bool = Field(description="False if an older adult should not answer this")
    skip_reason: str = Field(description="Why it was skipped, or empty string")
    topics: list[str] = Field(description="1-3 short lowercase topic tags")
    elder_index: int = Field(description="Index of the best-matching elder, or -1 if none fit")


class TriageResult(BaseModel):
    items: list[TriageItem]


class FollowUpDecision(BaseModel):
    action: Literal["follow_up", "done"]
    follow_up_question: str = Field(description="Short friendly question to ask, or empty string")


class DraftAnswer(BaseModel):
    title: str = Field(description="Post title, under 80 characters")
    body: str = Field(description="The full answer, 80-250 words, first person")
    short_version: str = Field(description="Stand-alone version under 240 characters")
    key_points: list[str] = Field(description="2-4 short takeaways")
    readback: str = Field(
        description="1-2 sentence summary to read aloud to the elder, in the elder's language"
    )


# ---------- prompts ----------

TRIAGE_SYSTEM = """You route questions people asked online to older adults who answer them by phone.

For each question:
- answerable: false if it needs a licensed professional (medical, legal, tax, investment
  decisions), involves a crisis or self-harm, asks for personal or identifying information,
  is harassment or bait, or makes no sense out of context. Everyday life advice, skills,
  history, relationships, work, cooking, repairs, and "what was it like" questions are fine.
- topics: 1-3 short lowercase tags.
- elder_index: the elder whose expertise fits best, or -1 if nobody fits well.
Return one item per question."""

FOLLOW_UP_SYSTEM = """You are Pip, a warm phone host. An older adult is answering a question
that a stranger asked online. Their words come from speech-to-text, so expect small errors.

Decide whether you already have enough to write a genuinely helpful answer.
- If a key detail is missing (a concrete example, a step, the "why"), ask ONE short, friendly
  follow-up question in plain spoken language. Never ask for personal or sensitive information.
- If the answer is already useful, or the person sounds finished or tired, choose "done".
Write the follow-up in the same language the person is speaking."""

DRAFT_SYSTEM = """You turn an older adult's spoken answer (from a phone call transcript) into a
written post answering someone's question online.

Rules:
- Use ONLY what they said. Do not add facts, tips, or claims they did not make.
- Write in first person, in their voice. Keep their phrases, stories and humour.
- Fix obvious speech-to-text errors and filler words, nothing more.
- Write title, body, short_version and key_points in the language of the question.
- Write readback in the elder's language, simple enough to understand when heard once."""


class LLM:
    def __init__(self, settings: Settings):
        self.model = settings.claude_model
        self._client = (
            anthropic.AsyncAnthropic(api_key=settings.anthropic_api_key)
            if settings.anthropic_api_key
            else None
        )

    @property
    def configured(self) -> bool:
        return self._client is not None

    async def _parse(self, *, system: str, user: str, schema: type[BaseModel], effort: str,
                     max_tokens: int) -> BaseModel:
        if self._client is None:
            raise LLMNotConfigured("Set ANTHROPIC_API_KEY")
        response = await self._client.messages.parse(
            model=self.model,
            max_tokens=max_tokens,
            system=system,
            messages=[{"role": "user", "content": user}],
            output_format=schema,
            output_config={"effort": effort},
            # If a safety classifier declines, retry on Anthropic's recommended
            # fallback model inside the same call instead of failing.
            extra_headers={"anthropic-beta": FALLBACK_BETA},
            extra_body={"fallbacks": "default"},
        )
        if response.stop_reason == "refusal":
            raise LLMRefusal("Claude declined this request")
        if response.parsed_output is None:
            raise RuntimeError(f"No structured output (stop_reason={response.stop_reason})")
        return response.parsed_output

    async def triage_questions(self, questions: list[dict], elders: list[dict],
                               batch_size: int = 25) -> TriageResult:
        """Triage in batches so a big scrape doesn't become one giant request.

        Returned indices always refer to positions in the full `questions` list.
        """
        e_lines = "\n".join(
            f"[{i}] {e['name']}: {', '.join(e.get('expertise', []))}. {e.get('bio') or ''}"
            for i, e in enumerate(elders)
        )
        items: list[TriageItem] = []
        for start in range(0, len(questions), batch_size):
            batch = questions[start:start + batch_size]
            q_lines = "\n".join(
                f"[{i}] ({q.get('source', 'web')}"
                f"{' · ' + q['community'] if q.get('community') else ''}) {q['title']}\n"
                f"    {(q.get('body') or '')[:400]}"
                for i, q in enumerate(batch)
            )
            user = f"ELDERS:\n{e_lines or '(none yet)'}\n\nQUESTIONS:\n{q_lines}"
            result = await self._parse(system=TRIAGE_SYSTEM, user=user, schema=TriageResult,
                                       effort="medium", max_tokens=16000)
            seen: set[int] = set()
            for item in result.items:
                if 0 <= item.index < len(batch) and item.index not in seen:
                    seen.add(item.index)
                    items.append(item.model_copy(update={"index": start + item.index}))
        return TriageResult(items=items)

    async def decide_follow_up(self, question: dict, turns: list[dict], follow_ups_left: int
                               ) -> FollowUpDecision:
        if follow_ups_left <= 0:
            return FollowUpDecision(action="done", follow_up_question="")
        transcript = "\n".join(f"{t['role'].upper()}: {t['text']}" for t in turns)
        user = (
            f"QUESTION: {question['title']}\n{question.get('body') or ''}\n\n"
            f"CALL SO FAR:\n{transcript}\n\nFollow-ups you may still ask: {follow_ups_left}"
        )
        # Low effort: the elder is waiting on the line.
        return await self._parse(system=FOLLOW_UP_SYSTEM, user=user, schema=FollowUpDecision,
                                 effort="low", max_tokens=4000)

    async def draft_answer(self, question: dict, elder: dict, turns: list[dict]) -> DraftAnswer:
        elder_words = "\n".join(t["text"] for t in turns if t["role"] == "elder")
        user = (
            f"QUESTION: {question['title']}\n{question.get('body') or ''}\n\n"
            f"ELDER: {elder['name']} (speaks {elder.get('language', 'en-US')})\n\n"
            f"WHAT THEY SAID ON THE CALL:\n{elder_words}"
        )
        return await self._parse(system=DRAFT_SYSTEM, user=user, schema=DraftAnswer,
                                 effort="medium", max_tokens=16000)
