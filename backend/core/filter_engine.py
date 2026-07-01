"""Filter engine: individual filters, chain application, and auto-suggest logic."""

from __future__ import annotations

import numpy as np
from scipy.signal import butter, sosfiltfilt, savgol_filter, medfilt, iirnotch

from core.cache_manager import CacheManager
from core.spectrum_engine import compute_psd, detect_peaks, estimate_noise_floor, estimate_knee_frequency
from models.filter_model import FilterChain, FilterStep, FilterSuggestion, FilterType


def apply_lowpass(signal: np.ndarray, fs: float, cutoff: float, order: int = 4) -> np.ndarray:
    nyq = fs / 2.0
    if cutoff >= nyq:
        return signal.copy()
    sos = butter(order, cutoff / nyq, btype="low", output="sos")
    return sosfiltfilt(sos, signal).astype(signal.dtype)


def apply_highpass(signal: np.ndarray, fs: float, cutoff: float, order: int = 4) -> np.ndarray:
    nyq = fs / 2.0
    if cutoff <= 0 or cutoff >= nyq:
        return signal.copy()
    sos = butter(order, cutoff / nyq, btype="high", output="sos")
    return sosfiltfilt(sos, signal).astype(signal.dtype)


def apply_bandpass(signal: np.ndarray, fs: float, low: float, high: float, order: int = 4) -> np.ndarray:
    nyq = fs / 2.0
    low_n = max(low / nyq, 1e-6)
    high_n = min(high / nyq, 0.9999)
    if low_n >= high_n:
        return signal.copy()
    sos = butter(order, [low_n, high_n], btype="band", output="sos")
    return sosfiltfilt(sos, signal).astype(signal.dtype)


def apply_bandstop(signal: np.ndarray, fs: float, low: float, high: float, order: int = 4) -> np.ndarray:
    nyq = fs / 2.0
    low_n = max(low / nyq, 1e-6)
    high_n = min(high / nyq, 0.9999)
    if low_n >= high_n:
        return signal.copy()
    sos = butter(order, [low_n, high_n], btype="bandstop", output="sos")
    return sosfiltfilt(sos, signal).astype(signal.dtype)


def apply_savgol(signal: np.ndarray, window: int = 51, polyorder: int = 3) -> np.ndarray:
    window = window if window % 2 == 1 else window + 1
    window = min(window, len(signal))
    if window <= polyorder:
        return signal.copy()
    return savgol_filter(signal, window, polyorder).astype(signal.dtype)


