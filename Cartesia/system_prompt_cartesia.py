"""Pull the Cartesia agents' system prompts into the repo, one file per agent.

    python Cartesia/system_prompt_cartesia.py                  every agent in the account
    python Cartesia/system_prompt_cartesia.py Oscar "Juanito 2"  only these (by name)

Reads CARTESIA_API_KEY from the environment or from frontporch/.env, then writes
next to this file:
    prompts/<name>.md        the agent's prompt (llm_system_prompt), for other code to read
    configs/<name>.json      the full agent record, including the greeting (llm_introduce);
                             gitignored, it holds the Twilio account SID
"""

import json
import os
import re
import sys
from pathlib import Path

import requests

HERE = Path(__file__).resolve().parent
ENV_FILE = HERE.parent / ".env"
API = "https://api.cartesia.ai"


def load_env():
    if not ENV_FILE.exists():
        return
    for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
        key, sep, value = line.partition("=")
        if sep and not key.strip().startswith("#"):
            os.environ.setdefault(key.strip(), value.strip())


def cartesia(path):
    headers = {
        "X-API-Key": os.environ["CARTESIA_API_KEY"],
        "Cartesia-Version": "2026-08-14",
    }
    r = requests.get(f"{API}{path}", headers=headers, timeout=30)
    r.raise_for_status()
    return r.json()


def slug(name):
    """'Juanito 2' -> 'juanito-2'"""
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or "agent"


def main():
    sys.stdout.reconfigure(encoding="utf-8")  # Windows terminals mangle á, ¿, ñ otherwise
    load_env()
    wanted = {name.lower() for name in sys.argv[1:]}

    agents = [a for a in cartesia("/agents")["summaries"] if not a.get("deleted_at")]
    if wanted:
        agents = [a for a in agents if a["name"].lower() in wanted]
        missing = wanted - {a["name"].lower() for a in agents}
        if missing:
            print("Not found in Cartesia:", ", ".join(sorted(missing)))

    (HERE / "prompts").mkdir(exist_ok=True)
    (HERE / "configs").mkdir(exist_ok=True)
    for summary in agents:
        agent = cartesia(f"/agents/{summary['id']}")
        name = slug(agent["name"])
        prompt = agent.get("llm_system_prompt") or ""
        (HERE / "prompts" / f"{name}.md").write_text(prompt + "\n", encoding="utf-8")
        (HERE / "configs" / f"{name}.json").write_text(json.dumps(agent, indent=2) + "\n", encoding="utf-8")
        print(f"{agent['name']:<12} {agent['id']}  {len(prompt):>5} chars -> prompts/{name}.md")
        print(f"{'':<12} greeting: {agent.get('llm_introduce')}")

    print(f"\nSaved {len(agents)} prompt(s) in {HERE / 'prompts'}")


if __name__ == "__main__":
    main()
