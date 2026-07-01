"""Tests for correlation engine: Pearson matrix, cross-correlation."""

import numpy as np

from core.correlation_engine import compute_correlation_matrix, compute_cross_correlation


class TestCorrelationMatrix:
    def test_perfect_correlation(self):
        x = np.arange(100, dtype=float)
        signals = {"a": x, "b": x * 2 + 1}
        result = compute_correlation_matrix(signals)
        assert abs(result.pearson_matrix[0, 1] - 1.0) < 0.01

    def test_uncorrelated(self):
        np.random.seed(42)
        signals = {"a": np.random.randn(1000), "b": np.random.randn(1000)}
        result = compute_correlation_matrix(signals)
        assert abs(result.pearson_matrix[0, 1]) < 0.1

    def test_top_pairs_sorted(self):
        np.random.seed(42)
        x = np.arange(500, dtype=float)
        signals = {
            "a": x,
            "b": x * 2,
            "c": np.random.randn(500),
        }
        result = compute_correlation_matrix(signals)
        assert len(result.top_pairs) > 0
        # First pair should be most correlated
        assert abs(result.top_pairs[0].pearson_r) >= abs(result.top_pairs[-1].pearson_r)


class TestCrossCorrelation:
    def test_no_lag(self):
        x = np.sin(np.linspace(0, 4 * np.pi, 200))
        lags, corr = compute_cross_correlation(x, x, max_lag=50)
        peak_idx = np.argmax(corr)
        assert abs(lags[peak_idx]) < 2  # peak near zero lag

    def test_with_lag(self):
        x = np.zeros(200)
        x[100] = 1.0
        y = np.zeros(200)
        y[110] = 1.0  # 10 sample lag
        lags, corr = compute_cross_correlation(x, y, max_lag=50)
        peak_idx = np.argmax(corr)
        assert abs(abs(lags[peak_idx]) - 10) < 2
