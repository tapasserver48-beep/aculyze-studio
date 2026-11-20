"""
Zara AI — BrowserManager: local Playwright (Chromium) automation.

Design notes
------------
* One browser session is kept ALIVE and reused across commands ("Open Chrome"
  once, then many searches/navigations in the same session).
* Crash-safe: before every action we verify the browser is still connected;
  if it died we transparently relaunch (session recreation) and continue.
* Only http(s) navigation is allowed — javascript:/file:/data: are rejected.
* Logging uses the [BROWSER] prefix. Typed text, cookies, tokens and form
  values are NEVER logged (only the selector and the character count).

All operations are async (playwright.async_api). The HTTP service (server.py)
hosts a single persistent asyncio loop in a daemon thread and dispatches
actions onto it with run_coroutine_threadsafe().
"""

from __future__ import annotations

import asyncio
import os
import re
import sys
import traceback
import urllib.parse
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Optional

if hasattr(sys.stdout, "reconfigure"):  # Windows cp1252 consoles → UTF-8
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

# --------------------------------------------------------------------------
# Configuration
# --------------------------------------------------------------------------

LOG_DIR = Path(__file__).resolve().parent / "logs"
LOG_FILE = LOG_DIR / "browser.log"
SCREENSHOT_DIR = LOG_DIR / "screens"

MAX_PAGE_CHARS = int(os.environ.get("ZARA_BROWSER_MAX_PAGE_CHARS", "6000"))
NAV_TIMEOUT_MS = int(os.environ.get("ZARA_BROWSER_NAV_TIMEOUT_MS", "30000"))
ACTION_TIMEOUT_MS = int(os.environ.get("ZARA_BROWSER_ACTION_TIMEOUT_MS", "15000"))
HEADLESS = os.environ.get("ZARA_BROWSER_HEADLESS", "0") == "1"
CHANNEL = os.environ.get("ZARA_BROWSER_CHANNEL", "").strip() or None  # e.g. "chrome"
# "signed-in" (default) = drive the user's REAL Chrome profile (their logins,
# cookies, bookmarks, extensions). "fresh" = isolated automation profile.
PROFILE_MODE = os.environ.get("ZARA_BROWSER_PROFILE", "signed-in").strip().lower()
USER_DATA_DIR = os.environ.get("ZARA_BROWSER_USER_DATA_DIR", "").strip() or None

ALLOWED_SCHEMES = ("http://", "https://")


def default_profile_dir(channel: Optional[str]) -> str:
    """Path of the real (signed-in) Chrome/Edge profile on this platform."""
    if os.name == "nt":
        base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~\\AppData\\Local")
        if channel == "msedge":
            return os.path.join(base, "Microsoft", "Edge", "User Data")
        return os.path.join(base, "Google", "Chrome", "User Data")
    if sys.platform == "darwin":
        return os.path.expanduser("~/Library/Application Support/Google/Chrome")
    return os.path.expanduser("~/.config/google-chrome")

# Small friendly-name → URL map so "Go to YouTube" works without a domain.
KNOWN_SITES = {
    "youtube": "https://www.youtube.com",
    "google": "https://www.google.com",
    "gmail": "https://mail.google.com",
    "github": "https://github.com",
    "wikipedia": "https://www.wikipedia.org",
    "amazon": "https://www.amazon.com",
    "twitter": "https://twitter.com",
    "x": "https://x.com",
    "linkedin": "https://www.linkedin.com",
    "instagram": "https://www.instagram.com",
    "facebook": "https://www.facebook.com",
    "reddit": "https://www.reddit.com",
    "stackoverflow": "https://stackoverflow.com",
    "chatgpt": "https://chat.openai.com",
    "aculyze": "https://aculyze.in",
    "lm.aculyze.in": "https://lm.aculyze.in",
}

# Per-engine search result URLs (site-scoped "search" without clicking UI).
SEARCH_URLS = {
    "google": "https://www.google.com/search?q={q}",
    "youtube": "https://www.youtube.com/results?search_query={q}",
    "bing": "https://www.bing.com/search?q={q}",
    "duckduckgo": "https://duckduckgo.com/?q={q}",
}

