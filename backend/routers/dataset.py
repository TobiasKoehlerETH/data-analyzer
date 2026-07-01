"""Data area: load a CSV, list signals, stream signal arrays."""

from __future__ import annotations

import tempfile

import numpy as np
from fastapi import APIRouter, HTTPException, UploadFile
from fastapi.responses import Response

import dataset as ds

router = APIRouter(prefix="/dataset", tags=["dataset"])


def meta(d: ds.Dataset) -> dict:
    return {
        "id": d.id,
        "filename": d.filename,
        "rows": int(d.time.size),
        "signalCount": len(d.order),
        "duration": d.duration,
        "sampleRate": d.sample_rate,
        "raser": d.raser,
        "info": d.info,
    }


def require(dataset_id: str) -> ds.Dataset:
    try:
        return ds.get(dataset_id)
    except KeyError:
        raise HTTPException(404, "Unknown dataset")


@router.post("/load")
async def load(file: UploadFile) -> dict:
    with tempfile.NamedTemporaryFile(delete=False, suffix="_" + (file.filename or "csv")) as tmp:
        tmp.write(await file.read())
        path = tmp.name
    try:
        d = ds.build_dataset(path, file.filename or "upload.csv")
    except Exception as e:
        raise HTTPException(400, f"Could not parse CSV: {e}") from e
    ds.put(d)
    return {"dataset": meta(d), "signals": ds.signal_stats(d), "preview": d.preview}


@router.get("/{dataset_id}/signals")
def signals(dataset_id: str) -> list[dict]:
    return ds.signal_stats(require(dataset_id))


@router.get("/{dataset_id}/signal-data")
def signal_data(dataset_id: str, names: str) -> Response:
    """Binary Float32, column-major: [time, ...signals] in requested order."""
    d = require(dataset_id)
    wanted = [n for n in names.split(",") if n]
    missing = [n for n in wanted if n not in d.arrays]
    if missing:
        raise HTTPException(400, f"Unknown signals: {', '.join(missing)}")
    buf = np.concatenate([d.time, *(d.arrays[n] for n in wanted)]).astype(np.float32, copy=False)
    return Response(buf.tobytes(), media_type="application/octet-stream")
