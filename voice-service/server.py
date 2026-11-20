"""
Zara AI — OmniVoice TTS microservice.

Stdlib-only HTTP wrapper (no FastAPI/Flask needed) that loads the OmniVoice
model ONCE and serves synthesis requests from Zara's Node backend.

  GET  /status  -> {"ok": true, "model": "..."}
  POST /tts     -> audio/wav  (24 kHz)

Run:  python server.py        (env: OMNIVOICE_PORT=8091, OMNIVOICE_MODEL=k2-fsa/OmniVoice)
"""
import io
import json
import os
import sys
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("OMNIVOICE_PORT", "8091"))
MODEL_ID = os.environ.get("OMNIVOICE_MODEL", "k2-fsa/OmniVoice")
MAX_CHARS = int(os.environ.get("OMNIVOICE_MAX_CHARS", "4000"))
NUM_STEP = int(os.environ.get("OMNIVOICE_NUM_STEP", "16"))

_lock = threading.Lock()
_model = None
_device = "cpu"
_load_error = None


def _load_model():
    global _model, _device, _load_error
    if _model is not None:
        return _model
    with _lock:
        if _model is not None:
            return _model
        try:
            import torch
            from omnivoice import OmniVoice

            if torch.cuda.is_available():
                _device = "cuda:0"
            elif getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
                _device = "mps"
            else:
                _device = "cpu"
            print(f"[omnivoice] loading {MODEL_ID} on {_device} ...", flush=True)
            kwargs = {"device_map": _device}
            if _device.startswith("cuda"):
                kwargs["dtype"] = torch.float16
            _model = OmniVoice.from_pretrained(MODEL_ID, **kwargs)
            print("[omnivoice] model loaded", flush=True)
        except Exception as e:
            _load_error = f"{type(e).__name__}: {e}"
            traceback.print_exc()
            raise
    return _model


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        sys.stdout.write("[voice] " + (fmt % args) + "\n")

    def _json(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/status"):
            if _load_error:
                self._json(503, {"ok": False, "error": _load_error[:300]})
            else:
                self._json(200, {"ok": True, "model": MODEL_ID, "device": _device,
                                 "loaded": _model is not None})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        if not self.path.startswith("/tts"):
            return self._json(404, {"error": "not found"})
        try:
            length = int(self.headers.get("Content-Length") or 0)
            payload = json.loads(self.rfile.read(length) or b"{}")
        except Exception:
            return self._json(400, {"error": "invalid JSON body"})

        text = str(payload.get("text") or "").strip()
        if not text:
            return self._json(400, {"error": "text is required"})
        if len(text) > MAX_CHARS:
            text = text[:MAX_CHARS]

        try:
            model = _load_model()
            import numpy as np
            import soundfile as sf

            kwargs = {}
            instruct = str(payload.get("instruct") or "").strip()
            if instruct:
                kwargs["instruct"] = instruct
            speed = payload.get("speed")
            if isinstance(speed, (int, float)) and 0.5 <= float(speed) <= 2.0:
                kwargs["speed"] = float(speed)
            # keep the fast path for chat-sized inputs
            kwargs.setdefault("num_step", NUM_STEP)

            import time as _time
            t0 = _time.time()
            print(f"[voice] generation start: {len(text)} chars, kwargs={kwargs}", flush=True)
            with _lock:  # single generation at a time (CPU-friendly)
                audio = model.generate(text=text, **kwargs)
            elapsed = _time.time() - t0
            samples = audio[0] if isinstance(audio, list) else audio
            dur = len(samples) / 24000.0
            print(
                f"[voice] generation done: {elapsed:.1f}s wall -> {dur:.1f}s audio "
                f"(real-time factor {elapsed / max(dur, 0.01):.2f}x)",
                flush=True,
            )
            buf = io.BytesIO()
            sf.write(buf, np.asarray(samples, dtype="float32"), 24000, format="WAV")
            data = buf.getvalue()
            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(data)
        except Exception as e:
            traceback.print_exc()
            self._json(500, {"error": f"{type(e).__name__}: {e}"[:300]})


def main():
    print(f"[omnivoice] service on 127.0.0.1:{PORT}", flush=True)
    # Warm the model in a background thread so startup stays responsive;
    # failures are reported via /status.
    threading.Thread(target=lambda: (_load_model()), daemon=True).start()
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
