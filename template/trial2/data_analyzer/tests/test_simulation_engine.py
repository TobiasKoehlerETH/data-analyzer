"""Tests for simulation engine: known system simulation."""

import numpy as np

from core.simulation_engine import simulate, estimate_x0
from models.sysid_model import StateSpaceResult


class TestSimulate:
    def _make_model(self):
        A = np.array([[0.9]])
        B = np.array([[0.5]])
        C = np.array([[1.0]])
        D = np.array([[0.0]])
        return StateSpaceResult(
            name="test", A=A, B=B, C=C, D=D,
            input_names=["u"], output_names=["y"],
            order=1, dt=1.0,
        )

    def test_simulation_matches_known(self):
        model = self._make_model()
        n = 100
        u = np.ones(n)
        y = np.zeros(n)
        x = 0.0
        for k in range(n):
            y[k] = x
            x = 0.9 * x + 0.5 * u[k]

        time = np.arange(n, dtype=float)
        result = simulate(
            model,
            input_data={"u": u},
            output_data={"y": y},
            time=time,
            x0=np.array([0.0]),
        )
        # Simulated should be close to measured (they're the same system)
        error = np.mean(np.abs(result.simulated["y"] - result.measured["y"]))
        assert error < 1.0


class TestEstimateX0:
    def test_zero_x0_recovery(self):
        A = np.array([[0.9]])
        B = np.array([[0.5]])
        C = np.array([[1.0]])
        D = np.array([[0.0]])
        model = StateSpaceResult(
            name="test", A=A, B=B, C=C, D=D,
            input_names=["u"], output_names=["y"],
            order=1, dt=1.0,
        )
        U = np.ones((50, 1))
        Y = np.zeros((50, 1))
        x = 0.0
        for k in range(50):
            Y[k, 0] = x
            x = 0.9 * x + 0.5 * U[k, 0]

        x0 = estimate_x0(model, U, Y, n_steps=20)
        assert abs(x0[0]) < 0.5  # should recover near-zero
