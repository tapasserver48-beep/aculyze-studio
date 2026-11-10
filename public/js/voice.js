/**
 * Voice module — browser-native speech-to-text (dictation) and
 * text-to-speech (read aloud) for Zara chat.
 *
 * Uses the Web Speech API only. No server, provider, or model involved.
 * Notes:
 *  - Dictation (SpeechRecognition) needs a secure context: it works on
 *    localhost but most browsers block it on plain-http LAN IPs. TTS
 *    (speechSynthesis) works everywhere with no permission prompt.
 */

export function sttSupported() {
  return typeof window !== 'undefined' && !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

export function ttsSupported() {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

/**
 * Single-utterance dictation session. Tap mic → speak → auto-stops.
 * Callbacks: onInterim(text), onFinal(text), onEnd(), onError(code).
 */
export function createListener({ lang = 'en-US', onInterim, onFinal, onEnd, onError } = {}) {
  const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Ctor) return null;
  const rec = new Ctor();
  rec.lang = lang;
  rec.interimResults = true;
  rec.continuous = false;
  rec.maxAlternatives = 1;

  rec.onresult = (e) => {
    let interim = '';
    let final = '';
    for (const res of e.results) {
      const text = res[0] ? res[0].transcript : '';
      if (res.isFinal) final += text;
      else interim += text;
    }
    if (interim && onInterim) onInterim(interim);
    if (final && onFinal) onFinal(final);
  };
  rec.onerror = (e) => {
    if (onError) onError((e && e.error) || 'unknown');
  };
  rec.onend = () => {
    if (onEnd) onEnd();
  };
  return {
    start() {
      try { rec.start(); } catch { /* already started */ }
    },
    stop() {
      try { rec.stop(); } catch { /* noop */ }
    },
    abort() {
      try { rec.abort(); } catch { /* noop */ }
    },
  };
}

// ---------- Text-to-speech ----------

let voicesCache = [];

function loadVoices() {
  try {
    const list = window.speechSynthesis.getVoices();
    if (list && list.length) voicesCache = list;
  } catch { /* noop */ }
  return voicesCache;
}

if (ttsSupported()) {
  loadVoices();
  try {
    window.speechSynthesis.onvoiceschanged = loadVoices;
  } catch { /* noop */ }
}

function pickVoice() {
  const voices = loadVoices();
  if (!voices.length) return null;
  const prefs = [/google us english/i, /\bzira\b/i, /\bsamantha\b/i, /\baria\b/i, /\bjenny\b/i, /\bdavid\b/i];
  for (const rx of prefs) {
    const found = voices.find((v) => rx.test(v.name || '') && (v.lang || '').toLowerCase().startsWith('en'));
    if (found) return found;
  }
  return voices.find((v) => (v.lang || '').toLowerCase().startsWith('en')) || voices[0];
}

/** Speak text aloud. Returns false when there is nothing speakable. */
export function speak(text, { rate = 1, onEnd, onError } = {}) {
  if (!ttsSupported()) return false;
  stopSpeaking();
  const clean = toSpokenText(text);
  if (!clean) return false;
  try {
    const utterance = new SpeechSynthesisUtterance(clean);
    const voice = pickVoice();
    if (voice) utterance.voice = voice;
    utterance.rate = rate;
    if (onEnd) utterance.onend = onEnd;
    if (onError) utterance.onerror = onError;
    window.speechSynthesis.speak(utterance);
    return true;
  } catch {
    return false;
  }
}

export function stopSpeaking() {
  try {
    if (ttsSupported()) window.speechSynthesis.cancel();
  } catch { /* noop */ }
}

export function isSpeaking() {
  try {
    return ttsSupported() && !!window.speechSynthesis.speaking;
  } catch {
    return false;
  }
}

/** Convert a markdown reply into speakable plain text. */
export function toSpokenText(md) {
  let t = String(md || '');
  t = t.replace(/```[\s\S]*?```/g, ' Code snippet omitted. ');
  t = t.replace(/`([^`]*)`/g, '$1');
  t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  t = t.replace(/^#{1,6}\s+/gm, '');
  t = t.replace(/^(>\s?|[-*]\s+|\d+[.)]\s+)/gm, '');
  t = t.replace(/(\*\*|__)(.*?)\1/g, '$2');
  t = t.replace(/(^|\W)\*([^*\n]+)\*/g, '$1$2');
  t = t.replace(/\|/g, ' ');
  t = t.replace(/https?:\/\/\S+/g, ' link ');
  t = t.replace(/[~_#]/g, '');
  t = t.replace(/\s+/g, ' ').trim();
  if (t.length > 2000) t = `${t.slice(0, 2000)} … truncated`;
  return t;
}
