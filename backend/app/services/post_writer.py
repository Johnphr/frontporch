"""Per-platform post versions + an automatic "nothing was invented" check.

Two Claude calls (reusing `LLM._parse`, so model/effort/fallback settings are
shared with the rest of the app):

  1. write_variants      one tailored text per platform (Bluesky, LinkedIn,
                          Reddit, Quora, Discourse), from ONLY the elder's words
  2. check_faithfulness  a judge that lists any claim, number, name or advice
                          that isn't in what the elder said (pass/fail per platform)

Code, not the AI, enforces length limits (one retry, then a safe truncate) and
appends the disclosure line, so every post says it was written up with AI.

How other code uses this
------------------------
Legacy Twilio flow: routes/twilio.py calls `schedule_prepare(...)` right after the
draft is saved. Publishing (`publishing.publish_answer`) waits for it, or runs
`prepare_posts` itself if the versions are missing.

v2 pipeline (services/pipeline.py), after drafting with Claude:

    from app.services.post_writer import build_posts
    variants, quality = await build_posts(services.llm, question, elder, turns, draft,
                                          settings=services.settings)
    await services.store.set_posts(answer_id, variants, quality)
    # then publish; publish_answer() skips any platform whose check failed
    # (status "needs_review") unless force=True.

Publishers read the final text with `ctx.text_for(platform)` (publishers/base.py);
"linkedapi" maps to the LinkedIn version.
"""

from __future__ import annotations

import asyncio
import logging
import re
from typing import Any

from pydantic import BaseModel, Field

from ..config import Settings, get_settings
from .publishers.base import PublishContext, truncate
from .publishers.bluesky import LINK_LABEL as BLUESKY_LINK_LABEL
from .publishers.bluesky import POST_LIMIT as BLUESKY_LIMIT
from .publishers.bluesky import tail as bluesky_tail

log = logging.getLogger(__name__)

# Platforms that get their own AI-written version. "feed" shows the base draft.
VARIANT_PLATFORMS = ("bluesky", "linkedin", "reddit", "quora", "discourse")
# Platforms whose text the judge checks (feed = the base draft body).
CHECKED_PLATFORMS = ("feed", *VARIANT_PLATFORMS)

# Limits for the AI-written part (before the disclosure is added).
# max_chars is a hard limit (truncated); word ranges trigger one rewrite.
LIMITS: dict[str, dict[str, int]] = {
    "linkedin": {"min_words": 100, "max_words": 280, "max_chars": 2600},
    "reddit": {"min_words": 50, "max_words": 350, "max_chars": 9000},
    "quora": {"min_words": 80, "max_words": 330, "max_chars": 9000},
    "discourse": {"min_words": 40, "max_words": 330, "max_chars": 9000},
}


# ---------- schemas ----------


class PostVariants(BaseModel):
    bluesky: str = Field(description="Bluesky post text, within the character budget given")
    linkedin: str = Field(description="LinkedIn post, 120-250 words, short paragraphs")
    reddit: str = Field(description="Reddit comment replying to the question, conversational")
    quora: str = Field(description="Quora answer: direct answer first, then the story")
    discourse: str = Field(description="Friendly forum reply, markdown allowed")


class PlatformCheck(BaseModel):
    platform: str
    passed: bool = Field(description="True only if issues is empty")
    issues: list[str] = Field(description="Each unsupported claim, quoted or paraphrased briefly")


class QualityReport(BaseModel):
    checks: list[PlatformCheck]


# ---------- prompts ----------

VARIANTS_SYSTEM = """You adapt an older adult's spoken answer into posts for different platforms.
You get their exact words from a phone call (speech-to-text, so expect small errors) and a
base draft already written from those words.

Rules for every platform:
- Use ONLY what they said: their facts, stories, numbers, names, places and advice.
  Do not add tips, statistics, dates or details they did not give.
- First person, in their voice. Keep their phrases and humour.
- Do NOT add a signature, disclosure, hashtag block, link or "posted by" line; that is added
  automatically.
- Write in the language of the question.

Platform styles:
- bluesky: one punchy first line, then the core advice. Stay within the character budget
  given (count every character). At most one hashtag, only if natural.
- linkedin: 120-250 words. Open by restating the question in one line, then short paragraphs
  (1-3 sentences each), framed as a lesson learned. No emoji spam, no hashtag block.
- reddit: a conversational comment replying to the asker, 60-300 words. No title, no links,
  no "As an AI". Reads like a real person typing.
- quora: answer the question directly in the first sentence, then the story behind it,
  100-300 words.
- discourse: a friendly forum reply, 50-300 words. Markdown is fine (short lists, bold)."""

JUDGE_SYSTEM = """You are a strict fact-checker for posts written from an older adult's phone call.

For each platform text, list every statement that is NOT supported by the elder's own words:
invented facts, numbers, dates, names, places, advice or steps they didn't give, or opinions
they didn't express. Paraphrasing, reordering, fixing grammar, restating the question, and
generic warmth ("hope this helps") are fine and are not issues.

Return one check per platform you were given. passed must be true only when issues is empty."""


