"""Data area: multi-file comparison — fuzzy signal matching, offset alignment, stats.

Each file is loaded as a normal Dataset (via /dataset/load). This overlays one
signal across files on a common time grid and computes stats vs the first file.
"""

from __future__ import annotations

import difflib

import numpy as np
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from routers.dataset import require

router = APIRouter(tags=["compare"])

MATCH_THRESHOLD = 0.7


def _resolve(order, arrays, signal: str) -> str | None:
    """Find the column in a file matching `signal` (exact, else fuzzy ≥0.7)."""
    if signal in arrays:
        return signal
    best, score = None, MATCH_THRESHOLD
    for n in order:
        s = difflib.SequenceMatcher(None, signal.lower(), n.lower()).ratio()
        if s >= score:
            best, score = n, s
    return best


def _floats(a) -> list[float]:
    return np.asarray(a, dtype=float).tolist()


class OverlayReq(BaseModel):
    datasetIds: list[str]
    signal: str
    offsets: dict[str, float] = {}  # dataset id -> time offset (seconds)


@router.post("/compare/overlay")
def overlay(req: OverlayReq) -> dict:
    if not req.datasetIds:
        raise HTTPException(400, "No files to compare")

    ref = require(req.datasetIds[0])
    ref_col = _resolve(ref.order, ref.arrays, req.signal)
    if not ref_col:
        raise HTTPException(400, f"Signal '{req.signal}' not found in reference file")

    ref_t = ref.time.astype(float) + req.offsets.get(req.datasetIds[0], 0.0)
    ref_y = ref.arrays[ref_col].astype(float)

    # Common x grid = reference time, capped to ~2000 points for a snappy overlay.
    step = max(1, ref_t.size // 2000)
    grid = ref_t[::step]

    files, stats = [], []
    for did in req.datasetIds:
        d = require(did)
        col = _resolve(d.order, d.arrays, req.signal)
        if not col:
            continue
        t = d.time.astype(float) + req.offsets.get(did, 0.0)
        y = d.arrays[col].astype(float)
        files.append({"id": did, "name": d.filename, "values": _floats(np.interp(grid, t, y))})

        if did != req.datasetIds[0]:  # stats vs reference on the overlapping range
            lo, hi = max(ref_t[0], t[0]), min(ref_t[-1], t[-1])
            if lo < hi:
                mask = (ref_t >= lo) & (ref_t <= hi)
                rv = ref_y[mask]
                diff = np.interp(ref_t[mask], t, y) - rv
                ss_tot = float(np.sum((rv - np.mean(rv)) ** 2))
                stats.append({
                    "file": d.filename,
                    "rmse": float(np.sqrt(np.mean(diff**2))),
                    "maxDev": float(np.max(np.abs(diff))),
                    "r2": float(1 - np.sum(diff**2) / ss_tot) if ss_tot > 1e-12 else 0.0,
                    "meanError": float(np.mean(diff)),
                })

    return {"time": _floats(grid), "files": files, "stats": stats, "matchedColumn": ref_col}
