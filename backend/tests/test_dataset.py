from pathlib import Path

import pytest

from core.table_parser import HeaderMode, ImportOptions
from dataset import build_dataset


def _load(tmp_path: Path, header: str, rows: str):
    path = tmp_path / "data.csv"
    path.write_text(f"{header}\n{rows}", encoding="utf-8")
    return build_dataset(
        str(path),
        path.name,
        ImportOptions(header_mode=HeaderMode.FIRST_ROW),
    )


def test_numeric_minute_time_becomes_seconds_and_is_not_a_signal(
    tmp_path: Path,
) -> None:
    dataset = _load(tmp_path, "Force,Time [min]", "1,2.0\n2,2.5\n")

    assert dataset.time.tolist() == pytest.approx([0.0, 30.0])
    assert dataset.order == ["Force"]


def test_parenthesized_second_time_becomes_elapsed_seconds(
    tmp_path: Path,
) -> None:
    dataset = _load(tmp_path, "Force (N),Time (s)", "1,10.0\n2,10.25\n")

    assert dataset.time.tolist() == pytest.approx([0.0, 0.25])
    assert dataset.order == ["Force (N)"]
