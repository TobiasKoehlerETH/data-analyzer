//! MIMO state-space identification with decimation, windowing and order sweep.
//!
//! Subspace identification in the OLSims family (N4SID, MOESP, CVA weightings):
//! block Hankel data → LQ factor (via the Hankel Gram matrix) → weighted SVD →
//! A, C from the extended observability matrix → B, D by least squares on the
//! simulation error.

use nalgebra::{DMatrix, DVector, SymmetricEigen};
use std::collections::HashMap;
use std::sync::Arc;

use super::cache::CacheManager;
use super::dsp::{decimate, mean, var};
use super::models::{from_dmatrix, now_iso, OutputMetrics, StateSpaceResult};
use super::spectrum::{compute_psd, estimate_knee_frequency};

pub type Signals<'a> = &'a [(String, Arc<Vec<f64>>)];

/// Decimation factor so the highest output knee frequency is sampled ~4× above Nyquist.
pub fn estimate_decimation_factor(signals: Signals, fs: f64, cache: Option<&CacheManager>) -> usize {
    let mut max_knee: f64 = 0.0;
    let mut n_samples = usize::MAX;
    for (name, sig) in signals {
        let psd = compute_psd(sig, fs, None, cache, name);
        max_knee = max_knee.max(estimate_knee_frequency(&psd, 2.0));
        n_samples = n_samples.min(sig.len());
    }
    if signals.is_empty() {
        return 1;
    }
    let nyquist_needed = max_knee * 4.0;
    if nyquist_needed <= 0.0 {
        return 1;
    }
    let factor = (fs / (2.0 * nyquist_needed)).floor() as usize;
    // Keep at least ~200 samples for identification and stay within the UI range.
    let cap = (n_samples / 200).clamp(1, 1000);
    factor.clamp(1, cap)
}

pub fn estimate_time(n_samples: usize, n_inputs: usize, n_outputs: usize, order_min: usize, order_max: usize) -> f64 {
    let n_orders = (order_max as f64 - order_min as f64 + 1.0).max(0.0);
    let p = 50.min(n_samples / 4) as f64;
    let ch = (n_inputs + n_outputs) as f64;
    let ns = n_samples as f64;
    let hankel_ops = ns * p * ch;
    let svd_ops = p * ch * (p * ch).min(ns);
    (hankel_ops + svd_ops) * n_orders / 1e9
}

pub fn compute_vaf(y: &[f64], ysim: &[f64]) -> f64 {
    let err: Vec<f64> = y.iter().zip(ysim).map(|(a, b)| a - b).collect();
    let var_y = var(y);
    if var_y < 1e-30 {
        return 0.0;
    }
    ((1.0 - var(&err) / var_y) * 100.0).max(0.0)
}

pub fn compute_metrics(y: &[f64], ysim: &[f64], name: &str) -> OutputMetrics {
    let res: Vec<f64> = y.iter().zip(ysim).map(|(a, b)| a - b).collect();
    let n = res.len().max(1) as f64;
    let rmse = (res.iter().map(|r| r * r).sum::<f64>() / n).sqrt();
    let mae = res.iter().map(|r| r.abs()).sum::<f64>() / n;
    let (ymin, ymax) = y.iter().fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), &v| (lo.min(v), hi.max(v)));
    let range = ymax - ymin;
    let nrmse = if range > 1e-30 { rmse / range * 100.0 } else { 0.0 };
    let ss_res: f64 = res.iter().map(|r| r * r).sum();
    let ym = mean(y);
    let ss_tot: f64 = y.iter().map(|v| (v - ym).powi(2)).sum();
    let r_squared = if ss_tot > 1e-30 { 1.0 - ss_res / ss_tot } else { 0.0 };
    OutputMetrics { name: name.to_string(), rmse, nrmse, mae, r_squared, vaf: compute_vaf(y, ysim) }
}

/// Simulates x(k+1) = A x + B u, y = C x + D u. `u` is (N × m), returns (N × l).
pub fn simulate_ss(a: &DMatrix<f64>, b: &DMatrix<f64>, c: &DMatrix<f64>, d: &DMatrix<f64>, u: &DMatrix<f64>, x0: Option<&DVector<f64>>) -> DMatrix<f64> {
    let n = a.nrows();
    let l = c.nrows();
    let samples = u.nrows();
    let mut x = x0.cloned().unwrap_or_else(|| DVector::zeros(n));
    let mut y = DMatrix::zeros(samples, l);
    for k in 0..samples {
        let uk = u.row(k).transpose();
        let yk = c * &x + d * &uk;
        y.set_row(k, &yk.transpose());
        x = a * &x + b * &uk;
    }
    y
}

