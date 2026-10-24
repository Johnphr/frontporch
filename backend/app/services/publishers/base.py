"""Shared context and text formatting for publishers."""

from dataclasses import dataclass

from ...config import Settings


@dataclass
class PublishContext:
    settings: Settings
    answer: dict
    question: dict
    elder: dict

    @property
    def first_name(self) -> str:
        return (self.elder.get("name") or "A neighbor").split()[0]

    @property
    def feed_url(self) -> str:
        return f"{self.settings.frontend_url.rstrip('/')}/#/answer/{self.answer['_id']}"

    @property
    def disclosure(self) -> str:
        # Always say how the post was made: a real person, written up by AI.
        return (f"— {self.first_name}, answered over a phone call with "
                f"{self.settings.app_name} (written up with AI from their own words)")

    @property
    def short_disclosure(self) -> str:
        # For tight limits (Bluesky): still says it was AI-written from their words.
        return f"— {self.first_name}, told by phone · written up with AI"

    def long_text(self) -> str:
        a = self.answer
        points = "\n".join(f"• {p}" for p in a.get("keyPoints") or [])
        parts = [a.get("body", "").strip(), points, self.disclosure]
        return "\n\n".join(p for p in parts if p)

    def text_for(self, platform: str) -> str:
        """Final text to post on `platform` (disclosure included).

        Uses the AI-written platform version saved by services/post_writer.py
        when there is one, otherwise the generic long_text(). "linkedapi"
        (posting through grandpa's own LinkedIn) uses the LinkedIn version.
        For Bluesky the link label is added by the publisher.
        """
        key = VARIANT_ALIASES.get(platform, platform)
        variant = (self.answer.get("variants") or {}).get(key)
        return variant.strip() if variant and variant.strip() else self.long_text()

    def check_for(self, platform: str) -> dict | None:
        """The faithfulness check for `platform`, or None if it wasn't checked."""
        key = VARIANT_ALIASES.get(platform, platform)
        for check in self.answer.get("quality") or []:
            if check.get("platform") == key:
                return check
        return None


# Platforms that reuse another platform's AI-written version.
VARIANT_ALIASES = {"linkedapi": "linkedin"}


def result(platform: str, status: str, **extra: str | None) -> dict:
    """Build a publication record, dropping empty fields (Convex rejects null)."""
    return {"platform": platform, "status": status, **{k: v for k, v in extra.items() if v}}


def truncate(text: str, limit: int) -> str:
    """Cut to at most `limit` characters on a word boundary, adding an ellipsis."""
    if len(text) <= limit:
        return text
    if limit <= 1:
        return "…"[:limit]
    cut = text[: limit - 1].rsplit(" ", 1)[0].rstrip(",.;: ")
    if not cut:
        cut = text[: limit - 1]
    return cut + "…"