# ---------- helpers ----------


def _ctx(settings: Settings, question: dict, elder: dict, answer: dict | None = None
         ) -> PublishContext:
    return PublishContext(settings=settings, answer=answer or {"_id": "draft"},
                          question=question or {}, elder=elder or {})


def draft_to_dict(draft: Any) -> dict:
    """Accept a DraftAnswer (Pydantic) or an answer dict from Convex."""
    if isinstance(draft, dict):
        return draft
    return {
        "title": getattr(draft, "title", ""),
        "body": getattr(draft, "body", ""),
        "shortVersion": getattr(draft, "short_version", ""),
        "keyPoints": list(getattr(draft, "key_points", []) or []),
    }


def elder_words_from_turns(turns: list[dict]) -> str:
    return "\n".join(t["text"] for t in turns if t.get("role") == "elder" and t.get("text"))


def elder_words_from_transcript(transcript: str) -> str:
    """Pull the ELDER: lines out of a stored transcript ("PIP: ..." / "ELDER: ...")."""
    lines = [m.group(1).strip() for m in re.finditer(r"^ELDER:\s*(.*)$", transcript or "",
                                                       re.MULTILINE)]
    return "\n".join(line for line in lines if line) or (transcript or "").strip()


def word_count(text: str) -> int:
    return len(text.split())


def truncate_words(text: str, max_words: int) -> str:
    words = text.split()
    if len(words) <= max_words:
        return text
    return " ".join(words[:max_words]).rstrip(",.;:") + "…"


def bluesky_budget(ctx: PublishContext) -> int:
    """Characters left for the AI-written part of a Bluesky post."""
    return BLUESKY_LIMIT - len(bluesky_tail(ctx)) - len(BLUESKY_LINK_LABEL)


def problems(raw: dict[str, str], bluesky_max: int) -> dict[str, str]:
    """Return {platform: what's wrong} for versions that break a limit."""
    found: dict[str, str] = {}
    for platform in VARIANT_PLATFORMS:
        text = (raw.get(platform) or "").strip()
        if not text:
            found[platform] = "it was empty"
            continue
        if platform == "bluesky":
            if len(text) > bluesky_max:
                found[platform] = f"it was {len(text)} characters; the limit is {bluesky_max}"
            continue
        limit = LIMITS[platform]
        words = word_count(text)
        if words < limit["min_words"] or words > limit["max_words"]:
            found[platform] = (f"it was {words} words; aim for {limit['min_words']}-"
                               f"{limit['max_words']}")
        elif len(text) > limit["max_chars"]:
            found[platform] = f"it was {len(text)} characters; the limit is {limit['max_chars']}"
    return found


def enforce_limits(raw: dict[str, str], bluesky_max: int) -> dict[str, str]:
    """Last resort after the retry: cut anything still over a hard limit."""
    fixed: dict[str, str] = {}
    for platform in VARIANT_PLATFORMS:
        text = (raw.get(platform) or "").strip()
        if platform == "bluesky":
            text = truncate(text, bluesky_max)
        else:
            limit = LIMITS[platform]
            text = truncate(truncate_words(text, limit["max_words"]), limit["max_chars"])
        fixed[platform] = text
    return fixed


def finalize(raw: dict[str, str], ctx: PublishContext) -> dict[str, str]:
    """Append the disclosure (by code, never by the AI). Returns final texts."""
    final: dict[str, str] = {}
    for platform in VARIANT_PLATFORMS:
        text = raw.get(platform, "").strip()
        if not text:
            continue
        if platform == "bluesky":
            final[platform] = text + bluesky_tail(ctx)  # link label added when posting
        else:
            final[platform] = f"{text}\n\n{ctx.disclosure}"
    return final


# ---------- Claude calls ----------


async def write_variants(llm, question: dict, elder: dict, elder_words: str, draft: Any, *,
                         settings: Settings | None = None) -> dict[str, str]:
    """One Claude call (plus at most one rewrite). Returns raw texts, no disclosure."""
    settings = settings or get_settings()
    ctx = _ctx(settings, question, elder)
    base = draft_to_dict(draft)
    bluesky_max = bluesky_budget(ctx)
    user = (
        f"QUESTION: {question.get('title', '')}\n{question.get('body') or ''}\n\n"
        f"ELDER: {ctx.first_name} (speaks {elder.get('language', 'en-US')})\n\n"
        f"WHAT THEY SAID ON THE CALL:\n{elder_words}\n\n"
        f"BASE DRAFT:\nTitle: {base.get('title', '')}\n{base.get('body', '')}\n\n"
        f"Bluesky character budget: {bluesky_max}"
    )
    result = await llm._parse(system=VARIANTS_SYSTEM, user=user, schema=PostVariants,
                              effort="medium", max_tokens=16000)
    raw = result.model_dump()

    issues = problems(raw, bluesky_max)
    if issues:
        notes = "\n".join(f"- {p}: {why}" for p, why in issues.items())
        retry_user = (f"{user}\n\nYOUR PREVIOUS VERSIONS:\n"
                      + "\n\n".join(f"[{p}]\n{raw.get(p, '')}" for p in VARIANT_PLATFORMS)
                      + f"\n\nThese broke the length rules:\n{notes}\n"
                        "Return all five again, fixing only those.")
        try:
            again = (await llm._parse(system=VARIANTS_SYSTEM, user=retry_user,
                                      schema=PostVariants, effort="medium",
                                      max_tokens=16000)).model_dump()
            for platform in issues:
                if again.get(platform):
                    raw[platform] = again[platform]
        except Exception:
            log.warning("variant rewrite failed; truncating instead", exc_info=True)
    return enforce_limits(raw, bluesky_max)


