"""CSV parser with auto-detection and Raser DataLog format support.

Auto-detects delimiter, encoding, header row, and metadata.
Returns pandas DataFrame + metadata dict.
"""

from __future__ import annotations

import csv
import io
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import chardet
import numpy as np
import pandas as pd


@dataclass
class ParseResult:
    dataframe: pd.DataFrame
    metadata: dict[str, Any] = field(default_factory=dict)
    header_row: int = 0
    delimiter: str = ","
    encoding: str = "utf-8"
    is_raser_format: bool = False


def detect_encoding(file_path: str | Path, sample_size: int = 65536) -> str:
    with open(file_path, "rb") as f:
        raw = f.read(sample_size)
    if raw[:3] == b"\xef\xbb\xbf":
        return "utf-8-sig"
    if raw[:2] in (b"\xff\xfe", b"\xfe\xff"):
        return "utf-16"
    result = chardet.detect(raw)
    encoding = result.get("encoding", "utf-8") or "utf-8"
    encoding = encoding.lower().replace("ascii", "utf-8")

    # Validate detected encoding; fall back to latin-1 if it can't decode the sample
    try:
        raw.decode(encoding)
    except (UnicodeDecodeError, LookupError):
        encoding = "latin-1"

    return encoding


def _read_head_lines(file_path: str | Path, encoding: str, n: int = 40) -> list[str]:
    lines: list[str] = []
    with open(file_path, "r", encoding=encoding, errors="replace") as f:
        for i, line in enumerate(f):
            if i >= n:
                break
            lines.append(line.rstrip("\n\r"))
    return lines


def _detect_raser_format(lines: list[str]) -> tuple[bool, dict[str, Any]]:
    metadata: dict[str, Any] = {}
    if len(lines) < 3:
        return False, metadata
    if not lines[0].startswith("sep="):
        return False, metadata
    if not re.match(r"Log\s+V\d+\.\d+", lines[1]):
        return False, metadata

    metadata["format"] = "RaserDataLog"
    metadata["log_version"] = lines[1].strip()

    for line in lines[2:]:
        if not line.strip():
            continue
        if ";" in line and line.count(";") > 1:
            break
        if ":" in line and ";" not in line:
            key, _, val = line.partition(":")
            metadata[key.strip()] = val.strip()

    return True, metadata


def _detect_delimiter(lines: list[str], is_raser: bool, raser_lines: list[str]) -> str:
    if is_raser and raser_lines:
        match = re.match(r"sep=(.)", raser_lines[0])
        if match:
            return match.group(1)

    data_lines = [l for l in lines if l.strip() and not l.startswith("#")]
    if not data_lines:
        return ","

    sample = "\n".join(data_lines[-10:])
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=";,\t|")
        return dialect.delimiter
    except csv.Error:
        pass

    for delim in [";", ",", "\t", "|"]:
        counts = [l.count(delim) for l in data_lines[-10:]]
        if counts and min(counts) > 0 and max(counts) == min(counts):
            return delim

    return ","


def _is_numeric_str(s: str) -> bool:
    s = s.strip().strip('"').strip("'")
    if not s:
        return False
    try:
        float(s.replace(",", "."))
        return True
    except ValueError:
        return False


def _find_header_row(lines: list[str], delimiter: str) -> int:
    if not lines:
        return 0

    counts = [line.count(delimiter) for line in lines]

    # Determine the typical delimiter count from the tail lines (data rows)
    tail_size = min(10, len(lines))
    tail_counts = [c for c in counts[-tail_size:] if c > 0]
    if not tail_counts:
        # No delimiters found at all — fall back to row 0
        return 0

    from collections import Counter
    target_count = Counter(tail_counts).most_common(1)[0][0]

    # Among lines with the target delimiter count, find the first one that
    # looks like a header (majority of fields are non-numeric).
    for i, (count, line) in enumerate(zip(counts, lines)):
        if count != target_count:
            continue
        parts = [p.strip() for p in line.split(delimiter) if p.strip()]
        if not parts:
            continue
        numeric = sum(1 for p in parts if _is_numeric_str(p))
        if numeric < len(parts) * 0.5:
            return i

    # Fallback: return the first line with the target delimiter count
    for i, c in enumerate(counts):
        if c == target_count:
            return i

    return 0


