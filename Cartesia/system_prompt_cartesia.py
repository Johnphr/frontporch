"""Pull the Cartesia agent's system prompt into the repo.

    python Cartesia/system_prompt_cartesia.py

Reads CARTESIA_API_KEY (and optionally CARTESIA_AGENT_ID) from the environment
or from frontporch/.env, then writes next to this file:
    system_prompt.md         the prompt (llm_system_prompt), for other code to read
    agent_config.json        the full agent record, including the greeting (llm_introduce)
"""

import json
import os
import sys
from pathlib import Path

import requests

HERE = Path(__file__).resolve().parent
ENV_FILE = HERE.parent / ".env"
DEFAULT_AGENT_ID = "agent_thWW5zWgLxRJCDuCEatBA9"


def load_env():
    if not ENV_FILE.exists():
        return
    for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
        key, sep, value = line.partition("=")
        if sep and not key.strip().startswith("#"):
            os.environ.setdefault(key.strip(), value.strip())


def get_agent(agent_id):
    headers = {
        "X-API-Key": os.environ["CARTESIA_API_KEY"],
        "Cartesia-Version": "2026-08-14",
    }
    r = requests.get(f"https://api.cartesia.ai/agents/{agent_id}", headers=headers, timeout=30)
    r.raise_for_status()
    return r.json()


def main():
    sys.stdout.reconfigure(encoding="utf-8")  # Windows terminals mangle á, ¿, ñ otherwise
    load_env()
    agent_id = os.environ.get("CARTESIA_AGENT_ID") or DEFAULT_AGENT_ID
    agent = get_agent(agent_id)

    prompt = agent["llm_system_prompt"]
    (HERE / "system_prompt.md").write_text(prompt + "\n", encoding="utf-8")
    (HERE / "agent_config.json").write_text(json.dumps(agent, indent=2) + "\n", encoding="utf-8")

    print(prompt)
    print("\nGreeting:", agent.get("llm_introduce"))
    print(f"\nSaved {HERE / 'system_prompt.md'} and agent_config.json")


if __name__ == "__main__":
    main()
