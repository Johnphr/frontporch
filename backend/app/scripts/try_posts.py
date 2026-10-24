"""Dry run: turn a saved call into every platform version + the quality check.

Usage (from backend/, needs only ANTHROPIC_API_KEY in backend/.env):

    python -m app.scripts.try_posts tests/fixtures/sample_call.json

Never posts anything and never writes to Convex.
The fixture is JSON: {"question": {...}, "elder": {...}, "turns": [...], "draft"?: {...}}.
If "draft" is missing, the base draft is written with Claude first.
"""

import argparse
import asyncio
import json
import sys
from pathlib import Path

from app.config import get_settings
from app.llm import LLM
from app.services.post_writer import build_posts, draft_to_dict


async def main(path: Path) -> int:
    settings = get_settings()
    llm = LLM(settings)
    if not llm.configured:
        print("Set ANTHROPIC_API_KEY in backend/.env first.", file=sys.stderr)
        return 1
    data = json.loads(path.read_text(encoding="utf-8"))
    question, elder, turns = data["question"], data["elder"], data["turns"]
    draft = data.get("draft") or draft_to_dict(await llm.draft_answer(question, elder, turns))

    print(f"QUESTION: {question['title']}\n")
    print(f"BASE DRAFT ({len(draft.get('body', ''))} chars)\n{draft.get('body', '')}\n")
    variants, quality = await build_posts(llm, question, elder, turns, draft, settings=settings)
    checks = {q["platform"]: q for q in quality}
    for platform, text in variants.items():
        check = checks.get(platform)
        verdict = "not checked" if check is None else ("PASS" if check["passed"] else "REVIEW")
        print("=" * 72)
        print(f"{platform.upper()}  ·  {len(text)} chars  ·  {verdict}")
        print("-" * 72)
        print(text)
        for issue in (check or {}).get("issues", []):
            print(f"  ⚠ {issue}")
    feed = checks.get("feed")
    if feed:
        print("=" * 72)
        print(f"FEED (base draft) · {'PASS' if feed['passed'] else 'REVIEW'}")
        for issue in feed["issues"]:
            print(f"  ⚠ {issue}")
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("fixture", type=Path)
    sys.exit(asyncio.run(main(parser.parse_args().fixture)))