def _parse_timestamp(ts_series: pd.Series) -> pd.Series | None:
    formats = [
        "%Y %m %d %H:%M:%S:%f",
        "%Y-%m-%d %H:%M:%S.%f",
        "%Y-%m-%d %H:%M:%S",
        "%Y/%m/%d %H:%M:%S",
        "%d.%m.%Y %H:%M:%S",
        "%d/%m/%Y %H:%M:%S",
    ]
    sample = ts_series.dropna().head(5)
    if sample.empty:
        return None

    for fmt in formats:
        try:
            pd.to_datetime(sample, format=fmt)
            return pd.to_datetime(ts_series, format=fmt, errors="coerce")
        except (ValueError, TypeError):
            continue

    try:
        return pd.to_datetime(ts_series, format="mixed", errors="coerce")
    except (ValueError, TypeError):
        pass

    try:
        return pd.to_datetime(ts_series, errors="coerce")
    except Exception:
        return None


def parse_csv(file_path: str | Path) -> ParseResult:
    file_path = Path(file_path)
    if not file_path.exists():
        raise FileNotFoundError(f"File not found: {file_path}")

    encoding = detect_encoding(file_path)
    head_lines = _read_head_lines(file_path, encoding, n=40)

    is_raser, metadata = _detect_raser_format(head_lines)
    delimiter = _detect_delimiter(head_lines, is_raser, head_lines)
    header_row = _find_header_row(head_lines, delimiter)

    df = pd.read_csv(
        file_path,
        sep=delimiter,
        header=0,
        skiprows=range(header_row) if header_row > 0 else None,
        encoding=encoding,
        engine="c",
        on_bad_lines="warn",
        low_memory=False,
    )

    # Drop fully-empty columns (trailing delimiters)
    df = df.dropna(axis=1, how="all")

    # Strip whitespace from column names
    df.columns = [c.strip() for c in df.columns]

    # Parse timestamp column first (before dropping non-numeric columns)
    ts_col = None
    for col in df.columns:
        if col.lower() in ("timestamp", "time", "date", "datetime", "zeit"):
            ts_col = col
            break
    if ts_col is None and len(df.columns) > 0:
        first_col = df.columns[0]
        if df[first_col].dtype == object:
            ts_col = first_col

    if ts_col:
        parsed = _parse_timestamp(df[ts_col])
        if parsed is not None and parsed.notna().sum() > len(parsed) * 0.5:
            df[ts_col] = parsed
        else:
            ts_col = None  # Parsing failed, treat as regular column

    # Drop columns with entirely non-numeric, non-timestamp content (e.g. stop reason strings)
    # but keep them in metadata
    cols_to_drop: list[str] = []
    for col in df.columns:
        if col == ts_col:
            continue  # Don't drop the successfully parsed timestamp column
        if df[col].dtype == object:
            numeric = pd.to_numeric(df[col], errors="coerce")
            non_null_ratio = numeric.notna().sum() / max(len(numeric), 1)
            if non_null_ratio < 0.5:
                unique_vals = df[col].dropna().unique()
                if len(unique_vals) > 0:
                    metadata[f"column_{col}"] = unique_vals.tolist()
                cols_to_drop.append(col)

    for col in cols_to_drop:
        if col in df.columns:
            df = df.drop(columns=[col])

    # Optimize numeric dtypes
    for col in df.select_dtypes(include=["float64"]).columns:
        col_data = df[col]
        if col_data.abs().max() < 1e6 and col_data.notna().all():
            df[col] = col_data.astype(np.float32)

    return ParseResult(
        dataframe=df,
        metadata=metadata,
        header_row=header_row,
        delimiter=delimiter,
        encoding=encoding,
        is_raser_format=is_raser,
    )
