"""FastAPI web server — API + WebSocket + serves frontend."""

import asyncio
import hashlib
import json
import logging
import os
import time
import traceback

from datetime import datetime

from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from myxo.brain import Brain
from myxo.config import config, get_creature_config
from myxo.identity import _derive_traits
from myxo.provider import create_provider

logger = logging.getLogger("myxo.server")

brains: dict[str, Brain] = {}  # creature_id -> Brain


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Start brain coroutines on startup, stop them on shutdown."""
    async def _start_brains():
        # Small delay so the server finishes binding the port first
        await asyncio.sleep(0.5)
        for creature_id, brain in brains.items():
            asyncio.create_task(_supervise_brain(creature_id, brain))
            logger.info(f"{brain.identity['name']} ({creature_id}) starting...")
    asyncio.create_task(_start_brains())
    yield
    # Shutdown: stop all brains
    for brain in brains.values():
        brain.stop()


app = FastAPI(title="Myxo", lifespan=lifespan)


def create_app(all_brains: dict[str, Brain]) -> FastAPI:
    """Initialize the app with brains dict. Called from main.py."""
    global brains
    brains = all_brains
    return app


async def _supervise_brain(creature_id: str, brain: Brain):
    """Supervise a brain coroutine — restart on crash with exponential backoff."""
    backoff = 5
    max_backoff = 120
    restart_count = 0

    while True:
        start = time.monotonic()
        try:
            await brain.run()
            break  # clean exit (brain.stop() was called)
        except Exception as e:
            restart_count += 1
            elapsed = time.monotonic() - start
            tb = traceback.format_exc()
            logger.error(
                f"Brain '{creature_id}' died (restart #{restart_count}, "
                f"ran {elapsed:.0f}s): {e}"
            )

            # Log to JSONL so it shows up in the permanent record
            brain._log_jsonl({
                "timestamp": datetime.now().isoformat(),
                "type": "coroutine_death",
                "creature_id": creature_id,
                "creature_name": brain.identity.get("name", creature_id),
                "error": str(e),
                "traceback": tb,
                "thought_count": brain.thought_count,
                "restart_count": restart_count,
                "backoff_seconds": backoff,
            })

            # Best-effort broadcast to connected frontends
            try:
                await brain._broadcast({
                    "event": "error",
                    "data": {
                        "message": f"Brain crashed: {e}",
                        "restarting_in": backoff,
                    },
                })
            except Exception:
                pass

            # If the brain ran for 5+ minutes, it was probably a transient issue
            if elapsed > 300:
                backoff = 5
                restart_count = 0

            # Don't restart if we were intentionally stopped
            if not brain.running:
                break

            logger.info(f"Restarting '{creature_id}' in {backoff}s...")
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, max_backoff)


def _get_brain(request: Request) -> Brain | None:
    """Look up brain by ?creature=ID query param, or default to first."""
    creature_id = request.query_params.get("creature")
    if creature_id and creature_id in brains:
        return brains[creature_id]
    if brains:
        return next(iter(brains.values()))
    return None


_NO_CREATURE = JSONResponse({"error": "no creatures running"}, status_code=404)


# CORS for development (Vite dev server)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# --- WebSocket ---

@app.websocket("/ws/{creature_id}")
async def websocket_endpoint(ws: WebSocket, creature_id: str):
    brain = brains.get(creature_id)
    if not brain:
        await ws.close(code=4004)
        return
    await ws.accept()
    brain.add_ws_client(ws)
    logger.info(f"WebSocket client connected to {creature_id}")
    try:
        while True:
            await ws.receive_text()  # keep connection alive
    except WebSocketDisconnect:
        brain.remove_ws_client(ws)
        logger.info(f"WebSocket client disconnected from {creature_id}")


@app.websocket("/ws")
async def websocket_default(ws: WebSocket):
    """Backwards-compatible /ws — connects to the first brain."""
    if not brains:
        await ws.close(code=4004)
        return
    brain = next(iter(brains.values()))
    await ws.accept()
    brain.add_ws_client(ws)
    logger.info("WebSocket client connected (default)")
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        brain.remove_ws_client(ws)
        logger.info("WebSocket client disconnected (default)")


# --- REST API ---

@app.get("/api/creatures")
async def get_creatures():
    """List all running creatures."""
    return [
        {
            "id": creature_id,
            "name": brain.identity["name"],
            "state": brain.state,
            "thought_count": brain.thought_count,
        }
        for creature_id, brain in brains.items()
    ]


@app.post("/api/creatures")
async def create_creature(request: Request):
    """Create a new creature at runtime."""
    body = await request.json()
    name = body.get("name", "").strip()
    if not name:
        return {"ok": False, "error": "name is required"}

    creature_id = name.lower()
    if creature_id in brains:
        return {"ok": False, "error": f"creature '{creature_id}' already exists"}

    # Create box directory
    project_root = os.path.dirname(os.path.dirname(__file__))
    box_path = os.path.join(project_root, f"{creature_id}_box")
    os.makedirs(box_path, exist_ok=True)

    # Generate identity with random entropy (no interactive keyboard mashing)
    seed_bytes = hashlib.sha256(
        f"{name}{time.time_ns()}{os.urandom(32).hex()}".encode()
    ).digest()
    genome_hex = seed_bytes.hex()
    traits = _derive_traits(seed_bytes)

    identity = {
        "name": name,
        "genome": genome_hex,
        "traits": traits,
        "born": time.strftime("%Y-%m-%d %H:%M:%S"),
    }

    with open(os.path.join(box_path, "identity.json"), "w") as f:
        json.dump(identity, f, indent=2)

    # Start the brain
    creature_cfg = get_creature_config(creature_id)
    provider = create_provider(creature_cfg)
    brain = Brain(identity, box_path, provider, creature_config=creature_cfg)
    brains[creature_id] = brain
    asyncio.create_task(_supervise_brain(creature_id, brain))
    logger.info(f"Created and started new creature: {name} ({creature_id})")

    return {"ok": True, "id": creature_id, "name": name}


@app.get("/api/identity")
async def get_identity(request: Request):
    """Get the creature's identity."""
    brain = _get_brain(request)
    if not brain:
        return _NO_CREATURE
    return brain.identity

