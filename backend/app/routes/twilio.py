"""Twilio voice webhooks: the whole phone conversation with Pip.

Flow (each step is one webhook; Twilio sends CallSid with every request):

  /voice     greet, read thank-yous, ask the question  -> Gather -> /answer
  /answer    maybe ask a follow-up (inline, low effort) -> Gather -> /answer
             or start drafting in the background        -> /readback
  /readback  poll until the draft is ready, read it back -> Gather -> /confirm
  /confirm   yes -> approve + publish in the background; no -> keep as draft
  /no-input  silence: retry once, then say goodbye

Twilio gives up on a webhook after ~15 seconds, which is why drafting (the slow
Claude call) runs as a background task while /readback keeps the line alive.
"""

import asyncio
import logging

from fastapi import APIRouter, Depends, Request
from twilio.twiml.voice_response import VoiceResponse

from ..db import StoreNotConfigured
from ..deps import Services, get_services, verify_twilio
from ..services.calls import SESSIONS, CallSession, is_yes
from ..twiml import say, speech_gather, twiml

log = logging.getLogger(__name__)
router = APIRouter(prefix="/twilio", tags=["twilio"], dependencies=[Depends(verify_twilio)])

MAX_READBACK_POLLS = 12  # x 2 s pause = ~25 s of "still writing"
_BACKGROUND: set[asyncio.Task] = set()  # keep task references alive


# ---------- helpers ----------


def _lang(session: CallSession | None) -> str:
    return (session.elder.get("language") if session else None) or "en-US"


async def _record(services: Services, session: CallSession, role: str, text: str) -> None:
    session.turns.append({"role": role, "text": text})
    if session.call_id:
        try:
            await services.store.add_call_turn(session.call_id, role, text)
        except Exception:  # the transcript copy in Convex is best-effort
            log.exception("could not save call turn")


async def _pip(services: Services, session: CallSession, target, text: str) -> None:
    """Pip says something, and it goes into the transcript."""
    await say(target, text, _lang(session), services.voice)
    await _record(services, session, "pip", text)


async def _end_call(services: Services, session: CallSession | None, status: str) -> None:
    if session is None:
        return
    if session.call_id:
        try:
            await services.store.set_call_status(session.call_id, status)
        except Exception:
            log.exception("could not update call status")
    SESSIONS.pop(session.call_sid, None)


async def _goodbye(services: Services, session: CallSession | None, text: str,
                   status: str = "completed"):
    vr = VoiceResponse()
    if session:
        await _pip(services, session, vr, text)
    else:
        await say(vr, text, "en-US", services.voice)
    vr.hangup()
    await _end_call(services, session, status)
    return twiml(vr)


async def _ask(services: Services, session: CallSession, text: str):
    """Ask something and listen for a spoken answer."""
    session.last_prompt = text
    vr = VoiceResponse()
    gather = speech_gather("/twilio/answer", _lang(session))
    await _pip(services, session, gather, text)
    vr.append(gather)
    vr.redirect("/twilio/no-input", method="POST")
    return twiml(vr)


def _question_prompt(question: dict) -> str:
    text = f"Someone asked: {question['title'].rstrip('?.!')}?"
    body = (question.get("body") or "").strip()
    if body:
        snippet = body if len(body) <= 220 else body[:220].rsplit(" ", 1)[0] + "..."
        text += f" They added: {snippet}"
    return text + (" What would you tell them? Take your time, and just stop talking "
                   "when you're done.")


async def _draft(services: Services, session: CallSession) -> None:
    """Background job: turn the call into a draft answer saved in Convex."""
    try:
        draft = await services.llm.draft_answer(session.question, session.elder, session.turns)
        transcript = "\n".join(
            f"{'PIP' if t['role'] == 'pip' else 'ELDER'}: {t['text']}" for t in session.turns
        )
        fields = {
            "elderId": session.elder["_id"],
            "questionId": session.question["_id"],
            "transcript": transcript,
            "title": draft.title,
            "body": draft.body,
            "shortVersion": draft.short_version,
            "keyPoints": draft.key_points,
            "readback": draft.readback,
        }
        if session.call_id:
            fields["callId"] = session.call_id
        session.answer_id = await services.store.create_answer(**fields)
        session.readback = draft.readback
    except Exception as exc:
        log.exception("drafting failed")
        session.error = str(exc) or exc.__class__.__name__


