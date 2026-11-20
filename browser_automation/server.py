"""
Zara AI — browser automation microservice.

Stdlib-only HTTP wrapper (same pattern as voice-service/server.py) that hosts
ONE persistent asyncio loop + ONE reusable Chromium session, and exposes a
fixed whitelist of browser actions to Zara's Node backend.

  GET  /health           -> {"ok": true, "browser": "open"|"closed", ...}
  POST /action           -> {"action": "open|navigate|search|type|click|
                              press|back|read|close|status", "args": {...}}
                            -> {"ok": true, ...} | {"ok": false, "error", "code"}

Security boundaries:
  * Binds to 127.0.0.1 only (never exposed to the network).
  * ONLY the whitelisted actions above are executable — no arbitrary code,
    no shell, no Python execution, no file operations.
  * Navigation restricted to http(s). Typed text/cookies/tokens are never
    logged ([BROWSER] log lines omit form values).

Run:  python browser_automation/server.py
Env:  ZARA_BROWSER_PORT=8735   ZARA_BROWSER_HEADLESS=0   ZARA_BROWSER_CHANNEL=
"""

import asyncio
import json
import os
import sys
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

if hasattr(sys.stdout, "reconfigure"):  # Windows cp1252 consoles → UTF-8
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from browser_automation.browser import BrowserManager, BrowserError, log  # noqa: E402

PORT = int(os.environ.get("ZARA_BROWSER_PORT", "8735"))
HOST = "127.0.0.1"
ACTION_TIMEOUT_S = float(os.environ.get("ZARA_BROWSER_ACTION_TIMEOUT_S", "45"))

# The ONLY actions this service will ever execute (explicit implementation only).
WHITELIST = {"open", "close", "navigate", "search", "type", "click", "press", "back", "read", "status",
             "screenshot", "find_visible", "click_visible", "video_state", "video_control"}

# --------------------------------------------------------------------------
# One persistent asyncio loop hosts the single browser session.
# --------------------------------------------------------------------------

_loop = asyncio.new_event_loop()
_loop_thread = threading.Thread(target=_loop.run_forever, name="browser-loop", daemon=True)
_loop_thread.start()

_manager = BrowserManager()


def run_coro(coro, timeout=ACTION_TIMEOUT_S):
    """Dispatch a coroutine onto the browser loop and wait for the result."""
    future = asyncio.run_coroutine_threadsafe(coro, _loop)
    return future.result(timeout=timeout)


# --------------------------------------------------------------------------
# HTTP handler
# --------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    server_version = "ZaraBrowser/1.0"

    def log_message(self, fmt, *args):  # quiet default access log → our [BROWSER] style
        pass

    def _send(self, code: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(body)
        except BrokenPipeError:
            pass

    # ---------------- GET /health ----------------

    def do_GET(self):
        if self.path.split("?")[0] in ("/health", "/status"):
            try:
                status = _manager.status()  # sync snapshot — safe without the loop
            except Exception as exc:
                return self._send(500, {"ok": False, "error": f"status failed: {type(exc).__name__}"})
            return self._send(200, {"ok": True, **status})
        self._send(404, {"ok": False, "error": "not found", "code": "not_found"})

    # ---------------- POST /action ----------------

    def do_POST(self):
        if self.path.split("?")[0] != "/action":
            return self._send(404, {"ok": False, "error": "not found", "code": "not_found"})
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0 or length > 64 * 1024:
            return self._send(400, {"ok": False, "error": "JSON body required", "code": "bad_request"})
        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return self._send(400, {"ok": False, "error": "invalid JSON", "code": "bad_request"})

        action = str(payload.get("action", "")).lower()
        args = payload.get("args") or {}
        if not isinstance(args, dict):
            return self._send(400, {"ok": False, "error": "args must be an object", "code": "bad_args"})
        if action not in WHITELIST:
            log(f"rejected non-whitelisted action: {action!r}")
            return self._send(403, {"ok": False, "error": "action not allowed", "code": "forbidden"})

        # Request log: action name only — NEVER form values or typed text.
        log(f"action requested: {action}")
        try:
            result = run_coro(_manager.perform(action, args))
            return self._send(200, {"ok": True, "action": action, **(result or {})})
        except BrowserError as exc:
            log(f"action '{action}' refused: {exc}")
            return self._send(200, {"ok": False, "action": action, "error": str(exc), "code": exc.code})
        except TimeoutError:
            log(f"action '{action}' timed out")
            return self._send(504, {"ok": False, "action": action,
                                    "error": "The browser took too long — try again.", "code": "timeout"})
        except Exception as exc:
            log(f"action '{action}' crashed: {type(exc).__name__}: {exc}")
            traceback.print_exc()
            return self._send(500, {"ok": False, "action": action,
                                    "error": "Browser automation failed unexpectedly.", "code": "internal"})


# --------------------------------------------------------------------------
# Entrypoint
# --------------------------------------------------------------------------

def main() -> None:
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    log(f"browser automation service on http://{HOST}:{PORT} (whitelist: {', '.join(sorted(WHITELIST))})")
    print(f"[BROWSER] ready — POST actions to http://{HOST}:{PORT}/action", flush=True)
    try:
        httpd.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        print("\n[BROWSER] shutting down", flush=True)
    finally:
        try:
            run_coro(_manager.close(), timeout=10)
        except Exception:
            pass
        httpd.server_close()
        _loop.call_soon_threadsafe(_loop.stop)


if __name__ == "__main__":
    main()
