"""Jobs triggered by Convex crons (stub, not wired into main.py yet).

Auth: X-Backend-Secret header must equal CONVEX_BACKEND_SECRET.

  POST /jobs/find-questions  -> reuse services.questions.fetch_from_apify +
                                route_new_questions (same as /api/questions/refresh)

Owner: Integrations. See ARCHITECTURE.md "Online questions".
"""

from fastapi import APIRouter

router = APIRouter(prefix="/jobs", tags=["jobs"])


@router.post("/find-questions")
async def find_questions():
    # TODO: check secret header, then run the existing Apify refresh + routing.
    raise NotImplementedError
