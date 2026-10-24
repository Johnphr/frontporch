"""FastAPI entrypoint. Run with:  uvicorn app.main:app --reload --port 8000"""

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from .config import get_settings
from .db import StoreNotConfigured
from .llm import LLMNotConfigured, LLMRefusal
from .routes import api, twilio
from .voice import AUDIO_DIR

settings = get_settings()
app = FastAPI(title="Front Porch API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=list({settings.frontend_url.rstrip("/"), "http://localhost:5173"}),
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(StoreNotConfigured)
async def _store_not_configured(_: Request, exc: StoreNotConfigured):
    return JSONResponse(status_code=503, content={"detail": f"Convex not configured: {exc}"})


@app.exception_handler(LLMNotConfigured)
async def _llm_not_configured(_: Request, exc: LLMNotConfigured):
    return JSONResponse(status_code=503, content={"detail": f"Claude not configured: {exc}"})


@app.exception_handler(LLMRefusal)
async def _llm_refusal(_: Request, exc: LLMRefusal):
    return JSONResponse(status_code=422, content={"detail": str(exc)})


app.include_router(api.router)
app.include_router(twilio.router)

AUDIO_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/audio", StaticFiles(directory=AUDIO_DIR), name="audio")


@app.get("/")
async def root():
    return {"name": "Front Porch API", "docs": "/docs"}
