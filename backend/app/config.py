"""All settings come from environment variables (or a .env file).

Every integration is optional: the app starts with none of them set, and
/api/health reports which ones are configured.
"""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=(".env", "../.env"), extra="ignore")

    # Public URL of this backend (your ngrok/cloudflared URL in dev). Twilio
    # fetches TwiML and audio from here, so it must be reachable from the internet.
    public_base_url: str = "http://localhost:8000"
    # Where the React app runs. Used for CORS and for links in posts.
    frontend_url: str = "http://localhost:5173"

    # --- Claude (Anthropic) ---
    anthropic_api_key: str | None = None
    claude_model: str = "claude-opus-5-5"

    # --- Cartesia (Pip's voice) ---
    cartesia_api_key: str | None = None
    cartesia_voice_id: str = "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4"
    cartesia_model: str = "sonic-3.6"
    cartesia_version: str = "2026-08-14"

    # --- Twilio (phone calls) ---
    twilio_account_sid: str | None = None
    twilio_auth_token: str | None = None
    twilio_phone_number: str | None = None
    twilio_validate_signature: bool = True

    # --- Convex (database) ---
    convex_url: str | None = None
    # Must match BACKEND_SECRET set in the Convex dashboard (npx convex env set).
    convex_backend_secret: str | None = None

    # --- Apify (finding questions) ---
    apify_token: str | None = None
    question_sources_file: str = "question_sources.json"

    # --- Publishing ---
    # Platforms an answer goes to when the elder says "yes" on the call.
    default_platforms: str = "feed,bluesky"

    bluesky_handle: str | None = None
    bluesky_app_password: str | None = None

    linkedin_access_token: str | None = None
    linkedin_author_urn: str | None = None  # e.g. urn:li:person:abc123
    linkedin_version: str = "202606"  # YYYYMM; LinkedIn retires versions after ~1 year

    reddit_client_id: str | None = None
    reddit_client_secret: str | None = None
    reddit_username: str | None = None
    reddit_password: str | None = None
    reddit_user_agent: str = "frontporch/0.1 (hackathon project)"
    # Off by default: Reddit needs API approval for new apps, and many
    # subreddits ban AI-written replies. When off, Reddit gets a draft.
    reddit_posting_enabled: bool = False

    discourse_url: str | None = None
    discourse_api_key: str | None = None
    discourse_username: str | None = None

    # --- Call behaviour ---
    max_follow_ups: int = 2
    app_name: str = "Front Porch"

    @property
    def platforms(self) -> list[str]:
        return [p.strip() for p in self.default_platforms.split(",") if p.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
