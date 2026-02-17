# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

HermitClaw is an autonomous AI agent that lives in a folder — a tamagotchi that does research. It thinks continuously on a timer, uses tools (shell, web search, Scheme evaluation), builds up memories, reflects, and plans. Multiple crabs can run simultaneously, each sandboxed in its own `{name}_box/` directory.

## Commands

```bash
# Backend
pip install -e .
python hermitclaw/main.py          # discovers *_box/ dirs, starts all crabs
HERMITCLAW_PORT=9000 python hermitclaw/main.py  # custom port (default 8080)

# Frontend (dev with hot-reload on :5173, proxies to backend on :8080)
cd frontend && npm install && npm run dev

# Frontend (production build)
cd frontend && npm run build       # outputs to frontend/dist/
```

No test suite exists. No linter is configured.

## Architecture

### Core Loop (`brain.py`)

`Brain.run()` is the heart — an async loop that repeats: think → reflect (if importance threshold crossed) → plan (every 10 cycles) → idle wander → sleep.

`_think_once()` builds context (system prompt + rolling history window + nudge), calls the LLM with tools enabled, then enters a **tool loop**: execute each tool call → feed results back → call LLM again → repeat until the model emits final text with no tool calls. Every final thought gets stored in the memory stream with an importance score and embedding.

The nudge varies by state: wake-up (reads `projects.md`, lists files, retrieves memories), user message pending ("voice from outside"), new files detected ("inbox alert"), focus mode, or normal continue (current focus + relevant memories + random mood).

### Provider Abstraction (`provider.py`)

Two providers behind a shared `Provider` interface:
- **`OpenAIProvider`** — Uses the **Responses API** (`client.responses.create`). Supports `web_search_preview` as a native tool. Tool results use `function_call_output` type.
- **`LocalProvider`** — Uses **Chat Completions API** (`client.chat.completions.create`) for vLLM, OpenRouter, etc. Converts between Responses API input format and Chat Completions messages format (`_convert_input`). Tool results use the `tool` role. Stores assistant tool-call messages as `_local_type: "assistant_with_tools"` so the tool loop can replay them correctly.

Both share the same `_FUNCTION_TOOLS` definitions (shell, respond, fold, move). The `create_provider()` factory selects based on `provider` field in config.

**Important:** The Brain's `input_list` uses Responses API format internally. LocalProvider translates on every `chat()` call. When modifying tool handling or adding tools, changes need to work for both output shapes.

### Config Layering (`config.py`)

`config.yaml` has global defaults at the top level and per-crab overrides under `crabs:`. `get_crab_config(crab_id)` merges them into a flat dict. Environment variables (`OPENAI_API_KEY`, `HERMITCLAW_MODEL`, `HERMITCLAW_PORT`) override config file values.

### Memory System (`memory.py`)

Inspired by Park et al. (2023) generative agents. Append-only JSONL (`memory_stream.jsonl` in each crab's box). Three-factor retrieval: `score = recency + importance + relevance` where recency is exponential decay, importance is LLM-scored 1-10, and relevance is cosine similarity of embeddings. Reflection triggers when cumulative importance crosses the threshold (default 50).

### Sandboxing (`tools.py`, `pysandbox.py`)

The crab can only touch files inside its `{name}_box/`. Shell commands are checked against blocked prefixes, `..` traversal, absolute paths, and shell escapes. Python commands are rewritten to run through `pysandbox.py` which patches `builtins.open`, `os.*` functions, and blocks dangerous module imports. Each crab gets its own venv at `{name}_box/.venv/`.

### Server + WebSocket Protocol (`server.py`)

FastAPI app with REST endpoints (`/api/crabs`, `/api/message`, `/api/status`, `/api/focus-mode`, etc.) and per-crab WebSocket channels (`/ws/{crab_id}`). The Brain broadcasts events to connected WebSocket clients: `entry` (thoughts, tool calls), `api_call` (full LLM request/response for the chat feed), `position`, `status`, `activity`, `conversation`, `alert`, `focus_mode`.

The frontend renders API calls as a deduplicated message stream — each call's `input` contains the full accumulated history, so App.tsx tracks `seenInputItems` to only render new items.

### The Fold Integration (`fold_client.py`)

Thin client that talks to a Fold daemon (Scheme REPL) via Unix domain socket with length-prefixed s-expression messages. Each crab gets a persistent session (`hermitclaw-{name}`). The daemon is auto-started if not running.

### Frontend (`frontend/`)

React 18 + TypeScript + Vite. Single-page app with two panes: pixel-art room (HTML5 Canvas in `GameWorld.tsx`) and chat feed (`App.tsx`). All styles are inline CSS-in-JS objects (no CSS files). Sprite definitions in `sprites.ts`.

## Key Conventions

- **`{name}_box/` directories are gitignored** — they contain runtime crab state (identity, memories, projects, generated files). Never commit these.
- **`helper_box/`** is the existing crab's workspace — treat its contents as crab-generated, not project source.
- **The Brain's input_list accumulates** — the tool loop appends tool call outputs and LLM responses to the same list across iterations. This is how multi-turn tool use works.
- **LLM calls are wrapped in `asyncio.to_thread`** — the provider's `chat()` is synchronous (blocking OpenAI SDK calls), so it's run in a thread to avoid blocking the event loop.
- **Adaptive pacing** — active cycles (tool calls happened) sleep 30s, idle cycles sleep 60s. User messages wake immediately via `_wake_event`.

## Design Principles

- **Radically simple code.** Each file does one thing. No frameworks beyond FastAPI and React.
- **Single folder world.** The crab can only touch files inside its `{name}_box/`.
- **Continuous thinking.** The crab thinks on a steady pulse, not just in response to input.
- **Organic memory.** Dreams (reflections) consolidate thoughts into lasting memories that shape personality over time.
