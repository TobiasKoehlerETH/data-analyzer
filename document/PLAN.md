# Rebuild an Optimized UI for the Data Analyzer

## Context

The original software (`template/trial2/data_analyzer/`) is a **PySide6 desktop application** for
analyzing industrial time-series CSV files ("Raser DataLog" and generic CSVs, ~100K+ rows × 40+
signals). It covers 11 functional areas: file load/preview, time-series plotting, multi-file
comparison, filtering, spectrum/FFT, correlation, system identification (state-space), a model
library, simulation, validation, and report export. Its computation lives in `core/` engines that
are already **pure Python with no Qt dependencies** — ideal for reuse.

We are rebuilding the **UI** as a modern, optimized app while **reusing the proven Python numerics
unchanged**. The tabbed Qt interface is replaced by a React + shadcn/ui shell (the `sidebar-08`
block). Goal: same behaviour and functionality, but a snappier, cleaner, better-organized UI and
workflow — with minimal, readable, maintainable code.

## Decisions

| Area | Decision |
|---|---|
| Architecture | **Web app now, Tauri packaging last.** React/shadcn frontend + Python FastAPI backend reusing the existing `core/` engines. Tauri wraps the *same* web build for a native desktop feel at the end. |
| Frontend stack | Vite + React + TypeScript + Tailwind + shadcn/ui + lucide icons |
| App shell | shadcn `sidebar-08` block, nav re-grouped by workflow |
| Backend comms | Local FastAPI/uvicorn server on `127.0.0.1`; job-polling for long jobs |
| Scope | All 11 functional areas |
| Charts | uPlot (time-series/spectrum) + canvas heatmap (correlation) + shadcn charts (small stat cards) |
| Data flow | Ship full-resolution arrays to client as binary Float32; client-side downsampling via uPlot |
| App state | Global Zustand store (dataset, selected signals, filter chain, model library, sim results) |
| Navigation | Grouped by workflow (Data / Signal Processing / Modelling / Output) + Overview home |
| Theme | Light-first with dark toggle; neutral shadcn base + one accent + categorical trace palette |
| Principles | Minimal LOC, readability, maintainability. Reuse Python numerics — do NOT rewrite math in JS. |

## Reuse (do NOT rewrite)

FastAPI is a thin wrapper over the existing engines — copy verbatim and import:

- `core/`: data_manager, csv_parser, statistics_engine, filter_engine, spectrum_engine,
  correlation_engine, simulation_engine, sysid_engine, validation_engine, compare_manager,
  model_manager, report_generator, cache_manager
- `models/`: signal_model, filter_model, sysid_model
- `resources/report_template.html`

Only the Qt-signal progress bits in data_manager/model_manager get replaced by plain
callbacks/job-status updates.

## Project Structure (new, at repo root)

```
/
├── document/                # PLAN.md + PROGRESS.md handover docs
├── backend/                 # Python FastAPI server
│   ├── app.py               # FastAPI app + routers; uvicorn entry
│   ├── routers/             # load, plot, filter, spectrum, correlation, sysid, models, sim, validation, report
│   ├── jobs.py              # in-process job registry (status/progress/result)
│   ├── serialization.py     # Float32 binary array responses + JSON metadata
│   └── core/, models/, resources/   # copied engines (reused unchanged)
├── frontend/                # Vite + React + TS
│   └── src/
│       ├── components/ui/    # shadcn components
│       ├── components/app-sidebar.tsx   # sidebar-08, re-grouped
│       ├── components/plots/ # UPlotChart, StackedSignalPlot, SpectrumPlot, CorrelationHeatmap
│       ├── components/shared/# SignalPicker, ParamPanel, JobProgress, DataTablePreview
│       ├── routes/           # one screen per functional area
│       ├── store/            # Zustand slices
│       └── lib/              # api client, binary decode, downsample helpers
├── src-tauri/               # (added LAST) Tauri shell wrapping the web build
└── template/                # original Qt app — reference only, never modified
```

## Backend API (thin over engines)

Signals returned as `application/octet-stream` Float32 + JSON metadata; tables/results as JSON.

- `POST /dataset/load` → `{dataset_id, metadata, columns, preview_rows, format_info}` (+ bg stats/corr)
- `GET  /dataset/{id}/signals` → names + units + basic stats
- `GET  /dataset/{id}/signal-data?names=...` → binary Float32 arrays (+ time)
- `GET  /dataset/{id}/stats` → statistics table
- `POST /filter/preview` · `POST /filter/apply` · `POST /filter/suggest` · `GET/POST /filter/chain`
- `POST /spectrum` → FFT magnitude + Welch PSD + peaks
- `GET  /correlation/{id}` → Pearson matrix + top-N pairs; `POST /correlation/pair` → scatter + lag
- `POST /sysid/estimate` (job) · `GET /sysid/sweep`
- `GET/POST/PUT/DELETE /models` · `GET/POST /models/io`
- `POST /simulate` · `POST /validate`
- `POST /report` (job)
- `GET  /jobs/{job_id}` → `{status, progress, eta, result|error}`

## Frontend Screens — all 11 areas + Overview

Two-pane layout per screen: left control panel (SignalPicker + ParamPanel) + main plot/result area,
inside the sidebar-08 shell. Selection + filter chain live in the global store.

1. Overview — dataset summary cards, quick stats, recent files, preview chart
2. File Load & Preview — drag/drop CSV, bg load w/ progress, metadata/format panel, 100-row table
3. Time-Series Plot — stacked uPlot, linked X, synced crosshair, peak downsampling
4. Multi-File Compare — fuzzy auto-match, time alignment, overlay + comparison stats
5. Filter — chain editor (add/remove/reorder/enable), live preview, apply, auto-suggest, save/load
6. Spectrum — FFT + Welch PSD, peaks, before/after overlay, draggable cutoff
7. Correlation — canvas heatmap, top-20 pairs, scatter + xcorr lag, Spearman toggle
8. System ID — I/O mapping + auto-suggest, method, order/sweep (VAF chart), auto-decimation, job
9. Model Library — CRUD table, save/load JSON, compare metrics, detail drawer
10. Simulation — pick model(s), measured vs simulated overlays, multi-model, auto-x0
11. Validation — residuals, histogram+Shapiro, ACF+bounds, input-residual xcorr, metrics table
12. Report Export — section checkboxes, async HTML/PDF, preview + save

## Build Order

1. Scaffold: Vite+React+TS, Tailwind, shadcn init + `sidebar-08` + lucide, theme provider, store skeleton
2. Backend skeleton: FastAPI + copied engines, `/dataset/load`, `/signal-data` (binary), `/jobs`
3. Vertical slice: File Load → Time-Series Plot (proves the pipeline end to end)
4. Signal Processing: Filter, Spectrum, Correlation
5. Modelling: System ID (+ job polling), Model Library, Simulation, Validation
6. Output + polish: Report Export, Overview, Compare, states, dark mode, perf
7. Tauri packaging (last): wrap the web build as a native app + Python sidecar

## Verification

- Backend: `uvicorn backend.app:app`; hit endpoints with a real Raser CSV; reuse existing `tests/`.
- Frontend: `npm run dev`; load 100K-row CSV; smooth pan/zoom, crosshair, live filter, heatmap,
  small sysid job w/ progress, report export.
- Packaged: `npm run tauri build`; sidecar starts/stops with the window; full workflow works.
- Perf: load < ~2s, corr matrix < ~0.5s, single filter < ~100ms, PSD < ~200ms on ~110K rows.
