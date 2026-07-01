"""Signal Processing area: filtering, spectrum (FFT/PSD), correlation.

Thin wrappers over the reused engines. Signals live client-side, so requests
name a signal (+ optional filter chain) and get computed results back.
"""

from __future__ import annotations

import numpy as np
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import dataset as ds
from routers.dataset import require

from core.filter_engine import apply_chain, suggest_filters
from core.spectrum_engine import compute_fft, compute_psd, detect_peaks
from core.correlation_engine import (
    compute_correlation_matrix,
    compute_cross_correlation,
)
from models.filter_model import FilterChain

router = APIRouter(tags=["signal-ops"])


class SignalReq(BaseModel):
    datasetId: str
    signal: str
    chain: dict | None = None  # {steps: [{filter_type, params, enabled}]}


class PairReq(BaseModel):
    datasetId: str
    a: str
    b: str
    maxLag: int | None = None


def _resolve(datasetId: str, signal: str, chain: dict | None) -> tuple[ds.Dataset, np.ndarray]:
    d = require(datasetId)
    if signal not in d.arrays:
        raise HTTPException(400, f"Unknown signal: {signal}")
    a = d.arrays[signal]
    if chain and chain.get("steps"):
        a = apply_chain(a, FilterChain.from_dict(chain), d.sample_rate)
    return d, a


def _floats(a: np.ndarray) -> list[float]:
    return np.asarray(a, dtype=float).tolist()


def _py(v: object) -> object:
    """Coerce numpy scalars to native Python so responses serialize cleanly."""
    if isinstance(v, np.floating):
        return float(v)
    if isinstance(v, np.integer):
        return int(v)
    return v


@router.post("/filter/apply")
def filter_apply(req: SignalReq):
    from fastapi.responses import Response

    _, a = _resolve(req.datasetId, req.signal, req.chain)
    return Response(a.astype(np.float32, copy=False).tobytes(), media_type="application/octet-stream")


@router.post("/filter/suggest")
def filter_suggest(req: SignalReq) -> list[dict]:
    d, a = _resolve(req.datasetId, req.signal, None)
    return [
        {
            "filterType": s.filter_type.value,
            "params": {k: _py(v) for k, v in s.params.items()},
            "reason": s.reason,
            "improvement": float(s.estimated_improvement),
        }
        for s in suggest_filters(a, d.sample_rate, signal_name=req.signal)
    ]


@router.post("/spectrum")
def spectrum(req: SignalReq) -> dict:
    d, a = _resolve(req.datasetId, req.signal, req.chain)
    fft = compute_fft(a, d.sample_rate)
    psd = compute_psd(a, d.sample_rate)
    peaks = detect_peaks(psd)
    return {
        "fft": {"freqs": _floats(fft.freqs), "magnitude": _floats(fft.magnitude)},
        "psd": {"freqs": _floats(psd.freqs), "psd": _floats(psd.psd)},
        "peaks": [
            {"frequency": p.frequency, "amplitude": p.amplitude, "prominence": p.prominence}
            for p in peaks
        ],
    }


@router.get("/correlation/{dataset_id}")
def correlation(dataset_id: str) -> dict:
    d = require(dataset_id)
    result = compute_correlation_matrix(d.arrays)
    return {
        "columns": result.columns,
        "pearson": result.pearson_matrix.tolist(),
        "topPairs": [
            {"a": p.signal_a, "b": p.signal_b, "pearson": p.pearson_r, "spearman": p.spearman_r}
            for p in result.top_pairs
        ],
    }


@router.post("/correlation/pair")
def correlation_pair(req: PairReq) -> dict:
    d = require(req.datasetId)
    for name in (req.a, req.b):
        if name not in d.arrays:
            raise HTTPException(400, f"Unknown signal: {name}")
    n = d.time.size
    max_lag = req.maxLag or min(n - 1, 1000)
    lags, corr = compute_cross_correlation(d.arrays[req.a], d.arrays[req.b], max_lag=max_lag)
    return {"lags": _floats(lags), "corr": _floats(corr)}
