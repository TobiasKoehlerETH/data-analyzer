# Build a Desktop Data Analyzer for Industrial Time-Series CSV Files

## Goal

Build a **Python desktop application** for loading, exploring, filtering, correlating, and modelling time-series data from industrial test benches. The data lives in CSV files that can be large (~100K+ rows, 40+ signals sampled at 1 Hz). The application should feel snappy on that scale.

Use **PySide6** for the GUI, **pyqtgraph** for interactive plots (it handles 100K+ points at 60 fps out of the box with downsampling), and the standard scientific Python stack (pandas, numpy, scipy). Organize the code as a clean separation of **core engines** (pure logic, no Qt) and **UI widgets** (thin wrappers that call the engines).

---

## Data Format

The primary format is a proprietary "Raser DataLog" CSV, but the loader must work with **any** CSV:

- **Raser files** start with ~15 lines of metadata (`sep=;`, `Log V1.x`, key:value pairs like `User:`, `Description:`, `SealL:`, `OilL:`, `ShaftD:`, …), followed by a blank line, then a semicolon-delimited header row with units in brackets (`Motor_Torque [Nm]`), then data rows.
- **Generic CSVs** may use commas, tabs, pipes, or semicolons; may or may not have a header; may use any encoding.

The parser should **auto-detect**: encoding (with `chardet`, falling back to `latin-1` when chardet is wrong), delimiter, header-row position (by counting delimiters and distinguishing text headers from numeric data), and whether it's a Raser file. Extract metadata when present. Parse timestamps (Raser uses `YYYY MM DD HH:MM:SS:mmm`). Drop empty trailing columns and non-numeric columns (stash them in metadata).

### Important pitfall
`pd.read_csv(header=N)` breaks when pre-header rows have inconsistent column counts. Use `skiprows=range(N), header=0` instead.

---

## Functional Areas

The application should have a tabbed interface covering these areas. Design the UI however makes sense — the descriptions below are about **what** each area does, not how it should look.

### 1. File Loading & Preview

- Browse and load a CSV file on a **background thread** (the UI must never freeze).
- Show a preview of the first ~100 rows and the detected metadata/format info.
- After loading, pre-compute basic statistics and a Pearson correlation matrix in the background so later tabs open instantly.

### 2. Time-Series Plotting

- Let the user select signals and plot them as stacked time-series sharing a linked X axis (time in seconds).
- Use pyqtgraph with `setDownsampling(auto=True, mode='peak')` and `setClipToView(True)` for performance.
- Provide a crosshair that tracks the mouse and shows coordinates.

### 3. Multi-File Comparison

- Load multiple CSV files side by side.
- **Auto-match** signals across files using fuzzy string matching (`difflib.SequenceMatcher`, threshold ~0.7) with manual override.
- **Time alignment**: manual offset, click-to-align, or trigger-based (detect a threshold crossing on a chosen signal).
- Show overlay plots (one trace per file per signal, color-coded) and comparison statistics (RMSE, correlation, max difference).

### 4. Signal Filtering

- Support a **filter chain**: an ordered list of filter steps the user can add, remove, reorder, and enable/disable individually.
- Filter types (all via `scipy.signal`):
  - Butterworth: lowpass, highpass, bandpass, bandstop (`sosfiltfilt`)
  - Savitzky-Golay, Moving Average, Exponential Moving Average, Median, Notch
- **Live preview** on a downsampled version (~5K points) that updates instantly as parameters change. "Apply" button runs on full data.
- **Auto-suggest filters** by analyzing the signal's PSD:
  - High noise floor → suggest lowpass at the knee frequency
  - Outlier spikes (>4σ from rolling median) → suggest median filter
  - Prominent PSD peaks → suggest notch filters at those frequencies
  - Low-frequency drift (low-freq power ≫ mid-freq) → suggest highpass
- Save / load filter chains as JSON.

### 5. Spectrum Analysis

- Compute and plot **FFT magnitude** and **Welch PSD** for a selected signal.
- Detect and annotate spectral peaks.
- Show before/after overlay when the signal has been filtered.
- Provide an interactive draggable line to explore cutoff frequencies.

### 6. Correlation Analysis