def apply_moving_average(signal: np.ndarray, window: int = 21) -> np.ndarray:
    if window < 2 or window > len(signal):
        return signal.copy()
    kernel = np.ones(window) / window
    padded = np.pad(signal, (window // 2, window // 2), mode="edge")
    return np.convolve(padded, kernel, mode="valid")[:len(signal)].astype(signal.dtype)


def apply_exp_moving_average(signal: np.ndarray, alpha: float = 0.1) -> np.ndarray:
    alpha = max(0.001, min(alpha, 1.0))
    result = np.empty_like(signal)
    result[0] = signal[0]
    for i in range(1, len(signal)):
        result[i] = alpha * signal[i] + (1 - alpha) * result[i - 1]
    return result


def apply_median(signal: np.ndarray, window: int = 5) -> np.ndarray:
    window = window if window % 2 == 1 else window + 1
    window = min(window, len(signal))
    if window < 3:
        return signal.copy()
    return medfilt(signal, kernel_size=window).astype(signal.dtype)


def apply_notch(signal: np.ndarray, fs: float, freq: float, Q: float = 30.0) -> np.ndarray:
    if freq <= 0 or freq >= fs / 2:
        return signal.copy()
    b, a = iirnotch(freq, Q, fs)
    from scipy.signal import filtfilt
    return filtfilt(b, a, signal).astype(signal.dtype)


def apply_step(signal: np.ndarray, step: FilterStep, fs: float) -> np.ndarray:
    p = step.params
    ft = step.filter_type

    if ft == FilterType.LOWPASS:
        return apply_lowpass(signal, fs, p.get("cutoff", 0.1), p.get("order", 4))
    elif ft == FilterType.HIGHPASS:
        return apply_highpass(signal, fs, p.get("cutoff", 0.01), p.get("order", 4))
    elif ft == FilterType.BANDPASS:
        return apply_bandpass(signal, fs, p.get("low", 0.01), p.get("high", 0.1), p.get("order", 4))
    elif ft == FilterType.BANDSTOP:
        return apply_bandstop(signal, fs, p.get("low", 0.01), p.get("high", 0.1), p.get("order", 4))
    elif ft == FilterType.SAVGOL:
        return apply_savgol(signal, p.get("window", 51), p.get("polyorder", 3))
    elif ft == FilterType.MOVING_AVERAGE:
        return apply_moving_average(signal, p.get("window", 21))
    elif ft == FilterType.EXP_MOVING_AVERAGE:
        return apply_exp_moving_average(signal, p.get("alpha", 0.1))
    elif ft == FilterType.MEDIAN:
        return apply_median(signal, p.get("window", 5))
    elif ft == FilterType.NOTCH:
        return apply_notch(signal, fs, p.get("freq", 0.1), p.get("Q", 30.0))
    else:
        return signal.copy()


def apply_chain(signal: np.ndarray, chain: FilterChain, fs: float) -> np.ndarray:
    result = signal.copy()
    for step in chain.enabled_steps():
        result = apply_step(result, step, fs)
    return result


def suggest_filters(signal: np.ndarray, fs: float,
                    cache: CacheManager | None = None,
                    signal_name: str = "") -> list[FilterSuggestion]:
    suggestions: list[FilterSuggestion] = []

    # 1. PSD analysis - noise floor and knee frequency
    psd_result = compute_psd(signal, fs, cache=cache, signal_name=signal_name)
    noise_floor = estimate_noise_floor(psd_result)
    knee_freq = estimate_knee_frequency(psd_result)

    if knee_freq < fs / 2 * 0.8:
        signal_power = np.sum(psd_result.psd[psd_result.freqs <= knee_freq])
        noise_power = np.sum(psd_result.psd[psd_result.freqs > knee_freq])
        total = signal_power + noise_power
        if total > 0:
            improvement = noise_power / total * 100
        else:
            improvement = 0
        if improvement > 1.0:
            suggestions.append(FilterSuggestion(
                filter_type=FilterType.LOWPASS,
                params={"cutoff": round(knee_freq, 4), "order": 4},
                reason=f"Low-pass at {knee_freq:.4f} Hz — removes high-frequency noise ({improvement:.1f}% of power is above knee)",
                estimated_improvement=improvement,
            ))

    # 2. Outlier / spike detection
    window_size = min(101, len(signal) // 10)
    if window_size % 2 == 0:
        window_size += 1
    if window_size >= 3:
        rolling_med = medfilt(signal, kernel_size=window_size)
        residuals = np.abs(signal - rolling_med)
        std_res = np.std(residuals)
        if std_res > 0:
            n_outliers = int(np.sum(residuals > 4 * std_res))
            if n_outliers > 0:
                outlier_ratio = n_outliers / len(signal) * 100
                spike_window = min(11, window_size)
                if spike_window % 2 == 0:
                    spike_window += 1
                suggestions.append(FilterSuggestion(
                    filter_type=FilterType.MEDIAN,
                    params={"window": spike_window},
                    reason=f"Median filter (window={spike_window}) — {n_outliers} outlier spikes detected ({outlier_ratio:.2f}% of data)",
                    estimated_improvement=outlier_ratio,
                ))

    # 3. Periodic interference peaks
    peaks = detect_peaks(psd_result, prominence_factor=10.0, min_freq=0.001)
    for peak in peaks[:3]:
        suggestions.append(FilterSuggestion(
            filter_type=FilterType.NOTCH,
            params={"freq": round(peak.frequency, 4), "Q": 30.0},
            reason=f"Notch filter at {peak.frequency:.4f} Hz — periodic interference (prominence={peak.prominence:.2e})",
            estimated_improvement=float(peak.prominence / (noise_floor + 1e-30)),
        ))

    # 4. Drift detection (very low frequency dominance)
    if len(psd_result.freqs) > 10:
        low_freq_mask = psd_result.freqs < psd_result.freqs[-1] * 0.05
        if low_freq_mask.sum() > 0:
            low_power = np.mean(psd_result.psd[low_freq_mask])
            mid_power = np.mean(psd_result.psd[~low_freq_mask])
            if mid_power > 0 and low_power / mid_power > 20:
                hp_cutoff = psd_result.freqs[low_freq_mask][-1]
                suggestions.append(FilterSuggestion(
                    filter_type=FilterType.HIGHPASS,
                    params={"cutoff": round(float(hp_cutoff), 6), "order": 2},
                    reason=f"High-pass at {hp_cutoff:.6f} Hz — removes slow drift (low-freq power is {low_power / mid_power:.0f}x higher)",
                    estimated_improvement=min(50.0, low_power / mid_power),
                ))

    suggestions.sort(key=lambda s: s.estimated_improvement, reverse=True)
    return suggestions
