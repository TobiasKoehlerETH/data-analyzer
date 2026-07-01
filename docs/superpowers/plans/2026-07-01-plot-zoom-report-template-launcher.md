# Plot Zoom, Report Template, and Launcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add reversible zoom controls to every uPlot chart, sanitize and use the local report template, and provide a tested Windows launcher.

**Architecture:** Zoom calculations and history live in a small pure TypeScript module consumed by the shared `UPlotChart` wrapper. The backend loads the ignored repository-root template when available and otherwise uses its built-in template. A root batch file launches Tauri from paths resolved relative to the batch file.

**Tech Stack:** React 19, TypeScript 6, uPlot, Vitest, Python 3, pytest, Jinja2, Windows batch, Tauri 2.

## Global Constraints

- `template.html` remains local-only and must never be committed.
- The sanitized template contains no logo, company/person names, source links, or source-specific content.
- Zoom affects both X and Y axes and includes `+`, `-`, Back, and Reset controls at each plot's top right.
- Mouse wheel zooms around the cursor and drag selects a rectangular zoom region.
- Correlation heatmaps remain unchanged.
- Existing user changes in `frontend/src-tauri/Cargo.toml` must not be overwritten or included in feature commits.

---

### Task 1: Windows Launcher

**Files:**
- Create: `launch.bat`

**Interfaces:**
- Consumes: local `frontend/node_modules/@tauri-apps/cli/tauri.js`
- Produces: `launch.bat`, a cwd-independent native-app launcher

- [ ] **Step 1: Verify the launcher is absent**

Run:

```powershell
if (Test-Path .\launch.bat) { throw "launch.bat unexpectedly exists" }
```

Expected: exit code 0 with no output.

- [ ] **Step 2: Create the minimal launcher**

```bat
@echo off
setlocal
cd /d "%~dp0frontend"
call npx tauri dev
set "exit_code=%errorlevel%"
if not "%exit_code%"=="0" pause
exit /b %exit_code%
```

- [ ] **Step 3: Test the launcher from a different working directory**

Run `launch.bat` with redirected logs, wait up to 60 seconds, and require a
responsive `Data Analyzer` window:

```powershell
$p = Start-Process -FilePath "C:\Code\data-analyzer\launch.bat" -WorkingDirectory $env:TEMP -WindowStyle Hidden -PassThru
$deadline = (Get-Date).AddSeconds(60)
do {
  Start-Sleep -Milliseconds 500
  $window = Get-Process -Name app -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowTitle -eq "Data Analyzer" -and $_.Responding }
} until ($window -or (Get-Date) -ge $deadline -or $p.HasExited)
if (-not $window) { throw "launch.bat did not open a responsive Data Analyzer window" }
```

Expected: exit code 0 and a responsive native window titled `Data Analyzer`.

- [ ] **Step 4: Commit**

```powershell
git add -- launch.bat
git commit -m "Add Windows launcher"
```

### Task 2: Zoom Range and History Logic

**Files:**
- Create: `frontend/src/components/plots/zoom.ts`
- Create: `frontend/src/components/plots/zoom.test.ts`
- Modify: `frontend/package.json`

**Interfaces:**
- Produces: `Range`, `Viewport`, `zoomViewport(viewport, factors, anchors)`, and `ZoomHistory`

- [ ] **Step 1: Add Vitest and write failing pure-logic tests**

Add `"test": "vitest run"` to scripts and `vitest` to dev dependencies, then
test that center zoom-in halves both ranges, cursor anchors remain stationary,
Back pops one viewport, and Reset restores the original viewport and clears
history.

```ts
import { describe, expect, it } from "vitest"
import { ZoomHistory, zoomViewport } from "./zoom"

describe("zoomViewport", () => {
  it("zooms both axes around their centers", () => {
    expect(zoomViewport({ x: [0, 10], y: [-10, 10] }, 0.5, { x: 5, y: 0 }))
      .toEqual({ x: [2.5, 7.5], y: [-5, 5] })
  })
  it("keeps the cursor anchor stationary", () => {
    expect(zoomViewport({ x: [0, 10], y: [0, 20] }, 0.5, { x: 2, y: 5 }))
      .toEqual({ x: [1, 6], y: [2.5, 12.5] })
  })
})

describe("ZoomHistory", () => {
  it("goes back one viewport and resets to the original", () => {
    const original = { x: [0, 10], y: [0, 20] } as const
    const history = new ZoomHistory(original)
    history.push({ x: [2, 8], y: [4, 16] })
    expect(history.back()).toEqual(original)
    history.push({ x: [1, 9], y: [2, 18] })
    expect(history.reset()).toEqual(original)
    expect(history.canGoBack).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```powershell
