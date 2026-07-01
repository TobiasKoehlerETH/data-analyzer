"""Data area: load a CSV, list signals, stream signal arrays."""

from __future__ import annotations

import os
import tempfile
import uuid
from pathlib import Path

import numpy as np
from fastapi import APIRouter, Form, HTTPException, UploadFile
from fastapi.responses import Response

import dataset as ds
from core.table_parser import HeaderMode, ImportOptions, inspect_table

router = APIRouter(prefix="/dataset", tags=["dataset"])
_UPLOADS: dict[str, tuple[str, str]] = {}


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
        "columns": d.columns,
        "warnings": d.warnings,
        "sheet": d.sheet,
    }


def require(dataset_id: str) -> ds.Dataset:
    try:
        return ds.get(dataset_id)
    except KeyError:
        raise HTTPException(404, "Unknown dataset")


@router.post("/inspect")
async def inspect(file: UploadFile) -> dict:
    filename = file.filename or "upload.csv"
    suffix = Path(filename).suffix.lower()
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        tmp.write(await file.read())
        path = tmp.name
    try:
        inspection = inspect_table(path)
    except Exception as e:
        os.unlink(path)
        raise HTTPException(400, f"Could not inspect table: {e}") from e
    token = uuid.uuid4().hex
    _UPLOADS[token] = (path, filename)
    return {
        "token": token,
        "filename": filename,
        "format": inspection.format,
        "sheets": [
            {"name": sheet.name, "empty": sheet.empty}
            for sheet in inspection.sheets
        ],
        "suggestedSheet": inspection.suggested_sheet,
        "suggestedHeaderRow": inspection.suggested_header_row,
        "delimiter": inspection.delimiter,
        "encoding": inspection.encoding,
        "columns": [
            {"name": name, "type": inspection.column_types[name]}
            for name in inspection.columns
        ],
        "preview": {
            "columns": inspection.columns,
            "rows": inspection.preview,
        },
        "warnings": inspection.warnings,
        "raser": inspection.is_raser_format,
    }


@router.post("/load")
async def load(
    token: str = Form(...),
    sheet: str | None = Form(None),
    headerMode: str = Form("auto"),
    headerRow: int | None = Form(None),
) -> dict:
    upload = _UPLOADS.pop(token, None)
    if upload is None:
        raise HTTPException(404, "Unknown or expired upload")
    path, filename = upload
    try:
        options = ImportOptions(
            sheet=sheet or None,
            header_mode=HeaderMode(headerMode),
            header_row=headerRow,
        )
        d = ds.build_dataset(path, filename, options)
    except Exception as e:
        raise HTTPException(400, f"Could not parse table: {e}") from e
    finally:
        if os.path.exists(path):
            os.unlink(path)
    ds.put(d)
    return {"dataset": meta(d), "signals": ds.signal_stats(d), "preview": d.preview}


@router.post("/preview")
async def preview(
    token: str = Form(...),
    sheet: str | None = Form(None),
    headerMode: str = Form("auto"),
    headerRow: int | None = Form(None),
) -> dict:
    upload = _UPLOADS.get(token)
    if upload is None:
        raise HTTPException(404, "Unknown or expired upload")
    path, filename = upload
    try:
        options = ImportOptions(
            sheet=sheet or None,
            header_mode=HeaderMode(headerMode),
            header_row=headerRow,
        )
        d = ds.build_dataset(path, filename, options)
    except Exception as e:
        raise HTTPException(400, f"Could not preview table: {e}") from e
    return {
        "columns": d.columns,
        "preview": d.preview,
        "warnings": d.warnings,
    }


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