/// LQ blocks of the stacked Hankel matrix [Uf; Up; Yp; Yf].
struct Decomposition {
    f: usize,
    l21: DMatrix<f64>,
    l22: DMatrix<f64>,
    l32: DMatrix<f64>,
    l33: DMatrix<f64>,
}

/// Gram matrix of the block Hankel matrix with rows (block i, channel c), computed along
/// diagonals so the cost is O(channels² · blocks · j) instead of O(rows² · j).
fn hankel_gram(z: &[Vec<f64>], blocks: usize, j: usize) -> DMatrix<f64> {
    let ch = z.len();
    let rows = blocks * ch;
    let mut g = DMatrix::zeros(rows, rows);
    for c1 in 0..ch {
        for c2 in 0..ch {
            let (a, b) = (&z[c1], &z[c2]);
            for d in -(blocks as isize - 1)..(blocks as isize) {
                let (mut i1, mut i2) = if d >= 0 { (0usize, d as usize) } else { ((-d) as usize, 0usize) };
                let mut s: f64 = (0..j).map(|k| a[i1 + k] * b[i2 + k]).sum();
                loop {
                    g[(i1 * ch + c1, i2 * ch + c2)] = s;
                    if i1 + 1 >= blocks || i2 + 1 >= blocks {
                        break;
                    }
                    s += a[i1 + j] * b[i2 + j] - a[i1] * b[i2];
                    i1 += 1;
                    i2 += 1;
                }
            }
        }
    }
    g
}

fn cholesky_jitter(g: &DMatrix<f64>) -> Result<DMatrix<f64>, String> {
    let dim = g.nrows();
    let scale = (g.trace() / dim as f64).abs().max(1e-300);
    let mut eps = 1e-12;
    while eps < 1e-2 {
        let mut m = g.clone();
        for i in 0..dim {
            m[(i, i)] += eps * scale;
        }
        if let Some(ch) = m.cholesky() {
            return Ok(ch.l());
        }
        eps *= 10.0;
    }
    Err("Hankel matrix is numerically singular (constant or collinear signals?)".into())
}

fn decompose(u: &DMatrix<f64>, y: &DMatrix<f64>, f: usize) -> Result<Decomposition, String> {
    let (n, m) = (u.nrows(), u.ncols());
    let l = y.ncols();
    if n + 1 < 2 * f + 1 {
        return Err("Not enough data for the requested model order.".into());
    }
    let j = n - 2 * f + 1;
    let mut z: Vec<Vec<f64>> = (0..m).map(|c| u.column(c).iter().copied().collect()).collect();
    z.extend((0..l).map(|c| y.column(c).iter().copied().collect::<Vec<f64>>()));
    let ch = m + l;
    let g = hankel_gram(&z, 2 * f, j);
    // Row permutation to [Uf; Up; Yp; Yf].
    let mut perm: Vec<usize> = Vec::with_capacity(2 * f * ch);
    for i in f..2 * f {
        perm.extend((0..m).map(|c| i * ch + c));
    }
    for i in 0..f {
        perm.extend((0..m).map(|c| i * ch + c));
    }
    for i in 0..f {
        perm.extend((m..ch).map(|c| i * ch + c));
    }
    for i in f..2 * f {
        perm.extend((m..ch).map(|c| i * ch + c));
    }
    let dim = perm.len();
    let gp = DMatrix::from_fn(dim, dim, |r, c| g[(perm[r], perm[c])] / j as f64);
    let lmat = cholesky_jitter(&gp)?;
    let r1 = f * m;
    let r2 = f * (m + l);
    let r3 = f * l;
    Ok(Decomposition {
        f,
        l21: lmat.view((r1, 0), (r2, r1)).into_owned(),
        l22: lmat.view((r1, r1), (r2, r2)).into_owned(),
        l32: lmat.view((r1 + r2, r1), (r3, r2)).into_owned(),
        l33: lmat.view((r1 + r2, r1 + r2), (r3, r3)).into_owned(),
    })
}

