# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Myxo is an autonomous AI creature that lives in The Fold — a content-addressable homoiconic computation environment built in Chez Scheme. It thinks continuously on a timer, computes exclusively through Scheme expressions evaluated in the Fold, builds up memories, reflects, and plans. Multiple creatures can run simultaneously, each with its own Fold session and `{name}_box/` directory for state.

This is a **Fold-native model environment**: the creature's sole computational tool is the Fold. No shell, no Python execution, no web search. All computation goes through Fold expressions evaluated via Unix domain socket to the Fold daemon. The Fold source lives in the `fold/` submodule.

## Commands

```bash
# Backend
pip install -e .
python myxo/main.py                # discovers *_box/ dirs, starts all creatures
MYXO_PORT=9000 python myxo/main.py # custom port (default 8080)

# Frontend (dev with hot-reload on :5173, proxies to backend on :8080)
cd frontend && npm install && npm run dev

# Frontend (production build)
cd frontend && npm run build       # outputs to frontend/dist/

# Update Fold submodule
scripts/update-fold-submodule.sh   # also runs hourly via cron
```

No test suite exists. No linter is configured.

## Architecture

### Core Loop (`brain.py`)

`Brain.run()` is the heart — an async loop that repeats: think -> reflect (if importance threshold crossed) -> plan (every 10 cycles) -> idle wander -> sleep.

`_think_once()` builds context (system prompt + rolling history window + nudge), calls the LLM with tools enabled, then enters a **tool loop**: execute each tool call -> feed results back -> call LLM again -> repeat until the model emits final text with no tool calls. Every final thought gets stored in the memory stream with an importance score and embedding.

The creature has three tools:
- **fold** — evaluate a Scheme expression in the Fold (persistent session via Unix socket)
- **respond** — talk to its owner
- **move** — move to a location in its pixel-art room

### Provider Abstraction (`provider.py`)

Two providers behind a shared `Provider` interface:
- **`OpenAIProvider`** — Uses the **Responses API** (`client.responses.create`).
- **`LocalProvider`** — Uses **Chat Completions API** (`client.chat.completions.create`) for vLLM, OpenRouter, etc.

Both share the same `_FUNCTION_TOOLS` definitions (fold, respond, move). The `create_provider()` factory selects based on `provider` field in config.

**Important:** The Brain's `input_list` uses Responses API format internally. LocalProvider translates on every `chat()` call. When modifying tool handling or adding tools, changes need to work for both output shapes.

### The Fold Integration (`fold_client.py`)

Thin client that talks to the Fold daemon via Unix domain socket with length-prefixed S-expression messages. Each creature gets a persistent session (`myxo-{name}`). The daemon is auto-started if not running.

The Fold provides a skill lattice (verified DAG of computational capabilities), content-addressed storage, a module system, and fuel-bounded evaluation. See `fold/CLAUDE.md` for full Fold architecture.

**Procedure repr:** The REPL supports a Python-style `__repr__` for procedures — evaluating a bare symbol (e.g. just `matrix-multiply` without parens) returns a rich repr: type signature, docstring, source skill, and `(require 'module)` path. This is the fastest way for the creature to look up documentation on a known function.

### Config Layering (`config.py`)

`config.yaml` has global defaults at the top level and per-creature overrides under `creatures:`. `get_creature_config(creature_id)` merges them into a flat dict. Environment variables (`OPENAI_API_KEY`, `MYXO_MODEL`, `MYXO_PORT`) override config file values.

### Memory System (`memory.py`)

Inspired by Park et al. (2023) generative agents. Append-only JSONL (`memory_stream.jsonl` in each creature's box). Three-factor retrieval: `score = recency + importance + relevance` where recency is exponential decay, importance is LLM-scored 1-10, and relevance is cosine similarity of embeddings. Reflection triggers when cumulative importance crosses the threshold (default 50).

### Server + WebSocket Protocol (`server.py`)

FastAPI app with REST endpoints and per-creature WebSocket channels. The Brain broadcasts events to connected WebSocket clients: `entry` (thoughts, tool calls), `api_call`, `position`, `status`, `activity`, `conversation`, `alert`, `focus_mode`.

### Frontend (`frontend/`)

React 18 + TypeScript + Vite. Single-page app with two panes: pixel-art room (HTML5 Canvas) and chat feed. All styles are inline CSS-in-JS objects.

## Process Management

When testing myxo, stale processes from previous runs are common and should be cleaned up without asking:
- **Kill stale myxo instances** (`python myxo/main.py`) from previous test runs freely
- **Kill stale Fold workers** (`repl-worker-socket.ss`) from previous sessions freely
- **Restart the Fold daemon** (`cd ~/fold && bash daemon.sh stop && bash daemon.sh start`) as needed
- **Kill runaway workers** (100% CPU Scheme processes) immediately — they're zombies

These are ephemeral test processes, not production services. Clean them up as part of normal test workflow.

## Key Conventions

- **`{name}_box/` directories are gitignored** — they contain runtime creature state (identity, memories, projects). Never commit these.
- **The Brain's input_list accumulates** — the tool loop appends tool call outputs and LLM responses to the same list across iterations. This is how multi-turn tool use works.
- **LLM calls are wrapped in `asyncio.to_thread`** — the provider's `chat()` is synchronous, so it's run in a thread to avoid blocking the event loop.
- **Adaptive pacing** — active cycles (tool calls happened) sleep 30s, idle cycles sleep 60s. User messages wake immediately via `_wake_event`.
- **All computation is Fold expressions** — the creature cannot execute shell commands, Python scripts, or web searches.

## Landing the Plane

This project is worked on by multiple agents across distributed sessions. **Work isn't done until it's committed and pushed to the remote.** At the end of every work session — before you stop, before context runs out — land the plane:

1. Build the frontend if you touched `frontend/src/` (`cd frontend && npm run build`)
2. Commit all changes with a clear message
3. `git push origin main`
4. If the Fold submodule was modified, commit and push there first, then update the submodule pointer in hermitclaw

Don't leave uncommitted work on the floor. Don't leave commits unpushed. If you're running low on context, prioritize shipping what you have over starting something new.

## Design Principles

- **Radically simple code.** Each file does one thing. No frameworks beyond FastAPI and React.
- **Single substrate.** The creature computes exclusively through the Fold.
- **Continuous thinking.** The creature thinks on a steady pulse, not just in response to input.
- **Organic memory.** Dreams (reflections) consolidate thoughts into lasting memories that shape personality over time.

## Phase 2 Direction

This architecture is designed to migrate toward the Fold's RLM v2 framework (`fold/lattice/pipeline/rlm2.ss`, `fold/boundary/pipeline/rlm2-drive.ss`). RLM v2 provides a HUD-based state machine with a structured action language, CAS trajectory recording, fuel budgeting, and episodic memory. The migration path: free-form Fold expressions -> shaped RLM v2 actions -> Python brain becomes a thin event bridge -> creature cognition IS the Fold.
