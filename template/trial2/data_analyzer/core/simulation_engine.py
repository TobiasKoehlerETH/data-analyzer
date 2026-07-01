"""Simulation engine: feed real inputs into state-space models, x0 estimation."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from models.sysid_model import StateSpaceResult


@dataclass
class SimulationResult:
    time: np.ndarray
    measured: dict[str, np.ndarray]
    simulated: dict[str, np.ndarray]
    x0: np.ndarray


def estimate_x0(model: StateSpaceResult, U: np.ndarray, Y: np.ndarray,
                n_steps: int = 50) -> np.ndarray:
    A, B, C, D = model.A, model.B, model.C, model.D
    n_states = A.shape[0]
    n_steps = min(n_steps, len(U))

    # Build observation matrix: Y_block = Gamma * x0 + H * U_block
    # Gamma = [C; CA; CA^2; ...], H accounts for B,D contributions
    n_out = C.shape[0]
    Gamma = np.zeros((n_steps * n_out, n_states))
    Y_corrected = np.zeros(n_steps * n_out)

    A_power = np.eye(n_states)
    for k in range(n_steps):
        Gamma[k * n_out:(k + 1) * n_out, :] = C @ A_power

        # Subtract D*u(k) and B contributions from past inputs
        y_k = Y[k]
        correction = D @ U[k]
        for j in range(k):
            A_pow_j = np.linalg.matrix_power(A, k - j - 1)
            correction = correction + C @ A_pow_j @ B @ U[j]
        Y_corrected[k * n_out:(k + 1) * n_out] = y_k - correction

        A_power = A_power @ A

    # Least-squares solve for x0
    x0, _, _, _ = np.linalg.lstsq(Gamma, Y_corrected, rcond=None)
    return x0


def simulate(model: StateSpaceResult,
             input_data: dict[str, np.ndarray],
             output_data: dict[str, np.ndarray],
             time: np.ndarray,
             x0: np.ndarray | None = None,
             start_idx: int = 0,
             end_idx: int = -1) -> SimulationResult:
    if end_idx <= 0:
        end_idx = len(time)

    # Slice
    time_s = time[start_idx:end_idx]
    U = np.column_stack([input_data[n][start_idx:end_idx] for n in model.input_names])
    Y = np.column_stack([output_data[n][start_idx:end_idx] for n in model.output_names])

    # Remove mean (consistent with identification)
    U_mean = np.mean(U, axis=0)
    Y_mean = np.mean(Y, axis=0)
    U_z = U - U_mean
    Y_z = Y - Y_mean

    # Decimate if model was identified on decimated data
    dec = model.decimation_factor
    if dec > 1:
        from scipy.signal import decimate as sp_decimate
        U_sim = np.column_stack([sp_decimate(U_z[:, i], dec, zero_phase=True)
                                  for i in range(U_z.shape[1])])
        Y_ref = np.column_stack([sp_decimate(Y_z[:, i], dec, zero_phase=True)
                                  for i in range(Y_z.shape[1])])
        time_sim = time_s[::dec][:len(U_sim)]
    else:
        U_sim = U_z
        Y_ref = Y_z
        time_sim = time_s

    A, B, C, D = model.A, model.B, model.C, model.D

    # Estimate x0
    if x0 is None:
        try:
            x0 = estimate_x0(model, U_sim, Y_ref, n_steps=min(50, len(U_sim)))
        except Exception:
            x0 = np.zeros(A.shape[0])

    # Simulate
    n_states = A.shape[0]
    n_samples = len(U_sim)
    n_outputs = C.shape[0]
    Y_sim = np.zeros((n_samples, n_outputs))
    x = x0.copy()

    for k in range(n_samples):
        Y_sim[k] = C @ x + D @ U_sim[k]
        x = A @ x + B @ U_sim[k]

    # Build result
    measured = {}
    simulated = {}
    for j, name in enumerate(model.output_names):
        measured[name] = Y_ref[:, j]
        simulated[name] = Y_sim[:, j]

    return SimulationResult(
        time=time_sim,
        measured=measured,
        simulated=simulated,
        x0=x0,
    )
