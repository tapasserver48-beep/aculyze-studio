"""
Zara AI — local browser automation module (Python + Playwright).

Runs LOCALLY on this Windows machine. No cloud browser, no Selenium,
no external AI service — Playwright's Chromium only.

Structure:
  browser.py   BrowserManager — async Playwright session (open/close/navigate/
               search/type/click/press/back/read) with session reuse and
               crash-restart. Emits [BROWSER] logs (never secrets).
  server.py    Stdlib-only HTTP service (127.0.0.1:8735) exposing a fixed,
               whitelisted action set to Zara's Node backend.
  test_browser.py  Standalone tests (start, Google, search, nav, back,
               close, crash/restart).

Usage (service):   python browser_automation/server.py
Usage (in-process): from browser_automation.browser import BrowserManager
"""

from .browser import BrowserManager, log  # noqa: F401

__all__ = ["BrowserManager", "log"]
