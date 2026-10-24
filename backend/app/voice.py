"""Pip's voice: Cartesia text-to-speech, saved as MP3 and played by Twilio.

Audio files are cached by a hash of (text, language, voice), so repeated
lines (greetings, "give me a moment") are generated once.
If Cartesia isn't configured, callers fall back to Twilio's built-in <Say>.
"""

import hashlib
from pathlib import Path

import httpx

from .config import Settings

AUDIO_DIR = Path(__file__).resolve().parent.parent / "static" / "audio"
CARTESIA_TTS_URL = "https://api.cartesia.ai/tts/bytes"


class Voice:
    def __init__(self, settings: Settings):
        self.settings = settings
        AUDIO_DIR.mkdir(parents=True, exist_ok=True)

    @property
    def configured(self) -> bool:
        return bool(self.settings.cartesia_api_key)

    async def speak_url(self, text: str, language: str = "en-US") -> str:
        """Generate (or reuse) an MP3 of `text` and return its public URL."""
        lang = language.split("-")[0].lower()  # Cartesia takes "en", "es", ...
        key = hashlib.sha256(
            f"{self.settings.cartesia_voice_id}|{lang}|{text}".encode()
        ).hexdigest()[:24]
        path = AUDIO_DIR / f"{key}.mp3"
        if not path.exists():
            async with httpx.AsyncClient(timeout=20) as client:
                response = await client.post(
                    CARTESIA_TTS_URL,
                    headers={
                        "Authorization": f"Bearer {self.settings.cartesia_api_key}",
                        "Cartesia-Version": self.settings.cartesia_version,
                    },
                    json={
                        "model_id": self.settings.cartesia_model,
                        "transcript": text,
                        "voice": {"id": self.settings.cartesia_voice_id},
                        "language": lang,
                        # 22.05 kHz mono-friendly MP3 keeps files small for phone audio.
                        "output_format": {"container": "mp3", "sample_rate": 22050,
                                          "bit_rate": 64000},
                    },
                )
                response.raise_for_status()
                path.write_bytes(response.content)
        return f"{self.settings.public_base_url.rstrip('/')}/audio/{path.name}"