npm --prefix frontend test -- src/components/plots/zoom.test.ts
```

Expected: FAIL because `./zoom` does not exist.

- [ ] **Step 3: Implement minimal pure zoom logic**

Implement immutable two-number ranges, anchor-preserving range scaling, and a
bounded 50-entry history that clones values on input and output.

- [ ] **Step 4: Run tests and verify GREEN**

Run:

```powershell
npm --prefix frontend test -- src/components/plots/zoom.test.ts
```

Expected: all zoom tests PASS.

- [ ] **Step 5: Commit**

```powershell
git add -- frontend/package.json frontend/package-lock.json frontend/src/components/plots/zoom.ts frontend/src/components/plots/zoom.test.ts
git commit -m "Add plot zoom state logic"
```

### Task 3: Shared Plot Zoom UI

**Files:**
- Modify: `frontend/src/components/plots/UPlotChart.tsx`
- Create: `frontend/src/components/plots/UPlotChart.test.tsx`

**Interfaces:**
- Consumes: `zoomViewport` and `ZoomHistory` from Task 2
- Produces: shared top-right controls and mouse zoom interactions for all uPlot charts

- [ ] **Step 1: Write failing component tests**

Render `UPlotChart` with a lightweight uPlot constructor mock and assert that
buttons named `Zoom in`, `Zoom out`, `Back`, and `Reset zoom` exist, Back starts
disabled, zoom-in calls `setScale` for both `x` and `y`, and Reset restores the
initial scales.

- [ ] **Step 2: Run component tests and verify RED**

Run:

```powershell
npm --prefix frontend test -- src/components/plots/UPlotChart.test.tsx
```

Expected: FAIL because the controls do not exist.

- [ ] **Step 3: Add controls and interactions**

Wrap the plot in `relative`, add an absolute top-right control group using the
existing Button component, bind wheel events to anchor-preserving X/Y zoom,
enable rectangular drag selection, and route all viewport changes through the
history object. Give each control an accessible label and title.

- [ ] **Step 4: Run tests and build**

Run:

```powershell
npm --prefix frontend test
npm --prefix frontend run build
```

Expected: all tests PASS and the production build exits 0.

- [ ] **Step 5: Commit**

```powershell
git add -- frontend/src/components/plots/UPlotChart.tsx frontend/src/components/plots/UPlotChart.test.tsx
git commit -m "Add reversible controls to every plot"
```

### Task 4: Sanitized Local Report Template

**Files:**
- Modify: `.gitignore`
- Modify but do not stage: `template.html`
- Modify: `backend/core/report_generator.py`
- Create: `backend/tests/test_report_template.py`

**Interfaces:**
- Produces: `load_report_template() -> str`
- Consumes: repository-root `template.html`, falling back to `DEFAULT_TEMPLATE`

- [ ] **Step 1: Write failing backend tests**

Test that `load_report_template(path)` returns a readable local template, falls
back for a missing path, and falls back when Jinja parsing fails. Test the
sanitized local file for required variables and absence of `logo`, `<img
src="logo`, `APSOparts`, `Angst`, `Tobias`, and external `http` links.

- [ ] **Step 2: Run tests and verify RED**

Run:

```powershell
backend\.venv\Scripts\python -m pytest backend\tests\test_report_template.py -q
```

Expected: FAIL because `load_report_template` does not exist and the local
template still contains prohibited content.

- [ ] **Step 3: Sanitize the local file and ignore it**

Preserve the source template's print/page CSS, replace its body with generic
Jinja sections for title, timestamp, metadata, statistics, plots, filters,
correlation, models, simulation, validation, and comparison, and remove every
non-generated image. Add this exact root rule:

```gitignore
/template.html
```

- [ ] **Step 4: Implement safe template loading**

Add `load_report_template(path: str | Path | None = None) -> str`, resolve the
default path to `<repo>/template.html`, read UTF-8 text, validate it by
constructing `Template(text)`, and return `DEFAULT_TEMPLATE` on `OSError` or
`TemplateError`. Change `generate_report` to render
`Template(load_report_template())`.

- [ ] **Step 5: Run backend tests and report smoke test**

Run:

```powershell
backend\.venv\Scripts\python -m pytest backend\tests -q
backend\.venv\Scripts\python -c "from pathlib import Path; from core.report_generator import generate_report; p=Path('$env:TEMP/data-analyzer-report.html'); generate_report(p, metadata={'File':'generic.csv'}); assert p.exists() and 'generic.csv' in p.read_text(encoding='utf-8')"
git check-ignore -v template.html
git status --short -- template.html
```

Expected: tests PASS, smoke report contains `generic.csv`, Git reports the
root ignore rule, and `template.html` is absent from status.

- [ ] **Step 6: Commit tracked changes only**

```powershell
git add -- .gitignore backend/core/report_generator.py backend/tests/test_report_template.py
git commit -m "Use sanitized local report template"
```

### Task 5: End-to-End Verification

**Files:**
- No new files

**Interfaces:**
- Consumes: all prior task deliverables

- [ ] **Step 1: Run the complete verification suite**

```powershell
npm --prefix frontend test
npm --prefix frontend run lint
npm --prefix frontend run build
backend\.venv\Scripts\python -m pytest backend\tests template\trial2\data_analyzer\tests -q
git diff --check
git status --short
```

Expected: tests, lint, and build PASS; no whitespace errors; `template.html`
remains ignored; the pre-existing `frontend/src-tauri/Cargo.toml` modification
remains untouched.

- [ ] **Step 2: Launch through the batch file and verify the native window**

Run the Task 1 launch test again and verify the `Data Analyzer` window is
responsive. Exercise `+`, `-`, Back, Reset, wheel zoom, and drag zoom on one
time-series plot.

- [ ] **Step 3: Confirm report generation uses sanitized content**

Generate a report from the UI and verify its preview uses the sanitized layout,
contains generated dataset content, and contains no branding or logo.

