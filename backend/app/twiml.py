"""Small helpers for building Twilio TwiML responses."""

from fastapi import Response
from twilio.twiml.voice_response import Gather, VoiceResponse

from .voice import Voice

# Bare language codes -> the regional code Twilio <Say>/<Gather> expect.
DEFAULT_REGIONS = {
    "en": "en-US",
    "es": "es-MX",
    "fr": "fr-FR",
    "pt": "pt-BR",
    "de": "de-DE",
    "it": "it-IT",
    "ja": "ja-JP",
    "zh": "zh-CN",
    "ko": "ko-KR",
}


def twilio_language(language: str | None) -> str:
    """'es' -> 'es-MX', 'es_mx' -> 'es-MX', None -> 'en-US'."""
    if not language:
        return "en-US"
    parts = language.replace("_", "-").split("-")
    base = parts[0].lower()
    if len(parts) > 1 and parts[1]:
        return f"{base}-{parts[1].upper()}"
    return DEFAULT_REGIONS.get(base, "en-US")


async def say(target: VoiceResponse | Gather, text: str, language: str, voice: Voice) -> None:
    """Speak `text` with Pip's Cartesia voice, or Twilio's <Say> as a fallback."""
    lang = twilio_language(language)
    if voice.configured:
        try:
            target.play(await voice.speak_url(text, lang))
            return
        except Exception:
            pass  # a TTS hiccup shouldn't drop the call; fall back to <Say>
    target.say(text, language=lang)


def speech_gather(action: str, language: str, hints: str | None = None) -> Gather:
    kwargs = {"hints": hints} if hints else {}
    return Gather(input="speech", action=action, method="POST", speech_timeout="auto",
                  language=twilio_language(language), **kwargs)


def twiml(response: VoiceResponse) -> Response:
    return Response(content=str(response), media_type="application/xml")
