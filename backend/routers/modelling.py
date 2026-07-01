"""Modelling area: system identification, model library, simulation, validation.

Wraps the reused sysid/simulation/validation engines. Identified models live in
an in-process library; system-ID runs as a background job (progress via /jobs).
"""

from __future__ import annotations

import numpy as np
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from scipy.signal import decimate as sp_decimate

import dataset as ds
import jobs
from routers.dataset import require

from core.sysid_engine import estimate_decimation_factor, estimate_time, identify_model
from core.simulation_engine import simulate as sim_engine
from core.validation_engine import validate as validate_engine
from models.sysid_model import StateSpaceResult

router = APIRouter(tags=["modelling"])

# In-process model library (name -> model), reused across simulate/validate.
_MODELS: dict[str, StateSpaceResult] = {}

_IN_KW = ["setpoint", "heater", "valve", "command", "ref", "input", "pump"]
_OUT_KW = ["temp", "t_", "pressure", "leak", "vibration", "speed", "rpm", "output", "flow"]


def _floats(a) -> list[float]:
    return np.asarray(a, dtype=float).tolist()


def _summary(m: StateSpaceResult) -> dict:
    return {
        "name": m.name,
        "order": m.order,
        "method": m.method,
        "nInputs": m.n_inputs,
        "nOutputs": m.n_outputs,
        "inputNames": m.input_names,
        "outputNames": m.output_names,
        "decimation": m.decimation_factor,
        "meanVaf": m.mean_vaf,
        "bestVaf": m.best_vaf,
        "metrics": [mm.to_dict() for mm in m.metrics],
    }


def _add(m: StateSpaceResult) -> str:
    """Add a model under a unique name."""
    base, i = m.name, 2
    while m.name in _MODELS:
        m.name = f"{base}_{i}"
        i += 1
    _MODELS[m.name] = m
    return m.name


def _io(d: ds.Dataset, inputs: list[str], outputs: list[str]):
    for n in inputs + outputs:
        if n not in d.arrays:
            raise HTTPException(400, f"Unknown signal: {n}")
    return {n: d.arrays[n] for n in inputs}, {n: d.arrays[n] for n in outputs}


# --- System identification ---------------------------------------------------
class SysIdReq(BaseModel):
    datasetId: str
    inputs: list[str]
    outputs: list[str]
    method: str = "N4SID"
    orderMin: int = 2
    orderMax: int = 10
    autoDecimate: bool = True


@router.get("/sysid/suggest-io/{dataset_id}")
def suggest_io(dataset_id: str) -> dict:
    d = require(dataset_id)
    inputs, outputs = [], []
    for n in d.order:
        nl = n.lower()
        if any(k in nl for k in _IN_KW):
            inputs.append(n)
        elif any(k in nl for k in _OUT_KW):
            outputs.append(n)
    return {"inputs": inputs, "outputs": outputs}


@router.post("/sysid/plan")
def sysid_plan(req: SysIdReq) -> dict:
    d = require(req.datasetId)
    inp, out = _io(d, req.inputs, req.outputs)
    dec = estimate_decimation_factor({**inp, **out}, d.sample_rate) if req.autoDecimate else 1
    n = d.time.size // max(dec, 1)
    return {
        "decimation": dec,
        "samples": int(n),
        "estimatedSeconds": estimate_time(n, len(req.inputs), len(req.outputs), req.orderMin, req.orderMax),
    }


@router.post("/sysid/estimate")
def sysid_estimate(req: SysIdReq) -> dict:
    d = require(req.datasetId)
    inp, out = _io(d, req.inputs, req.outputs)
    if not req.inputs or not req.outputs:
        raise HTTPException(400, "Select at least one input and one output")
    dec = estimate_decimation_factor({**inp, **out}, d.sample_rate) if req.autoDecimate else 1

    def work(jid: str) -> dict:
        results = identify_model(
            inp, out, d.sample_rate, name="Model", method=req.method,
            order_min=req.orderMin, order_max=req.orderMax, decimation_factor=dec,
            progress_callback=lambda p, msg: jobs.update(jid, p, msg),
        )
        best = _add(results[0]) if results else None  # auto-save the best-VAF model
        return {"sweep": [_summary(m) for m in results], "bestName": best}

    return {"jobId": jobs.run(work)}