- Display the full **Pearson correlation matrix** as a heatmap (use matplotlib for this — pyqtgraph doesn't do heatmaps well).
- Rank and list the top ~20 most correlated signal pairs.
- On selection, show a scatter plot and an **FFT-based cross-correlation** lag plot.
- Compute Spearman rank correlation as well (subsample to ~20K for speed).
- Only compute cross-correlation lags for the top-N pairs, never all N² — it's too slow.

### 7. System Identification (State-Space Models)

- Identify **discrete-time MIMO state-space models** (A, B, C, D matrices) from selected input and output signals.
- Methods: N4SID, MOESP, CVA — use `sippy` if available, otherwise implement a basic N4SID fallback (block Hankel matrices → QR → truncated SVD → extract A/C from observability matrix → least-squares for B/D).
- **Auto-suggest I/O mapping**: setpoints / heaters / valves → inputs; temperatures / pressures / leakage → outputs.
- **Order sweep**: identify models across a range of orders (e.g. 2–10) and plot VAF vs. order so the user can pick the best.
- **Auto-decimation**: analyze output signal bandwidths via PSD, find the highest knee frequency, and decimate to ~4× that frequency. This is critical — a 110K-sample thermal signal decimated 50× becomes 2.2K samples and identifies in seconds instead of minutes.
- Show estimated computation time before starting, and run on a background thread with progress reporting.

### 8. Model Library

- Store identified models in a named collection (CRUD: add, rename, duplicate, delete).
- Save / load the entire library as JSON (matrices serialized as nested lists).
- Compare selected models side-by-side (metrics table).
- Show model details on request (matrices, I/O names, per-output metrics).

### 9. Simulation

- Select a model from the library and feed the **real measured inputs** through it to produce simulated outputs.
- Overlay measured (solid) vs. simulated (dashed) on stacked per-output plots.
- Support overlaying multiple models on the same plot for visual comparison.
- **Auto-estimate initial state x₀** via least-squares on the observability matrix (Γ·x₀ ≈ Y_corrected).
- Handle decimation consistently with how the model was identified (decimate the input data the same way).

### 10. Validation

For a given simulation result, provide:

- **Residual time series** (measured − simulated) with zero line.
- **Residual histogram** with fitted normal curve and Shapiro-Wilk normality test.
- **Autocorrelation function (ACF)** of residuals with 95% confidence bounds (±1.96/√n). Good models have white-noise residuals (ACF ≈ 0 for lag > 0).
- **Input-residual cross-correlation** per input — should be near zero if the model captured the dynamics.
- **Metrics table**: RMSE, NRMSE (%), MAE, R², VAF (%) per output.

### 11. Report Export

- Generate an **HTML or PDF report** containing user-selected sections: metadata, statistics table, signal plots, applied filters, correlation results, model details, simulation plots, validation results.
- Use Jinja2 for HTML templating with inline CSS. Embed plots as base64 PNGs rendered via matplotlib.
- PDF via weasyprint (with graceful fallback to HTML-only if weasyprint fails).
- Generate on a background thread.

---

## Cross-Cutting Concerns

### Performance & Caching

- **Cache computed results** (stats, PSD, FFT, correlations) in a thread-safe dict keyed by `(signal_name, operation, params_hash)`. Invalidate per-signal when a filter is applied.
- **All heavy work on background threads** (`QThreadPool` + `QRunnable`) with progress and ETA reporting in the status bar.
- Use `float32` for signal storage where safe (values < 1e6, no NaN) to halve memory.

### Architecture

- `core/` — pure computation engines (no Qt imports except `QObject` for signals in the data manager and model manager).
- `models/` — plain dataclasses: `SignalMetadata`, `FilterStep`/`FilterChain`/`FilterSuggestion`, `StateSpaceResult`/`OutputMetrics`.
- `ui/` — one widget per tab, a main window that wires them together.
- `main.py` — entry point. **Must import pandas/numpy/dateutil/matplotlib before PySide6** to avoid a shiboken/six.moves conflict.

### Testing

- Unit tests for each core engine using pytest.
- Test against synthetic data with known properties (known sinusoid frequencies, known correlations, known state-space systems).
- Performance benchmarks: CSV load <2s, stats <0.5s, correlation matrix <0.5s, single filter <100ms, PSD <200ms on 110K rows.

---

## Suggested Tech Stack

| Purpose | Library |
|---------|---------|
| GUI | PySide6 |
| Interactive plots | pyqtgraph |
| Static plots / reports | matplotlib |
| Data | pandas, numpy |
| Signal processing | scipy |
| System ID | sippy-sa (with custom N4SID fallback) |
| Control systems | python-control |
| Reports | Jinja2, weasyprint |
| Encoding detection | chardet |
| Dates | python-dateutil |

---

## Pitfalls to Avoid

1. **Import order**: PySide6's shiboken clashes with `six.moves` (used by dateutil). Import the scientific stack first in the entry point.
2. **chardet lies**: it often returns `big5` for European latin-1 files. Validate by decoding a sample, fall back to `latin-1`.
3. **`pd.read_csv(header=N)` with messy pre-header rows**: use `skiprows` instead.
4. **Cross-correlation on all signal pairs**: O(N² · n log n) — only compute for the top-K Pearson pairs.
5. **System ID on raw 110K samples**: always decimate first based on signal bandwidth. A 1 Hz thermal signal only needs ~0.02 Hz sampling.
6. **pyqtgraph downsampling mode**: use `'peak'` not `'mean'` — mean hides transient spikes on zoom-out.
