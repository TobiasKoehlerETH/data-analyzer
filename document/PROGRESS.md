# Progress & Handover Log

> Living handover doc. Any agent picking up this work: read [PLAN.md](./PLAN.md) first, then this
> file. Update the **Status** table and **Next up** section as you complete steps. Keep entries
> terse. Newest log entry on top.

## How to run (dev)

```bash
# Backend
cd backend && python -m venv .venv && .venv/Scripts/pip install -r requirements.txt
.venv/Scripts/uvicorn app:app --reload --port 8000

# Frontend
cd frontend && npm install && npm run dev   # http://localhost:5173
```

Sample data: use a Raser CSV; the original app's engine tests live in `template/trial2/data_analyzer/tests`.

## Status

| Step | Area | State |
|---|---|---|
| 0 | Env check, codegraph init, docs, git/GitHub setup | ✅ done |
| 1 | Scaffold (Vite+React+TS, Tailwind, shadcn, sidebar-08, store) | ✅ done |
| 2 | Backend skeleton (FastAPI + engines, load, signal-data) | 🟡 in progress |
| 3 | Vertical slice: File Load → Time-Series Plot | ✅ done |
| 4 | Signal Processing: Filter, Spectrum, Correlation | ✅ done |
| 5 | Modelling: System ID, Model Library, Simulation, Validation | ✅ done |
| 6 | Output + polish: Report, Overview, Compare, states, dark mode | ✅ done |
| 7 | Tauri packaging | ✅ done (compiles; GUI launch = manual) |

Legend: ⬜ todo · 🟡 in progress · ✅ done · ⚠️ blocked

**All build steps complete.** The web app is fully implemented and verified in-browser; the Tauri
shell compiles (`cargo check` clean) with dev/release backend spawning wired. Remaining manual steps
are the GUI smoke test (`tauri dev`) and producing the installer (`build_sidecar.ps1` + `tauri build`).

## Next up

- Finish step 7: verify `npm --prefix frontend run tauri dev` opens the native window and the
  spawned backend serves (first Rust build is slow, ~10 min). Then `./scripts/build_sidecar.ps1`
  + `tauri build` for the installer.

## Tauri setup (step 7)

- Scaffolded under `frontend/src-tauri/` (Tauri v2). `src/lib.rs` spawns the backend: **dev** runs
  `backend/.venv` uvicorn (path via `CARGO_MANIFEST_DIR`); **release** runs the PyInstaller sidecar
  `data-analyzer-backend` (see `bundle.externalBin` in `tauri.conf.json`).
- Frontend API base is env-aware (`lib/api.ts`): `/api` in dev (Vite proxy), `http://127.0.0.1:8000`
  in the packaged app. Backend has permissive CORS for the desktop origin.
- Release sidecar: `backend/run_server.py` is the PyInstaller entry; `scripts/build_sidecar.ps1`
  builds it and drops `data-analyzer-backend-<triple>.exe` into `frontend/src-tauri/binaries/`.
- Reused-engine tests: 33/33 pass under the backend venv
  (`pytest template/trial2/data_analyzer/tests`).

## Ops notes

- Backend routers under `backend/routers/` (dataset, signal_ops, modelling). Run WITHOUT `--reload`
  — the reloader spawned zombie workers that held port 8000. Restart manually after backend edits:
  kill python procs on :8000 (see below), then `uvicorn app:app --port 8000`.
- Numpy scalars must be coerced to native before returning JSON (`_py`/`_floats`) — Pydantic rejects
  `np.float32`.
- System-ID runs as a background job (`jobs.py`); frontend polls via `api.pollJob`. Best-VAF model is
  auto-saved to the in-process library. Order-sweep table is informational (only best is persisted).
- Kill stray backend: `Get-CimInstance Win32_Process -Filter "Name='python.exe'" | ? {$_.CommandLine
  -match 'uvicorn'} | % { Stop-Process $_.ProcessId -Force }` (netstat PIDs on :8000 can be stale).

## What's built

- **Frontend** (`frontend/`): Vite+React+TS+Tailwind v4, shadcn (Nova preset), `sidebar-08`
  re-grouped by workflow (`lib/nav.ts`). Router + 12 route stubs (`routes.tsx`); Overview, Load,
  and Plot are real. Zustand store (`store/index.ts`). uPlot wrapper + StackedSignalPlot with
  linked crosshair. API client with binary Float32 decode (`lib/api.ts`). Builds & typechecks clean.
- **Backend** (`backend/`): copied engines (`core/`,`models/`,`resources/`). Qt-free `dataset.py`
  (reuses `core.csv_parser`) + in-process registry. `app.py` FastAPI: `/dataset/load`,
  `/dataset/{id}/signals`, `/dataset/{id}/signal-data` (binary). `smoke_test.py` checks the layer.
- **Sample**: `sample_data.csv` (5000-row synthetic Raser log; gitignored).

## Key decisions

See [PLAN.md](./PLAN.md) → Decisions table. Highlights:
- **Reuse Python numerics** (copy `core/`+`models/` from `template/trial2/data_analyzer`). Do NOT
  rewrite math in JS.
- Web app first; Tauri added last as a thin wrapper.
- Full-res Float32 arrays to client; uPlot handles downsampling.
- Global Zustand store for dataset/selection/filters/models/sim.

## Gotchas (from original build notes)

- Import scientific stack before any GUI lib (shiboken/six.moves clash) — N/A once Qt is gone.
- `chardet` often misreports latin-1 as big5 → validate + fall back to latin-1 (already in `csv_parser`).
- `pd.read_csv(header=N)` breaks on messy pre-header rows → use `skiprows` (already handled).
- Cross-correlation only on top-K Pearson pairs, never all N².
- System ID: always decimate by signal bandwidth first (auto-decimation) — critical for speed.
- uPlot / downsampling: use peak (min+max per bucket), not mean — preserves transient spikes.

## Log

- **Setup**: env verified (node 24, python 3.11, cargo 1.95, gh 2.89, codegraph 0.8.0).
  CodeGraph indexed 43 files. Created `document/PLAN.md` + this file. Repo is greenfield (no commits).