# Friendly engine names for logs/results.
SITE_LABELS = {
    "google": "Google", "youtube": "YouTube", "bing": "Bing", "duckduckgo": "DuckDuckGo",
}

# Fixed role → CSS selector map for the visual/target-detection ops. Callers
# supply only a role NAME + optional visible text — never a raw selector — so
# no selector/JS can be injected through this surface.
ROLE_SELECTORS = {
    "button": "button, [role=button], input[type=button], input[type=submit]",
    "link": "a[href], [role=link]",
    "textbox": "input[type=text], input[type=search], textarea, [role=textbox], [contenteditable=true]",
    "video": "video",
    "result": "a#video-title[href], ytd-video-renderer a#video-title, h3 a[href]",
}


def role_selectors_for(role: str) -> str:
    sel = ROLE_SELECTORS.get(str(role or "").lower())
    if not sel:
        raise BrowserError(f"I don't know the target kind “{role}”.", code="bad_role")
    return sel


# --------------------------------------------------------------------------
# Logging ([BROWSER] — console + logs/browser.log, never secrets)
# --------------------------------------------------------------------------

def log(msg: str) -> None:
    line = f"[BROWSER] {msg}"
    print(line, flush=True)
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        with LOG_FILE.open("a", encoding="utf-8") as fh:
            fh.write(f"{datetime.now().isoformat(timespec='seconds')} {line}\n")
    except OSError:
        pass


# --------------------------------------------------------------------------
# URL helpers (safety: http/https only)
# --------------------------------------------------------------------------

_DOMAIN_RE = re.compile(r"^(?:www\.)?[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+(?:[/:?#].*)?$", re.I)


def normalize_url(target: str) -> Optional[str]:
    """Return a safe http(s) URL for a user-given target, else None."""
    t = str(target or "").strip().strip("\"'<>.,;()[]{}")
    if not t:
        return None
    low = t.lower()
    if low.startswith(("javascript:", "file:", "data:", "about:", "blob:")):
        return None
    if low.startswith(ALLOWED_SCHEMES):
        url = t
    else:
        key = low.rstrip("/").replace("https://", "").replace("http://", "")
        known = KNOWN_SITES.get(key) or KNOWN_SITES.get(key.replace("www.", ""))
        if known:
            url = known
        elif _DOMAIN_RE.match(t):
            url = f"https://{t}"
        else:
            return None
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        return None
    return url


def search_url(query: str, site: str = "google") -> str:
    q = urllib.parse.quote_plus(str(query or "").strip())
    template = SEARCH_URLS.get(site, SEARCH_URLS["google"])
    return template.format(q=q)


# --------------------------------------------------------------------------
# BrowserManager
# --------------------------------------------------------------------------

class BrowserError(Exception):
    """Friendly browser-automation error (message safe to show in chat)."""

    def __init__(self, message: str, code: str = "failed"):
        super().__init__(message)
        self.code = code