async def _publish(services: Services, answer_id: str, platforms: list[str]):
    # Imported lazily so this module doesn't depend on the publishers at import time.
    from ..services.publishing import publish_answer

    return await publish_answer(services, answer_id, platforms)


def _schedule_publish(services: Services, answer_id: str, platforms: list[str]) -> None:
    task = asyncio.create_task(_publish(services, answer_id, platforms))
    _BACKGROUND.add(task)
    task.add_done_callback(_BACKGROUND.discard)


def _session(form) -> CallSession | None:
    return SESSIONS.get(str(form.get("CallSid", "")))


# ---------- webhooks ----------


@router.post("/voice")
async def voice(request: Request, services: Services = Depends(get_services)):
    form = await request.form()
    call_sid = str(form.get("CallSid", ""))
    direction = str(form.get("Direction", "inbound"))
    phone = str(form.get("From" if direction == "inbound" else "To", ""))

    try:
        elder = await services.store.elder_by_phone(phone)
    except StoreNotConfigured:
        return await _goodbye(services, None,
                              "Sorry, Front Porch isn't set up yet. Please try again later.")
    if not elder:
        return await _goodbye(services, None,
                              "Hello! This number isn't registered with Front Porch yet. "
                              "Ask your family or the organizers to add you. Goodbye!")

    question = await services.store.next_question_for(elder["_id"])
    session = CallSession(call_sid=call_sid, elder=elder, question=question)
    SESSIONS[call_sid] = session
    try:
        session.call_id = await services.store.start_call(
            call_sid, elder["_id"], question["_id"] if question else None
        )
    except Exception:
        log.exception("could not create call record")

    first_name = (elder.get("name") or "friend").split()[0]
    vr = VoiceResponse()
    await _pip(services, session, vr, f"Hi {first_name}, it's Pip from Front Porch!")

    # Thank-yous first: hearing that an answer helped someone is the best part.
    try:
        replies = (await services.store.unread_replies(elder["_id"]))[:2]
    except Exception:
        log.exception("could not load replies")
        replies = []
    for reply in replies:
        about = reply.get("questionTitle")
        about_text = f"your answer to '{about}'" if about else "one of your answers"
        await _pip(services, session, vr,
                   f"Good news first: {reply.get('author', 'someone')} wrote back about "
                   f"{about_text}: {reply.get('text', '')}")
        try:
            await services.store.mark_reply_read(reply["_id"])
        except Exception:
            log.exception("could not mark reply read")

    if not question:
        await _pip(services, session, vr,
                   "I don't have any new questions for you today. I'll call again soon. Goodbye!")
        vr.hangup()
        await _end_call(services, session, "completed")
        return twiml(vr)

    prompt = _question_prompt(question)
    session.last_prompt = prompt
    gather = speech_gather("/twilio/answer", _lang(session))
    await _pip(services, session, gather, prompt)
    vr.append(gather)
    vr.redirect("/twilio/no-input", method="POST")
    return twiml(vr)


@router.post("/answer")
async def answer(request: Request, services: Services = Depends(get_services)):
    form = await request.form()
    session = _session(form)
    if session is None or session.question is None:
        return await _goodbye(services, None, "Sorry, I lost track of our call. Goodbye!")

    speech = str(form.get("SpeechResult", "")).strip()
    if not speech:
        return await _handle_no_input(services, session)

    session.no_input_retries = 0
    await _record(services, session, "elder", speech)

    decision = await services.llm.decide_follow_up(
        session.question, session.turns,
        services.settings.max_follow_ups - session.follow_ups,
    )
    if decision.action == "follow_up" and decision.follow_up_question.strip():
        session.follow_ups += 1
        return await _ask(services, session, decision.follow_up_question.strip())

    vr = VoiceResponse()
    await _pip(services, session, vr,
               "Thank you, that's wonderful. Give me a moment to write that down.")
    session.draft_task = asyncio.create_task(_draft(services, session))
    vr.redirect("/twilio/readback", method="POST")
    return twiml(vr)


