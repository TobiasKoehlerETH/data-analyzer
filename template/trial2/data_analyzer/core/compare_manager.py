"""Compare manager: multi-file data store with alignment, matching, and statistics."""

from __future__ import annotations

import difflib
import re
import uuid
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pandas as pd
from PySide6.QtCore import QObject, Signal

from core.csv_parser import parse_csv


FILE_COLORS = [
    "#1f77b4", "#ff7f0e", "#2ca02c", "#d62728", "#9467bd",
    "#8c564b", "#e377c2", "#17becf", "#bcbd22", "#aec7e8",
    "#ffbb78", "#98df8a", "#ff9896", "#c5b0d5", "#c49c94",
]

MATCH_THRESHOLD = 0.7


@dataclass
class CompareFile:
    file_id: str
    path: str
    short_name: str
    time_array: np.ndarray
    signals: dict[str, np.ndarray]
    columns: list[str]
    offset: float = 0.0
    color: str = ""


@dataclass
class SignalMapping:
    """Maps a canonical signal name to actual column names in each file."""
    canonical_name: str
    file_columns: dict[str, str] = field(default_factory=dict)


@dataclass
class CompareStatistics:
    signal: str
    file_name: str
    rmse: float
    max_deviation: float
    r_squared: float
    mean_error: float


