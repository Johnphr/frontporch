"""Send one approved answer to several platforms and record each result."""

from .publishers import PUBLISHERS
from .publishers.base import PublishContext, result


async def publish_answer(services, answer_id: str, platforms: list[str]) -> list[dict]:
    store = services.store
    answer = await store.get_answer(answer_id)
    if answer is None:
        raise ValueError(f"Answer {answer_id} not found")
    question = await store.get_question(answer["questionId"]) or {}
    elder = await store.get_elder(answer["elderId"]) or {}
    ctx = PublishContext(settings=services.settings, answer=answer, question=question,
                         elder=elder)

    publications: list[dict] = []
    for platform in platforms:
        publisher = PUBLISHERS.get(platform)
        if publisher is None:
            pub = result(platform, "skipped", error="Unknown platform")
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
