"""Quora has no public posting API, and automating its website breaks its
terms. So Quora always gets a copy-ready draft plus a link to the question."""

from .base import PublishContext, result


async def publish(ctx: PublishContext) -> dict:
    url = ctx.question.get("sourceUrl") if ctx.question.get("source") == "quora" else None
    return result("quora", "draft", draftText=ctx.text_for("quora"), url=url)
