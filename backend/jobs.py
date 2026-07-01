"""Tiny in-process job registry for long-running work (system-ID, reports).

A job runs on a daemon thread and reports progress; the UI polls GET /jobs/{id}.
"""

from __future__ import annotations

import threading
import traceback
import uuid

_JOBS: dict[str, dict] = {}


def _new() -> str:
    jid = uuid.uuid4().hex[:8]
    _JOBS[jid] = {"status": "running", "progress": 0, "message": "", "result": None, "error": None}
    return jid


def update(jid: str, progress: int, message: str = "") -> None:
    if jid in _JOBS:
        _JOBS[jid].update(progress=progress, message=message)


def get(jid: str) -> dict | None:
    return _JOBS.get(jid)


def run(fn) -> str:
    """Start `fn(jid)` on a background thread; return the job id immediately."""
    jid = _new()

    def worker() -> None:
        try:
            _JOBS[jid].update(status="done", progress=100, result=fn(jid))
        except Exception as e:  # capture full traceback for the UI
            _JOBS[jid].update(status="error", error="".join(traceback.format_exception(e)))

    threading.Thread(target=worker, daemon=True).start()
    return jid
