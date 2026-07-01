"""FastAPI backend — thin HTTP layer over the reused analysis engines.

Run: uvicorn app:app --reload --port 8000
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from routers import compare, dataset, modelling, report, signal_ops

app = FastAPI(title="Data Analyzer API")

# The packaged Tauri app serves the UI from tauri://localhost and calls the
# sidecar directly, so allow cross-origin from the desktop shell (local only).
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(dataset.router)
app.include_router(compare.router)
app.include_router(signal_ops.router)
app.include_router(modelling.router)
app.include_router(report.router)
