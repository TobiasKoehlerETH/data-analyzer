"""Descriptive statistics, outlier detection, and distribution fitting."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd
from scipy import stats as sp_stats

from core.cache_manager import CacheManager


@dataclass
class OutlierResult:
    indices: np.ndarray
    method: str
    threshold: float
    count: int


def compute_descriptive_stats(signals: dict[str, np.ndarray],
                              cache: CacheManager | None = None) -> pd.DataFrame:
    if cache:
        key = cache.make_key("__all__", "descriptive_stats")
        cached = cache.get(key)
        if cached is not None:
            return cached

    rows = []
    for name, data in signals.items():
        clean = data[np.isfinite(data)]
        if len(clean) == 0:
            continue
        rows.append({
            "Signal": name,
            "Count": len(clean),
            "Mean": float(np.mean(clean)),
            "Std": float(np.std(clean)),
            "Min": float(np.min(clean)),
            "Q1": float(np.percentile(clean, 25)),
            "Median": float(np.median(clean)),
            "Q3": float(np.percentile(clean, 75)),
            "Max": float(np.max(clean)),
            "Skew": float(sp_stats.skew(clean)),
            "Kurtosis": float(sp_stats.kurtosis(clean)),
        })

    df = pd.DataFrame(rows)
    if cache:
        cache.set(key, df)
    return df


def detect_outliers_iqr(data: np.ndarray, factor: float = 1.5) -> OutlierResult:
    clean = data[np.isfinite(data)]
    q1 = np.percentile(clean, 25)
    q3 = np.percentile(clean, 75)
    iqr = q3 - q1
    lower = q1 - factor * iqr
    upper = q3 + factor * iqr
    mask = (data < lower) | (data > upper)
    indices = np.where(mask)[0]
    return OutlierResult(indices=indices, method="IQR", threshold=factor, count=len(indices))


def detect_outliers_zscore(data: np.ndarray, threshold: float = 3.0) -> OutlierResult:
    clean = data[np.isfinite(data)]
    mean = np.mean(clean)
    std = np.std(clean)
    if std == 0:
        return OutlierResult(indices=np.array([], dtype=int), method="Z-score", threshold=threshold, count=0)
    z = np.abs((data - mean) / std)
    mask = z > threshold
    indices = np.where(mask)[0]
    return OutlierResult(indices=indices, method="Z-score", threshold=threshold, count=len(indices))


def fit_distribution(data: np.ndarray) -> dict:
    clean = data[np.isfinite(data)]
    if len(clean) < 10:
        return {"distribution": "unknown"}

    # Test normality
    if len(clean) > 5000:
        sample = np.random.choice(clean, 5000, replace=False)
    else:
        sample = clean
    _, norm_p = sp_stats.shapiro(sample[:min(len(sample), 5000)])

    mu, sigma = sp_stats.norm.fit(clean)

    return {
        "distribution": "normal" if norm_p > 0.05 else "non-normal",
        "shapiro_p": float(norm_p),
        "mu": float(mu),
        "sigma": float(sigma),
    }
