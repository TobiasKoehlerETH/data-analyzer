"""FastAPI backend — thin HTTP layer over the reused analysis engines.

Run: uvicorn app:app --reload --port 8000
"""

from __future__ import annotations

from fastapi import FastAPI

from routers import compare, dataset, modelling, report, signal_ops

app = FastAPI(title="Data Analyzer API")
app.include_router(dataset.router)
app.include_router(compare.router)
app.include_router(signal_ops.router)
app.include_router(modelling.router)
app.include_router(report.router)
