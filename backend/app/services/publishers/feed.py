"""Our own public feed. Nothing to call: the React feed shows every answer
whose status is "published", so publishing here just records the link."""

from .base import PublishContext, result


async def publish(ctx: PublishContext) -> dict:
    return result("feed", "published", url=ctx.feed_url)
