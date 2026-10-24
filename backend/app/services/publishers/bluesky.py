"""Bluesky via the atproto SDK. Uses an app password (Settings -> App passwords),
never the account's main password. Posts are limited to 300 graphemes."""

import asyncio

from atproto import Client, client_utils

from .base import PublishContext, result, truncate

POST_LIMIT = 300
LINK_LABEL = "Full answer"


def tail(ctx: PublishContext) -> str:
    """Name + AI disclosure line that ends every Bluesky post (before the link)."""
    return f"\n\n{ctx.short_disclosure}\n"


def build_post_text(ctx: PublishContext) -> tuple[str, str]:
    """Return (body, link_label). body + label fits in POST_LIMIT.

    Uses the AI-written Bluesky version when there is one (it already ends with
    the disclosure tail), otherwise trims the short version to fit.
    Uses len() (code points), which is never smaller than the grapheme count,
    so the result always fits.
    """
    budget = POST_LIMIT - len(LINK_LABEL)
    variant = ((ctx.answer.get("variants") or {}).get("bluesky") or "").strip("\n")
    if variant:
        if not variant.endswith("\n"):
            variant += "\n"
        if len(variant) <= budget:
            return variant, LINK_LABEL
    end = tail(ctx)
    text = ctx.answer.get("shortVersion") or ctx.answer.get("title", "")
    return truncate(text, budget - len(end)) + end, LINK_LABEL


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
