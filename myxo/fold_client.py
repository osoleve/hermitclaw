"""Thin client for The Fold daemon — talks via Unix domain socket."""

import os
import re
import socket
import struct
import uuid
import subprocess
import logging

logger = logging.getLogger("myxo.fold")

# The Fold's REPL directory (where the daemon writes its ready file)
FOLD_ROOT = os.path.expanduser("~/fold")
REPL_DIR = os.path.join(FOLD_ROOT, ".fold-repl")


def _get_socket_path() -> str | None:
    """Find the daemon's socket path from its ready file."""
    ready = os.path.join(REPL_DIR, "ready")
    if not os.path.exists(ready):
        return None
    try:
        with open(ready) as f:
            content = f.read().strip()
        if content.startswith("socket:"):
            path = content[len("socket:"):]
            # Socket path may be relative to FOLD_ROOT
            if not os.path.isabs(path):
                path = os.path.join(FOLD_ROOT, path)
            if os.path.exists(path):
                return path
    except IOError:
        pass
    return None


def _ensure_daemon() -> str | None:
    """Start the daemon if not running. Returns socket path or None."""
    sock_path = _get_socket_path()
    if sock_path:
        return sock_path

    logger.info("Fold daemon not running, starting...")
    daemon_script = os.path.join(FOLD_ROOT, "daemon.sh")
    if not os.path.exists(daemon_script):
        logger.error(f"Daemon script not found: {daemon_script}")
        return None

    try:
        subprocess.Popen(
            ["bash", daemon_script, "start"],
            cwd=FOLD_ROOT,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        # Wait for daemon to be ready (up to 10s)
        import time
        for _ in range(20):
            time.sleep(0.5)
            sock_path = _get_socket_path()
            if sock_path:
                logger.info("Fold daemon started.")
                return sock_path
        logger.error("Fold daemon failed to start in time.")
    except Exception as e:
        logger.error(f"Failed to start daemon: {e}")

    return None


def _recv_exact(s: socket.socket, n: int) -> bytes:
    """Receive exactly n bytes."""
    buf = b""
    while len(buf) < n:
        chunk = s.recv(n - len(buf))
        if not chunk:
            raise ConnectionError("Socket closed during read")
        buf += chunk
    return buf


def _parse_response(resp_str: str) -> dict:
    """Parse s-expression response into a result dict."""
    type_match = re.search(r'\(type\s+\.\s+(\w+)\)', resp_str)
    msg_type = type_match.group(1) if type_match else "unknown"

    if msg_type == "result":
        value_match = re.search(r'\(value\s+\.\s+"((?:[^"\\]|\\.)*)"\)', resp_str)
        value = value_match.group(1).replace('\\"', '"').replace('\\\\', '\\') if value_match else ""
        return {"status": "success", "result": value}
    elif msg_type == "error":
        err_match = re.search(r'\(message\s+\.\s+"((?:[^"\\]|\\.)*)"\)', resp_str)
        error_msg = err_match.group(1).replace('\\"', '"').replace('\\\\', '\\') if err_match else "unknown error"
        return {"status": "error", "error": error_msg}
    else:
        return {"status": "error", "error": f"Unexpected response: {resp_str[:200]}"}


MAX_RESULT_LENGTH = 2000  # Truncate results longer than this to avoid context blowup
MAX_RESULT_LENGTH_LONG = 8000  # For long-running evaluations (RLM runs)

# Track daemon generation per-session to detect restarts
_daemon_generation: dict[str, float] = {}  # session_id -> daemon pid file mtime


def _daemon_pid_mtime() -> float:
    """Get mtime of daemon PID file — changes on daemon restart."""
    pid_file = os.path.join(REPL_DIR, "daemon.pid")
    try:
        return os.path.getmtime(pid_file)
    except OSError:
        return 0.0


def check_session_fresh(session_id: str) -> bool:
    """Returns True if the daemon has restarted since we last used this session.

    Call after evaluate() — if True, the session's Fold environment was reset
    (all definitions, loaded modules, and variables are gone).
    """
    current = _daemon_pid_mtime()
    prev = _daemon_generation.get(session_id, current)
    return current != prev


def _evaluate_impl(expression: str, session_id: str, timeout: float,
                    max_result_length: int, max_response_bytes: int,
                    timeout_label: str = "timed out") -> str:
    """Shared implementation for evaluate() and evaluate_long()."""
    sock_path = _ensure_daemon()
    if not sock_path:
        return "Error: Fold daemon is not running and could not be started."

    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(timeout)
    try:
        s.connect(sock_path)

        req_id = uuid.uuid4().hex[:8]
        escaped = expression.replace('\\', '\\\\').replace('"', '\\"')
        msg = f'((type . request) (id . "{req_id}") (session . "{session_id}") (expr . "{escaped}"))'
        data = msg.encode("utf-8")

        s.sendall(struct.pack(">I", len(data)) + data)

        length_bytes = _recv_exact(s, 4)
        length = struct.unpack(">I", length_bytes)[0]
        if length > max_response_bytes:
            return f"Error: response too large ({length} bytes)"

        payload = _recv_exact(s, length)
        resp = _parse_response(payload.decode("utf-8"))

        if resp["status"] == "success":
            _daemon_generation[session_id] = _daemon_pid_mtime()

            result = resp.get("result", "(no result)")
            if len(result) > max_result_length:
                result = result[:max_result_length] + f"\n(truncated — {len(result)} chars total)"
            return result
        else:
            return f"Error: {resp.get('error', 'unknown')}"

    except socket.timeout:
        return f"Error: {timeout_label} after {timeout}s"
    except ConnectionRefusedError:
        return "Error: Fold daemon refused connection."
    except Exception as e:
        return f"Error: {e}"
    finally:
        s.close()


def evaluate(expression: str, session_id: str, timeout: float = 30.0) -> str:
    """Evaluate a Scheme expression via the Fold daemon. Returns result string."""
    return _evaluate_impl(expression, session_id, timeout,
                          MAX_RESULT_LENGTH, 16 * 1024 * 1024,
                          "timed out")


def evaluate_long(expression: str, session_id: str, timeout: float = 300.0) -> str:
    """Evaluate a long-running Scheme expression (e.g. RLM runs).

    Same protocol as evaluate() but with relaxed limits:
    - 5 minute default timeout (vs 30s)
    - 8000 char result truncation (vs 2000)
    - 64MB response cap (vs 16MB)
    """
    return _evaluate_impl(expression, session_id, timeout,
                          MAX_RESULT_LENGTH_LONG, 64 * 1024 * 1024,
                          "RLM run timed out")
