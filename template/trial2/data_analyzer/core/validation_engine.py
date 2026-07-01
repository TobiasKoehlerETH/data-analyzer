"""Validation engine: residuals, metrics, ACF, normality tests."""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from scipy import stats as sp_stats
from scipy.signal import fftconvolve

from core.simulation_engine import SimulationResult
from models.sysid_model import OutputMetrics


@dataclass
class ResidualAnalysis:
    output_name: str
    residuals: np.ndarray
    acf: np.ndarray
    acf_lags: np.ndarray
    acf_confidence: float
    shapiro_stat: float
    shapiro_p: float
    metrics: OutputMetrics


@dataclass
class ValidationResult:
    analyses: list[ResidualAnalysis] = field(default_factory=list)
    input_residual_xcorr: dict[str, dict[str, np.ndarray]] = field(default_factory=dict)


def compute_residuals(sim_result: SimulationResult) -> dict[str, np.ndarray]:
    residuals = {}
    for name in sim_result.measured:
        residuals[name] = sim_result.measured[name] - sim_result.simulated[name]
    return residuals


def compute_acf(residuals: np.ndarray, max_lag: int = 100) -> tuple[np.ndarray, np.ndarray]:
    n = len(residuals)
    max_lag = min(max_lag, n - 1)
    r = residuals - np.mean(residuals)
    var = np.var(r)
    if var < 1e-30:
        return np.arange(max_lag + 1), np.zeros(max_lag + 1)

    acf = np.correlate(r, r, mode="full")
    acf = acf[n - 1:]  # positive lags only
    acf = acf[:max_lag + 1] / (var * n)

    return np.arange(max_lag + 1), acf


def compute_metrics(measured: np.ndarray, simulated: np.ndarray, name: str) -> OutputMetrics:
    residuals = measured - simulated
    rmse = float(np.sqrt(np.mean(residuals ** 2)))
    mae = float(np.mean(np.abs(residuals)))
    y_range = float(np.max(measured) - np.min(measured))
    nrmse = (rmse / y_range * 100) if y_range > 1e-30 else 0.0
    ss_res = np.sum(residuals ** 2)
    ss_tot = np.sum((measured - np.mean(measured)) ** 2)
    r_squared = float(1.0 - ss_res / ss_tot) if ss_tot > 1e-30 else 0.0
    var_err = np.var(residuals)
    var_y = np.var(measured)
    vaf = max(0.0, (1.0 - var_err / var_y) * 100.0) if var_y > 1e-30 else 0.0

    return OutputMetrics(name=name, rmse=rmse, nrmse=nrmse, mae=mae,
                         r_squared=r_squared, vaf=vaf)


def compute_input_residual_xcorr(input_data: dict[str, np.ndarray],
                                  residuals: dict[str, np.ndarray],
                                  max_lag: int = 200) -> dict[str, dict[str, np.ndarray]]:
    result: dict[str, dict[str, np.ndarray]] = {}
    for out_name, res in residuals.items():
        result[out_name] = {}
        r_norm = (res - np.mean(res)) / (np.std(res) + 1e-30)
        for in_name, inp in input_data.items():
            i_norm = (inp - np.mean(inp)) / (np.std(inp) + 1e-30)
            n = min(len(r_norm), len(i_norm))
            xcorr = fftconvolve(r_norm[:n], i_norm[:n][::-1], mode="full") / n
            center = n - 1
            start = max(0, center - max_lag)
            end = min(len(xcorr), center + max_lag + 1)
            result[out_name][in_name] = xcorr[start:end]
    return result


def validate(sim_result: SimulationResult,
             input_data: dict[str, np.ndarray] | None = None,
             max_acf_lag: int = 100) -> ValidationResult:
    residuals = compute_residuals(sim_result)
    analyses = []

    for name in sim_result.measured:
        res = residuals[name]
        meas = sim_result.measured[name]
        sim = sim_result.simulated[name]

        # Metrics
        metrics = compute_metrics(meas, sim, name)

        # ACF
        acf_lags, acf = compute_acf(res, max_lag=max_acf_lag)
        n = len(res)
        acf_confidence = 1.96 / np.sqrt(n) if n > 0 else 0.0

        # Shapiro-Wilk (subsample if too large)
        sample = res[:min(5000, len(res))]
        try:
            stat, p = sp_stats.shapiro(sample)
        except Exception:
            stat, p = 0.0, 0.0

        analyses.append(ResidualAnalysis(
            output_name=name,
            residuals=res,
            acf=acf,
            acf_lags=acf_lags,
            acf_confidence=acf_confidence,
            shapiro_stat=float(stat),
            shapiro_p=float(p),
            metrics=metrics,
        ))

    # Input-residual cross-correlation
    xcorr = {}
    if input_data:
        xcorr = compute_input_residual_xcorr(input_data, residuals)

    return ValidationResult(analyses=analyses, input_residual_xcorr=xcorr)
