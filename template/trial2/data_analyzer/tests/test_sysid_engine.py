"""Tests for sysid engine: simple SISO recovery, decimation, time estimator."""

import numpy as np

from core.sysid_engine import identify_model, estimate_time, estimate_decimation_factor


class TestTimeEstimator:
    def test_returns_positive(self):
        t = estimate_time(1000, 2, 2, 1, 5)
        assert t > 0

    def test_more_data_more_time(self):
        t1 = estimate_time(1000, 1, 1, 1, 5)
        t2 = estimate_time(10000, 1, 1, 1, 5)
        assert t2 > t1


class TestIdentifyModel:
    def test_siso_identification(self):
        np.random.seed(42)
        n = 500
        u = np.random.randn(n)
        # Simple first-order system: y[k] = 0.9*y[k-1] + 0.5*u[k]
        y = np.zeros(n)
        for k in range(1, n):
            y[k] = 0.9 * y[k - 1] + 0.5 * u[k]

        results = identify_model(
            input_data={"u": u},
            output_data={"y": y},
            fs=1.0,
            name="test",
            order_min=1,
            order_max=3,
            decimation_factor=1,
        )
        assert len(results) > 0
        best = results[0]
        assert best.mean_vaf > 50.0  # Should get reasonable fit
        assert best.A.shape[0] >= 1
