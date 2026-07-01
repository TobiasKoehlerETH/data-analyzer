"""FastAPI backend — thin HTTP layer over the reused analysis engines.

Run: uvicorn app:app --reload --port 8000
"""

from __future__ import annotations

import tempfile

import numpy as np
from fastapi import FastAPI, HTTPException, UploadFile
from fastapi.responses import Response

import dataset as ds

app = FastAPI(title="Data Analyzer API")


def _meta(d: ds.Dataset) -> dict:
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


@app.post("/dataset/load")
async def load(file: UploadFile) -> dict:
    suffix = "_" + (file.filename or "upload.csv")
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        tmp.write(await file.read())
        path = tmp.name
    try:
        d = ds.build_dataset(path, file.filename or "upload.csv")
    except Exception as e:  # surface parse errors to the UI
        raise HTTPException(400, f"Could not parse CSV: {e}") from e
    ds.put(d)
    return {"dataset": _meta(d), "signals": ds.signal_stats(d), "preview": d.preview}


@app.get("/dataset/{dataset_id}/signals")
def signals(dataset_id: str) -> list[dict]:
    try:
        return ds.signal_stats(ds.get(dataset_id))
    except KeyError:
        raise HTTPException(404, "Unknown dataset")


@app.get("/dataset/{dataset_id}/signal-data")
def signal_data(dataset_id: str, names: str) -> Response:
    """Binary Float32, column-major: [time, ...signals] in requested order."""
    try:
        d = ds.get(dataset_id)
    except KeyError:
        raise HTTPException(404, "Unknown dataset")
    wanted = [n for n in names.split(",") if n]
    missing = [n for n in wanted if n not in d.arrays]
    if missing:
        raise HTTPException(400, f"Unknown signals: {', '.join(missing)}")
    columns = [d.time, *(d.arrays[n] for n in wanted)]
    buf = np.concatenate(columns).astype(np.float32, copy=False)
    return Response(buf.tobytes(), media_type="application/octet-stream")
