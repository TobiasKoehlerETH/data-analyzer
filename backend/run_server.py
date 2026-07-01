"""Frozen entry point for the packaged (PyInstaller) backend sidecar.

In dev the backend runs via `uvicorn app:app`; the release build bundles this
script into a single exe that the Tauri shell launches.
"""

import uvicorn

from app import app

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8000, log_level="warning")
