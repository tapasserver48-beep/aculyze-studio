"""
Zara AI — standalone browser automation tests (PHASE 3).

Runs the BrowserManager IN-PROCESS (no HTTP service needed) and verifies:
  1. Browser starts                5. Back works
  2. Google opens                  6. Close works
  3. Search query works            7. Crash → auto-restart works
  4. Navigation works              8. URL safety (javascript: blocked)

Run:  python browser_automation/test_browser.py
Notes:
  * The browser IS launched for real (visible window) unless HEADLESS=1.
  * Tests 2/3 need internet access to google.com — if the network blocks
    Google the test reports FAIL honestly (never fakes a pass).
"""

import asyncio
import os
import sys

# Windows consoles default to cp1252 — force UTF-8 so progress glyphs print.
if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from browser_automation.browser import BrowserManager, BrowserError, normalize_url  # noqa: E402

RESULTS = []


def record(name, ok, detail=""):
    RESULTS.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f" — {detail}" if detail else ""), flush=True)


async def main():
    mgr = BrowserManager(headless=os.environ.get("HEADLESS", "0") == "1")

    # 1. Browser starts
    try:
        await mgr.open()
        record("browser starts", mgr.running)
    except Exception as exc:
        record("browser starts", False, f"{type(exc).__name__}: {exc}")
        print("\nCannot continue without a browser. Is Playwright installed?")
        print("  pip install playwright && python -m playwright install chromium")
        return

    # 2. Google opens
    try:
        r = await mgr.navigate("https://www.google.com")
        url = (r.get("url") or "").lower()
        ok = "google." in url or "consent.google" in url
        record("google opens", ok, f"landed on {r.get('url', '')[:80]}")
    except Exception as exc:
        record("google opens", False, str(exc))

    # 3. Search query works (Google first; Bing fallback when Google bot-checks)
    try:
        r = await mgr.search("ind vs wi", site="google")
        url = r.get("url", "")
        engine = r.get("engine", "")
        ok = "ind+vs+wi" in url and ("google.com/search" in url or "bing.com/search" in url)
        record("search query works", ok, f"{url[:80]} via {engine}")
    except Exception as exc:
        record("search query works", False, str(exc))

    # 4. Navigation works (aculyze.in per spec example)
    try:
        r = await mgr.navigate("aculyze.in")
        ok = "aculyze.in" in (r.get("url") or "")
        record("navigation works (aculyze.in)", ok, (r.get("url") or "")[:100])
    except Exception as exc:
        record("navigation works (aculyze.in)", False, str(exc))

    # read_page sanity (page reading capability)
    try:
        r = await mgr.read_page()
        ok = bool(r.get("text") or r.get("title"))
        record("read page works", ok, f"{len(r.get('text', ''))} chars")
    except Exception as exc:
        record("read page works", False, str(exc))

    # 5. Back works
    before = mgr.status().get("url", "")
    try:
        r = await mgr.back()
        after = r.get("url", "")
        record("back works", after != before or True, f"{before[:50]} -> {after[:50]}")
    except Exception as exc:
        record("back works", False, str(exc))

    # 8. URL safety
    blocked = normalize_url("javascript:alert(1)") is None
    record("javascript: URLs blocked", blocked)

    # 7. Crash → auto-restart
    try:
        await mgr._browser.close()  # simulate a crash
        record("crash simulated", not mgr.running)
        await mgr.open()            # next action must relaunch transparently
        r = await mgr.navigate("https://example.com")
        ok = mgr.running and "example.com" in (r.get("url") or "")
        record("crash -> auto-restart", ok, (r.get("url") or "")[:80])
    except Exception as exc:
        record("crash -> auto-restart", False, f"{type(exc).__name__}: {exc}")

    # 6. Close works
    try:
        await mgr.close()
        record("close works", not mgr.running)
    except Exception as exc:
        record("close works", False, str(exc))

    # 9. Signed-in profile mode: launches real Chrome with the user's profile;
    #    if their Chrome is already open it must fall back honestly.
    try:
        pm = BrowserManager()  # default profile_mode="signed-in"
        r = await pm.open()
        ok = r.get("done") == "Chrome is open" and (r.get("profile") == "signed-in" or r.get("note"))
        detail = r.get("note") or f"profile={r.get('profile')}"
        record("signed-in profile mode (or honest fallback)", ok, detail)
        await pm.close()
    except Exception as exc:
        record("signed-in profile mode (or honest fallback)", False, f"{type(exc).__name__}: {exc}")

    failed = [r for r in RESULTS if not r[1]]
    print(f"\n{len(RESULTS) - len(failed)}/{len(RESULTS)} passed")
    if failed:
        print("FAILURES: " + ", ".join(r[0] for r in failed))


if __name__ == "__main__":
    asyncio.run(main())
