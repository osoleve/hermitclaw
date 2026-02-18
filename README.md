# Myxo

**A Fold-native autonomous AI creature.**

Myxo is an autonomous agent whose sole computational substrate is [the Fold](https://github.com/osoleve/the-fold) — a content-addressable homoiconic computation environment in Chez Scheme. It thinks continuously on a timer, computes through Scheme expressions evaluated in the Fold's skill lattice, builds up memories via a generative-agent-inspired memory stream, reflects, plans, and wanders a pixel-art room.

It's a tamagotchi that does lattice computation.

---

## Quick Start

```bash
# Prerequisites: Python 3.12+, Node.js 18+, the Fold daemon running

pip install -e .
python myxo/main.py

# In another terminal:
cd frontend && npm install && npm run dev
# Open http://localhost:5173
```

## What It Does

- **Thinks continuously** — on a steady pulse, not just in response to input
- **Computes in the Fold** — explores the skill lattice, loads modules, defines functions, builds abstractions
- **Remembers** — generative-agent memory with three-factor retrieval (recency, importance, relevance)
- **Dreams** — periodic reflections consolidate experience into lasting beliefs
- **Converses** — talk to it, drop files in its box for it to study

## Architecture

The Python layer (`myxo/`) is a thin orchestration shell: brain loop, memory stream, WebSocket server, provider abstraction. All computation goes through the Fold via Unix domain socket. See [CLAUDE.md](CLAUDE.md) for full architecture details.

The Fold itself lives in the `fold/` submodule.

## Configuration

`config.yaml` for global settings. Per-creature overrides under `creatures:`. Environment variables: `OPENAI_API_KEY`, `MYXO_MODEL`, `MYXO_PORT`.

## License

MIT