fn pinv(m: &DMatrix<f64>) -> DMatrix<f64> {
    let tol = 1e-12 * m.nrows().max(m.ncols()) as f64 * m.norm().max(1e-300);
    m.clone().pseudo_inverse(tol).unwrap_or_else(|_| DMatrix::zeros(m.ncols(), m.nrows()))
}

/// Weighted left singular vectors / values and the left weight inverse (CVA).
struct WeightedSvd {
    u: DMatrix<f64>,
    s: DVector<f64>,
    w1_inv: Option<DMatrix<f64>>,
}

fn weighted_svd(dec: &Decomposition, method: &str) -> Result<WeightedSvd, String> {
    let mat = match method {
        "MOESP" => dec.l32.clone(),
        "CVA" => {
            let wy = &dec.l32 * dec.l32.transpose() + &dec.l33 * dec.l33.transpose();
            let eig = SymmetricEigen::new(wy);
            let floor = eig.eigenvalues.max() * 1e-12;
            let lam: Vec<f64> = eig.eigenvalues.iter().map(|v| v.max(floor).max(1e-300)).collect();
            let q = &eig.eigenvectors;
            let isqrt = DMatrix::from_diagonal(&DVector::from_iterator(lam.len(), lam.iter().map(|v| 1.0 / v.sqrt())));
            let sqrt = DMatrix::from_diagonal(&DVector::from_iterator(lam.len(), lam.iter().map(|v| v.sqrt())));
            let w1 = q * isqrt * q.transpose();
            let w1_inv = q * sqrt * q.transpose();
            let m = &w1 * &dec.l32;
            let svd = m.svd(true, false);
            return Ok(WeightedSvd { u: svd.u.ok_or("SVD failed")?, s: svd.singular_values, w1_inv: Some(w1_inv) });
        }
        _ => {
            // N4SID: oblique projection Ob = L32 L22⁺ [L21 L22] (row space of [Q1; Q2]).
            let left = &dec.l32 * pinv(&dec.l22);
            let mut wp = DMatrix::zeros(dec.l21.nrows(), dec.l21.ncols() + dec.l22.ncols());
            wp.view_mut((0, 0), (dec.l21.nrows(), dec.l21.ncols())).copy_from(&dec.l21);
            wp.view_mut((0, dec.l21.ncols()), (dec.l22.nrows(), dec.l22.ncols())).copy_from(&dec.l22);
            left * wp
        }
    };
    let svd = mat.svd(true, false);
    Ok(WeightedSvd { u: svd.u.ok_or("SVD failed")?, s: svd.singular_values, w1_inv: None })
}

fn estimate_ac(ws: &WeightedSvd, order: usize, l: usize, f: usize) -> Result<(DMatrix<f64>, DMatrix<f64>), String> {
    if order > ws.s.len() || order == 0 {
        return Err("Model order exceeds available singular values".into());
    }
    let u1 = ws.u.columns(0, order).into_owned();
    let s_half = DMatrix::from_diagonal(&DVector::from_iterator(order, ws.s.iter().take(order).map(|v| v.max(0.0).sqrt())));
    let mut gamma = u1 * s_half;
    if let Some(w) = &ws.w1_inv {
        gamma = w * gamma;
    }
    let c = gamma.rows(0, l).into_owned();
    let up = gamma.rows(0, (f - 1) * l).into_owned();
    let down = gamma.rows(l, (f - 1) * l).into_owned();
    let a = pinv(&up) * down;
    Ok((a, c))
}

