"""LinkedIn via LinkedAPI (stub, not in PUBLISHERS yet).

Posts on grandpa's own account through LinkedAPI's cloud browser, using the
createPost workflow (POST https://api.linkedapi.io/workflows, headers
linked-api-token + identification-token). Workflows run human-paced, so
expect to poll for the result instead of getting the post URL immediately.

Same contract as the other publishers: async publish(ctx) -> result(...) dict.
Reuse ctx.long_text() so the AI disclosure line is always included.

Owner: Integrations. Env: LINKEDAPI_TOKEN, LINKEDAPI_ID_TOKEN.
"""

from .base import PublishContext


async def publish(ctx: PublishContext) -> dict:
    raise NotImplementedError
