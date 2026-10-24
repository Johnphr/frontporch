"""LinkedIn Posts API, posting to the authenticated member's own feed.

Needs a developer app with the self-serve "Share on LinkedIn" product
(scope w_member_social) and "Sign In with LinkedIn using OpenID Connect"
(to look up your person URN). Without a token, this returns a draft.
"""

import httpx

from .base import PublishContext, result

POSTS_URL = "https://api.linkedin.com/rest/posts"
# Characters with special meaning in LinkedIn's "little text" commentary format.
RESERVED = set("\\|{}@[]()<>#*_~")


def escape_little_text(text: str) -> str:
    return "".join(f"\\{c}" if c in RESERVED else c for c in text)


def build_commentary(ctx: PublishContext) -> str:
    """Unescaped post text. Uses the AI-written LinkedIn version when present."""
    variant = (ctx.answer.get("variants") or {}).get("linkedin")
    if variant and variant.strip():
        return f"{variant.strip()}\n\nRead more: {ctx.feed_url}"
    q = ctx.question.get("title", "")
    return (f"{ctx.answer.get('title', '')}\n\nQ: {q}\n\n{ctx.long_text()}\n\n"
            f"Read more: {ctx.feed_url}")


async def publish(ctx: PublishContext) -> dict:
    s = ctx.settings
    commentary = build_commentary(ctx)
    if not (s.linkedin_access_token and s.linkedin_author_urn):
        return result("linkedin", "draft", draftText=commentary,
                      error="LINKEDIN_ACCESS_TOKEN / LINKEDIN_AUTHOR_URN not set")
    payload = {
        "author": s.linkedin_author_urn,
        "commentary": escape_little_text(commentary),
        "visibility": "PUBLIC",
        "distribution": {"feedDistribution": "MAIN_FEED", "targetEntities": [],
                         "thirdPartyDistributionChannels": []},
        "lifecycleState": "PUBLISHED",
        "isReshareDisabledByAuthor": False,
    }
    headers = {
        "Authorization": f"Bearer {s.linkedin_access_token}",
        "LinkedIn-Version": s.linkedin_version,
        "X-Restli-Protocol-Version": "2.0.0",
        "Content-Type": "application/json",
    }
    async with httpx.AsyncClient(timeout=20) as client:
        response = await client.post(POSTS_URL, headers=headers, json=payload)
    if response.status_code >= 400:
        return result("linkedin", "failed", draftText=commentary,
                      error=f"LinkedIn {response.status_code}: {response.text[:300]}")
    urn = response.headers.get("x-restli-id", "")
    url = f"https://www.linkedin.com/feed/update/{urn}/" if urn else None
    return result("linkedin", "published", url=url)