@router.post("/readback")
async def readback(request: Request, services: Services = Depends(get_services)):
    form = await request.form()
    session = _session(form)
    if session is None:
        return await _goodbye(services, None, "Sorry, I lost track of our call. Goodbye!")

    if session.draft_task is not None and not session.draft_task.done():
        session.readback_polls += 1
        if session.readback_polls > MAX_READBACK_POLLS:
            return await _goodbye(
                services, session,
                "I'm sorry, this is taking longer than usual. I'll keep your answer safe "
                "and won't post anything without asking you. Goodbye!",
            )
        vr = VoiceResponse()
        if session.readback_polls % 4 == 0:
            await say(vr, "Still writing, almost there.", _lang(session), services.voice)
        vr.pause(length=2)
        vr.redirect("/twilio/readback", method="POST")
        return twiml(vr)

    if session.error or not session.readback:
        return await _goodbye(
            services, session,
            "I'm sorry, something went wrong while writing your answer. Nothing was posted. "
            "Thank you for sharing, and goodbye!", status="failed",
        )

    vr = VoiceResponse()
    gather = speech_gather("/twilio/confirm", _lang(session), hints="yes, no, sí")
    await _pip(services, session, gather,
               f"Here's what I'll share: {session.readback}. Should I post it? "
               "Please say yes or no.")
    vr.append(gather)
    vr.redirect("/twilio/confirm", method="POST")  # silence counts as "unclear"
    return twiml(vr)


@router.post("/confirm")
async def confirm(request: Request, services: Services = Depends(get_services)):
    form = await request.form()
    session = _session(form)
    if session is None or not session.answer_id:
        return await _goodbye(services, session, "Sorry, I lost track of our call. Goodbye!")

    speech = str(form.get("SpeechResult", "")).strip()
    if speech:
        await _record(services, session, "elder", speech)
    choice = is_yes(speech) if speech else None

    if choice is None and session.confirm_attempts < 1:
        session.confirm_attempts += 1
        vr = VoiceResponse()
        gather = speech_gather("/twilio/confirm", _lang(session), hints="yes, no, sí")
        await _pip(services, session, gather,
                   "Sorry, I didn't catch that. Should I post your answer? Yes or no?")
        vr.append(gather)
        vr.redirect("/twilio/confirm", method="POST")
        return twiml(vr)

    if choice is True:
        await services.store.set_answer_status(session.answer_id, "approved")
        _schedule_publish(services, session.answer_id, services.settings.platforms)
        return await _goodbye(
            services, session,
            "Wonderful, I'll post it now. Thank you for sharing your wisdom! "
            "I'll tell you when people write back. Goodbye!",
        )

    # "no", or still unclear after asking twice: never post without a clear yes.
    return await _goodbye(services, session,
                          "No problem, I won't post it. Thank you for sharing. Goodbye!")


async def _handle_no_input(services: Services, session: CallSession):
    if session.no_input_retries < 1 and session.last_prompt:
        session.no_input_retries += 1
        return await _ask(services, session,
                          "Sorry, I didn't hear anything. " + session.last_prompt)
    status = "completed" if any(t["role"] == "elder" for t in session.turns) else "no-answer"
    return await _goodbye(services, session,
                          "That's alright, we can talk another time. Goodbye!", status=status)


@router.post("/no-input")
async def no_input(request: Request, services: Services = Depends(get_services)):
    form = await request.form()
    session = _session(form)
    if session is None:
        return await _goodbye(services, None, "Goodbye!")
    return await _handle_no_input(services, session)
