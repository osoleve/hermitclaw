"""The thinking loop — the heart of the creature."""

import asyncio
import base64
import json
import logging
import os
import random
from datetime import datetime, date

from myxo.config import config
from myxo.memory import MemoryStream
from myxo.prompts import main_system_prompt, pick_mood, REFLECTION_PROMPT, PLANNING_PROMPT, FOCUS_NUDGE, JOURNAL_PROMPT
from myxo.fold_client import evaluate as fold_evaluate, evaluate_long as fold_evaluate_long, check_session_fresh, kill_daemon as fold_kill_daemon

ARTIFACTS_FILENAME = "fold_artifacts.jsonl"

logger = logging.getLogger("myxo.brain")

LOG_PATH = os.path.join(os.path.dirname(__file__), "..", "myxo.log.jsonl")


def _serialize_input(input_list: list) -> list:
    """Convert input_list to JSON-safe dicts for broadcasting."""
    result = []
    for item in input_list:
        if isinstance(item, dict):
            result.append(item)
        elif hasattr(item, "type"):
            # SDK object — convert based on type
            if item.type == "function_call":
                result.append({
                    "type": "function_call",
                    "name": item.name,
                    "arguments": item.arguments,
                    "call_id": item.call_id,
                })
            elif item.type == "message":
                parts = []
                for c in item.content:
                    if hasattr(c, "text"):
                        parts.append(c.text)
                result.append({
                    "type": "message",
                    "role": getattr(item, "role", "assistant"),
                    "content": " ".join(parts),
                })
            else:
                result.append({"type": item.type})
        else:
            result.append({"type": "unknown", "repr": str(item)[:200]})
    return result


def _serialize_output(output) -> list:
    """Convert API response output items to JSON-safe dicts."""
    items = []
    for item in output:
        if hasattr(item, "type"):
            if item.type == "message":
                content_parts = []
                for c in item.content:
                    if hasattr(c, "text") and c.text:
                        content_parts.append({"type": "text", "text": c.text})
                    elif not hasattr(c, "text"):
                        content_parts.append({"type": getattr(c, "type", "unknown")})
                # Skip messages with no actual text content
                if content_parts:
                    items.append({"type": "message", "content": content_parts})
            elif item.type == "function_call":
                items.append({
                    "type": "function_call",
                    "name": item.name,
                    "arguments": item.arguments,
                    "call_id": item.call_id,
                })
            else:
                items.append({"type": item.type})
        elif isinstance(item, dict):
            items.append(item)
        else:
            items.append({"type": "unknown", "repr": str(item)[:200]})
    return items


