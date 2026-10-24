"""Question source adapters. Each kind fetches raw items for one source config.

Every adapter is `async def fetch(source: dict, settings: Settings) -> list[dict]`
and returns raw items. `questions.normalize()` maps them to our question shape
using the source's `fields` map, falling back to DEFAULT_FIELDS for its kind.

Kinds:
  apify              run an Apify Actor (Reddit, Quora, anything in the Store)
  stackexchange_api  free official Stack Exchange API (no key needed)
  discourse_json     a Discourse forum's public /latest.json
"""

from . import apify, discourse, stackexchange


class SourceError(RuntimeError):
    """A source can't run (missing token, bad config). Reported, never fatal."""


ADAPTERS = {
    "apify": apify.fetch,
    "stackexchange_api": stackexchange.fetch,
    "discourse_json": discourse.fetch,
}

# Which raw item keys hold each of our fields (first non-empty wins).
# A source's own "fields" entry overrides these key by key.
DEFAULT_FIELDS: dict[str, dict[str, list[str]]] = {
    "apify": {
        "title": ["title", "question", "questionTitle"],
        "body": ["body", "selftext", "text", "description"],
        "url": ["url", "link"],
        "id": ["parsedId", "questionId", "id"],
        "community": ["parsedCommunityName", "communityName"],
        "score": ["upVotes", "score", "followerCount"],
        "answers": ["numberOfComments", "answerCount"],
        "postedAt": ["createdAt", "creationTime", "askedAt"],
        "tags": ["tags", "topics"],
    },
    "stackexchange_api": {
        "title": ["title"],
        "body": ["body"],
        "url": ["link"],
        "id": ["question_id"],
        "community": ["site"],
        "score": ["score"],
        "answers": ["answer_count"],
        "postedAt": ["creation_date"],
        "tags": ["tags"],
    },
    "discourse_json": {
        "title": ["title", "fancy_title"],
        "body": ["excerpt"],
        "url": ["url"],
        "id": ["id"],
        "community": ["community"],
        "score": ["like_count"],
        "answers": ["answer_count"],
        "postedAt": ["created_at"],
        "tags": ["tags"],
    },
}
