"""Vapi server URL webhook (stub, not wired into main.py yet).

Vapi owns the live call. This route only receives server events:
  - end-of-call-report  -> build a CallResult, run services.pipeline in the background
  - status-update       -> optional: mirror call status into Convex
  - tool-calls          -> only if we add mid-call tools (see ARCHITECTURE.md, decision 2)

Auth: check the Vapi server secret header against VAPI_WEBHOOK_SECRET.
Vapi expects a fast 200, so do the slow work in a background task.

Owner: Voice (route) + AI (pipeline). See ARCHITECTURE.md "After the call".
"""

from fastapi import APIRouter, Request

router = APIRouter(prefix="/vapi", tags=["vapi"])


@router.post("/webhook")
async def webhook(request: Request):
    # TODO: verify secret, switch on body["message"]["type"], parse into CallResult
    # (metadata carries elderId / questionId), schedule pipeline.process_call.
    raise NotImplementedError