/// B, D by linear least squares on the simulation error (x0 = 0).
fn estimate_bd(a: &DMatrix<f64>, c: &DMatrix<f64>, u: &DMatrix<f64>, y: &DMatrix<f64>) -> Result<(DMatrix<f64>, DMatrix<f64>), String> {
    let n = a.nrows();
    let l = c.nrows();
    let (samples, m) = (u.nrows(), u.ncols());
    let np = n * m + l * m;
    let mut ata = DMatrix::<f64>::zeros(np, np);
    let mut aty = DVector::<f64>::zeros(np);
    // z[c] = n×n state responses to unit B columns, stored row-major.
    let mut z = vec![vec![0.0; n * n]; m];
    let mut tmp = vec![0.0; n * n];
    let mut phi = vec![0.0; l * np];
    let av: Vec<f64> = (0..n * n).map(|i| a[(i / n, i % n)]).collect();
    let cv: Vec<f64> = (0..l * n).map(|i| c[(i / n, i % n)]).collect();
    for k in 0..samples {
        phi.iter_mut().for_each(|v| *v = 0.0);
        for ci in 0..m {
            let zc = &z[ci];
            for o in 0..l {
                for r in 0..n {
                    let mut s = 0.0;
                    for q in 0..n {
                        s += cv[o * n + q] * zc[q * n + r];
                    }
                    phi[o * np + ci * n + r] = s;
                }
            }
            let uk = u[(k, ci)];
            for o in 0..l {
                phi[o * np + n * m + ci * l + o] = uk;
            }
        }
        for o in 0..l {
            let row = &phi[o * np..(o + 1) * np];
            let yk = y[(k, o)];
            for p1 in 0..np {
                let v1 = row[p1];
                if v1 == 0.0 {
                    continue;
                }
                aty[p1] += v1 * yk;
                for p2 in p1..np {
                    ata[(p1, p2)] += v1 * row[p2];
                }
            }
        }
        // z ← A z + I u_k
        for ci in 0..m {
            let zc = &mut z[ci];
            for r in 0..n {
                for col in 0..n {
                    let mut s = 0.0;
                    for q in 0..n {
                        s += av[r * n + q] * zc[q * n + col];
                    }
                    tmp[r * n + col] = s;
                }
            }
            let uk = u[(k, ci)];
            for r in 0..n {
                tmp[r * n + r] += uk;
            }
            zc.copy_from_slice(&tmp);
        }
        if k % 1024 == 0 && !ata[(0, 0)].is_finite() {
            return Err("Unstable model (simulation diverged)".into());
        }
    }
    for p1 in 0..np {
        for p2 in 0..p1 {
            ata[(p1, p2)] = ata[(p2, p1)];
        }
    }
    if !ata.iter().all(|v| v.is_finite()) {
        return Err("Unstable model (simulation diverged)".into());
    }
    let reg = 1e-12 * (ata.trace() / np as f64).abs().max(1e-300);
    for i in 0..np {
        ata[(i, i)] += reg;
    }
    let theta = ata.svd(true, true).solve(&aty, 1e-14).map_err(|e| e.to_string())?;
    let b = DMatrix::from_fn(n, m, |r, ci| theta[ci * n + r]);
    let d = DMatrix::from_fn(l, m, |o, ci| theta[n * m + ci * l + o]);
    Ok((b, d))
}

pub struct SysIdParams {
    pub name: String,
    pub method: String,
    pub order_min: usize,
    pub order_max: usize,
    pub decimation_factor: usize,
    pub start_idx: usize,
    /// Exclusive end index; 0 means "to the end".
    pub end_idx: usize,
}

fn columns_to_matrix(cols: &[Vec<f64>]) -> DMatrix<f64> {
    let n = cols.first().map(|c| c.len()).unwrap_or(0);
    DMatrix::from_fn(n, cols.len(), |r, c| cols[c][r])
}

/// [start, end) shrunk to the rows where every signal has a value. Files that cover slightly
/// different spans leave missing rows at the ends of the common time axis.
pub fn finite_window(inputs: Signals, outputs: Signals, start: usize, end: usize) -> (usize, usize) {
    let all_finite = |i: usize| inputs.iter().chain(outputs.iter()).all(|(_, s)| s.get(i).is_some_and(|v| v.is_finite()));
    let start = (start..end).find(|&i| all_finite(i)).unwrap_or(end);
    let end = (start..end).rev().find(|&i| all_finite(i)).map_or(start, |i| i + 1);
    (start, end)
}

/// Window → decimate → remove mean. Returns (U, Y, dt).
pub fn prepare_io(inputs: Signals, outputs: Signals, fs: f64, dec: usize, start: usize, end: usize) -> Result<(DMatrix<f64>, DMatrix<f64>, f64), String> {
    let len = inputs.first().map(|(_, s)| s.len()).unwrap_or(0);
    let end = if end == 0 || end > len { len } else { end };
    let (start, end) = finite_window(inputs, outputs, start, end);
    if start >= end {
        return Err("Empty identification window".into());
    }
    let prep = |sigs: Signals| -> Result<Vec<Vec<f64>>, String> {
        sigs.iter()
            .map(|(_, s)| {
                let w = &s[start..end.min(s.len())];
                let mut d = if dec > 1 { decimate(w, dec)? } else { w.to_vec() };
                let m = mean(&d);
                d.iter_mut().for_each(|v| *v -= m);
                Ok(d)
            })
            .collect()
    };
    let u = prep(inputs)?;
    let y = prep(outputs)?;
    let dt = if dec > 1 { dec as f64 / fs } else { 1.0 / fs };
    Ok((columns_to_matrix(&u), columns_to_matrix(&y), dt))
}

