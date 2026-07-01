"""Correlation analysis: Pearson/Spearman matrix, FFT-based cross-correlation, auto-ranking."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy.signal import fftconvolve
from scipy.stats import spearmanr

from core.cache_manager import CacheManager


@dataclass
class CorrelationPair:
    signal_a: str
    signal_b: str
    pearson_r: float
    spearman_r: float = 0.0
    lag_samples: int = 0
    lag_seconds: float = 0.0


@dataclass
class CorrelationResult:
    columns: list[str]
    pearson_matrix: np.ndarray
    spearman_matrix: np.ndarray
    top_pairs: list[CorrelationPair]


def compute_correlation_matrix(signals: dict[str, np.ndarray],
                               cache: CacheManager | None = None) -> CorrelationResult:
    if cache:
        key = cache.make_key("__all__", "correlation_matrix")
        cached = cache.get(key)
        if cached is not None:
            return cached

    columns = list(signals.keys())
    n = len(columns)
    data_matrix = np.column_stack([signals[c] for c in columns])

    # Pearson
    pearson = np.corrcoef(data_matrix, rowvar=False)

    # Spearman (on subsampled data for speed if large)
    if data_matrix.shape[0] > 20000:
        indices = np.linspace(0, data_matrix.shape[0] - 1, 20000, dtype=int)
        sub = data_matrix[indices]
    else:
        sub = data_matrix
    spearman, _ = spearmanr(sub)
    if spearman.ndim == 0:
        spearman = np.array([[spearman]])

    # Top pairs by |pearson|
    pairs: list[CorrelationPair] = []
    for i in range(n):
        for j in range(i + 1, n):
            r = float(pearson[i, j])
            sr = float(spearman[i, j]) if spearman.shape[0] > 1 else 0.0
            pairs.append(CorrelationPair(
                signal_a=columns[i],
                signal_b=columns[j],
                pearson_r=r,
                spearman_r=sr,
            ))

    pairs.sort(key=lambda p: abs(p.pearson_r), reverse=True)
    top_pairs = pairs[:20]

    result = CorrelationResult(
        columns=columns,
        pearson_matrix=pearson,
        spearman_matrix=spearman,
        top_pairs=top_pairs,
    )

    if cache:
        cache.set(key, result)
    return result


def compute_cross_correlation(sig_a: np.ndarray, sig_b: np.ndarray,
                              max_lag: int | None = None) -> tuple[np.ndarray, np.ndarray]:
    a = (sig_a - np.mean(sig_a)) / (np.std(sig_a) + 1e-30)
    b = (sig_b - np.mean(sig_b)) / (np.std(sig_b) + 1e-30)

    corr = fftconvolve(a, b[::-1], mode="full") / len(a)
    n = len(a)
    lags = np.arange(-(n - 1), n)

    if max_lag is not None:
        center = n - 1
        start = max(0, center - max_lag)
        end = min(len(corr), center + max_lag + 1)
        return lags[start:end], corr[start:end]

    return lags, corr


def compute_lagged_correlations(signals: dict[str, np.ndarray],
                                pairs: list[CorrelationPair],
                                fs: float,
                                max_lag_seconds: float = 300.0) -> list[CorrelationPair]:
    max_lag = int(max_lag_seconds * fs)

    for pair in pairs:
        if pair.signal_a not in signals or pair.signal_b not in signals:
            continue
        a = signals[pair.signal_a]
        b = signals[pair.signal_b]

        lags, corr = compute_cross_correlation(a, b, max_lag=max_lag)
        peak_idx = np.argmax(np.abs(corr))
        pair.lag_samples = int(lags[peak_idx])
        pair.lag_seconds = pair.lag_samples / fs

    return pairs