@app.get("/api/events")
async def get_events(request: Request, limit: int = 100):
    brain = _get_brain(request)
    if not brain:
        return _NO_CREATURE
    return brain.events[-limit:]

@app.get("/api/raw")
async def get_raw(request: Request, limit: int = 20):
    """Get raw API call history."""
    brain = _get_brain(request)
    if not brain:
        return _NO_CREATURE
    return brain.api_calls[-limit:]

@app.get("/api/status")
async def get_status(request: Request):
    brain = _get_brain(request)
    if not brain:
        return _NO_CREATURE
    return {
        "state": brain.state,
        "thought_count": brain.thought_count,
        "importance_sum": brain.stream.importance_sum if brain.stream else 0,
        "reflection_threshold": config["reflection_threshold"],
        "memory_count": len(brain.stream.memories) if brain.stream else 0,
        "model": config["model"],
        "name": brain.identity["name"],
        "position": brain.position,
        "focus_mode": brain._focus_mode,
    }

@app.post("/api/focus-mode")
async def post_focus_mode(request: Request):
    """Toggle focus mode on or off."""
    brain = _get_brain(request)
    if not brain:
        return _NO_CREATURE
    body = await request.json()
    enabled = bool(body.get("enabled", False))
    await brain.set_focus_mode(enabled)
    return {"ok": True, "focus_mode": enabled}

@app.post("/api/message")
async def post_message(request: Request):
    """Receive a message from the user (voice from outside the room)."""
    brain = _get_brain(request)
    if not brain:
        return _NO_CREATURE
    body = await request.json()
    text = body.get("text", "").strip()
    if not text:
        return {"ok": False, "error": "empty message"}
    if brain._waiting_for_reply:
        brain.receive_conversation_reply(text)
    else:
        brain.receive_user_message(text)
    return {"ok": True}

@app.post("/api/snapshot")
async def post_snapshot(request: Request):
    """Receive a canvas snapshot from the frontend."""
    brain = _get_brain(request)
    if not brain:
        return _NO_CREATURE
    body = await request.json()
    brain.latest_snapshot = body.get("image")
    return {"ok": True}

@app.get("/api/bbs")
async def get_bbs(request: Request):
    """Get BBS issues filed by a creature this run."""
    brain = _get_brain(request)
    if not brain:
        return _NO_CREATURE
    return brain._bbs_issues


@app.get("/api/journal")
async def get_journal(request: Request):
    """Get today's journal entries."""
    brain = _get_brain(request)
    if not brain:
        return _NO_CREATURE
    from datetime import date
    date_str = date.today().isoformat()
    journal_path = os.path.join(brain.env_path, "journal", f"{date_str}.md")
    try:
        with open(journal_path, "r") as f:
            content = f.read()
    except FileNotFoundError:
        content = ""
    return {"date": date_str, "content": content}


@app.get("/api/journal/{date_str}")
async def get_journal_by_date(request: Request, date_str: str):
    """Get journal entries for a specific date."""
    brain = _get_brain(request)
    if not brain:
        return _NO_CREATURE
    journal_path = os.path.join(brain.env_path, "journal", f"{date_str}.md")
    try:
        with open(journal_path, "r") as f:
            content = f.read()
    except FileNotFoundError:
        content = ""
    return {"date": date_str, "content": content}


@app.get("/api/files")
async def get_files(request: Request):
    brain = _get_brain(request)
    if not brain:
        return _NO_CREATURE
    env_root = os.path.realpath(brain.env_path)
    files = []
    for dirpath, _, filenames in os.walk(env_root):
        for fn in filenames:
            full = os.path.join(dirpath, fn)
            rel = os.path.relpath(full, env_root)
            if not rel.startswith("."):
                files.append(rel)
    files.sort()
    return {"files": files}

@app.get("/api/files/{path:path}")
async def get_file(request: Request, path: str):
    brain = _get_brain(request)
    if not brain:
        return _NO_CREATURE
    env_root = os.path.realpath(brain.env_path)
    full = os.path.realpath(os.path.join(env_root, path))
    if not full.startswith(env_root + os.sep) and full != env_root:
        return {"path": path, "content": "Blocked: path outside environment."}
    try:
        with open(full, "r") as f:
            return {"path": path, "content": f.read()}
    except Exception as e:
        return {"path": path, "content": f"Error: {e}"}


# --- Static frontend ---

frontend_dist = os.path.join(os.path.dirname(__file__), "..", "frontend", "dist")
if os.path.isdir(frontend_dist):
    app.mount("/assets", StaticFiles(directory=os.path.join(frontend_dist, "assets")), name="assets")

    @app.get("/{full_path:path}")
    async def serve_frontend(full_path: str):
        file_path = os.path.join(frontend_dist, full_path)
        if os.path.isfile(file_path):
            return FileResponse(file_path)
        return FileResponse(os.path.join(frontend_dist, "index.html"))