async def check_faithfulness(llm, elder_words: str, texts: dict[str, str]) -> list[dict]:
    """Judge each text against the elder's words. Returns
    [{"platform", "passed", "issues"}] with one entry per text given."""
    user = (f"THE ELDER'S OWN WORDS (from the call):\n{elder_words}\n\n"
            + "\n\n".join(f"[{p}]\n{t}" for p, t in texts.items()))
    report = await llm._parse(system=JUDGE_SYSTEM, user=user, schema=QualityReport,
                              effort="medium", max_tokens=16000)
    by_platform = {c.platform.strip().lower(): c for c in report.checks}
    checks: list[dict] = []
    for platform in texts:
        check = by_platform.get(platform)
        if check is None:  # the judge skipped it: don't let it through unchecked
            checks.append({"platform": platform, "passed": False,
                           "issues": ["The quality check returned no result for this post"]})
            continue
        issues = [i.strip() for i in check.issues if i and i.strip()]
        checks.append({"platform": platform, "passed": bool(check.passed and not issues),
                       "issues": issues})
    return checks


async def build_posts(llm, question: dict, elder: dict, turns: list[dict] | str, draft: Any, *,
                      settings: Settings | None = None) -> tuple[dict[str, str], list[dict]]:
    """Pure step (no database): write every platform version, then check it.

    `turns` is the call ([{"role": "pip"|"elder", "text"}]) or a stored transcript string.
    `draft` is a DraftAnswer or an answer dict (title/body/shortVersion/keyPoints).
    Returns (variants, quality):
      variants = {"bluesky": final text, "linkedin": ..., ...}  (disclosure included)
      quality  = [{"platform": "feed"|"bluesky"|..., "passed": bool, "issues": [str]}]
    """
    settings = settings or get_settings()
    words = (elder_words_from_transcript(turns) if isinstance(turns, str)
             else elder_words_from_turns(turns))
    raw = await write_variants(llm, question, elder, words, draft, settings=settings)
    variants = finalize(raw, _ctx(settings, question, elder))
    to_check = {"feed": draft_to_dict(draft).get("body", ""), **raw}
    quality = await check_faithfulness(llm, words, {p: t for p, t in to_check.items() if t})
    return variants, quality


# ---------- with the database ----------

_IN_FLIGHT: dict[str, asyncio.Task] = {}


async def prepare_posts(services, answer_id: str, *, answer: dict | None = None,
                        question: dict | None = None, elder: dict | None = None) -> dict:
    """Load the answer, build every version + quality check, and save them.

    Returns {"variants": {...}, "quality": [...]}.
    """
    store = services.store
    answer = answer or await store.get_answer(answer_id)
    if answer is None:
        raise ValueError(f"Answer {answer_id} not found")
    question = question or await store.get_question(answer["questionId"]) or {}
    elder = elder or await store.get_elder(answer["elderId"]) or {}
    variants, quality = await build_posts(services.llm, question, elder,
                                          answer.get("transcript", ""), answer,
                                          settings=services.settings)
    await store.set_posts(answer_id, variants, quality)
    return {"variants": variants, "quality": quality}


def schedule_prepare(services, answer_id: str, question: dict, elder: dict,
                     turns: list[dict], draft: Any) -> None:
    """Fire-and-forget version for the live call. Never raises."""

    async def _run() -> None:
        try:
            variants, quality = await build_posts(services.llm, question, elder, turns, draft,
                                                  settings=services.settings)
            await services.store.set_posts(answer_id, variants, quality)
        except Exception:
            log.warning("preparing platform posts failed for %s", answer_id, exc_info=True)
        finally:
            _IN_FLIGHT.pop(answer_id, None)

    _IN_FLIGHT[answer_id] = asyncio.create_task(_run())


async def wait_for(answer_id: str, timeout: float = 120) -> None:
    """If versions for this answer are still being written, wait for them."""
    task = _IN_FLIGHT.get(answer_id)
    if task is None:
        return
    try:
        await asyncio.wait_for(asyncio.shield(task), timeout)
    except Exception:
        log.warning("gave up waiting for platform posts for %s", answer_id)