pub fn identify_model(
    inputs: Signals,
    outputs: Signals,
    fs: f64,
    params: &SysIdParams,
    progress: &dyn Fn(i32, String),
    cancelled: &dyn Fn() -> bool,
) -> Result<Vec<StateSpaceResult>, String> {
    if inputs.is_empty() || outputs.is_empty() {
        return Err("Select at least one input and one output signal.".into());
    }
    let input_names: Vec<String> = inputs.iter().map(|(n, _)| n.clone()).collect();
    let output_names: Vec<String> = outputs.iter().map(|(n, _)| n.clone()).collect();
    progress(0, "Preparing data...".into());
    let (u, y, dt) = prepare_io(inputs, outputs, fs, params.decimation_factor, params.start_idx, params.end_idx)?;
    if u.iter().chain(y.iter()).any(|v| !v.is_finite()) {
        return Err("The signals have gaps inside the selected window. Fill the gaps (Prepare) or pick a window without them.".into());
    }
    let samples = u.nrows();
    let l = y.ncols();
    let method = params.method.to_uppercase();
    let n_orders = params.order_max.saturating_sub(params.order_min) + 1;

    let mut decomps: HashMap<usize, Result<Decomposition, String>> = HashMap::new();
    let mut svds: HashMap<usize, Result<WeightedSvd, String>> = HashMap::new();
    let mut results = Vec::new();
    let mut last_err = String::new();

    for (i, order) in (params.order_min..=params.order_max).enumerate() {
        if cancelled() {
            break;
        }
        progress(((i as f64 / n_orders as f64) * 100.0) as i32, format!("Identifying order {order}..."));
        let mut f = 50.min(samples / 4);
        if f < order + 1 {
            f = order + 1;
        }
        if !decomps.contains_key(&f) {
            decomps.insert(f, decompose(&u, &y, f));
        }
        let dec = match decomps.get(&f).unwrap() {
            Ok(d) => d,
            Err(e) => {
                last_err = e.clone();
                continue;
            }
        };
        if !svds.contains_key(&f) {
            svds.insert(f, weighted_svd(dec, &method));
        }
        let ws = match svds.get(&f).unwrap() {
            Ok(w) => w,
            Err(e) => {
                last_err = e.clone();
                continue;
            }
        };
        let fit = (|| -> Result<StateSpaceResult, String> {
            let (a, c) = estimate_ac(ws, order, l, dec.f)?;
            let (b, d) = estimate_bd(&a, &c, &u, &y)?;
            let ysim = simulate_ss(&a, &b, &c, &d, &u, None);
            let mut metrics = Vec::with_capacity(l);
            for (jo, name) in output_names.iter().enumerate() {
                let ym: Vec<f64> = y.column(jo).iter().copied().collect();
                let ys: Vec<f64> = ysim.column(jo).iter().copied().collect();
                if ys.iter().any(|v| !v.is_finite()) {
                    return Err("Simulation diverged".into());
                }
                metrics.push(compute_metrics(&ym, &ys, name));
            }
            Ok(StateSpaceResult {
                name: format!("{}_order{}", params.name, order),
                a: from_dmatrix(&a),
                b: from_dmatrix(&b),
                c: from_dmatrix(&c),
                d: from_dmatrix(&d),
                input_names: input_names.clone(),
                output_names: output_names.clone(),
                method: params.method.clone(),
                order,
                decimation_factor: params.decimation_factor,
                dt,
                metrics,
                timestamp: now_iso(),
            })
        })();
        match fit {
            Ok(m) => results.push(m),
            Err(e) => last_err = e,
        }
    }
    if results.is_empty() && !cancelled() && !last_err.is_empty() {
        return Err(last_err);
    }
    results.sort_by(|a, b| b.mean_vaf().total_cmp(&a.mean_vaf()));
    progress(100, "Identification complete.".into());
    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_window_skips_missing_rows_at_the_ends() {
        // Two files over slightly different spans: the input starts later, the output ends earlier.
        let u: Vec<f64> = (0..10).map(|i| if i < 2 { f64::NAN } else { i as f64 }).collect();
        let y: Vec<f64> = (0..10).map(|i| if i > 7 { f64::NAN } else { i as f64 }).collect();
        let (u, y) = ([("u".to_string(), Arc::new(u))], [("y".to_string(), Arc::new(y))]);
        assert_eq!(finite_window(&u, &y, 0, 10), (2, 8));
        assert_eq!(finite_window(&u, &y, 3, 6), (3, 6));
    }

    fn lcg(seed: &mut u64) -> f64 {
        *seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        ((*seed >> 11) as f64 / (1u64 << 53) as f64) * 2.0 - 1.0
    }

    #[test]
    fn time_estimator() {
        assert!(estimate_time(1000, 2, 2, 1, 5) > 0.0);
        assert!(estimate_time(10000, 1, 1, 1, 5) > estimate_time(1000, 1, 1, 1, 5));
    }

    #[test]
    fn siso_first_order_recovered() {
        let mut seed = 42;
        let n = 500;
        let u: Vec<f64> = (0..n).map(|_| lcg(&mut seed)).collect();
        let mut y = vec![0.0; n];
        for k in 1..n {
            y[k] = 0.9 * y[k - 1] + 0.5 * u[k];
        }
        for method in ["N4SID", "MOESP", "CVA"] {
            let params = SysIdParams {
                name: "test".into(),
                method: method.into(),
                order_min: 1,
                order_max: 3,
                decimation_factor: 1,
                start_idx: 0,
                end_idx: 0,
            };
            let res = identify_model(
                &[("u".into(), Arc::new(u.clone()))],
                &[("y".into(), Arc::new(y.clone()))],
                1.0,
                &params,
                &|_, _| {},
                &|| false,
            )
            .unwrap();
            assert!(!res.is_empty());
            assert!(res[0].mean_vaf() > 95.0, "{method}: VAF {}", res[0].mean_vaf());
            let pole = res.iter().find(|m| m.order == 1).unwrap().a[0][0];
            assert!((pole - 0.9).abs() < 0.05, "{method}: pole {pole}");
        }
    }

    #[test]
    fn mimo_second_order() {
        let mut seed = 7;
        let n = 2000;
        let u1: Vec<f64> = (0..n).map(|_| lcg(&mut seed)).collect();
        let u2: Vec<f64> = (0..n).map(|_| lcg(&mut seed)).collect();
        let (mut x1, mut x2) = (0.0, 0.0);
        let mut y1 = vec![0.0; n];
        let mut y2 = vec![0.0; n];
        for k in 0..n {
            y1[k] = x1 + 0.1 * u1[k];
            y2[k] = x2;
            let nx1 = 0.95 * x1 + 0.2 * u1[k];
            let nx2 = 0.3 * x1 + 0.8 * x2 + 0.4 * u2[k];
            x1 = nx1;
            x2 = nx2;
        }
        let params = SysIdParams { name: "m".into(), method: "N4SID".into(), order_min: 2, order_max: 2, decimation_factor: 1, start_idx: 0, end_idx: 0 };
        let res = identify_model(
            &[("u1".into(), Arc::new(u1)), ("u2".into(), Arc::new(u2))],
            &[("y1".into(), Arc::new(y1)), ("y2".into(), Arc::new(y2))],
            1.0,
            &params,
            &|_, _| {},
            &|| false,
        )
        .unwrap();
        assert!(res[0].mean_vaf() > 99.0, "VAF {}", res[0].mean_vaf());
    }

    #[test]
    fn hankel_gram_matches_direct() {
        let z = vec![vec![1.0, 2.0, 3.0, 4.0, 5.0, 6.0], vec![0.5, -1.0, 2.0, 0.0, 1.0, 3.0]];
        let blocks = 3;
        let j = 6 - blocks + 1;
        let g = hankel_gram(&z, blocks, j);
        for i1 in 0..blocks {
            for c1 in 0..2 {
                for i2 in 0..blocks {
                    for c2 in 0..2 {
                        let direct: f64 = (0..j).map(|k| z[c1][i1 + k] * z[c2][i2 + k]).sum();
                        assert!((g[(i1 * 2 + c1, i2 * 2 + c2)] - direct).abs() < 1e-9);
                    }
                }
            }
        }
    }
}
