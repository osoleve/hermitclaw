"""Thin client for The Fold daemon — talks via Unix domain socket."""

import os
import re
import socket
import struct
import uuid
import subprocess
import logging

logger = logging.getLogger("hermitclaw.fold")

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


def evaluate(expression: str, session_id: str, timeout: float = 30.0) -> str:
    """Evaluate a Scheme expression via the Fold daemon. Returns result string."""
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
        if length > 16 * 1024 * 1024:
            return f"Error: response too large ({length} bytes)"

        payload = _recv_exact(s, length)
        resp = _parse_response(payload.decode("utf-8"))

        if resp["status"] == "success":
            return resp.get("result", "(no result)")
        else:
            return f"Error: {resp.get('error', 'unknown')}"

    except socket.timeout:
        return f"Error: timed out after {timeout}s"
    except ConnectionRefusedError:
        return "Error: Fold daemon refused connection."
    except Exception as e:
        return f"Error: {e}"
    finally:
        s.close()
