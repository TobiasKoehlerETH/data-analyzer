"""Qt-free in-memory dataset built on the original `core.csv_parser`.

Replaces the Qt-coupled DataManager: same load logic (time extraction, signal
name/unit parsing), but plain data classes and an in-process registry.
"""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from core.table_parser import ImportOptions, parse_table

_NAME_RE = re.compile(r"^(.*?)\s*\[([^\]]*)\]\s*$")


def _parse_name(col: str) -> tuple[str, str]:
    """'Motor_Torque [Nm]' -> ('Motor_Torque', 'Nm')."""
    m = _NAME_RE.match(col)
    return (m.group(1).strip(), m.group(2).strip()) if m else (col.strip(), "")


def _unique(name: str, taken: set[str], fallback: str) -> str:
    return name if name and name not in taken else fallback


@dataclass
class Dataset:
    id: str
    filename: str
    time: np.ndarray  # float32 elapsed seconds
    arrays: dict[str, np.ndarray]  # signal name -> float32 samples
    units: dict[str, str]
    order: list[str]  # signal names in column order
    raser: bool
    info: dict[str, str]  # scalar header metadata
    preview: dict = field(default_factory=dict)  # {columns, rows}
    table: pd.DataFrame = field(default_factory=pd.DataFrame, repr=False)
    columns: list[dict[str, str]] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    sheet: str | None = None

    @property
    def sample_rate(self) -> float:
        if self.time.size > 1:
            dt = float(np.median(np.diff(self.time)))
            if dt > 0:
                return 1.0 / dt
        return 1.0

    @property
    def duration(self) -> float:
        return float(self.time[-1] - self.time[0]) if self.time.size else 0.0


def _time_and_signals(df: pd.DataFrame) -> tuple[np.ndarray, list[str]]:
    """Return (elapsed-seconds time array, list of numeric signal columns)."""
    ts_col = next(
        (c for c in df.columns if pd.api.types.is_datetime64_any_dtype(df[c])), None
    )
    if ts_col is not None:
        t = (df[ts_col] - df[ts_col].iloc[0]).dt.total_seconds().to_numpy()
        cols = [c for c in df.columns if c != ts_col]
    else:
        t = np.arange(len(df), dtype=float)
        cols = list(df.columns)
    numeric = [c for c in cols if pd.api.types.is_numeric_dtype(df[c])]
    return t.astype(np.float32), numeric


def _preview(df: pd.DataFrame, n: int = 100) -> dict:
    head = df.head(n).copy()
    for c in head.columns:
        if pd.api.types.is_datetime64_any_dtype(head[c]):
            head[c] = head[c].dt.strftime("%Y-%m-%d %H:%M:%S")

    def cell(v: object) -> object:
        if pd.isna(v):
            return None
        if isinstance(v, np.floating):
            return round(float(v), 4)
        if isinstance(v, np.integer):
            return int(v)
        if isinstance(v, pd.Timestamp):
            return v.isoformat()
        return v

    rows = [[cell(v) for v in row] for row in head.itertuples(index=False)]
    return {"columns": list(head.columns), "rows": rows}


def build_dataset(
    path: str, filename: str, options: ImportOptions | None = None
) -> Dataset:
    result = parse_table(path, options)
    df = result.dataframe
    time, cols = _time_and_signals(df)

    arrays: dict[str, np.ndarray] = {}
    units: dict[str, str] = {}
    order: list[str] = []
    for col in cols:
        name, unit = _parse_name(col)
        name = _unique(name, set(arrays), col)
        arrays[name] = df[col].to_numpy(dtype=np.float32)
        units[name] = unit
        order.append(name)

    info = {k: str(v) for k, v in result.metadata.items() if isinstance(v, (str, int, float))}
    return Dataset(
        id=uuid.uuid4().hex[:8],
        filename=filename,
        time=time,
        arrays=arrays,
        units=units,
        order=order,
        raser=result.is_raser_format,
        info=info,
        preview=_preview(df),
        table=df,
        columns=[
            {"name": str(column), "type": result.column_types[str(column)]}
            for column in df.columns
        ],
        warnings=result.warnings,
        sheet=result.sheet,
    )


# --- in-process registry -----------------------------------------------------
_DATASETS: dict[str, Dataset] = {}


def put(ds: Dataset) -> None:
    _DATASETS[ds.id] = ds


def get(dataset_id: str) -> Dataset:
    if dataset_id not in _DATASETS:
        raise KeyError(dataset_id)
    return _DATASETS[dataset_id]


def signal_stats(ds: Dataset) -> list[dict]:
    """Per-signal summary used by the /signals endpoint (NaN-aware)."""
    out = []
    for name in ds.order:
        a = ds.arrays[name]
        out.append(
            {
                "name": name,
                "unit": ds.units[name],
                "min": float(np.nanmin(a)) if a.size else 0.0,
                "max": float(np.nanmax(a)) if a.size else 0.0,
                "mean": float(np.nanmean(a)) if a.size else 0.0,
                "std": float(np.nanstd(a)) if a.size else 0.0,
            }
        )
    return out