class CompareManager(QObject):
    files_changed = Signal()
    alignment_changed = Signal()
    mappings_changed = Signal()

    def __init__(self, parent: QObject | None = None) -> None:
        super().__init__(parent)
        self._files: dict[str, CompareFile] = {}
        self._file_order: list[str] = []
        self._mappings: list[SignalMapping] = []
        self._color_idx = 0

    @property
    def files(self) -> dict[str, CompareFile]:
        return self._files

    @property
    def file_order(self) -> list[str]:
        return self._file_order

    @property
    def mappings(self) -> list[SignalMapping]:
        return self._mappings

    @property
    def reference_file(self) -> CompareFile | None:
        if self._file_order:
            return self._files[self._file_order[0]]
        return None

    def add_file(self, path: str) -> str:
        """Load a CSV file and add to comparison. Returns file_id."""
        result = parse_csv(path)
        df = result.dataframe

        time_array, numeric_cols = self._extract_time_and_cols(df)

        signals: dict[str, np.ndarray] = {}
        columns: list[str] = []
        for col in numeric_cols:
            if pd.api.types.is_numeric_dtype(df[col]):
                signals[col] = df[col].values.astype(np.float64)
                columns.append(col)

        file_id = uuid.uuid4().hex[:8]
        color = FILE_COLORS[self._color_idx % len(FILE_COLORS)]
        self._color_idx += 1

        cf = CompareFile(
            file_id=file_id,
            path=path,
            short_name=Path(path).stem,
            time_array=time_array,
            signals=signals,
            columns=columns,
            offset=0.0,
            color=color,
        )
        self._files[file_id] = cf
        self._file_order.append(file_id)
        self._auto_match_signals()
        self.files_changed.emit()
        return file_id

    def remove_file(self, file_id: str) -> None:
        if file_id in self._files:
            del self._files[file_id]
            self._file_order.remove(file_id)
            for mapping in self._mappings:
                mapping.file_columns.pop(file_id, None)
            self._mappings = [m for m in self._mappings if m.file_columns]
            self.files_changed.emit()

    def clear(self) -> None:
        self._files.clear()
        self._file_order.clear()
        self._mappings.clear()
        self._color_idx = 0
        self.files_changed.emit()

    def set_offset(self, file_id: str, offset: float) -> None:
        if file_id in self._files:
            self._files[file_id].offset = offset
            self.alignment_changed.emit()

    def get_aligned_time(self, file_id: str) -> np.ndarray | None:
        cf = self._files.get(file_id)
        if cf is None:
            return None
        return cf.time_array + cf.offset

    def detect_trigger_offset(
        self, file_id: str, signal_col: str, threshold: float, rising: bool = True
    ) -> float:
        """Detect when signal crosses threshold. Returns crossing time."""
        cf = self._files.get(file_id)
        if cf is None or signal_col not in cf.signals:
            return 0.0

        data = cf.signals[signal_col]
        time = cf.time_array

        if rising:
            crossings = np.where((data[:-1] < threshold) & (data[1:] >= threshold))[0]
        else:
            crossings = np.where((data[:-1] > threshold) & (data[1:] <= threshold))[0]

        if len(crossings) == 0:
            return 0.0

        idx = crossings[0]
        d0, d1 = data[idx], data[idx + 1]
        if abs(d1 - d0) > 1e-12:
            frac = (threshold - d0) / (d1 - d0)
        else:
            frac = 0.0
        return float(time[idx] + frac * (time[idx + 1] - time[idx]))

    def align_by_trigger(self, signal_col: str, threshold: float, rising: bool = True) -> None:
        """Align all files by trigger crossing. First file is reference."""
        if not self._file_order:
            return

        ref_id = self._file_order[0]
        ref_col = self._resolve_column(ref_id, signal_col)
        if ref_col is None:
            return

        ref_time = self.detect_trigger_offset(ref_id, ref_col, threshold, rising)

        for fid in self._file_order:
            col = self._resolve_column(fid, signal_col)
            if col is None:
                continue
            t_cross = self.detect_trigger_offset(fid, col, threshold, rising)
            self._files[fid].offset = ref_time - t_cross

        self.alignment_changed.emit()

    def _resolve_column(self, file_id: str, canonical_name: str) -> str | None:
        cf = self._files.get(file_id)
        if cf is None:
            return None
        if canonical_name in cf.signals:
            return canonical_name
        for m in self._mappings:
            if m.canonical_name == canonical_name and file_id in m.file_columns:
                return m.file_columns[file_id]
        return None

    def compute_difference(
        self, canonical_signal: str, ref_file_id: str, target_file_id: str
    ) -> tuple[np.ndarray, np.ndarray] | None:
        """Compute (target - reference) interpolated onto reference time grid."""
        ref = self._files.get(ref_file_id)
        target = self._files.get(target_file_id)
        if ref is None or target is None:
            return None

        ref_col = self._resolve_column(ref_file_id, canonical_signal)
        tgt_col = self._resolve_column(target_file_id, canonical_signal)
        if ref_col is None or tgt_col is None:
            return None

        ref_time = ref.time_array + ref.offset
        tgt_time = target.time_array + target.offset
        ref_data = ref.signals[ref_col]
        tgt_data = target.signals[tgt_col]

        t_min = max(ref_time[0], tgt_time[0])
        t_max = min(ref_time[-1], tgt_time[-1])
        if t_min >= t_max:
            return None

        mask = (ref_time >= t_min) & (ref_time <= t_max)
        common_time = ref_time[mask]
        ref_vals = ref_data[mask]
        tgt_interp = np.interp(common_time, tgt_time, tgt_data)

        return common_time, tgt_interp - ref_vals

    def compute_statistics(
        self, canonical_signal: str, ref_file_id: str, target_file_id: str
    ) -> CompareStatistics | None:
        """Compute RMSE, max deviation, R-squared, mean error."""
        result = self.compute_difference(canonical_signal, ref_file_id, target_file_id)
        if result is None:
            return None

        common_time, diff = result
        target = self._files.get(target_file_id)
        ref = self._files.get(ref_file_id)
        if target is None or ref is None:
            return None

        rmse = float(np.sqrt(np.mean(diff ** 2)))
        max_dev = float(np.max(np.abs(diff)))
        mean_err = float(np.mean(diff))

        ref_col = self._resolve_column(ref_file_id, canonical_signal)
        ref_time = ref.time_array + ref.offset
        tgt_time = target.time_array + target.offset
        t_min = max(ref_time[0], tgt_time[0])
        t_max = min(ref_time[-1], tgt_time[-1])
        mask = (ref_time >= t_min) & (ref_time <= t_max)
        ref_vals = ref.signals[ref_col][mask]

        ss_res = np.sum(diff ** 2)
        ss_tot = np.sum((ref_vals - np.mean(ref_vals)) ** 2)
        r_squared = 1.0 - (ss_res / ss_tot) if ss_tot > 1e-12 else 0.0

        return CompareStatistics(
            signal=canonical_signal,
            file_name=target.short_name,
            rmse=rmse,
            max_deviation=max_dev,
            r_squared=float(r_squared),
            mean_error=mean_err,
        )

    def get_mapped_signals(self) -> list[str]:
        """Return canonical names that exist in at least 2 files."""
        return [m.canonical_name for m in self._mappings if len(m.file_columns) >= 2]

    def set_signal_mapping(self, canonical_name: str, file_id: str, column: str | None) -> None:
        """Manually override a signal mapping for a file."""
        for m in self._mappings:
            if m.canonical_name == canonical_name:
                if column is None:
                    m.file_columns.pop(file_id, None)
                else:
                    m.file_columns[file_id] = column
                self.mappings_changed.emit()
                return
        if column is not None:
            mapping = SignalMapping(canonical_name=canonical_name, file_columns={file_id: column})
            self._mappings.append(mapping)
            self.mappings_changed.emit()

    def _auto_match_signals(self) -> None:
        """Auto-match columns across files using fuzzy name matching."""
        if not self._file_order:
            self._mappings = []
            return

        ref_id = self._file_order[0]
        ref = self._files[ref_id]

        existing_canonical = {m.canonical_name for m in self._mappings}

        for col in ref.columns:
            canonical = self._get_canonical_name(col)
            if canonical not in existing_canonical:
                mapping = SignalMapping(canonical_name=canonical, file_columns={ref_id: col})
                self._mappings.append(mapping)
                existing_canonical.add(canonical)
            else:
                for m in self._mappings:
                    if m.canonical_name == canonical:
                        m.file_columns[ref_id] = col
                        break

        for fid in self._file_order[1:]:
            cf = self._files[fid]
            matched_cols: set[str] = set()

            for mapping in self._mappings:
                if fid in mapping.file_columns:
                    matched_cols.add(mapping.file_columns[fid])
                    continue

                best_score = 0.0
                best_col = None
                canonical_lower = mapping.canonical_name.lower()

                for col in cf.columns:
                    if col in matched_cols:
                        continue
                    col_canonical = self._get_canonical_name(col).lower()

                    if col_canonical == canonical_lower:
                        best_col = col
                        best_score = 1.0
                        break

                    score = difflib.SequenceMatcher(None, canonical_lower, col_canonical).ratio()
                    if score > best_score and score >= MATCH_THRESHOLD:
                        best_score = score
                        best_col = col

                if best_col is not None:
                    mapping.file_columns[fid] = best_col
                    matched_cols.add(best_col)

        self.mappings_changed.emit()

    @staticmethod
    def _get_canonical_name(col: str) -> str:
        match = re.match(r"^(.*?)\s*\[([^\]]*)\]\s*$", col)
        if match:
            return match.group(1).strip()
        return col.strip()

    @staticmethod
    def _extract_time_and_cols(df: pd.DataFrame) -> tuple[np.ndarray, list[str]]:
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
                time_array = (ts - epoch).dt.total_seconds().values.astype(np.float64)
            else:
                try:
                    time_array = ts.values.astype(np.float64)
                except (ValueError, TypeError):
                    time_array = np.arange(len(df), dtype=np.float64)
            numeric_cols = [c for c in df.columns if c != ts_col]
        else:
            time_array = np.arange(len(df), dtype=np.float64)
            numeric_cols = list(df.columns)

        return time_array, numeric_cols
