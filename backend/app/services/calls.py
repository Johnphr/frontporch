"""In-memory state for live phone calls, keyed by Twilio CallSid.

A hackathon demo runs one backend process, so a dict is enough. Everything
worth keeping (transcript, drafts) is also written to Convex.
"""

import asyncio
from dataclasses import dataclass, field

YES_WORDS = {"yes", "yeah", "yep", "sure", "ok", "okay", "post", "go", "please", "absolutely",
             "si", "sí", "claro", "dale", "oui", "ja"}
NO_WORDS = {"no", "nope", "don't", "dont", "not", "wait", "stop", "nah"}


@dataclass
class CallSession:
    call_sid: str
    elder: dict
    question: dict | None = None
    call_id: str | None = None
    turns: list[dict] = field(default_factory=list)  # {"role": "pip"|"elder", "text": str}
    follow_ups: int = 0
    no_input_retries: int = 0
    confirm_attempts: int = 0
    last_prompt: str | None = None  # what Pip last asked, for retries
    draft_task: asyncio.Task | None = None
    answer_id: str | None = None
    readback: str | None = None
    readback_polls: int = 0
    error: str | None = None


SESSIONS: dict[str, CallSession] = {}


def is_yes(speech: str) -> bool | None:
    """True for yes, False for no, None if unclear."""
    words = {w.strip(".,!?¡¿").lower() for w in speech.split()}
    if words & NO_WORDS:
        return False
    if words & YES_WORDS:
        return True
    return None
