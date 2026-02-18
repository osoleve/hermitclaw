"""Entry point — creature discovery + onboarding + starts the server."""

import glob
import json
import logging
import os
import shutil
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import uvicorn
from myxo.brain import Brain
from myxo.config import config, get_crab_config
from myxo.identity import load_identity_from, create_identity
from myxo.provider import create_provider
from myxo.server import create_app
from myxo import summarizer

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(message)s",
    datefmt="%H:%M:%S",
)

PROJECT_ROOT = os.path.dirname(os.path.dirname(__file__))


def _crab_id_from_box(box_path: str) -> str:
    """Derive crab ID from box directory name: coral_box -> coral."""
    dirname = os.path.basename(box_path)
    if dirname.endswith("_box"):
        return dirname[:-4]
    return dirname


def _discover_crabs() -> dict[str, Brain]:
    """Discover all *_box/ dirs, migrate legacy environment/, return brains dict."""
    brains: dict[str, Brain] = {}

    # Migrate legacy environment/ if found
    legacy = os.path.join(PROJECT_ROOT, "environment")
    legacy_identity = os.path.join(legacy, "identity.json")
    if os.path.isfile(legacy_identity):
        with open(legacy_identity, "r") as f:
            identity = json.load(f)
        name = identity.get("name", "crab").lower()
        new_path = os.path.join(PROJECT_ROOT, f"{name}_box")
        print(f"\n  Migrating environment/ -> {name}_box/...")
        shutil.move(legacy, new_path)

    # Scan for *_box/ directories
    pattern = os.path.join(PROJECT_ROOT, "*_box")
    boxes = sorted(p for p in glob.glob(pattern) if os.path.isdir(p))

    for box_path in boxes:
        identity = load_identity_from(box_path)
        if not identity:
            continue
        crab_id = _crab_id_from_box(box_path)
        crab_cfg = get_crab_config(crab_id)
        provider = create_provider(crab_cfg)
        brain = Brain(identity, box_path, provider, crab_config=crab_cfg)
        brains[crab_id] = brain

    return brains


def _ensure_fold_env():
    """Auto-create ~/fold/.env.agents if OPENAI_API_KEY is set."""
    env_agents = os.path.expanduser("~/fold/.env.agents")
    if os.path.exists(env_agents):
        return
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        return
    try:
        with open(env_agents, "w") as f:
            f.write(f"OPENAI_API_KEY={api_key}\n")
        print(f"  Created {env_agents} for Fold RLM provider")
    except Exception as e:
        print(f"  Warning: could not create {env_agents}: {e}")


if __name__ == "__main__":
    # Ensure Fold-side env for RLM provider
    _ensure_fold_env()

    # Discover existing crabs
    brains = _discover_crabs()

    if brains:
        names = [b.identity["name"] for b in brains.values()]
        print(f"\n  Found {len(brains)} crab(s): {', '.join(names)}")
        answer = input("  Create a new one? (y/N) > ").strip().lower()
        if answer == "y":
            identity = create_identity()
            crab_id = identity["name"].lower()
            box_path = os.path.join(PROJECT_ROOT, f"{crab_id}_box")
            crab_cfg = get_crab_config(crab_id)
            provider = create_provider(crab_cfg)
            brain = Brain(identity, box_path, provider, crab_config=crab_cfg)
            brains[crab_id] = brain
    else:
        print("\n  No crabs found. Let's create one!")
        identity = create_identity()
        crab_id = identity["name"].lower()
        box_path = os.path.join(PROJECT_ROOT, f"{crab_id}_box")
        crab_cfg = get_crab_config(crab_id)
        provider = create_provider(crab_cfg)
        brain = Brain(identity, box_path, provider, crab_config=crab_cfg)
        brains[crab_id] = brain

    # Initialize the summarizer (local small model for compressing heavy Fold output)
    summarizer_url = config.get("summarizer_base_url")
    summarizer_model = config.get("summarizer_model")
    if summarizer_url and summarizer_model:
        summarizer.init(summarizer_url, summarizer_model)
    else:
        print("  (No summarizer configured — heavy Fold results will be truncated only)")

    # Initialize the app with all brains
    app = create_app(brains)

    port = int(os.environ.get("MYXO_PORT", config.get("port", 8080)))

    names = [b.identity["name"] for b in brains.values()]
    print(f"\n  Starting {len(brains)} crab(s): {', '.join(names)}")
    print(f"  Open http://localhost:{port} to watch them think\n")
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=port,
        log_level="info",
    )
