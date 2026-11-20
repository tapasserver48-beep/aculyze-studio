# Zara AI — OmniVoice TTS service

Local text-to-speech for Zara using [OmniVoice](https://github.com/k2-fsa/OmniVoice)
(k2-fsa) — high-quality multilingual zero-shot TTS with voice design/cloning.

This is a tiny stdlib-only HTTP wrapper so Zara's Node backend can call it
over localhost. The model loads **once** at startup and stays warm.

## Run

```bash
python -m venv .venv
.venv\Scripts\activate          # Windows (bash: source .venv/bin/activate)
pip install omnivoice
python server.py                # loads model, listens on 127.0.0.1:8091
```

## Endpoints

- `GET  /status` → `{"ok": true, "model": "k2-fsa/OmniVoice"}`
- `POST /tts` `{"text": "...", "instruct": "female, low pitch" (optional), "speed": 1.0}` → `audio/wav` (24 kHz)

`instruct` = voice design attributes (no reference audio needed).
Omit both → the model auto-selects a voice.
