"""Output area: assemble an HTML report from the reused report_generator."""

from __future__ import annotations

import tempfile

import pandas as pd
from fastapi import APIRouter
from pydantic import BaseModel

import dataset as ds
import jobs
from routers.dataset import require
from routers.modelling import _MODELS

from core.correlation_engine import compute_correlation_matrix
from core.report_generator import _fig_to_base64, generate_report, render_signal_plot

router = APIRouter(tags=["report"])


class ReportReq(BaseModel):
    datasetId: str
    sections: list[str]  # metadata | stats | plots | correlation | models
    signals: list[str] = []
    models: list[str] = []


def _corr_plot(d: ds.Dataset):
    import matplotlib.pyplot as plt

    res = compute_correlation_matrix(d.arrays)
    fig, ax = plt.subplots(figsize=(8, 6))
    im = ax.imshow(res.pearson_matrix, cmap="RdBu_r", vmin=-1, vmax=1)
    ax.set_xticks(range(len(res.columns)))
    ax.set_xticklabels(res.columns, rotation=90, fontsize=6)
    ax.set_yticks(range(len(res.columns)))
    ax.set_yticklabels(res.columns, fontsize=6)
    fig.colorbar(im, fraction=0.046)
    fig.tight_layout()
    return _fig_to_base64(fig), res.top_pairs


@router.post("/report")
def report(req: ReportReq) -> dict:
    d = require(req.datasetId)

    def work(jid: str) -> dict:
        kw: dict = {}
        if "metadata" in req.sections:
            kw["metadata"] = {"File": d.filename, **d.info}
        if "stats" in req.sections:
            stats = [s for s in ds.signal_stats(d) if not req.signals or s["name"] in req.signals]
            kw["stats_df"] = pd.DataFrame(stats)
        if "plots" in req.sections and req.signals:
            sigs = {n: d.arrays[n] for n in req.signals if n in d.arrays}
            kw["signal_plots"] = [
                {"title": "Selected signals", "data": render_signal_plot(d.time.astype(float), sigs)}
            ]
        if "correlation" in req.sections:
            plot, pairs = _corr_plot(d)
            kw["correlation_plot_data"] = plot
            kw["correlation_pairs"] = pairs
        if "models" in req.sections:
            kw["models_info"] = [
                {
                    "name": m.name,
                    "method": m.method,
                    "order": m.order,
                    "input_names": m.input_names,
                    "output_names": m.output_names,
                    "metrics_table": [mm.to_dict() for mm in m.metrics],
                }
                for name, m in _MODELS.items()
                if not req.models or name in req.models
            ]

        with tempfile.NamedTemporaryFile(delete=False, suffix=".html", mode="w", encoding="utf-8") as tmp:
            path = tmp.name
        generate_report(path, "html", progress_callback=lambda p, m: jobs.update(jid, p, m), **kw)
        return {"html": open(path, encoding="utf-8").read()}

    return {"jobId": jobs.run(work)}