class BrowserManager:
    """One reusable browser session with crash-recovery.

    Profile modes
    -------------
    * signed-in (default): drives the user's REAL Chrome/Edge profile via a
      persistent context — their logins, cookies, bookmarks and extensions
      are available (e.g. searching while signed into Google works naturally).
      If the profile is locked (their Chrome is already running), Playwright
      cannot attach to it, so we fall back to a fresh automation profile and
      report that honestly in the result (``profile_fallback``).
    * fresh: always an isolated automation profile (no user data touched).
    """

    def __init__(self, headless: bool = HEADLESS, channel: Optional[str] = CHANNEL,
                 profile_mode: Optional[str] = None, user_data_dir: Optional[str] = None):
        self._pw = None            # AsyncPlaywright instance
        self._browser = None       # Browser (None for persistent contexts)
        self._context = None       # BrowserContext (single, reused)
        self._page = None          # Page (single, reused — like one Chrome tab)
        self._headless = headless
        self._channel = channel or ("chrome" if (profile_mode or PROFILE_MODE) == "signed-in" else None)
        self._profile_mode = (profile_mode or PROFILE_MODE) if not headless else "fresh"
        self._user_data_dir = user_data_dir or USER_DATA_DIR
        self._persistent = False   # True when launched via launch_persistent_context
        self._profile_fallback: Optional[str] = None  # honest note when signed-in unavailable
        self._started_at: Optional[float] = None
        # One page is shared, so actions must run one at a time — otherwise
        # two concurrent commands interleave and destroy each other's context.
        self._lock = asyncio.Lock()

    # ---------------- state ----------------

    @property
    def running(self) -> bool:
        try:
            if self._context is not None:
                if self._context.is_closed():
                    return False
            elif self._browser is None or not self._browser.is_connected():
                return False
            return bool(self._page and not self._page.is_closed())
        except Exception:
            return False

    def status(self) -> Dict[str, Any]:
        info: Dict[str, Any] = {"browser": "open" if self.running else "closed",
                                "headless": self._headless,
                                "channel": self._channel or "chromium",
                                "profile": self._profile_mode}
        if self._profile_fallback:
            info["profile_fallback"] = self._profile_fallback
        if self.running:
            try:
                # Sync snapshot only — page.title is a coroutine, so the
                # async title read stays in the async operations.
                info["url"] = self._page.url
            except Exception:
                pass
        return info

    # ---------------- lifecycle ----------------

    async def _ensure(self):
        """Return a live page, launching (or re-launching after a crash)."""
        # Lazy import so /status still answers when Playwright isn't installed.
        try:
            from playwright.async_api import async_playwright
        except ImportError as exc:
            raise BrowserError(
                "Browser automation isn't installed yet. Run: pip install playwright "
                "&& python -m playwright install chromium", code="not_installed",
            ) from exc

        if self.running:
            return self._page

        crashed = self._pw is not None or self._browser is not None or self._context is not None
        if crashed:
            log("browser session lost — recreating it")
            await self._cleanup_quiet()

        self._pw = await async_playwright().start()

        # ---- Profile-based launch (signed-in real Chrome profile) ----------
        if self._profile_mode == "signed-in":
            udd = self._user_data_dir or default_profile_dir(self._channel)
            if os.path.isdir(udd):
                try:
                    self._context = await self._pw.chromium.launch_persistent_context(
                        udd,
                        channel=self._channel or "chrome",
                        headless=self._headless,
                        locale="en-US",
                        args=["--start-maximized"],
                    )
                    self._persistent = True
                    self._profile_fallback = None
                    self._page = self._context.pages[0] if self._context.pages else await self._context.new_page()
                    self._started_at = datetime.now().timestamp()
                    log(f"signed-in profile opened ({self._channel or 'chrome'}, profile: {udd})")
                    return self._page
                except Exception as exc:
                    # Profile locked (their Chrome is already open) or channel
                    # missing — fall back to an isolated profile, honestly noted.
                    reason = ("your Chrome profile is in use — close Chrome and try again"
                              if "in use" in str(exc).lower() or "processsingleton" in str(exc).lower()
                              else f"could not use your Chrome profile ({type(exc).__name__})")
                    log(f"signed-in profile unavailable: {reason} — using a fresh automation profile")
                    self._profile_fallback = reason
                    await self._cleanup_quiet()
                    self._pw = await async_playwright().start()

        # ---- Default: isolated automation profile --------------------------
        launch_kwargs: Dict[str, Any] = {"headless": self._headless}
        if self._channel:
            launch_kwargs["channel"] = self._channel  # e.g. system Chrome
        try:
            self._browser = await self._pw.chromium.launch(**launch_kwargs)
        except Exception as exc:
            # Fallback: if the requested channel (chrome/edge) is missing, use Chromium.
            if self._channel:
                log(f"channel '{self._channel}' unavailable — falling back to bundled chromium")
                self._channel = None
                launch_kwargs.pop("channel", None)
                self._browser = await self._pw.chromium.launch(**launch_kwargs)
            else:
                raise BrowserError(
                    "I couldn't start the browser. The browser automation "
                    "component may not be installed (python -m playwright install chromium).",
                    code="launch_failed",
                ) from exc
        self._context = await self._browser.new_context(
            viewport={"width": 1280, "height": 840},
            locale="en-US",
        )
        self._page = await self._context.new_page()
        self._started_at = datetime.now().timestamp()
        log(f"browser opened ({self._channel or 'chromium'}, headless={self._headless}, fresh profile)")
        return self._page

    async def _cleanup_quiet(self) -> None:
        for closer in (self._page, self._context, self._browser):
            try:
                if closer:
                    await closer.close()
            except Exception:
                pass
        try:
            if self._pw:
                await self._pw.stop()
        except Exception:
            pass
        self._page = self._context = self._browser = self._pw = None

    # ---------------- operations (the whitelisted set) ----------------

    async def open(self) -> Dict[str, Any]:
        log("opening browser")
        page = await self._ensure()
        out = {"done": "Chrome is open", "url": page.url, "title": await self._safe_title()}
        if self._profile_fallback:
            # Honest disclosure: the user asked for their signed-in Chrome but
            # we had to use an isolated profile (e.g. Chrome was already open).
            out["note"] = f"Using a fresh browser profile — {self._profile_fallback}."
        else:
            out["profile"] = "signed-in" if self._profile_mode == "signed-in" else "fresh"
        return out

    async def close(self) -> Dict[str, Any]:
        log("closing browser (user requested)")
        await self._cleanup_quiet()
        return {"done": "browser closed"}

    async def navigate(self, url: str) -> Dict[str, Any]:
        safe = normalize_url(url)
        if not safe:
            raise BrowserError(f"I can't open “{url}” — I only navigate to http(s) web addresses.", code="bad_url")
        page = await self._ensure()
        host = urllib.parse.urlparse(safe).netloc
        log(f"navigating to {safe}")
        for attempt in (1, 2):  # one retry for transient network failures
            try:
                await page.goto(safe, wait_until="domcontentloaded", timeout=NAV_TIMEOUT_MS)
                break
            except Exception as exc:  # timeout/abort — page may still have rendered
                if "Timeout" in type(exc).__name__:
                    log("navigation timed out — continuing with whatever loaded")
                    break
                if attempt == 1:
                    log(f"navigation failed ({type(exc).__name__}) — retrying once")
                    await asyncio.sleep(1.0)
                    continue
                log(f"navigation failed: {type(exc).__name__}")
                raise BrowserError(
                    f"I couldn't open {host} — the site may be down or blocked from this network.",
                    code="navigate_failed",
                ) from exc
        return {"done": f"opened {host}", "url": page.url, "title": await self._safe_title()}

    async def search(self, query: str, site: str = "google") -> Dict[str, Any]:
        q = str(query or "").strip()
        if not q:
            raise BrowserError("Tell me what to search for.", code="bad_args")
        site = site if site in SEARCH_URLS else "google"
        log(f"searching {site}: {q}")

        def failed(res) -> bool:
            u = str((res or {}).get("url") or "")
            return not u or "chrome-error://" in u or "google.com/sorry" in u

        # Try the requested engine; on failure (bot-check, timeout, network)
        # fall back Google → Bing → DuckDuckGo so the search still happens —
        # always reported honestly via the engine field.
        chain = [site] + [e for e in ("google", "bing", "duckduckgo") if e != site]
        result = None
        last_err: Optional[BrowserError] = None
        for eng in chain:
            try:
                result = await self.navigate(search_url(q, eng))
            except BrowserError as exc:
                last_err = exc
                result = None
                log(f"{eng} failed ({exc.code}) — trying next engine")
                continue
            if failed(result):
                log(f"{eng} did not load results — trying next engine")
                continue
            result["engine"] = SITE_LABELS.get(eng, eng.capitalize())
            result["query"] = q
            return result
        if last_err:
            raise last_err
        raise BrowserError(
            "I couldn't reach any search engine on this network — please check the connection.",
            code="search_unavailable",
        )

    async def type_text(self, selector: str, text: str, submit: bool = False) -> Dict[str, Any]:
        page = await self._ensure()
        # NEVER log the typed text (may be a password / personal data).
        log(f"typing {len(str(text))} chars into {selector!r}" + (" + Enter" if submit else ""))
        try:
            await page.click(selector, timeout=ACTION_TIMEOUT_MS)
            await page.fill(selector, text, timeout=ACTION_TIMEOUT_MS)
            if submit:
                await page.press(selector, "Enter")
        except Exception as exc:
            log(f"type failed: {type(exc).__name__}")
            raise BrowserError(f"I couldn't find the field {selector!r} on the page.", code="type_failed") from exc
        return {"done": "text entered", "url": page.url}

    async def click(self, selector: str) -> Dict[str, Any]:
        page = await self._ensure()
        log(f"clicking {selector!r}")
        try:
            await page.click(selector, timeout=ACTION_TIMEOUT_MS)
        except Exception as exc:
            log(f"click failed: {type(exc).__name__}")
            raise BrowserError(f"I couldn't click {selector!r} on the page.", code="click_failed") from exc
        return {"done": "clicked", "url": page.url}

    async def press(self, key: str = "Enter") -> Dict[str, Any]:
        page = await self._ensure()
        key = str(key or "Enter")
        log(f"pressing key {key!r}")
        await page.keyboard.press(key)
        return {"done": f"pressed {key}", "url": page.url}

    async def back(self) -> Dict[str, Any]:
        page = await self._ensure()
        log("going back")
        try:
            await page.go_back(wait_until="domcontentloaded", timeout=NAV_TIMEOUT_MS)
        except Exception as exc:
            if "Timeout" not in type(exc).__name__:
                raise BrowserError("I couldn't go back — there may be no page history yet.", code="back_failed") from exc
        return {"done": "went back", "url": page.url, "title": await self._safe_title()}

    async def read_page(self, limit: int = MAX_PAGE_CHARS) -> Dict[str, Any]:
        page = await self._ensure()
        log("reading page text")
        try:
            title = await self._safe_title()
            url = page.url
            text = await page.evaluate(
                "() => document.body ? document.body.innerText : ''"
            )
        except Exception as exc:
            log(f"read failed: {type(exc).__name__}")
            raise BrowserError("I couldn't read this page.", code="read_failed") from exc
        clean = re.sub(r"\n{3,}", "\n\n", str(text or "")).strip()
        cap = max(500, min(int(limit or MAX_PAGE_CHARS), MAX_PAGE_CHARS))
        if len(clean) > cap:
            clean = clean[:cap] + "\n… (page text truncated)"
        log(f"read {len(clean)} chars")
        return {"done": "page read", "url": url, "title": title, "text": clean}

    # ---------------- visual / video operations (safe, whitelisted) ----------
    # These support the controlled visual loop. Target identification is done
    # deterministically against the DOM (Playwright locators) — never by blindly
    # clicking raw coordinates. Screenshots are captured to VERIFY an expected
    # result after each action. No arbitrary JS is ever accepted from a caller:
    # each op runs a FIXED, hardcoded routine.

    async def screenshot(self) -> Dict[str, Any]:
        """Capture the current viewport to a PNG for visual verification."""
        page = await self._ensure()
        try:
            SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)
            name = f"screen-{datetime.now().strftime('%Y%m%d-%H%M%S-%f')}.png"
            path = SCREENSHOT_DIR / name
            await page.screenshot(path=str(path), full_page=False)
        except Exception as exc:
            log(f"screenshot failed: {type(exc).__name__}")
            raise BrowserError("I couldn't capture the screen.", code="capture_failed") from exc
        log(f"captured screenshot {name}")
        return {"done": "screen captured", "path": str(path), "name": name, "url": page.url}

    async def find_visible(self, role: str, name: str = "") -> Dict[str, Any]:
        """Identify a visible target by role + accessible name (deterministic).

        This is the TARGET DETECTION step of the visual loop: it resolves a
        visible element to its on-screen box (approximate coordinates) WITHOUT
        clicking. `role` is a small fixed vocabulary; `name` is matched
        case-insensitively as visible text. Returns the first matching,
        visible, enabled element's center point + size.
        """
        page = await self._ensure()
        role = str(role or "").lower()
        name = str(name or "").strip().lower()
        # Fixed role → selector map. No caller-supplied selectors (no injection).
        role_selectors = {
            "button": "button, [role=button], input[type=button], input[type=submit]",
            "link": "a[href], [role=link]",
            "textbox": "input[type=text], input[type=search], textarea, [role=textbox], [contenteditable=true]",
            "video": "video",
            "result": "a#video-title[href], ytd-video-renderer a#video-title, h3 a[href]",
        }
        selector = role_selectors.get(role)
        if not selector:
            raise BrowserError(f"I don't know the target kind “{role}”.", code="bad_role")
        try:
            # Wait for the target kind to appear (SPA results hydrate after
            # load). If nothing matches within the timeout we return found:False
            # honestly rather than guessing.
            try:
                await page.wait_for_selector(selector, timeout=6000, state="attached")
            except Exception:
                pass
            loc = page.locator(selector)
            count = await loc.count()
            for i in range(min(count, 40)):
                el = loc.nth(i)
                try:
                    if not await el.is_visible():
                        continue
                    if name:
                        text = (await el.inner_text(timeout=1500) or "").strip().lower()
                        aria = (await el.get_attribute("aria-label", timeout=1500) or "").strip().lower()
                        if name not in text and name not in aria:
                            continue
                    box = await el.bounding_box(timeout=2000)
                    if not box or box.get("width", 0) <= 0 or box.get("height", 0) <= 0:
                        continue
                    text = (await el.inner_text(timeout=1500) or "").strip()
                    return {
                        "found": True, "role": role, "index": i,
                        "x": round(box["x"] + box["width"] / 2), "y": round(box["y"] + box["height"] / 2),
                        "w": round(box["width"]), "h": round(box["height"]),
                        "label": text[:120], "url": page.url,
                    }
                except Exception:
                    continue
        except BrowserError:
            raise
        except Exception as exc:
            log(f"find_visible failed: {type(exc).__name__}")
            raise BrowserError("I couldn't scan the page for that target.", code="find_failed") from exc
        return {"found": False, "role": role, "url": page.url}

    async def click_visible(self, role: str, name: str = "") -> Dict[str, Any]:
        """Identify THEN click a visible target, then re-capture to verify.

        Implements: detect target → permission-independent safe click →
        screenshot again → report. It refuses to click when the target cannot
        be identified (never guesses coordinates).
        """
        target = await self.find_visible(role, name)
        if not target.get("found"):
            return {"done": "target not found", "found": False, "role": role, "url": (target or {}).get("url")}
        page = await self._ensure()
        try:
            # Re-locate by index and click the identified element only.
            loc = page.locator(role_selectors_for(role)).nth(target["index"])
            await loc.click(timeout=4000)
        except Exception as exc:
            log(f"click_visible failed: {type(exc).__name__}")
            raise BrowserError("I found the target but couldn't click it.", code="click_failed") from exc
        await asyncio.sleep(1.0)  # let the UI react before we verify
        after = await self.screenshot()
        return {
            "done": "clicked", "found": True, "role": role, "label": target.get("label"),
            "x": target["x"], "y": target["y"], "url": page.url, "after_shot": after.get("name"),
        }

    async def video_state(self) -> Dict[str, Any]:
        """Detect whether a <video> element is present and playing (verify step)."""
        page = await self._ensure()
        try:
            state = await page.evaluate(
                "() => { const v = document.querySelector('video');"
                " if (!v) return { present:false };"
                " const fin = (n) => (typeof n === 'number' && isFinite(n)) ? n : null;"
                " return { present:true, paused:!!v.paused, muted:!!v.muted, currentTime:fin(v.currentTime),"
                " duration:fin(v.duration), readyState:fin(v.readyState), src:String(v.currentSrc||v.src||'').slice(0,200) }; }"
            )
        except Exception as exc:
            log(f"video_state failed: {type(exc).__name__}")
            raise BrowserError("I couldn't read the video state.", code="video_state_failed") from exc
        state["url"] = page.url
        state["title"] = await self._safe_title()
        # "playing" = a media element is loaded, not paused, and ready enough.
        rs = state.get("readyState") or 0
        state["playing"] = bool(state.get("present") and not state.get("paused") and rs >= 2)
        return state

    async def video_control(self, action: str, mute: bool = False) -> Dict[str, Any]:
        """Play/pause the current video with a FIXED routine, then verify state.

        `action` is one of play|pause|toggle. `mute` (optional) silences the
        element first — used by automated tests so verifying playback doesn't
        blast audio; the chat feature leaves audio on. No caller-supplied JS.
        """
        page = await self._ensure()
        action = str(action or "").lower()
        if action not in ("play", "pause", "toggle"):
            raise BrowserError("Video control supports play, pause or toggle.", code="bad_action")
        try:
            await page.evaluate(
                "(o) => { const v = document.querySelector('video'); if (!v) return;"
                " if (o.mute) v.muted = true;"
                " if (o.action==='play'){ const p=v.play(); if(p&&p.catch)p.catch(()=>{}); }"
                " else if (o.action==='pause'){ v.pause(); }"
                " else { if (v.paused){ const p=v.play(); if(p&&p.catch)p.catch(()=>{});} else v.pause(); } }",
                {"action": action, "mute": bool(mute)},
            )
        except Exception as exc:
            log(f"video_control failed: {type(exc).__name__}")
            raise BrowserError("I couldn't control the video playback.", code="video_control_failed") from exc
        await asyncio.sleep(0.6)
        state = await self.video_state()
        state["action"] = action
        return state

    # ---------------- helpers ----------------

    async def _safe_title(self) -> str:
        try:
            return (await self._page.title())[:200]
        except Exception:
            return ""

    # ---------------- dispatcher ----------------

    async def perform(self, action: str, args: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Run one whitelisted action. Unknown actions are rejected."""
        args = args or {}
        table = {
            "open": lambda: self.open(),
            "close": lambda: self.close(),
            "navigate": lambda: self.navigate(args.get("url", "")),
            "search": lambda: self.search(args.get("query", ""), args.get("site", "google")),
            "type": lambda: self.type_text(args.get("selector", ""), args.get("text", ""), bool(args.get("submit"))),
            "click": lambda: self.click(args.get("selector", "")),
            "press": lambda: self.press(args.get("key", "Enter")),
            "back": lambda: self.back(),
            "read": lambda: self.read_page(int(args.get("limit", MAX_PAGE_CHARS))),
            "status": lambda: asyncio.sleep(0, result=self.status()),
            # Visual / video ops (safe, fixed routines — used by the controlled
            # visual loop and the YouTube workflow).
            "screenshot": lambda: self.screenshot(),
            "find_visible": lambda: self.find_visible(args.get("role", ""), args.get("name", "")),
            "click_visible": lambda: self.click_visible(args.get("role", ""), args.get("name", "")),
            "video_state": lambda: self.video_state(),
            "video_control": lambda: self.video_control(args.get("action", "toggle"), bool(args.get("mute"))),
        }
        fn = table.get(str(action or "").lower())
        if fn is None:
            raise BrowserError(f"Unknown browser action “{action}”.", code="unknown_action")
        try:
            async with self._lock:  # serialize: one shared page, one action at a time
                return await fn()
        except BrowserError:
            raise
        except Exception as exc:  # unexpected — friendly message, full detail in logs
            log(f"action '{action}' error: {type(exc).__name__}: {exc}")
            traceback.print_exc()
            raise BrowserError("The browser automation hit an unexpected problem — check the [BROWSER] logs.", code="internal") from exc


__all__ = ["BrowserManager", "BrowserError", "log", "normalize_url", "search_url",
           "MAX_PAGE_CHARS", "KNOWN_SITES", "SEARCH_URLS"]
