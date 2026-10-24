"""Post-call pipeline (stub). Runs after Vapi's end-of-call-report.

Steps, each isolated so one failure doesn't stop the rest:
  1. save transcript + summary to Convex (calls)
  2. Claude draft_story_post -> answers (use ONLY what he said)
  3. Claude extract_memories -> Convex memories:add (Convex embeds)
  4. LinkedAPI createPost -> publication on the answer (auto-post, no approval)
  5. SMS every family member with the post link (services.sms)
  6. mark the question answered

Owner: AI. See ARCHITECTURE.md "After the call" and "Contracts".
"""

from dataclasses import dataclass


@dataclass
class CallResult:
    vapi_call_id: str
    elder_id: str
    question_id: str | None
    turns: list[dict]  # [{"role": "pip" | "elder", "text": str}], same shape as the Gather flow
    summary: str | None
    ended_reason: str  # e.g. "customer-ended-call", "voicemail"


async def process_call(services, result: CallResult) -> None:
    # TODO: steps 1-6 above. Skip posting on voicemail / no elder speech.
    raise NotImplementedError
