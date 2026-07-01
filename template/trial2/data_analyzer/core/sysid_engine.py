"""MIMO state-space identification engine with decimation, windowing, and order sweep."""

from __future__ import annotations

from datetime import datetime
from typing import Any

import numpy as np
from scipy.signal import decimate as sp_decimate

from core.cache_manager import CacheManager
from core.spectrum_engine import compute_psd, estimate_knee_frequency
from models.sysid_model import OutputMetrics, StateSpaceResult


def estimate_decimation_factor(signals: dict[str, np.ndarray], fs: float,
                               cache: CacheManager | None = None) -> int:
    knee_freqs = []
    for name, sig in signals.items():
        psd = compute_psd(sig, fs, cache=cache, signal_name=name)
        knee = estimate_knee_frequency(psd)
        knee_freqs.append(knee)

    if not knee_freqs:
        return 1

    max_knee = max(knee_freqs)
    nyquist_needed = max_knee * 4  # 4x oversampling above knee
    if nyquist_needed <= 0:
        return 1

    factor = int(fs / (2 * nyquist_needed))
    factor = max(1, min(factor, int(fs)))
    return factor


def estimate_time(n_samples: int, n_inputs: int, n_outputs: int,
                  order_min: int, order_max: int) -> float:
    n_orders = order_max - order_min + 1
    p = min(50, n_samples // 4)
    hankel_ops = n_samples * p * (n_inputs + n_outputs)
    svd_ops = p * (n_inputs + n_outputs) * min(p * (n_inputs + n_outputs), n_samples)
    total_flops = (hankel_ops + svd_ops) * n_orders
    flops_per_sec = 1e9  # rough estimate
    return total_flops / flops_per_sec


def _compute_vaf(y_measured: np.ndarray, y_simulated: np.ndarray) -> float:
    var_err = np.var(y_measured - y_simulated)
    var_y = np.var(y_measured)
    if var_y < 1e-30:
        return 0.0
    return max(0.0, (1.0 - var_err / var_y) * 100.0)


def _compute_metrics(y_measured: np.ndarray, y_simulated: np.ndarray, name: str) -> OutputMetrics:
    residuals = y_measured - y_simulated
    rmse = float(np.sqrt(np.mean(residuals ** 2)))
    mae = float(np.mean(np.abs(residuals)))
    y_range = float(np.max(y_measured) - np.min(y_measured))
    nrmse = (rmse / y_range * 100) if y_range > 1e-30 else 0.0
    ss_res = np.sum(residuals ** 2)
    ss_tot = np.sum((y_measured - np.mean(y_measured)) ** 2)
    r_squared = float(1.0 - ss_res / ss_tot) if ss_tot > 1e-30 else 0.0
    vaf = _compute_vaf(y_measured, y_simulated)
    return OutputMetrics(name=name, rmse=rmse, nrmse=nrmse, mae=mae, r_squared=r_squared, vaf=vaf)


def _simulate_ss(A: np.ndarray, B: np.ndarray, C: np.ndarray, D: np.ndarray,
                 U: np.ndarray, x0: np.ndarray | None = None) -> np.ndarray:
    n_states = A.shape[0]
    n_samples = U.shape[0]
    n_outputs = C.shape[0]

    x = np.zeros(n_states) if x0 is None else x0.copy()
    Y = np.zeros((n_samples, n_outputs))

    for k in range(n_samples):
        u_k = U[k]
        Y[k] = C @ x + D @ u_k
        x = A @ x + B @ u_k

    return Y


def _n4sid_identify(U: np.ndarray, Y: np.ndarray, order: int,
                    block_rows: int = 50) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    n_samples, n_inputs = U.shape
    _, n_outputs = Y.shape

    p = min(block_rows, n_samples // 4)
    if p < order + 1:
        p = order + 1

    j = n_samples - 2 * p + 1
    if j < 1:
        raise ValueError("Not enough data for the requested model order.")

    # Build block Hankel matrices
    m = n_inputs
    l = n_outputs

    def block_hankel(data: np.ndarray, rows: int, cols: int, start: int = 0) -> np.ndarray:
        ch = data.shape[1]
        H = np.zeros((rows * ch, cols))
        for i in range(rows):
            for jj in range(cols):
                H[i * ch:(i + 1) * ch, jj] = data[start + i + jj]
        return H

    Up = block_hankel(U, p, j, 0)
    Uf = block_hankel(U, p, j, p)
    Yp = block_hankel(Y, p, j, 0)
    Yf = block_hankel(Y, p, j, p)

    Wp = np.vstack([Up, Yp])

    # Oblique projection via QR
    combined = np.vstack([Uf, Wp, Yf])
    _, R = np.linalg.qr(combined.T, mode="reduced")
    R = R.T

    r1 = p * m
    r2 = r1 + p * (m + l)
    r3 = r2 + p * l

    R22 = R[r1:r2, r1:r2]
    R32 = R[r2:r3, r1:r2]

    Ob = R32 @ np.linalg.pinv(R22) @ np.vstack([Up, Yp])

    # SVD
    U_svd, S_svd, Vt_svd = np.linalg.svd(Ob, full_matrices=False)

    S_n = S_svd[:order]
    U_n = U_svd[:, :order]
    Vt_n = Vt_svd[:order, :]

    Gamma = U_n @ np.diag(np.sqrt(S_n))

    # Extract C from first block of Gamma
    C_est = Gamma[:l, :]

    # Extract A from shift structure
    Gamma_up = Gamma[:-l, :]
    Gamma_down = Gamma[l:, :]
    A_est = np.linalg.pinv(Gamma_up) @ Gamma_down

    # Estimate B, D via least-squares
    X_hat = np.diag(np.sqrt(S_n)) @ Vt_n
    n_cols = min(X_hat.shape[1], j)

    # Build regression for B, D
    BD_rows = []
    BD_rhs = []
    for k in range(min(n_cols - 1, n_samples - p - 1)):
        x_next = X_hat[:, k + 1] if k + 1 < X_hat.shape[1] else np.zeros(order)
        x_curr = X_hat[:, k]
        u_k = U[p + k]
        BD_rows.append(np.concatenate([x_curr, u_k]))
        BD_rhs.append(np.concatenate([x_next, Y[p + k]]))

    if len(BD_rows) > order:
        Phi = np.array(BD_rows)
        Rhs = np.array(BD_rhs)
        Theta, _, _, _ = np.linalg.lstsq(Phi, Rhs, rcond=None)

        A_est2 = Theta[:order, :order].T
        B_est = Theta[order:, :order].T
        C_est2 = Theta[:order, order:].T
        D_est = Theta[order:, order:].T

        A_est = (A_est + A_est2) / 2
        C_est = (C_est + C_est2) / 2
    else:
        B_est = np.zeros((order, n_inputs))
        D_est = np.zeros((n_outputs, n_inputs))

    return A_est, B_est, C_est, D_est


def identify_model(input_data: dict[str, np.ndarray],
                   output_data: dict[str, np.ndarray],
                   fs: float,
                   name: str = "Model",
                   method: str = "N4SID",
                   order_min: int = 1,
                   order_max: int = 10,
                   decimation_factor: int = 1,
                   start_idx: int = 0,
                   end_idx: int = -1,
                   progress_callback=None,
                   cancelled_callback=None) -> list[StateSpaceResult]:
    input_names = list(input_data.keys())
    output_names = list(output_data.keys())

    U_raw = np.column_stack([input_data[n] for n in input_names])
    Y_raw = np.column_stack([output_data[n] for n in output_names])

    # Window
    if end_idx <= 0:
        end_idx = len(U_raw)
    U_raw = U_raw[start_idx:end_idx]
    Y_raw = Y_raw[start_idx:end_idx]

    # Decimate
    if decimation_factor > 1:
        U_dec = np.column_stack([sp_decimate(U_raw[:, i], decimation_factor, zero_phase=True)
                                 for i in range(U_raw.shape[1])])
        Y_dec = np.column_stack([sp_decimate(Y_raw[:, i], decimation_factor, zero_phase=True)
                                 for i in range(Y_raw.shape[1])])
        dt = decimation_factor / fs
    else:
        U_dec = U_raw
        Y_dec = Y_raw
        dt = 1.0 / fs

    # Remove mean
    U_mean = np.mean(U_dec, axis=0)
    Y_mean = np.mean(Y_dec, axis=0)
    U_z = U_dec - U_mean
    Y_z = Y_dec - Y_mean

    results: list[StateSpaceResult] = []
    n_orders = order_max - order_min + 1

    try:
        from sippy import system_identification
        use_sippy = True
    except ImportError:
        use_sippy = False

    for i, order in enumerate(range(order_min, order_max + 1)):
        if cancelled_callback and cancelled_callback():
            break

        if progress_callback:
            progress_callback(int((i / n_orders) * 100), f"Identifying order {order}...")

        try:
            if use_sippy:
                result = system_identification(
                    Y_z.T, U_z.T, method, SS_order=order,
                    SS_f=min(50, len(U_z) // 4),
                    tsample=dt,
                )
                A = np.array(result.A)
                B = np.array(result.B)
                C = np.array(result.C)
                D = np.array(result.D)
            else:
                A, B, C, D = _n4sid_identify(U_z, Y_z, order)

            # Simulate
            Y_sim = _simulate_ss(A, B, C, D, U_z)

            # Compute metrics
            metrics = []
            for j, oname in enumerate(output_names):
                m = _compute_metrics(Y_z[:, j], Y_sim[:, j], oname)
                metrics.append(m)

            model = StateSpaceResult(
                name=f"{name}_order{order}",
                A=A, B=B, C=C, D=D,
                input_names=input_names,
                output_names=output_names,
                method=method,
                order=order,
                decimation_factor=decimation_factor,
                dt=dt,
                metrics=metrics,
                timestamp=datetime.now().isoformat(),
            )
            results.append(model)

        except Exception:
            continue

    results.sort(key=lambda r: r.mean_vaf, reverse=True)

    if progress_callback:
        progress_callback(100, "Identification complete.")

    return results
