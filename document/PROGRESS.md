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
| 0 | Env check, codegraph init, docs, git/GitHub setup | 🟡 in progress |
| 1 | Scaffold (Vite+React+TS, Tailwind, shadcn, sidebar-08, store) | ⬜ todo |
| 2 | Backend skeleton (FastAPI + engines, load, signal-data, jobs) | ⬜ todo |
| 3 | Vertical slice: File Load → Time-Series Plot | ⬜ todo |
| 4 | Signal Processing: Filter, Spectrum, Correlation | ⬜ todo |
| 5 | Modelling: System ID, Model Library, Simulation, Validation | ⬜ todo |
| 6 | Output + polish: Report, Overview, Compare, states, dark mode | ⬜ todo |
| 7 | Tauri packaging | ⬜ todo |

Legend: ⬜ todo · 🟡 in progress · ✅ done · ⚠️ blocked

## Next up

- Finish step 0: initial commit + push to public GitHub.
- Start step 1: scaffold frontend.

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
