# Sample Compare Import Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import both real sample compare CSVs as numeric time-series datasets and produce a two-file Force overlay with statistics.

**Architecture:** The format-neutral table parser recovers overwhelmingly numeric text columns and trims only leading rows that contain no recovered numeric data. The dataset builder then recognizes numeric time columns, normalizes their units to seconds, and excludes the selected time column from signals. Existing fuzzy signal matching and interpolation remain unchanged.

**Tech Stack:** Python 3.11, pandas, NumPy, FastAPI, pytest.

## Global Constraints

- Numeric recovery requires at least 90% of non-empty values to be finite numbers.
- Only leading non-data rows are trimmed; later missing values remain.
- Time units support seconds, minutes, and milliseconds.
- No filename, instrument, or vendor special cases.
- Existing user changes in `frontend/src-tauri/Cargo.toml` remain untouched.

---

### Task 1: Recover Numeric Columns

**Files:**
- Modify: `backend/tests/test_table_parser.py`
- Modify: `backend/core/table_parser.py`

**Interfaces:**
- Produces: `_coerce_columns(dataframe) -> dataframe` with tolerant numeric recovery and leading-row trimming

- [ ] **Step 1: Write the failing parser regression test**

```python
def test_numeric_columns_recover_after_leading_units_and_label_rows(tmp_path: Path) -> None:
    path = tmp_path / "instrument.csv"
    path.write_text(
        "Force,Distance,Time,Event,\n"
        "N,mm,min,,\n"
        "Sample 1,,,,\n"
        "-0.5,-0.08,0.0,0,\n"
        "1.5,0.10,0.5,1,\n",
        encoding="utf-8",
    )

    result = parse_table(path)

    assert result.dataframe[["Force", "Distance", "Time", "Event"]].values.tolist() == [
        [-0.5, -0.08, 0.0, 0],
        [1.5, 0.10, 0.5, 1],
    ]
```

- [ ] **Step 2: Run RED**

Run:

```powershell
$env:PYTHONPATH=(Resolve-Path backend).Path
backend\.venv\Scripts\python -m pytest backend\tests\test_table_parser.py::test_numeric_columns_recover_after_leading_units_and_label_rows -q
```

Expected: FAIL because unit and sample rows remain and measurement columns are text.

- [ ] **Step 3: Implement numeric recovery and leading-row trimming**

In `_coerce_columns`, compute numeric conversion for each text column. Accept
conversion when `numeric.notna().mean() >= 0.9`, replace nonnumeric cells with
`NaN`, then drop only the leading rows before the first row containing any
finite value in the recovered numeric columns.

- [ ] **Step 4: Run GREEN and the table parser suite**

```powershell
backend\.venv\Scripts\python -m pytest backend\tests\test_table_parser.py -q
```

Expected: all table-parser tests PASS.

### Task 2: Numeric Time Axis

**Files:**
- Create: `backend/tests/test_dataset.py`
- Modify: `backend/dataset.py`

**Interfaces:**
- Produces: `_time_and_signals(df) -> (elapsed_seconds, numeric_signal_columns)`

- [ ] **Step 1: Write failing dataset tests**

```python
def test_numeric_minute_time_becomes_seconds_and_is_not_a_signal(tmp_path: Path) -> None:
    path = tmp_path / "data.csv"
    path.write_text("Force,Time\n1,2.0\n2,2.5\n", encoding="utf-8")
    dataset = build_dataset(
        str(path),
        path.name,
        ImportOptions(header_mode=HeaderMode.FIRST_ROW),
    )
    assert dataset.time.tolist() == pytest.approx([0.0, 30.0])
    assert dataset.order == ["Force"]
```

Use `Time [min]` in the fixture so `_parse_name` provides the unit. Add a
second test for `Time (s)` using factor 1.

- [ ] **Step 2: Run RED**

```powershell
backend\.venv\Scripts\python -m pytest backend\tests\test_dataset.py -q
```

Expected: FAIL because numeric time is currently a signal and time is a row index.

- [ ] **Step 3: Implement time-name and unit parsing**

Recognize time names after removing parenthesized or bracketed units. Parse
units from either notation, apply factors `s=1`, `min=60`, `ms=0.001`, subtract
the first finite value, and exclude the time column from returned signal names.

- [ ] **Step 4: Run GREEN**

```powershell
backend\.venv\Scripts\python -m pytest backend\tests\test_dataset.py -q
```

Expected: all dataset tests PASS.

### Task 3: Real Sample Comparison Regression

**Files:**
- Create: `backend/tests/test_sample_compare.py`

**Interfaces:**
- Consumes: `build_dataset`, `dataset.put`, and `routers.compare.overlay`
- Produces: regression coverage for both real `sample_compare` files

- [ ] **Step 1: Write the real-file integration test**

Load both sample files with default import options, register them, and call:

```python
result = overlay(
    OverlayReq(
        datasetIds=[force.id, capacitance.id],
        signal="Force",
        offsets={},
    )
)
assert result["matchedColumn"] == "Force"
assert len(result["files"]) == 2
assert len(result["stats"]) == 1
assert len(result["time"]) > 1000
```

Also assert `Force` exists in the first dataset, `Force (N)` exists in the
second, and both time arrays start at zero and increase.

- [ ] **Step 2: Run the integration test**

```powershell
backend\.venv\Scripts\python -m pytest backend\tests\test_sample_compare.py -q
```

Expected: PASS after Tasks 1 and 2; otherwise return to the failing boundary.

- [ ] **Step 3: Run full verification**

```powershell
$env:PYTHONPATH=(Resolve-Path backend).Path
backend\.venv\Scripts\python -m pytest backend\tests template\trial2\data_analyzer\tests -q
npm --prefix frontend test -- --pool=threads
npm --prefix frontend run build
git diff --check
```

Expected: all Python and frontend tests PASS, build exits 0, and no whitespace errors.

- [ ] **Step 4: Commit**

```powershell
git add -- backend/core/table_parser.py backend/dataset.py backend/tests/test_table_parser.py backend/tests/test_dataset.py backend/tests/test_sample_compare.py
git commit -m "Fix import of sample comparison files"
```

