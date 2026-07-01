# Data Analyzer

An optimized-UI rebuild of a desktop tool for exploring, filtering, correlating, and
modelling industrial time-series CSV data (Raser DataLog and generic CSVs).

The original PySide6 app lives under [`template/`](template/) as reference. This rebuild keeps the
proven Python numerics and replaces the UI with a modern **React + shadcn/ui** frontend, packaged as
a native desktop app with **Tauri**.

## Architecture

- **Frontend** (`frontend/`) — Vite + React + TypeScript + Tailwind + shadcn/ui (`sidebar-08`),
  uPlot charts, Zustand state. Navigation grouped by workflow: Data · Signal Processing · Modelling ·
  Output.
- **Backend** (`backend/`) — FastAPI, a thin HTTP layer over the original engines (`core/`, `models/`
  copied verbatim). Data stays server-side; signals stream to the client as binary Float32.
- **Shell** (`frontend/src-tauri/`) — Tauri wraps the built frontend and launches the backend as a
  sidecar.

See [`document/PLAN.md`](document/PLAN.md) for the full design and [`document/PROGRESS.md`](document/PROGRESS.md)
for the build log / handover notes.

## Features (all 11 areas of the original)

CSV/XLSX load & preview · time-series plotting · multi-file compare · filtering (chain + auto-suggest) ·
spectrum (FFT/PSD/peaks) · correlation (heatmap + cross-correlation) · state-space system
identification · model library · simulation · residual validation · HTML report export.

The table importer inspects files before loading them. It supports comma,
semicolon, tab, and pipe-delimited text plus XLSX workbooks. Multi-sheet
workbooks provide a sheet picker, and headers can be auto-detected, taken from
the first or another row, or disabled entirely. Text, mixed, and empty columns
remain visible in the preview; numeric analysis tools expose only compatible
numeric columns.

## Run (development)

```bash
# 1. Backend
cd backend
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt
.venv/Scripts/python -m uvicorn app:app --port 8000

# 2. Frontend (new terminal)
cd frontend
npm install
npm run dev              # http://localhost:5173  (proxies /api -> 127.0.0.1:8000)
```

Or run it as a native window (starts the frontend and spawns the backend automatically):

```bash
npm --prefix frontend run tauri dev
```

## Build (native desktop app)

```bash
# 1. Bundle the Python backend into a sidecar exe
./scripts/build_sidecar.ps1

# 2. Build the Tauri app (installer in frontend/src-tauri/target/release/bundle)
#    The extra config adds the sidecar; the base config omits it so `tauri dev` works
#    without a PyInstaller build.
npm --prefix frontend run tauri build -- --config src-tauri/tauri.bundle.conf.json
```

## Tests

The original engine tests apply unchanged (the numerics are reused):

```bash
cd backend && .venv/Scripts/python -m pytest ../template/trial2/data_analyzer/tests
```
