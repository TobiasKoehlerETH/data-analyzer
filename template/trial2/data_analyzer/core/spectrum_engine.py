"""Spectrum analysis: FFT, PSD (Welch), and peak detection with caching."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy.signal import welch, find_peaks

from core.cache_manager import CacheManager


@dataclass
class SpectrumResult:
    freqs: np.ndarray
    magnitude: np.ndarray


@dataclass
class PSDResult:
    freqs: np.ndarray
    psd: np.ndarray


@dataclass
class PeakInfo:
    frequency: float
    amplitude: float
    prominence: float


def compute_fft(signal: np.ndarray, fs: float, cache: CacheManager | None = None,
                signal_name: str = "") -> SpectrumResult:
    if cache and signal_name:
        key = cache.make_key(signal_name, "fft", {"fs": fs})
        cached = cache.get(key)
        if cached is not None:
            return cached

    n = len(signal)
    fft_vals = np.fft.rfft(signal - np.mean(signal))
    freqs = np.fft.rfftfreq(n, d=1.0 / fs)
    magnitude = np.abs(fft_vals) * 2.0 / n

    result = SpectrumResult(freqs=freqs, magnitude=magnitude)
    if cache and signal_name:
        cache.set(key, result)
    return result


def compute_psd(signal: np.ndarray, fs: float, nperseg: int | None = None,
                cache: CacheManager | None = None, signal_name: str = "") -> PSDResult:
    if nperseg is None:
        nperseg = min(len(signal), max(256, len(signal) // 8))

    if cache and signal_name:
        key = cache.make_key(signal_name, "psd", {"fs": fs, "nperseg": nperseg})
        cached = cache.get(key)
        if cached is not None:
            return cached

    freqs, psd_vals = welch(signal, fs=fs, nperseg=nperseg, detrend="linear")

    result = PSDResult(freqs=freqs, psd=psd_vals)
    if cache and signal_name:
        cache.set(key, result)
    return result


def detect_peaks(psd_result: PSDResult, prominence_factor: float = 5.0,
                 min_freq: float = 0.0) -> list[PeakInfo]:
    freqs = psd_result.freqs
    psd = psd_result.psd

    mask = freqs >= min_freq
    freqs_m = freqs[mask]
    psd_m = psd[mask]

    if len(psd_m) < 3:
        return []

    median_psd = np.median(psd_m)
    prominence_threshold = median_psd * prominence_factor

    indices, properties = find_peaks(psd_m, prominence=prominence_threshold)

    peaks = []
    for i, idx in enumerate(indices):
        peaks.append(PeakInfo(
            frequency=float(freqs_m[idx]),
            amplitude=float(psd_m[idx]),
            prominence=float(properties["prominences"][i]),
        ))

    peaks.sort(key=lambda p: p.prominence, reverse=True)
    return peaks


def estimate_noise_floor(psd_result: PSDResult, upper_fraction: float = 0.25) -> float:
    freqs = psd_result.freqs
    psd = psd_result.psd
    if len(freqs) < 2:
        return 0.0
    max_freq = freqs[-1]
    cutoff = max_freq * (1.0 - upper_fraction)
    mask = freqs >= cutoff
    if mask.sum() < 2:
        return float(np.median(psd))
    return float(np.median(psd[mask]))


def estimate_knee_frequency(psd_result: PSDResult, noise_factor: float = 2.0) -> float:
    noise_floor = estimate_noise_floor(psd_result)
    threshold = noise_floor * noise_factor
    for i in range(len(psd_result.freqs) - 1, -1, -1):
        if psd_result.psd[i] > threshold:
            return float(psd_result.freqs[i])
    return float(psd_result.freqs[-1])
