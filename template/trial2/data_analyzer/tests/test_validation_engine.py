"""Tests for validation engine: metrics on known residuals."""

import numpy as np

from core.validation_engine import compute_metrics, compute_acf, compute_residuals
from core.simulation_engine import SimulationResult


class TestComputeMetrics:
    def test_perfect_fit(self):
        y = np.array([1.0, 2.0, 3.0, 4.0, 5.0])
        m = compute_metrics(y, y, "test")
        assert m.rmse < 1e-10
        assert m.vaf > 99.99
        assert m.r_squared > 0.999

    def test_bad_fit(self):
        y = np.array([1.0, 2.0, 3.0, 4.0, 5.0])
        y_hat = np.array([5.0, 4.0, 3.0, 2.0, 1.0])
        m = compute_metrics(y, y_hat, "test")
        assert m.rmse > 1.0
        assert m.vaf < 50.0


class TestACF:
    def test_white_noise_acf(self):
        np.random.seed(42)
        res = np.random.randn(1000)
        lags, acf = compute_acf(res, max_lag=50)
        # ACF at lag 0 should be ~1, rest should be small
        assert abs(acf[0] - 1.0) < 0.01
        assert np.mean(np.abs(acf[1:])) < 0.1

    def test_correlated_acf(self):
        # AR(1) process: significant autocorrelation
        np.random.seed(42)
        n = 1000
        res = np.zeros(n)
        for k in range(1, n):
            res[k] = 0.9 * res[k - 1] + np.random.randn()
        lags, acf = compute_acf(res, max_lag=50)
        assert acf[1] > 0.5  # should show significant autocorrelation


class TestComputeResiduals:
    def test_residuals_correct(self):
        meas = {"y": np.array([1.0, 2.0, 3.0])}
        sim = {"y": np.array([1.1, 2.1, 2.9])}
        result = SimulationResult(
            time=np.arange(3, dtype=float),
            measured=meas, simulated=sim,
            x0=np.array([0.0]),
        )
        residuals = compute_residuals(result)
        np.testing.assert_allclose(residuals["y"], [-0.1, -0.1, 0.1], atol=1e-10)
