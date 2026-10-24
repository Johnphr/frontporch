"""One module per platform. Each exposes `async def publish(ctx) -> dict`.

The returned dict is stored on the answer in Convex:
  {"platform": str, "status": "published" | "draft" | "failed" | "skipped",
   "url"?: str, "draftText"?: str, "error"?: str}

"draft" means a person has to post it (no API, or posting is switched off);
the dashboard shows a copy button and a link to the original question.
"""

from . import bluesky, discourse, feed, linkedin, quora, reddit

PUBLISHERS = {
    "feed": feed.publish,
    "bluesky": bluesky.publish,
    "linkedin": linkedin.publish,
    "reddit": reddit.publish,
    "quora": quora.publish,
    "discourse": discourse.publish,
}
