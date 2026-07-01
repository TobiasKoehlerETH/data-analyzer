# Build the Python backend into a single-file sidecar for Tauri release bundling.
#
# Usage (from repo root):  ./scripts/build_sidecar.ps1
# Requires the backend venv (backend/.venv) with requirements installed.
# Produces: frontend/src-tauri/binaries/data-analyzer-backend-<target-triple>.exe

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$backend = Join-Path $root "backend"
$py = Join-Path $backend ".venv/Scripts/python.exe"

# Rust host triple (Tauri expects the sidecar name suffixed with it).
$triple = (& rustc -Vv | Select-String "^host:").ToString().Split(":")[1].Trim()
Write-Host "Target triple: $triple"

& $py -m pip install --quiet pyinstaller

Push-Location $backend
& $py -m PyInstaller --onefile --name data-analyzer-backend --clean --noconfirm `
    --collect-all scipy --collect-all pandas --collect-all matplotlib --collect-all control `
    --collect-submodules core --collect-submodules routers --collect-submodules models `
    run_server.py
Pop-Location

$binaries = Join-Path $root "frontend/src-tauri/binaries"
New-Item -ItemType Directory -Force -Path $binaries | Out-Null
Copy-Item (Join-Path $backend "dist/data-analyzer-backend.exe") `
    (Join-Path $binaries "data-analyzer-backend-$triple.exe") -Force

Write-Host "Sidecar ready: binaries/data-analyzer-backend-$triple.exe"
Write-Host "Now run:  npm --prefix frontend run tauri build -- --config src-tauri/tauri.bundle.conf.json"
