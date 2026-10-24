"""Reddit: draft by default, optional reply via PRAW.

Why draft by default:
- Since Reddit's Responsible Builder Policy (November 2025), new OAuth apps need
  manual approval before they get API tokens, and approval isn't guaranteed.
- Many subreddits (including advice communities) ban bot or AI-written replies.
  Check the subreddit's rules before turning posting on.

Set REDDIT_POSTING_ENABLED=true plus the REDDIT_* credentials to reply to the
original thread automatically. Otherwise a person copies the draft from the
dashboard and posts it themselves.
"""

import asyncio

import praw

from .base import PublishContext, result


def _can_post(ctx: PublishContext) -> bool:
    s = ctx.settings
    creds = all([s.reddit_client_id, s.reddit_client_secret, s.reddit_username,
                 s.reddit_password])
    return bool(s.reddit_posting_enabled and creds and ctx.question.get("source") == "reddit"
                and ctx.question.get("sourceUrl"))


def _reply(ctx: PublishContext, text: str) -> str:
    s = ctx.settings
    reddit = praw.Reddit(client_id=s.reddit_client_id, client_secret=s.reddit_client_secret,
                         username=s.reddit_username, password=s.reddit_password,
                         user_agent=s.reddit_user_agent)
    comment = reddit.submission(url=ctx.question["sourceUrl"]).reply(text)
    return "https://www.reddit.com" + comment.permalink


async def publish(ctx: PublishContext) -> dict:
    text = ctx.long_text()
    source_url = ctx.question.get("sourceUrl") if ctx.question.get("source") == "reddit" else None
    if not _can_post(ctx):
        return result("reddit", "draft", draftText=text, url=source_url)
    url = await asyncio.to_thread(_reply, ctx, text)
    return result("reddit", "published", url=url)
