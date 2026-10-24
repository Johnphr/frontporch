"""Dry run: fetch questions from sources and print them. Never writes to Convex.

    python -m app.scripts.try_sources --list
    python -m app.scripts.try_sources --source stackexchange-everyday --limit 5   # free
    python -m app.scripts.try_sources --source reddit-askoldpeople --limit 5      # APIFY_TOKEN
    python -m app.scripts.try_sources --source quora-life-advice --limit 5 --show-filtered

Run from backend/. Apify sources cost money per result (see README); keep --limit small.
"""

import argparse
import asyncio
import json
import sys
import time
from datetime import datetime, timezone

from ..config import get_settings
from ..services import questions as q


def _when(ms: float | None) -> str:
    if ms is None:
        return "?"
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d")


async def _show_filtered(settings, names: list[str]) -> None:
    """Re-run normalize + filter on the raw items so you can see what got dropped."""
    from ..services.sources import ADAPTERS

    now_ms = time.time() * 1000.0
    for source in q.load_sources(settings, names):
        try:
            items = await ADAPTERS[source.get("kind", "apify")](source, settings)
        except Exception as exc:
            print(f"  {source['name']}: {exc}")
            continue
        for item in items:
            question = q.normalize(item, source)
            reason = "no title" if question is None else q.filter_reason(item, question, source,
                                                                         now_ms)
            if reason:
                title = (question or {}).get("title") or str(item)[:80]
                print(f"  - [{reason}] {title[:100]}")


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--source", action="append", default=[],
                        help="source name from question_sources.json "
                             "(repeatable; default: all enabled)")
    parser.add_argument("--limit", type=int, default=5, help="max questions kept per source")
    parser.add_argument("--list", action="store_true", help="list configured sources and exit")
    parser.add_argument("--json", action="store_true", help="print raw JSON instead of a table")
    parser.add_argument("--show-filtered", action="store_true",
                        help="also list dropped items and why (fetches the sources again)")
    args = parser.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # Windows consoles
    settings = get_settings()

    if args.list:
        for s in q.all_sources(settings):
            flag = "on " if s.get("enabled") else "off"
            print(f"[{flag}] {s['name']:<26} {s.get('kind', 'apify'):<18} {s.get('label', '')}")
        return

    names = [n for arg in args.source for n in arg.split(",") if n] or None
    questions, reports = await q.fetch_questions(settings, names, args.limit)

    if args.json:
        print(json.dumps({"questions": questions, "sources": reports}, indent=2, default=str))
        return

    print("\nSources")
    for name, r in reports.items():
        line = (f"  {name:<26} fetched {r['fetched']:>3} · filtered {r['filtered']:>3} · "
                f"kept {r['kept']:>3} · duplicate {r.get('duplicate', 0):>2}")
        if r.get("reasons"):
            line += "  (" + ", ".join(f"{k}: {v}" for k, v in r["reasons"].items()) + ")"
        if r.get("error"):
            line += f"  ERROR: {r['error']}"
        print(line)

    print(f"\nQuestions ({len(questions)}), highest priority first")
    for question in sorted(questions, key=lambda x: x.get("priority", 0), reverse=True):
        where = question.get("community") or question["source"]
        print(f"  {question.get('priority', 0):>5.2f}  [{where}] {question['title'][:90]}")
        print(f"         score {question.get('score', '?')} · answers "
              f"{question.get('answerCount', '?')} · posted {_when(question.get('postedAt'))} · "
              f"{question.get('sourceUrl', '')}")

    if args.show_filtered:
        print("\nFiltered out")
        await _show_filtered(settings, names or [s["name"] for s in q.load_sources(settings)])


if __name__ == "__main__":
    asyncio.run(main())
