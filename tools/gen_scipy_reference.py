"""Generates scipy/numpy reference values for the Rust DSP ports.

Usage: python tools/gen_scipy_reference.py  (needs numpy + scipy)
Writes src-tauri/tests/fixtures/scipy_reference.json
"""

import json
from pathlib import Path

import numpy as np
from scipy import signal, stats

rng = np.random.default_rng(1234)
fs = 10.0
n = 1500
t = np.arange(n) / fs
x = np.sin(2 * np.pi * 0.3 * t) + 0.4 * np.sin(2 * np.pi * 2.2 * t) + 0.2 * rng.standard_normal(n) + 0.01 * t
x[700] += 4.0

ref = {"x": x.tolist(), "fs": fs}


def butter_case(order, wn, btype):
    sos = signal.butter(order, wn, btype=btype, output="sos")
    return {"order": order, "wn": list(np.atleast_1d(wn)), "btype": btype, "y": signal.sosfiltfilt(sos, x).tolist()}


ref["butter"] = [
    butter_case(4, 0.2, "low"),
    butter_case(3, 0.05, "low"),
    butter_case(2, 0.1, "high"),
    butter_case(4, [0.05, 0.3], "bandpass"),
    butter_case(3, [0.3, 0.6], "bandstop"),
]
b, a = signal.iirnotch(2.2, 30.0, fs)
ref["notch"] = {"freq": 2.2, "q": 30.0, "b": b.tolist(), "a": a.tolist(), "y": signal.filtfilt(b, a, x).tolist()}
ref["savgol"] = {"window": 51, "polyorder": 3, "y": signal.savgol_filter(x, 51, 3).tolist()}
ref["medfilt"] = {"kernel": 11, "y": signal.medfilt(x, 11).tolist()}
f, p = signal.welch(x, fs=fs, nperseg=256, detrend="linear")
ref["welch"] = {"nperseg": 256, "f": f.tolist(), "p": p.tolist()}
f2, p2 = signal.welch(x, fs=fs, nperseg=301, detrend="linear")
ref["welch_odd"] = {"nperseg": 301, "f": f2.tolist(), "p": p2.tolist()}
ref["decimate"] = {"q": 7, "y": signal.decimate(x, 7, zero_phase=True).tolist()}
ref["decimate_big"] = {"q": 30, "y": signal.decimate(x, 30, zero_phase=True).tolist()}
pk, props = signal.find_peaks(p, prominence=np.median(p) * 5)
ref["peaks"] = {"threshold": float(np.median(p) * 5), "idx": pk.tolist(), "prom": props["prominences"].tolist()}
sample = rng.standard_normal(300) * 2 + 1
w, pv = stats.shapiro(sample)
w8, pv8 = stats.shapiro([1, 2, 4, 8, 9, 15, 2, 3])
ref["shapiro"] = {"x": sample.tolist(), "w": float(w), "p": float(pv), "w8": float(w8), "p8": float(pv8)}

out = Path(__file__).resolve().parents[1] / "src-tauri" / "tests" / "fixtures" / "scipy_reference.json"
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(json.dumps(ref))
print(f"wrote {out}")