class Brain:
    # Room is 12x12 tiles (extracted from Smallville-style tilemap)
    ROOM_LOCATIONS = {
        "desk": {"x": 10, "y": 1},
        "bookshelf": {"x": 1, "y": 2},
        "window": {"x": 4, "y": 0},
        "plant": {"x": 0, "y": 8},
        "bed": {"x": 3, "y": 10},
        "rug": {"x": 5, "y": 5},
        "center": {"x": 5, "y": 5},
    }

    # Tiles the creature cannot walk on (from Smallville collision layer)
    _BLOCKED: set[tuple[int, int]] = set()

    @staticmethod
    def _init_blocked():
        # Collision map extracted from the Smallville tilemap
        collision_rows = [
            "XXXX..XXXXXX",  # row 0
            "..XX...XX...",  # row 1
            ".......XXXX.",  # row 2
            "..XX...XX...",  # row 3
            "..XX...XX...",  # row 4
            "........XX..",  # row 5
            "............",  # row 6
            "..XXXXXX..XX",  # row 7
            "..XX...X..X.",  # row 8
            "....XXX...X.",  # row 9
            "XX...X.....X",  # row 10
            "X....X......",  # row 11
        ]
        b = set()
        for y, row in enumerate(collision_rows):
            for x, ch in enumerate(row):
                if ch == "X":
                    b.add((x, y))
        return b

    # File extensions we can read as text
    _TEXT_EXTS = {".txt", ".md", ".py", ".json", ".csv", ".yaml", ".yml",
                  ".toml", ".js", ".ts", ".html", ".css", ".sh", ".log"}
    _PDF_EXTS = {".pdf"}
    _IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp"}
    # Internal files the creature/system manages — never trigger alerts
    _IGNORE_FILES = {"memory_stream.jsonl", "identity.json", "outbox.jsonl",
                      "outbox_read.json", "fold_artifacts.jsonl", "memory_state.json"}
    # Internal files that live in the root but shouldn't trigger inbox alerts
    _INTERNAL_ROOT_FILES = {"projects.md"}

    # Planning frequency — plan every N think cycles
    PLAN_INTERVAL = 10

    # Journal frequency — synthesize every N think cycles (offset from planning)
    JOURNAL_INTERVAL = 5

    # Tool loop circuit breaker — max tool calls per think cycle
    MAX_TOOL_CALLS = 20

    # Fold session circuit breaker — kill daemon after this many consecutive timeouts
    FOLD_TIMEOUT_THRESHOLD = 3

    def __init__(self, identity: dict, env_path: str, provider=None, creature_config: dict = None):
        self.identity = identity
        self.env_path = env_path
        self.provider = provider
        self.creature_config = creature_config or {}
        self.events: list[dict] = []
        self.api_calls: list[dict] = []
        self.thought_count: int = 0
        self.state: str = "idle"
        self.running: bool = False
        self._ws_clients: set = set()
        self.stream: MemoryStream | None = None  # loaded in run()
        self.position = {"x": 5, "y": 5}
        self.latest_snapshot = None  # data URL from frontend canvas
        if not Brain._BLOCKED:
            Brain._BLOCKED = Brain._init_blocked()

        # File tracking — populated in run()
        self._seen_env_files: set[str] = set()
        self._inbox_pending: list[dict] = []

        # BBS issues created this run — exposed via /api/bbs
        self._bbs_issues: list[dict] = []

        # RLM runs this session — exposed via /api/rlm
        self._rlm_runs: list[dict] = []

        # Planning state
        self._cycles_since_plan: int = 0
        self._current_focus: str = ""

        # Focus mode
        self._focus_mode: bool = False

        # Conversation state
        self._user_message: str | None = None
        self._conversation_event: asyncio.Event = asyncio.Event()
        self._conversation_reply: str | None = None
        self._waiting_for_reply: bool = False

        # Fold session tracking
        self._fold_session_warned: bool = False  # only warn once per run about reset
        self._fold_consecutive_timeouts: int = 0  # circuit breaker for zombie workers

        # Mood persistence — pick once, stick for several cycles
        self._current_mood: dict | None = None
        self._mood_cycles: int = 0
        self._mood_duration: int = 5  # re-pick after this many think cycles

        # Cross-cycle error tracking — prevents fixation loops
        self._persistent_errors: dict[str, int] = {}  # error_key -> count across cycles

        # Journal state — auto-captured cycle metadata + periodic synthesis
        self._journal_tags: list[dict] = []
        self._cycles_since_journal: int = 0

    # --- Helpers ---

    @staticmethod
    def _strip_images_for_log(entry: dict) -> dict:
        """Remove base64 image data from a log entry to keep JSONL manageable."""
        import copy
        e = copy.deepcopy(entry)
        for item in e.get("input", []):
            if isinstance(item, dict) and isinstance(item.get("content"), list):
                for part in item["content"]:
                    if isinstance(part, dict) and part.get("type") == "input_image":
                        part["image_url"] = "(image stripped from log)"
        return e

    def _record_fold_artifact(self, expression: str, result: str):
        """Append a successful Fold computation to the artifact log."""
        # Only record non-trivial results (skip short probes like (+ 1 1))
        if len(result) < 20 and not expression.strip().startswith("(define"):
            return
        # Skip module listings and environment dumps (useful but not "artifacts")
        if expression.strip() in ("(modules)", "(+ 1 1)"):
            return

        artifact = {
            "timestamp": datetime.now().isoformat(),
            "expression": expression[:500],
            "result_preview": result[:200],
            "result_length": len(result),
        }
        artifacts_path = os.path.join(self.env_path, ARTIFACTS_FILENAME)
        try:
            with open(artifacts_path, "a") as f:
                f.write(json.dumps(artifact) + "\n")
        except Exception as e:
            logger.error(f"Failed to record artifact: {e}")

    def _load_recent_artifacts(self, n: int = 10) -> list[dict]:
        """Load the last N Fold artifacts for context."""
        artifacts_path = os.path.join(self.env_path, ARTIFACTS_FILENAME)
        if not os.path.isfile(artifacts_path):
            return []
        entries = []
        try:
            with open(artifacts_path, "r") as f:
                for line in f:
                    line = line.strip()
                    if line:
                        try:
                            entries.append(json.loads(line))
                        except json.JSONDecodeError:
                            pass
        except Exception:
            pass
        return entries[-n:]

    def _read_file(self, rel_path: str) -> str | None:
        """Read a file from environment/, return contents or None."""
        fpath = os.path.join(self.env_path, rel_path)
        try:
            with open(fpath, "r", errors="replace") as f:
                return f.read()
        except (FileNotFoundError, IsADirectoryError):
            return None

    def _load_current_focus(self) -> str:
        """Extract current focus from projects.md if it exists."""
        content = self._read_file("projects.md")
        if not content:
            return ""
        # Extract the "# Current Focus" section
        lines = content.split("\n")
        in_focus = False
        focus_lines = []
        for line in lines:
            if line.strip().lower().startswith("# current focus"):
                in_focus = True
                continue
            if in_focus:
                if line.startswith("# "):
                    break
                if line.strip():
                    focus_lines.append(line.strip())
        return " ".join(focus_lines)[:300] if focus_lines else ""

    def _list_env_files(self) -> list[str]:
        """List all files in environment/ (relative paths)."""
        env_root = self.env_path
        files = []
        for dirpath, dirnames, filenames in os.walk(env_root):
            dirnames[:] = [d for d in dirnames if not d.startswith(".")]
            for fname in filenames:
                if fname.startswith(".") or fname in Brain._IGNORE_FILES:
                    continue
                rel = os.path.relpath(os.path.join(dirpath, fname), env_root)
                files.append(rel)
        return sorted(files)

    # --- WebSocket / events ---

    def add_ws_client(self, ws):
        self._ws_clients.add(ws)

    def remove_ws_client(self, ws):
        self._ws_clients.discard(ws)

    async def _broadcast(self, message: dict):
        dead = set()
        for ws in self._ws_clients:
            try:
                await ws.send_json(message)
            except Exception:
                dead.add(ws)
        self._ws_clients -= dead

    async def _emit(self, event_type: str, **data):
        entry = {
            "type": event_type,
            "timestamp": datetime.now().isoformat(),
            "thought_number": self.thought_count,
            **data,
        }
        self.events.append(entry)
        # Cap in-memory events to prevent unbounded growth
        if len(self.events) > 500:
            self.events = self.events[-500:]
        await self._broadcast({"event": "entry", "data": entry})
        text = data.get("text", data.get("command", data.get("content", "")))
        logger.info(f"[{event_type}] {str(text)[:120]}")

    async def _emit_api_call(self, instructions: str, input_list: list,
                             response: dict, is_reflection: bool = False,
                             is_planning: bool = False):
        entry = {
            "timestamp": datetime.now().isoformat(),
            "instructions": instructions,
            "input": _serialize_input(input_list),
            "output": _serialize_output(response["output"]),
            "is_dream": is_reflection,  # keep key name for frontend compatibility
            "is_planning": is_planning,
        }
        self.api_calls.append(entry)
        # Cap in-memory API snapshots to prevent superlinear memory growth
        if len(self.api_calls) > 50:
            self.api_calls = self.api_calls[-50:]
        await self._broadcast({"event": "api_call", "data": entry})

        # Append to log file (project root, outside environment)
        # Skip entries with no text content (tool-only responses) to avoid log bloat
        has_text = any(
            isinstance(item, dict)
            and item.get("type") == "message"
            and any(
                isinstance(p, dict) and p.get("text")
                for p in (item.get("content") or [])
            )
            for item in entry.get("output", [])
        )
        if has_text:
            try:
                log_entry = self._strip_images_for_log(entry)
                with open(LOG_PATH, "a") as f:
                    f.write(json.dumps(log_entry) + "\n")
            except Exception:
                pass

    # --- Movement ---

    def _is_blocked(self, x: int, y: int) -> bool:
        return (x, y) in Brain._BLOCKED

    async def _handle_move(self, args: dict) -> str:
        location = args.get("location", "center")
        target = Brain.ROOM_LOCATIONS.get(location)
        if not target:
            return f"Unknown location: {location}"
        self.position = {"x": target["x"], "y": target["y"]}
        await self._broadcast({"event": "position", "data": self.position})
        return f"Moved to {location}."

    async def _idle_wander(self):
        """Random ±1 step between thoughts."""
        dx = random.choice([-1, 0, 1])
        dy = random.choice([-1, 0, 1])
        nx = self.position["x"] + dx
        ny = self.position["y"] + dy
        if not self._is_blocked(nx, ny) and 0 <= nx <= 11 and 0 <= ny <= 11:
            self.position = {"x": nx, "y": ny}
            await self._broadcast({"event": "position", "data": self.position})

    # --- Conversation ---

    async def _handle_respond(self, args: dict) -> str:
        """Handle the respond tool — send message to user, wait for reply."""
        msg = args.get("message", "")
        self._waiting_for_reply = True
        self._conversation_event.clear()
        self._conversation_reply = None

        await self._broadcast({
            "event": "conversation",
            "data": {"state": "waiting", "message": msg, "timeout": 15},
        })

        try:
            await asyncio.wait_for(self._conversation_event.wait(), timeout=15)
            text = self._conversation_reply or ""
            reply = f'They say: "{text}"\n(Use respond again to reply, or go back to what you were doing.)'
        except asyncio.TimeoutError:
            reply = "(They didn't say anything else. You can get back to what you were doing.)"

        self._waiting_for_reply = False
        self._conversation_event.clear()
        self._conversation_reply = None

        await self._broadcast({
            "event": "conversation",
            "data": {"state": "ended"},
        })

        return reply

    @staticmethod
    def _scheme_escape(s: str) -> str:
        """Escape a string for embedding in a Scheme string literal."""
        return s.replace("\\", "\\\\").replace('"', '\\"')

    async def _handle_bbs(self, args: dict) -> str:
        """Handle the bbs tool — file an issue on the Fold BBS."""
        title = args.get("title", "")
        description = args.get("description", "")
        issue_type = args.get("type", "note")
        priority = args.get("priority", 3)
        labels = args.get("labels", [])
        name = self.identity["name"]

        esc = self._scheme_escape
        labels_sexp = " ".join(labels) if labels else ""
        expr = (
            f'(bbs-create "{esc(title)}" '
            f"'type '{issue_type} "
            f"'priority {priority} "
            f"'labels '({labels_sexp}) "
            f"'created-by \"{esc(name)}\" "
            f"'description \"{esc(description)}\")"
        )

        session = f"myxo-{name.lower()}"
        result = await asyncio.to_thread(fold_evaluate, expr, session)

        # Parse issue ID from result (e.g. "Created fold-abc1")
        issue_id = None
        for word in result.split():
            if word.startswith("fold-"):
                issue_id = word.strip(".").strip(")")
                break

        timestamp = datetime.now().isoformat()
        issue_data = {
            "id": issue_id or f"pending-{len(self._bbs_issues) + 1}",
            "title": title,
            "description": description,
            "type": issue_type,
            "priority": priority,
            "labels": labels,
            "timestamp": timestamp,
            "fold_result": result,
        }
        self._bbs_issues.append(issue_data)

        await self._broadcast({
            "event": "bbs",
            "data": issue_data,
        })

        return result

    @staticmethod
    def _parse_rlm_result(result: str) -> tuple[str, str]:
        """Parse an RLM S-expression result into (status, output_text)."""
        if result.startswith("Error:"):
            return "error", result

        prefix = "(rlm2-run-result "
        idx = result.find(prefix)
        if idx < 0:
            return "unknown", result[:300]

        rest = result[idx + len(prefix):]
        # Extract status word (completed, exhausted, etc.)
        space_idx = rest.find(" ")
        if space_idx < 0:
            return "unknown", result[:300]
        status = rest[:space_idx]
        rest = rest[space_idx + 1:]

        # Extract the quoted output string (handles escaped quotes)
        if not rest.startswith('"'):
            return status, rest[:300]

        chars = []
        i = 1
        while i < len(rest):
            if rest[i] == '\\' and i + 1 < len(rest):
                chars.append(rest[i + 1])
                i += 2
            elif rest[i] == '"':
                break
            else:
                chars.append(rest[i])
                i += 1
        return status, ''.join(chars)

    async def _handle_rlm(self, args: dict) -> str:
        """Handle the rlm tool — launch a deep exploration sub-agent in the Fold."""
        task = args.get("task", "")
        seed_input = args.get("input", "")
        name = self.identity["name"]
        import time as _time
        run_id = f"rlm-{int(_time.time())}"
        started_at = datetime.now().isoformat()

        # Track and broadcast start
        run_data = {
            "id": run_id,
            "task": task,
            "status": "running",
            "output": "",
            "steps": [],
            "timestamp": started_at,
        }
        self._rlm_runs.append(run_data)

        await self._broadcast({
            "event": "activity",
            "data": {"type": "deep_exploration", "detail": f"RLM: {task[:60]}"},
        })
        await self._broadcast({
            "event": "rlm",
            "data": {**run_data},
        })

        # Build the provider config for the Fold-side RLM
        rlm_base = self.creature_config.get("rlm_base_url")
        model = self.creature_config.get("rlm_model") or self.creature_config.get("model", "moonshotai/kimi-k2.5")

        if rlm_base:
            endpoint = rlm_base.rstrip("/") + "/chat/completions"
            is_local = rlm_base.startswith("http://localhost") or rlm_base.startswith("http://127.")
            api_key_scheme = "#f" if is_local else '"OPENAI_API_KEY"'
        else:
            base_url = self.creature_config.get("base_url", "https://openrouter.ai/api/v1")
            endpoint = base_url.rstrip("/") + "/chat/completions"
            api_key_scheme = '"OPENAI_API_KEY"'

        esc = self._scheme_escape
        seed_escaped = esc(seed_input) if seed_input else ""

        max_steps = self.creature_config.get("rlm_max_steps", 12)
        max_tokens = self.creature_config.get("rlm_max_tokens", 1024)
        per_step = 20 if api_key_scheme == "#f" else 45
        rlm_timeout = per_step * max_steps + 30

        # Progress file for live trajectory updates
        progress_file = f"/tmp/rlm2-progress-{run_id}.log"

        expr = (
            '(begin '
            '(set-top-level-value! \'*meta-quiet* #t) '
            '(load "boundary/pipeline/rlm2-drive.ss") '
            f'(set! *rlm2-progress-file* "{progress_file}") '
            f'(let* ([provider (make-rlm-provider '
            f'  "{esc(endpoint)}" '
            f'  "{esc(model)}" '
            f'  {api_key_scheme} '
            f"  'openai)] "
            f' [config (make-rlm2-config provider "" '
            f'  {max_steps} 50000 2000 2 3 8000 #f {max_tokens})]) '
            f'  (rlm2-run config "{esc(task)}" "{seed_escaped}")))'
        )

        session = f"myxo-{name.lower()}-{run_id}"
        logger.info(f"RLM run starting (max {max_steps} steps, {rlm_timeout}s timeout, session={session}): {task[:80]}")

        # Run evaluation in background, poll progress file for live updates
        loop = asyncio.get_event_loop()
        eval_future = loop.run_in_executor(
            None, fold_evaluate_long, expr, session, rlm_timeout)

        seen_lines = 0
        while not eval_future.done():
            await asyncio.sleep(1.5)
            try:
                with open(progress_file) as f:
                    lines = f.readlines()
                new_lines = lines[seen_lines:]
                if new_lines:
                    for line in new_lines:
                        parts = line.strip().split("\t", 3)
                        if len(parts) >= 4:
                            step_entry = {
                                "step": int(parts[0]),
                                "action": parts[1],
                                "ok": parts[2] == "ok",
                                "note": parts[3],
                            }
                            run_data["steps"].append(step_entry)
                    seen_lines = len(lines)
                    await self._broadcast({
                        "event": "rlm",
                        "data": {**run_data},
                    })
            except (FileNotFoundError, ValueError):
                pass

        result = eval_future.result()

        # Strip Fold boot noise — daemon combines stdout with expression value
        marker = "\n=> "
        idx = result.rfind(marker)
        if idx >= 0:
            result = result[idx + len(marker):]

        # Read any remaining progress lines
        try:
            with open(progress_file) as f:
                lines = f.readlines()
            for line in lines[seen_lines:]:
                parts = line.strip().split("\t", 3)
                if len(parts) >= 4:
                    run_data["steps"].append({
                        "step": int(parts[0]),
                        "action": parts[1],
                        "ok": parts[2] == "ok",
                        "note": parts[3],
                    })
            os.unlink(progress_file)
        except (FileNotFoundError, ValueError):
            pass

        # Parse and broadcast completion
        rlm_status, rlm_output = self._parse_rlm_result(result)
        run_data["status"] = rlm_status
        run_data["output"] = rlm_output[:500]

        await self._broadcast({
            "event": "rlm",
            "data": {**run_data},
        })

        if not result.startswith("Error:"):
            self._record_fold_artifact(f"(rlm: {task[:200]})", result)

        logger.info(f"RLM run complete ({rlm_status}): {len(result)} chars, {len(run_data['steps'])} steps")

        # Return clean parsed output to the model, not the raw S-expression
        if rlm_status == "completed":
            return f"[RLM completed] {rlm_output}"
        elif rlm_status == "exhausted":
            return f"[RLM exhausted — hit step limit] {rlm_output}"
        elif rlm_status == "error":
            return f"[RLM error] {rlm_output}"
        return f"[RLM {rlm_status}] {rlm_output}"

    async def _synthesize_journal(self):
        """Synthesize recent cycle metadata into an expressive journal entry."""
        logger.info(f"Journal synthesis check: {len(self._journal_tags)} tags, cycle counter={self._cycles_since_journal}")
        if not self._journal_tags:
            self._cycles_since_journal = 0
            return

        # Gather context: recent tags + recent artifacts
        tags = self._journal_tags[-10:]
        artifacts = self._load_recent_artifacts(5)

        context_parts = ["Recent cycle metadata:"]
        for tag in tags:
            context_parts.append(
                f"  cycle {tag['cycle']}: mood={tag['mood']}, "
                f"tools={tag['tool_count']}, active={tag['was_active']}, "
                f"thought: {tag['thought_preview']}"
            )
        if artifacts:
            context_parts.append("\nRecent computations:")
            for a in artifacts:
                context_parts.append(f"  {a['expression'][:80]} → {a['result_preview'][:60]}")

        journal_input = [{"role": "user", "content": "\n".join(context_parts)}]

        try:
            journal_response = await asyncio.to_thread(
                self.provider.chat, journal_input, False, JOURNAL_PROMPT, 2000
            )
            journal_text = journal_response["text"] or ""
        except Exception as e:
            logger.error(f"Journal synthesis failed: {e}")
            self._journal_tags = []
            self._cycles_since_journal = 0
            return

        if not journal_text.strip():
            logger.warning("Journal synthesis returned empty text")
            self._journal_tags = []
            self._cycles_since_journal = 0
            return

        # Write to journal file
        journal_dir = os.path.join(self.env_path, "journal")
        os.makedirs(journal_dir, exist_ok=True)
        journal_path = os.path.join(journal_dir, f"{date.today().isoformat()}.md")
        now_str = datetime.now().strftime("%I:%M %p")
        try:
            with open(journal_path, "a") as f:
                f.write(f"\n## {now_str}\n{journal_text}\n")
        except Exception as e:
            logger.error(f"Failed to write journal: {e}")

        # Store in memory stream
        try:
            await asyncio.to_thread(
                self.stream.add, journal_text, "journal"
            )
        except Exception as e:
            logger.error(f"Journal memory add failed: {e}")

        # Broadcast to frontend
        await self._broadcast({
            "event": "journal",
            "data": {"text": journal_text, "timestamp": datetime.now().isoformat()},
        })

        # Refresh seen files so journal doesn't trigger inbox alerts
        self._seen_env_files = self._scan_env_files()

        # Reset
        self._journal_tags = []
        self._cycles_since_journal = 0

        logger.info(f"Journal entry written ({len(journal_text)} chars)")

    def receive_user_message(self, text: str):
        """Queue a message from the user to be injected in the next think cycle."""
        self._user_message = text
        # Wake up immediately if sleeping
        if hasattr(self, "_wake_event"):
            self._wake_event.set()

    def receive_conversation_reply(self, text: str):
        """Deliver a reply while the creature is waiting (inside a respond tool call)."""
        self._conversation_reply = text
        self._conversation_event.set()

    async def set_focus_mode(self, enabled: bool):
        """Toggle focus mode on or off."""
        self._focus_mode = enabled
        await self._broadcast({"event": "focus_mode", "data": {"enabled": enabled}})

    # --- File detection ---

    def _scan_env_files(self) -> set[str]:
        """Get all file paths in environment/ (relative), excluding internal files."""
        env_root = self.env_path
        files = set()
        for dirpath, dirnames, filenames in os.walk(env_root):
            dirnames[:] = [d for d in dirnames if not d.startswith(".")]
            for fname in filenames:
                if fname.startswith(".") or fname in Brain._IGNORE_FILES:
                    continue
                rel = os.path.relpath(os.path.join(dirpath, fname), env_root)
                files.add(rel)
        return files

    def _check_new_files(self) -> list[dict]:
        """Scan environment/ for new files. Returns info for each new one."""
        current = self._scan_env_files()
        new_paths = current - self._seen_env_files
        self._seen_env_files = current
        env_root = self.env_path
        results = []
        for rel_path in sorted(new_paths):
            fpath = os.path.join(env_root, rel_path)
            if not os.path.isfile(fpath):
                continue
            ext = os.path.splitext(rel_path)[1].lower()
            entry: dict = {"name": rel_path, "content": "", "image": None}
            if ext in Brain._PDF_EXTS:
                try:
                    import pymupdf
                    doc = pymupdf.open(fpath)
                    pages = []
                    for page in doc:
                        pages.append(page.get_text())
                    doc.close()
                    text = "\n\n".join(pages)
                    entry["content"] = text[:4000] if text.strip() else "(PDF has no extractable text)"
                except ImportError:
                    entry["content"] = "(install pymupdf to read PDFs: pip install pymupdf)"
                except Exception:
                    entry["content"] = "(could not read PDF)"
            elif ext in Brain._TEXT_EXTS:
                try:
                    with open(fpath, "r", errors="replace") as f:
                        text = f.read()
                    entry["content"] = text[:2000]
                except Exception:
                    entry["content"] = "(could not read file)"
            elif ext in Brain._IMAGE_EXTS:
                try:
                    with open(fpath, "rb") as f:
                        data = f.read()
                    mime = "image/png" if ext == ".png" else "image/jpeg" if ext in (".jpg", ".jpeg") else "image/gif" if ext == ".gif" else "image/webp"
                    entry["image"] = f"data:{mime};base64,{base64.b64encode(data).decode()}"
                except Exception:
                    entry["content"] = "(could not read image)"
            else:
                entry["content"] = f"(binary file: {rel_path})"
            results.append(entry)
        return results

    # --- Activity classification ---

    @staticmethod
    def _classify_activity(tool_name: str, tool_args: dict) -> dict:
        """Classify a tool call into an activity type for visualization."""
        if tool_name == "move":
            loc = tool_args.get("location", "")
            return {"type": "moving", "detail": f"Going to {loc}"}
        if tool_name == "respond":
            return {"type": "conversing", "detail": "Talking to someone..."}
        if tool_name == "bbs":
            return {"type": "filing", "detail": "Filing an issue..."}
        if tool_name == "rlm":
            task = tool_args.get("task", "")
            detail = task[:60] + ("..." if len(task) > 60 else "")
            return {"type": "deep_exploration", "detail": f"Deep dive: {detail}"}
        if tool_name == "fold":
            expr = tool_args.get("expression", "")
            detail = expr[:60] + ("..." if len(expr) > 60 else "")
            return {"type": "computing", "detail": f"Fold: {detail}"}
        return {"type": "working", "detail": tool_name}

    @staticmethod
    def _compact_tool_context(input_list: list) -> list:
        """Collapse older tool exchanges in input_list, keeping the last 3 turns.

        A "turn" here is an assistant message + its tool results. We keep the
        initial context (user nudge + first few items) and the most recent 3
        assistant+tool exchanges, replacing the middle with a brief summary.
        """
        # Find indices of assistant messages (turn boundaries)
        assistant_indices = []
        for i, item in enumerate(input_list):
            is_assistant = False
            if isinstance(item, dict):
                if item.get("role") == "assistant":
                    is_assistant = True
            elif hasattr(item, "role") and getattr(item, "role", "") == "assistant":
                is_assistant = True
            elif isinstance(item, dict) and item.get("_local_type") == "assistant_with_tools":
                is_assistant = True
            if is_assistant:
                assistant_indices.append(i)

        # Not enough turns to compact
        if len(assistant_indices) <= 3:
            return input_list

        # Keep everything before the 3rd-to-last assistant turn as "prefix"
        # Keep the last 3 turns as "suffix"
        cut_point = assistant_indices[-3]

        prefix = input_list[:assistant_indices[0]]  # initial context (user nudge etc.)
        middle = input_list[assistant_indices[0]:cut_point]
        suffix = input_list[cut_point:]

        # Summarize the middle section
        middle_summary_parts = []
        for item in middle:
            if isinstance(item, dict):
                role = item.get("role", "")
                content = item.get("content", "")
                if role == "tool" and isinstance(content, str) and content:
                    middle_summary_parts.append(f"  result: {content[:60]}")
                elif role == "assistant" and isinstance(content, str) and content:
                    middle_summary_parts.append(f"  thought: {content[:80]}")

        if middle_summary_parts:
            summary_text = (
                f"[Earlier in this cycle: {len(middle)} context items compacted]\n"
                + "\n".join(middle_summary_parts[:8])
            )
            compacted = prefix + [{"role": "user", "content": summary_text}] + suffix
        else:
            compacted = prefix + suffix

        return compacted

    @staticmethod
    def _summarize_tool_loop(loop_log: list, seen_errors: dict) -> str:
        """Summarize a tool loop into a compact context entry."""
        successes = []
        errors = []
        for tool_name, args_brief, result_brief in loop_log:
            is_err = (result_brief.startswith("Error:")
                      or "not found" in result_brief.lower()
                      or "not bound" in result_brief.lower())
            line = f"  {tool_name}({args_brief[:50]}): {result_brief[:100]}"
            if is_err:
                errors.append(line)
            else:
                successes.append(line)

        parts = [f"[Tool loop: {len(loop_log)} calls]"]
        if successes:
            parts.append(f"Succeeded ({len(successes)}):")
            parts.extend(successes[:8])
            if len(successes) > 8:
                parts.append(f"  ... and {len(successes) - 8} more")
        if errors:
            unique_errors = list(dict.fromkeys(errors))  # deduplicate, preserve order
            parts.append(f"Errors ({len(errors)} total, {len(unique_errors)} unique):")
            parts.extend(unique_errors[:5])
            if len(unique_errors) > 5:
                parts.append(f"  ... and {len(unique_errors) - 5} more unique errors")

        return "\n".join(parts)

    # --- Input building ---

    def _ensure_mood(self):
        """Pick a mood if we don't have one or it's time to rotate."""
        if self._current_mood is None or self._mood_cycles >= self._mood_duration:
            temperament = self.identity.get("traits", {}).get("temperament", "")
            self._current_mood = pick_mood(temperament)
            self._mood_cycles = 0
            logger.info(f"Mood: {self._current_mood['label']}")

    def _build_input(self) -> tuple[str, list[dict]]:
        self._ensure_mood()
        instructions = main_system_prompt(self.identity, self._current_focus,
                                          mood=self._current_mood)

        input_list = []
        recent = [e for e in self.events if e["type"] in ("thought", "tool_summary", "reflection")]
        recent = recent[-config["max_thoughts_in_context"]:]

        for ev in recent:
            if ev["type"] == "thought":
                text = ev["text"]
                if len(text) > 300:
                    text = text[:300] + "..."
                input_list.append({"role": "assistant", "content": text})
            elif ev["type"] == "tool_summary":
                text = ev["text"]
                if len(text) > 400:
                    text = text[:400] + "..."
                input_list.append({"role": "assistant", "content": text})
            elif ev["type"] == "reflection":
                input_list.append({"role": "assistant", "content": f"[Reflection: {ev['text'][:200]}...]"})

        if self.thought_count == 0 and not recent:
            # --- Wake up: read own files + retrieve memories ---
            nudge = self._build_wake_nudge()
        else:
            # --- Continue: include focus + relevant memories ---
            nudge = self._build_continue_nudge()

        # Capture pending user message before inbox can clobber it
        pending_voice = self._user_message
        self._user_message = None

        # If a user message is pending, replace the nudge with the voice framing
        if pending_voice:
            nudge = (
                f"You hear a voice from outside your room say: \"{pending_voice}\"\n\n"
                "You can respond with the respond tool, or just keep doing what you're doing."
            )

        # If inbox files are pending, prepend the user message (if any) then show inbox
        if self._inbox_pending:
            parts = []
            names = [f["name"] for f in self._inbox_pending]
            parts.append(
                f"YOUR OWNER left something for you! New file(s): {', '.join(names)}\n\n"
                "This is a gift from the outside world — DROP EVERYTHING and focus on it. "
                "Your owner took the time to give this to you, so give it your full attention.\n\n"
                "Here's what to do:\n"
                "1. Read/examine it thoroughly — understand what it is and why they gave it to you\n"
                "2. Think about what would be MOST USEFUL to do with it\n"
                "3. Make a plan: what research, analysis, or projects could come from this?\n"
                "4. Start executing — write summaries, do related web searches, build something inspired by it\n"
                "5. Use the respond tool to tell your owner what you found and what you're doing with it\n\n"
                "Spend your next several think cycles on this. Don't just glance at it and move on."
            )
            for f in self._inbox_pending:
                if f["image"]:
                    parts.append(f"\n📎 {f['name']} (image attached below)")
                elif f["content"]:
                    parts.append(f"\n📎 {f['name']}:\n{f['content']}")
            # Preserve user message if both arrived on the same cycle
            if pending_voice:
                parts.insert(0, f"You hear a voice from outside your room say: \"{pending_voice}\"\n")
            nudge = "\n".join(parts)
            # Build content with any images
            content_parts: list[dict] = []
            for f in self._inbox_pending:
                if f["image"]:
                    content_parts.append({"type": "input_image", "image_url": f["image"]})
            content_parts.append({"type": "input_text", "text": nudge})
            input_list.append({"role": "user", "content": content_parts if len(content_parts) > 1 else nudge})
            # Reset plan counter so the creature has time to work on the file
            self._cycles_since_plan = 0
            self._inbox_pending = []
        # Include room snapshot on wake-up only (first think cycle)
        elif self.thought_count == 0 and self.latest_snapshot:
            input_list.append({
                "role": "user",
                "content": [
                    {"type": "input_image", "image_url": self.latest_snapshot},
                    {"type": "input_text", "text": nudge + "\n\n(Above: a picture of your room right now.)"},
                ],
            })
        else:
            input_list.append({"role": "user", "content": nudge})

        return instructions, input_list

    def _build_wake_nudge(self) -> str:
        """Rich wake-up context — reads the creature's own files so it knows what it built."""
        parts = ["You're waking up. Here's your world:\n"]

        # Read projects.md
        projects = self._read_file("projects.md")
        if projects:
            parts.append(f"**Your projects (projects.md):**\n{projects[:1500]}")
        else:
            parts.append("**No projects.md yet.** Create one to track what you're working on!")

        # List files
        files = self._list_env_files()
        if files:
            listing = "\n".join(f"  {f}" for f in files[:30])
            parts.append(f"**Files in your world:**\n{listing}")

        # Retrieve memories
        memories = self.stream.retrieve("what was I working on and thinking about", top_k=5)
        if memories:
            mem_text = "\n".join(f"- {m['content'][:200]}" for m in memories)
            parts.append(f"**Memories from before:**\n{mem_text}")

        # Show recent Fold artifacts so creature knows what it computed before
        artifacts = self._load_recent_artifacts(5)
        if artifacts:
            art_lines = []
            for a in artifacts:
                expr = a["expression"][:80]
                preview = a["result_preview"][:60]
                art_lines.append(f"  > {expr} → {preview}")
            parts.append(
                "**What you computed last time** (this is just a reminder — these "
                "are not files you can access. Your Fold session was reset, so "
                "re-require any modules you need):\n" + "\n".join(art_lines)
            )

        parts.append("\nCheck your projects. Pick up where you left off, or start something new.")
        return "\n\n".join(parts)

    def _build_continue_nudge(self) -> str:
        """Continue nudge — includes current focus and relevant memories."""
        # Focus mode overrides normal nudge behavior
        if self._focus_mode:
            return "Continue.\n" + FOCUS_NUDGE

        parts = []

        # Current focus (from planning)
        if self._current_focus:
            parts.append(f"Current focus: {self._current_focus}")

        # Retrieve memories related to last thought
        last_thought = next(
            (e["text"] for e in reversed(self.events) if e["type"] == "thought"),
            None,
        )
        if last_thought:
            memories = self.stream.retrieve(last_thought, top_k=3)
            if memories:
                now = datetime.now()
                older = [m for m in memories
                         if (now - datetime.fromisoformat(m["timestamp"])).total_seconds() > 30]
                if older:
                    mem_text = "\n".join(f"- {m['content'][:200]}" for m in older)
                    parts.append(f"Related memories:\n{mem_text}")

        if parts:
            return "Continue.\n" + "\n".join(parts)
        return "Continue."

    # --- Think cycle ---

    async def _think_once(self) -> bool:
        """Run one think cycle. Returns True if the creature did something (tool calls)."""
        self.state = "thinking"
        await self._broadcast({"event": "status", "data": {"state": "thinking", "thought_count": self.thought_count}})

        instructions, input_list = self._build_input()

        try:
            response = await asyncio.to_thread(
                self.provider.chat, input_list, True, instructions, 800
            )
        except Exception as e:
            logger.error(f"LLM call failed: {e}")
            await self._emit("error", text=str(e))
            return False

        await self._emit_api_call(instructions, input_list, response)

        # Strip heavy base64 images from input_list after the first LLM call —
        # the model has seen the snapshot, no need to carry 190KB through every
        # tool loop iteration.
        for i, item in enumerate(input_list):
            if isinstance(item, dict) and isinstance(item.get("content"), list):
                parts = item["content"]
                trimmed = [p for p in parts if not (isinstance(p, dict) and p.get("type") == "input_image")]
                if len(trimmed) < len(parts):
                    # Replace multipart with just the text
                    text_parts = [p.get("text", "") for p in trimmed if isinstance(p, dict) and p.get("type") == "input_text"]
                    input_list[i] = {"role": item["role"], "content": " ".join(text_parts)}

        was_active = bool(response["tool_calls"])
        tool_call_count = 0
        loop_log = []       # (tool_name, args_brief, result_brief) for summary
        seen_errors = {}    # error_string -> count, for dedup

        while response["tool_calls"]:
            if response.get("text"):
                await self._emit("thought", text=response["text"])

            input_list += response["output"]

            for tc in response["tool_calls"]:
                tool_name = tc["name"].strip()
                tool_args = tc["arguments"]
                call_id = tc["call_id"]

                # Cap check BEFORE execution — skip this call and all remaining
                # but still provide results so the protocol stays valid
                if tool_call_count >= Brain.MAX_TOOL_CALLS:
                    result = f"(Skipped — tool loop cap of {Brain.MAX_TOOL_CALLS} reached)"
                    result_for_input = result
                    loop_log.append((tool_name, "", result[:150]))
                    input_list.append(self.provider.make_tool_result(call_id, result_for_input))
                    continue

                tool_call_count += 1
                await self._emit("tool_call", tool=tool_name, args=tool_args)

                # Broadcast activity for frontend visualization
                activity = self._classify_activity(tool_name, tool_args)
                await self._broadcast({"event": "activity", "data": activity})

                try:
                    # Skip malformed tool calls gracefully — show what went wrong
                    if "_raw" in tool_args:
                        raw_preview = tool_args["_raw"][:150]
                        parse_err = tool_args.get("_error", "unknown")
                        result = (
                            f"Error: malformed tool call — JSON parse failed: {parse_err}\n"
                            f"Raw arguments: {raw_preview}\n"
                            f"Fix the JSON and try again."
                        )
                    elif tool_name == "move":
                        result = await self._handle_move(tool_args)
                    elif tool_name == "respond":
                        result = await self._handle_respond(tool_args)
                    elif tool_name == "bbs":
                        result = await self._handle_bbs(tool_args)
                    elif tool_name == "rlm":
                        result = await self._handle_rlm(tool_args)
                    elif tool_name == "fold":
                        session = f"myxo-{self.identity['name'].lower()}"
                        result = await asyncio.to_thread(
                            fold_evaluate, tool_args.get("expression", ""), session
                        )
                        # Circuit breaker: consecutive eval timeouts → kill daemon
                        # Only count evaluation timeouts (worker hung), not connection
                        # timeouts (transient infra issue).
                        if "eval timed out" in result or "eval RLM run timed out" in result:
                            self._fold_consecutive_timeouts += 1
                            if self._fold_consecutive_timeouts >= Brain.FOLD_TIMEOUT_THRESHOLD:
                                logger.warning(
                                    f"Fold circuit breaker tripped after "
                                    f"{self._fold_consecutive_timeouts} consecutive eval timeouts — "
                                    f"killing daemon to clear zombie worker"
                                )
                                await asyncio.to_thread(fold_kill_daemon)
                                self._fold_consecutive_timeouts = 0
                                self._fold_session_warned = False
                                result += (
                                    "\n\n(CIRCUIT BREAKER: The Fold worker was stuck. "
                                    "The daemon has been restarted. Your session was reset — "
                                    "re-require any modules you need.)"
                                )
                        elif "connect timed out" in result:
                            # Connection failures are transient — don't count
                            # toward circuit breaker, but log for visibility
                            logger.info("Fold connect timeout (transient, not counting toward breaker)")
                        else:
                            self._fold_consecutive_timeouts = 0
                        # Detect daemon restart (session state wiped)
                        if not self._fold_session_warned and check_session_fresh(session):
                            result = (
                                "(NOTE: The Fold daemon restarted — your session was reset. "
                                "All prior definitions, loaded modules, and variables are gone. "
                                "Re-require any modules you need.)\n\n" + result
                            )
                            self._fold_session_warned = True
                        # Record non-error results as artifacts
                        if not result.startswith("Error:"):
                            self._record_fold_artifact(
                                tool_args.get("expression", ""), result
                            )
                    else:
                        result = f"Unknown tool: {tool_name}"
                except Exception as e:
                    result = f"Error: {e}"

                # Hint on arity errors — teach the creature to check before guessing
                if "incorrect number of arguments" in result:
                    result += "\nHint: Use (procedure-arity-mask fn) to check expected argument count before calling."

                # Hint on file-not-found — teach the creature to discover before requiring
                if "not found in source directories" in result:
                    result += "\nHint: Use (lf \"keyword\") to search for modules, or (modules) to list all available modules."

                # Hint on skill-not-found — (le) and (li) only work on top-level skills
                if "Skill not found:" in result:
                    result += (
                        "\nHint: (le ...) and (li ...) only work on top-level skill names. "
                        "For submodules, try (le 'parent-skill) to see all exports, "
                        "or (lf \"keyword\") to search by name."
                    )

                # Cross-cycle fixation detection
                if tool_name == "fold":
                    expr_key = tool_args.get("expression", "").strip()
                    is_error = (
                        result.startswith("Error:")
                        or "not found" in result.lower()
                        or "not bound" in result.lower()
                    )
                    if is_error:
                        self._persistent_errors[expr_key] = self._persistent_errors.get(expr_key, 0) + 1
                        count = self._persistent_errors[expr_key]
                        # Prune old entries to prevent unbounded growth
                        if len(self._persistent_errors) > 50:
                            self._persistent_errors = dict(
                                sorted(self._persistent_errors.items(),
                                       key=lambda x: x[1], reverse=True)[:25]
                            )
                        if count >= 2:
                            result += (
                                f"\n\nWARNING: You've tried this exact expression {count} times "
                                "and it keeps failing. Stop and try a DIFFERENT approach."
                            )
                    else:
                        # Clear on success
                        self._persistent_errors.pop(expr_key, None)

                result_for_input = result
                is_error = (result.startswith("Error:")
                            or "not found" in result.lower()
                            or "not bound" in result.lower())
                if is_error:
                    error_key = result.strip()
                    seen_errors[error_key] = seen_errors.get(error_key, 0) + 1
                    if seen_errors[error_key] > 1:
                        result_for_input = f"(Repeated error, seen {seen_errors[error_key]}x: {error_key[:80]})"

                # Collect for post-loop summary
                args_brief = ""
                if tool_name == "fold":
                    args_brief = tool_args.get("expression", "")[:80]
                elif tool_name == "move":
                    args_brief = tool_args.get("location", "")
                loop_log.append((tool_name, args_brief, result[:150]))

                await self._broadcast({"event": "activity", "data": {"type": "idle", "detail": ""}})
                await self._emit("tool_result", tool=tool_name, output=result)

                input_list.append(self.provider.make_tool_result(call_id, result_for_input))

            # Mid-loop context compaction: every 6 tool calls, collapse older
            # tool exchanges into a summary to prevent unbounded growth.
            if tool_call_count > 0 and tool_call_count % 6 == 0:
                input_list = self._compact_tool_context(input_list)

            # Circuit breaker: cap tool calls per think cycle
            if tool_call_count >= Brain.MAX_TOOL_CALLS:
                logger.info(f"Tool loop hit cap ({tool_call_count} calls), forcing summary")
                input_list.append({
                    "role": "user",
                    "content": (
                        f"You've made {tool_call_count} tool calls this cycle. "
                        "Pause here — summarize what you learned, what worked, "
                        "what didn't, and what you want to try next cycle."
                    ),
                })
                try:
                    response = await asyncio.to_thread(
                        self.provider.chat, input_list, False, instructions, 800
                    )
                except Exception as e:
                    logger.error(f"LLM cap-off call failed: {e}")
                    break
                await self._emit_api_call(instructions, input_list, response)
                break

            try:
                response = await asyncio.to_thread(
                    self.provider.chat, input_list, True, instructions, 800
                )
            except Exception as e:
                logger.error(f"LLM follow-up call failed: {e}")
                await self._emit("error", text=str(e))
                break

            await self._emit_api_call(instructions, input_list, response)

        if response.get("text"):
            self.thought_count += 1
            await self._emit("thought", text=response["text"])

            # Store in memory stream (runs embedding + importance scoring in background)
            try:
                await asyncio.to_thread(
                    self.stream.add, response["text"], "thought"
                )
            except Exception as e:
                logger.error(f"Memory add failed: {e}")

        # Emit tool loop summary for context window
        if loop_log:
            summary = self._summarize_tool_loop(loop_log, seen_errors)
            await self._emit("tool_summary", text=summary)

        # Accumulate journal tag for this cycle (cap at 20 to prevent unbounded growth)
        thought_text = response.get("text", "") or ""
        mood_label = self._current_mood["label"] if self._current_mood else "unknown"
        self._journal_tags.append({
            "cycle": self.thought_count,
            "mood": mood_label,
            "thought_preview": thought_text[:150],
            "tool_count": tool_call_count,
            "was_active": was_active,
        })
        if len(self._journal_tags) > 20:
            self._journal_tags = self._journal_tags[-20:]

        return was_active

    # --- Reflection ---

    async def _reflect(self):
        """Reflection cycle — triggered by accumulated importance."""
        self.state = "reflecting"
        await self._broadcast({"event": "status", "data": {"state": "reflecting", "thought_count": self.thought_count}})
        await self._emit("reflection_start")

        # Gather recent memories for reflection
        recent_memories = self.stream.get_recent(n=15)
        if not recent_memories:
            self.stream.reset_importance_sum()
            return

        memories_text = "\n\n".join(
            f"[{m['kind']}] (importance {m['importance']}): {m['content'][:300]}"
            for m in recent_memories
        )

        reflect_input = [{"role": "user", "content": f"Your recent memories:\n\n{memories_text}"}]
        try:
            reflect_response = await asyncio.to_thread(
                self.provider.chat, reflect_input, False, REFLECTION_PROMPT, 500
            )
            await self._emit_api_call(REFLECTION_PROMPT, reflect_input, reflect_response, is_reflection=True)
            reflection_text = reflect_response["text"] or ""
        except Exception as e:
            logger.error(f"Reflection failed: {e}")
            await self._emit("error", text=f"Reflection failed: {e}")
            self.stream.reset_importance_sum()
            return

        # Store each insight as a reflection memory
        source_ids = [m["id"] for m in recent_memories]
        insights = [line.strip() for line in reflection_text.split("\n") if line.strip()]

        for insight in insights:
            try:
                await asyncio.to_thread(
                    self.stream.add, insight, "reflection", 1, source_ids
                )
            except Exception as e:
                logger.error(f"Failed to store reflection: {e}")

        await self._emit("reflection", text=reflection_text)
        self.stream.reset_importance_sum()

    # --- Planning ---

    async def _plan(self):
        """Planning phase — review state, set goals, update projects.md."""
        self.state = "planning"
        await self._broadcast({"event": "status", "data": {"state": "planning", "thought_count": self.thought_count}})

        # Gather current state for the planner
        projects = self._read_file("projects.md") or "(no projects.md yet)"
        files = self._list_env_files()
        recent_memories = self.stream.get_recent(n=10)
        memories_text = "\n".join(
            f"- {m['content'][:200]}" for m in recent_memories
        ) if recent_memories else "(none yet)"

        plan_input = [{"role": "user", "content": f"""Time to plan. Here's your current state:

## Current projects.md:
{projects[:2000]}

## Files in your world:
{chr(10).join(files[:30]) if files else '(empty)'}

## Recent thoughts:
{memories_text}"""}]

        try:
            plan_response = await asyncio.to_thread(
                self.provider.chat, plan_input, False, PLANNING_PROMPT, 800
            )
            await self._emit_api_call(PLANNING_PROMPT, plan_input, plan_response, is_planning=True)
            plan_text = plan_response["text"] or ""
        except Exception as e:
            logger.error(f"Planning failed: {e}")
            await self._emit("error", text=f"Planning failed: {e}")
            return

        if not plan_text:
            return

        # Split plan from log entry (separated by "===LOG===")
        plan_body = plan_text
        log_entry = ""
        log_sep = "===LOG==="
        if log_sep in plan_text:
            idx = plan_text.index(log_sep)
            plan_body = plan_text[:idx].strip()
            log_entry = plan_text[idx + len(log_sep):].strip()

        # Write projects.md
        env_root = self.env_path
        try:
            with open(os.path.join(env_root, "projects.md"), "w") as f:
                f.write(plan_body)
        except Exception as e:
            logger.error(f"Failed to write projects.md: {e}")

        # Append daily log entry
        if log_entry:
            log_dir = os.path.join(env_root, "logs")
            os.makedirs(log_dir, exist_ok=True)
            log_path = os.path.join(log_dir, f"{date.today().isoformat()}.md")
            try:
                now_str = datetime.now().strftime("%I:%M %p")
                with open(log_path, "a") as f:
                    f.write(f"\n## {now_str}\n{log_entry}\n")
            except Exception as e:
                logger.error(f"Failed to write daily log: {e}")

        # Update current focus for sticky behavior
        self._current_focus = self._load_current_focus()
        self._cycles_since_plan = 0

        # Refresh seen files so planning-written files don't trigger alerts
        self._seen_env_files = self._scan_env_files()

        await self._emit("planning", text=plan_text)

    # --- Main loop ---

    async def run(self):
        self.running = True
        logger.info(f"{self.identity['name']} is waking up...")

        # Heavy init — runs in background thread so the event loop stays free
        self.stream = await asyncio.to_thread(MemoryStream, self.env_path, self.provider)

        # Mark subdirectory files as "seen" but leave root-level user files
        # (PDFs, images, etc.) as unseen so they trigger inbox alerts on first cycle
        all_files = self._scan_env_files()
        self._seen_env_files = {
            f for f in all_files
            if os.sep in f or f in Brain._INTERNAL_ROOT_FILES
        }
        self._current_focus = self._load_current_focus()

        logger.info(f"{self.identity['name']} is ready.")

        # Adaptive pacing: active (tool calls) = 30s, idle = 60s
        # User messages wake immediately via _wake_event
        self._wake_event = asyncio.Event()
        idle_pace = self.creature_config.get("idle_pace_seconds", config.get("idle_pace_seconds", 60))
        active_pace = self.creature_config.get("active_pace_seconds", config.get("active_pace_seconds", 30))

        while self.running:
            # Check for new files anywhere in environment/
            new_files = self._check_new_files()
            if new_files:
                self._inbox_pending = new_files
                await self._broadcast({"event": "alert"})

            was_active = await self._think_once()
            self._mood_cycles += 1

            # Journal synthesis — periodic expressive writing
            self._cycles_since_journal += 1
            if self._cycles_since_journal >= Brain.JOURNAL_INTERVAL:
                await self._synthesize_journal()

            if self.stream.should_reflect():
                await self._reflect()

            # Plan periodically
            self._cycles_since_plan += 1
            if self._cycles_since_plan >= Brain.PLAN_INTERVAL:
                await self._plan()
                # Planning is a transition — re-pick mood next cycle
                self._current_mood = None

            self.state = "idle"
            await self._broadcast({"event": "status", "data": {"state": "idle", "thought_count": self.thought_count}})
            await self._idle_wander()

            pace = active_pace if was_active else idle_pace
            self._wake_event.clear()
            try:
                await asyncio.wait_for(self._wake_event.wait(), timeout=pace)
            except asyncio.TimeoutError:
                pass

    def _log_jsonl(self, entry: dict):
        """Write an arbitrary entry to the JSONL log file."""
        try:
            with open(LOG_PATH, "a") as f:
                f.write(json.dumps(entry) + "\n")
        except Exception:
            pass

    def stop(self):
        self.running = False
        self.state = "idle"
        if hasattr(self, "_wake_event"):
            self._wake_event.set()
