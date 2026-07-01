"""Central data store for loaded signals, filtered views, and metadata.

Singleton-like manager holding numpy arrays, signal metadata, filter chains.
Integrates CacheManager and emits Qt signals on data changes.
"""

from __future__ import annotations

import re
from typing import Any

import numpy as np
import pandas as pd
from PySide6.QtCore import QObject, Signal

from core.cache_manager import CacheManager


SIGNAL_GROUPS = {
    "Motor": ["motor", "shaft_rpm", "shaft_speed"],
    "Leakage": ["leak", "leakage"],
    "Temperature": ["t_left", "t_right", "t_probe", "temperature", "temp"],
    "Pressure": ["pressure"],
    "Vibration": ["vibration"],
    "Heater": ["heater"],
    "Setpoint": ["setpoint"],
    "Cooling": ["water_valve"],
    "Limits": ["max_", "min_"],
}


def _parse_signal_name(col: str) -> tuple[str, str, str]:
    """Parse column header like 'Motor_Torque [Nm]' into (name, unit, group)."""
    match = re.match(r"^(.*?)\s*\[([^\]]*)\]\s*$", col)
    if match:
        name = match.group(1).strip()
        unit = match.group(2).strip()
    else:
        name = col.strip()
        unit = ""

    col_lower = col.lower()
    group = "Other"
    for grp, keywords in SIGNAL_GROUPS.items():
        if any(kw in col_lower for kw in keywords):
            group = grp
            break

    return name, unit, group


class SignalInfo:
    __slots__ = ("column", "name", "unit", "group", "index")

    def __init__(self, column: str, name: str, unit: str, group: str, index: int) -> None:
        self.column = column
        self.name = name
        self.unit = unit
        self.group = group
        self.index = index

    def label(self) -> str:
        if self.unit:
            return f"{self.name} [{self.unit}]"
        return self.name


class DataManager(QObject):
    data_loaded = Signal()
    data_changed = Signal(str)  # signal_name
    filter_applied = Signal(str)  # signal_name

    def __init__(self, parent: QObject | None = None) -> None:
        super().__init__(parent)
        self.cache = CacheManager()

        self._dataframe: pd.DataFrame | None = None
        self._time_array: np.ndarray | None = None
        self._signals: dict[str, SignalInfo] = {}
        self._data_arrays: dict[str, np.ndarray] = {}
        self._filtered_arrays: dict[str, np.ndarray] = {}
        self._metadata: dict[str, Any] = {}
        self._filter_chains: dict[str, Any] = {}

    @property
    def is_loaded(self) -> bool:
        return self._dataframe is not None

    @property
    def metadata(self) -> dict[str, Any]:
        return self._metadata

    @property
    def signals(self) -> dict[str, SignalInfo]:
        return self._signals

    @property
    def signal_names(self) -> list[str]:
        return list(self._signals.keys())

    @property
    def time_array(self) -> np.ndarray | None:
        return self._time_array

    @property
    def n_samples(self) -> int:
        if self._time_array is not None:
            return len(self._time_array)
        return 0

    @property
    def sample_rate(self) -> float:
        if self._time_array is not None and len(self._time_array) > 1:
            dt = np.median(np.diff(self._time_array))
            if dt > 0:
                return 1.0 / dt
        return 1.0

    def load_dataframe(self, df: pd.DataFrame, metadata: dict[str, Any] | None = None) -> None:
        self.cache.invalidate_all()
        self._signals.clear()
        self._data_arrays.clear()
        self._filtered_arrays.clear()
        self._filter_chains.clear()
        self._metadata = metadata or {}
        self._dataframe = df

        # Extract time array
        self._time_array = None
        ts_col = None
        for col in df.columns:
            if hasattr(df[col], "dt"):
                try:
                    _ = df[col].dt.year
                    ts_col = col
                    break
                except (AttributeError, TypeError):
                    pass
            elif col.lower() in ("timestamp", "time", "date", "datetime"):
                ts_col = col
                break

        if ts_col is not None:
            ts = df[ts_col]
            if pd.api.types.is_datetime64_any_dtype(ts):
                epoch = ts.iloc[0]
                self._time_array = (ts - epoch).dt.total_seconds().values.astype(np.float64)
            else:
                self._time_array = np.arange(len(df), dtype=np.float64)
            numeric_cols = [c for c in df.columns if c != ts_col]
        else:
            self._time_array = np.arange(len(df), dtype=np.float64)
            numeric_cols = list(df.columns)

        idx = 0
        for col in numeric_cols:
            if pd.api.types.is_numeric_dtype(df[col]):
                name, unit, group = _parse_signal_name(col)
                info = SignalInfo(col, name, unit, group, idx)
                self._signals[col] = info
                self._data_arrays[col] = df[col].values.astype(np.float64)
                idx += 1

        self.data_loaded.emit()

    def get_signal(self, col: str, filtered: bool = True) -> np.ndarray | None:
        if filtered and col in self._filtered_arrays:
            return self._filtered_arrays[col]
        return self._data_arrays.get(col)

    def get_raw_signal(self, col: str) -> np.ndarray | None:
        return self._data_arrays.get(col)

    def set_filtered_signal(self, col: str, data: np.ndarray) -> None:
        self._filtered_arrays[col] = data
        self.cache.invalidate_signal(col)
        self.filter_applied.emit(col)
        self.data_changed.emit(col)

    def clear_filtered_signal(self, col: str) -> None:
        self._filtered_arrays.pop(col, None)
        self.cache.invalidate_signal(col)
        self.data_changed.emit(col)

    def has_filtered(self, col: str) -> bool:
        return col in self._filtered_arrays

    def set_filter_chain(self, col: str, chain: Any) -> None:
        self._filter_chains[col] = chain

    def get_filter_chain(self, col: str) -> Any | None:
        return self._filter_chains.get(col)

    def get_numeric_columns(self) -> list[str]:
        return list(self._data_arrays.keys())

    def get_signals_by_group(self) -> dict[str, list[SignalInfo]]:
        groups: dict[str, list[SignalInfo]] = {}
        for info in self._signals.values():
            groups.setdefault(info.group, []).append(info)
        return groups

    def get_dataframe_slice(self, columns: list[str], filtered: bool = True) -> pd.DataFrame:
        data = {}
        for col in columns:
            arr = self.get_signal(col, filtered=filtered)
            if arr is not None:
                data[col] = arr
        return pd.DataFrame(data)

    def clear(self) -> None:
        self.cache.invalidate_all()
        self._dataframe = None
        self._time_array = None
        self._signals.clear()
        self._data_arrays.clear()
        self._filtered_arrays.clear()
        self._metadata.clear()
        self._filter_chains.clear()