@router.get("/jobs/{jid}")
def job_status(jid: str) -> dict:
    j = jobs.get(jid)
    if not j:
        raise HTTPException(404, "Unknown job")
    return j


# --- Model library -----------------------------------------------------------
class SaveModel(BaseModel):
    model: dict  # StateSpaceResult.to_dict()


class Rename(BaseModel):
    name: str


@router.get("/models")
def list_models() -> list[dict]:
    return [_summary(m) for m in _MODELS.values()]


@router.get("/models/{name}")
def get_model(name: str) -> dict:
    if name not in _MODELS:
        raise HTTPException(404, "Unknown model")
    return _MODELS[name].to_dict()


@router.post("/models")
def add_model(req: SaveModel) -> dict:
    return {"name": _add(StateSpaceResult.from_dict(req.model))}


@router.put("/models/{name}")
def rename_model(name: str, req: Rename) -> dict:
    if name not in _MODELS or req.name in _MODELS:
        raise HTTPException(400, "Invalid rename")
    m = _MODELS.pop(name)
    m.name = req.name
    _MODELS[req.name] = m
    return {"name": req.name}


@router.post("/models/{name}/duplicate")
def duplicate_model(name: str) -> dict:
    if name not in _MODELS:
        raise HTTPException(404, "Unknown model")
    data = _MODELS[name].to_dict()
    data["name"] = f"{name}_copy"
    return {"name": _add(StateSpaceResult.from_dict(data))}


@router.delete("/models/{name}")
def delete_model(name: str) -> dict:
    _MODELS.pop(name, None)
    return {"ok": True}


@router.get("/models-export")
def export_models() -> dict:
    return {"models": [m.to_dict() for m in _MODELS.values()]}


@router.post("/models-import")
def import_models(body: dict) -> dict:
    for md in body.get("models", []):
        _add(StateSpaceResult.from_dict(md))
    return {"count": len(_MODELS)}


# --- Simulation & validation -------------------------------------------------
class SimReq(BaseModel):
    datasetId: str
    models: list[str]


class ValReq(BaseModel):
    datasetId: str
    model: str


def _run_sim(d: ds.Dataset, m: StateSpaceResult):
    return sim_engine(m, d.arrays, d.arrays, d.time.astype(float))


@router.post("/simulate")
def simulate(req: SimReq) -> dict:
    d = require(req.datasetId)
    if not req.models:
        raise HTTPException(400, "No models selected")
    time = None
    outputs: list[dict] = []
    sims: list[dict] = []
    for name in req.models:
        if name not in _MODELS:
            raise HTTPException(404, f"Unknown model: {name}")
        m = _MODELS[name]
        r = _run_sim(d, m)
        if time is None:  # first model sets the reference (time + measured outputs)
            time = r.time
            outputs = [{"name": o, "measured": _floats(r.measured[o])} for o in m.output_names]
        sims.append({"model": name, "byOutput": {o: _floats(r.simulated[o]) for o in m.output_names}})
    return {"time": _floats(time), "outputs": outputs, "sims": sims}


@router.post("/validate")
def validate(req: ValReq) -> dict:
    d = require(req.datasetId)
    if req.model not in _MODELS:
        raise HTTPException(404, "Unknown model")
    m = _MODELS[req.model]
    r = _run_sim(d, m)

    dec = m.decimation_factor
    inp = {
        n: (sp_decimate(d.arrays[n].astype(float), dec, zero_phase=True) if dec > 1 else d.arrays[n].astype(float))
        for n in m.input_names
    }
    vr = validate_engine(r, inp)

    def analysis(a) -> dict:
        counts, edges = np.histogram(a.residuals, bins=30)
        return {
            "name": a.output_name,
            "residuals": _floats(a.residuals),
            "acf": {"lags": _floats(a.acf_lags), "acf": _floats(a.acf), "confidence": float(a.acf_confidence)},
            "shapiro": {"stat": a.shapiro_stat, "p": a.shapiro_p},
            "hist": {"counts": _floats(counts), "edges": _floats(edges)},
            "metrics": a.metrics.to_dict(),
        }

    return {
        "time": _floats(r.time),
        "outputs": [analysis(a) for a in vr.analyses],
        "inputXcorr": {o: {i: _floats(x) for i, x in ins.items()} for o, ins in vr.input_residual_xcorr.items()},
    }
