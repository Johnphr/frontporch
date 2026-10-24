"""Bluesky via the atproto SDK. Uses an app password (Settings -> App passwords),
never the account's main password. Posts are limited to 300 graphemes."""

import asyncio

from atproto import Client, client_utils

from .base import PublishContext, result, truncate

POST_LIMIT = 300
LINK_LABEL = "Full answer"


def build_post_text(ctx: PublishContext) -> tuple[str, str]:
    """Return (body, link_label). body + "\n\n" + label fits in POST_LIMIT.

    Uses len() (code points), which is never smaller than the grapheme count,
    so the result always fits.
    """
    tail = f"\n\n— {ctx.first_name}\n"
    budget = POST_LIMIT - len(tail) - len(LINK_LABEL)
    body = truncate(ctx.answer.get("shortVersion") or ctx.answer.get("title", ""), budget)
    return body + tail, LINK_LABEL


def _post(handle: str, password: str, body: str, label: str, url: str) -> str:
    client = Client()
    client.login(handle, password)
    text = client_utils.TextBuilder().text(body).link(label, url)
    response = client.send_post(text)
    rkey = response.uri.rsplit("/", 1)[-1]  # at://did/app.bsky.feed.post/<rkey>
    return f"https://bsky.app/profile/{handle}/post/{rkey}"


async def publish(ctx: PublishContext) -> dict:
    s = ctx.settings
    if not (s.bluesky_handle and s.bluesky_app_password):
        return result("bluesky", "skipped", error="BLUESKY_HANDLE / BLUESKY_APP_PASSWORD not set")
    body, label = build_post_text(ctx)
    url = await asyncio.to_thread(_post, s.bluesky_handle, s.bluesky_app_password, body, label,
                                  ctx.feed_url)
    return result("bluesky", "published", url=url)
