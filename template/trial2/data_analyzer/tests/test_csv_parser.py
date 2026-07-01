"""Tests for CSV parser: auto-detection, Raser format, generic CSV."""

import os
import tempfile
import pytest
import pandas as pd

from core.csv_parser import parse_csv, detect_encoding, _detect_raser_format, _read_head_lines


def _write_temp(content: str, suffix=".csv") -> str:
    fd, path = tempfile.mkstemp(suffix=suffix)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(content)
    return path


class TestDetectEncoding:
    def test_utf8(self):
        path = _write_temp("a,b,c\n1,2,3\n")
        enc = detect_encoding(path)
        assert "utf" in enc.lower()
        os.unlink(path)


class TestRaserFormat:
    def test_raser_detected(self):
        lines = [
            "sep=;",
            "Log V1.1",
            "User:TESTER",
            "Description:Test run",
            "",
            "Timestamp;Signal_A [V];Signal_B [mA];",
        ]
        is_raser, meta = _detect_raser_format(lines)
        assert is_raser is True
        assert meta["User"] == "TESTER"
        assert meta["format"] == "RaserDataLog"

    def test_non_raser(self):
        lines = ["a,b,c", "1,2,3"]
        is_raser, _ = _detect_raser_format(lines)
        assert is_raser is False


class TestParseCSV:
    def test_simple_csv(self):
        content = "x,y,z\n1.0,2.0,3.0\n4.0,5.0,6.0\n7.0,8.0,9.0\n"
        path = _write_temp(content)
        result = parse_csv(path)
        assert len(result.dataframe) == 3
        assert result.delimiter == ","
        assert result.is_raser_format is False
        os.unlink(path)

    def test_semicolon_csv(self):
        content = "a;b;c\n1;2;3\n4;5;6\n"
        path = _write_temp(content)
        result = parse_csv(path)
        assert result.delimiter == ";"
        assert len(result.dataframe.columns) == 3
        os.unlink(path)

    def test_raser_format_csv(self):
        content = (
            "sep=;\n"
            "Log V1.1\n"
            "User:TEST\n"
            "Description:Unit test\n"
            "\n"
            "Timestamp;Signal_A [V];Signal_B [mA]\n"
            "2024 01 01 00:00:00:000;1.5;2.5\n"
            "2024 01 01 00:00:01:000;1.6;2.6\n"
        )
        path = _write_temp(content)
        result = parse_csv(path)
        assert result.is_raser_format is True
        assert "User" in result.metadata
        assert len(result.dataframe) == 2
        os.unlink(path)

    def test_file_not_found(self):
        with pytest.raises(FileNotFoundError):
            parse_csv("/nonexistent/path.csv")
