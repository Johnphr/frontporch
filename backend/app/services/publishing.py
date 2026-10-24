"""Send one answer to several platforms and record each result.

Before posting, each platform's text must pass the faithfulness check from
services/post_writer.py. A platform that fails gets status "needs_review"
(with the issues) and is NOT posted, unless force=True (a person reviewed it).
If the platform versions don't exist yet, they're generated first. If Claude
isn't available, the generic text is used unchecked, as before.
"""

import logging

from . import post_writer
from .publishers import PUBLISHERS
from .publishers.base import PublishContext, result

log = logging.getLogger(__name__)


async def _ensure_posts(services, answer_id: str, answer: dict, question: dict,
                        elder: dict) -> dict:
    """Return the answer with variants/quality, generating them if needed."""
    await post_writer.wait_for(answer_id)  # the call may still be writing them
    store = services.store
    fresh = await store.get_answer(answer_id) or answer
    if fresh.get("variants") and fresh.get("quality"):
        return fresh
    llm = getattr(services, "llm", None)
    if llm is None or not getattr(llm, "configured", False):
        return fresh
    try:
        prepared = await post_writer.prepare_posts(services, answer_id, answer=fresh,
                                                   question=question, elder=elder)
        return {**fresh, **prepared}
    except Exception:
        log.warning("couldn't prepare platform posts for %s; using generic text", answer_id,
                    exc_info=True)
        return fresh


async def publish_answer(services, answer_id: str, platforms: list[str],
                         force: bool = False) -> list[dict]:
    store = services.store
    answer = await store.get_answer(answer_id)
    if answer is None:
        raise ValueError(f"Answer {answer_id} not found")
    question = await store.get_question(answer["questionId"]) or {}
    elder = await store.get_elder(answer["elderId"]) or {}
    answer = await _ensure_posts(services, answer_id, answer, question, elder)
    ctx = PublishContext(settings=services.settings, answer=answer, question=question,
                         elder=elder)

    publications: list[dict] = []
    for platform in platforms:
        publisher = PUBLISHERS.get(platform)
        check = ctx.check_for(platform)
        if publisher is None:
            pub = result(platform, "skipped", error="Unknown platform")
        elif check is not None and not check.get("passed") and not force:
            issues = "; ".join(check.get("issues") or []) or "failed the quality check"
            pub = result(platform, "needs_review", draftText=ctx.text_for(platform),
                         error=f"Not posted. Possible invented details: {issues}"[:500])
        else:
            try:
                pub = await publisher(ctx)
            except Exception as exc:  # one platform failing shouldn't stop the rest
                pub = result(platform, "failed", error=f"{type(exc).__name__}: {exc}"[:500])
        await store.set_publication(answer_id, pub)
        publications.append(pub)

    if any(p["status"] == "published" for p in publications):
        await store.set_answer_status(answer_id, "published")
        if question.get("_id"):
            await store.set_question_status(question["_id"], "answered")
    return publications
