//! Simulation engine: feed measured inputs through state-space models, x0 estimation.

use nalgebra::{DMatrix, DVector};
use std::sync::Arc;

use super::dsp::{decimate, mean};
use super::models::StateSpaceResult;

#[derive(Debug, Clone)]
pub struct SimulationResult {
    pub time: Vec<f64>,
    /// (output name, measured, simulated) in model output order.
    pub outputs: Vec<(String, Vec<f64>, Vec<f64>)>,
    pub x0: Vec<f64>,
}

/// Least-squares x0 from the first `n_steps` samples: Γ x0 ≈ Y − (Markov · U).
pub fn estimate_x0(model: &StateSpaceResult, u: &DMatrix<f64>, y: &DMatrix<f64>, n_steps: usize) -> Result<DVector<f64>, String> {
    let (a, b, c, d) = model.matrices();
    let n = a.nrows();
    let l = c.nrows();
    let steps = n_steps.min(u.nrows());
    let mut gamma = DMatrix::zeros(steps * l, n);
    let mut ycorr = DVector::zeros(steps * l);
    // markov[k] = C A^(k-1) B for k ≥ 1
    let mut markov: Vec<DMatrix<f64>> = Vec::with_capacity(steps);
    let mut a_pow = DMatrix::identity(n, n);
    for k in 0..steps {
        gamma.view_mut((k * l, 0), (l, n)).copy_from(&(&c * &a_pow));
        markov.push(&c * &a_pow * &b);
        let uk = u.row(k).transpose();
        let mut corr = &d * &uk;
        for jj in 0..k {
            corr += &markov[k - jj - 1] * u.row(jj).transpose();
        }
        let yk = y.row(k).transpose();
        ycorr.rows_mut(k * l, l).copy_from(&(yk - corr));
        a_pow = &a_pow * &a;
    }
    gamma.svd(true, true).solve(&ycorr, 1e-12).map_err(|e| e.to_string())
}

pub type Signals<'a> = &'a [(String, Arc<Vec<f64>>)];

/// Simulates `model` on [start, end) of the measured data (mean removed, decimated like the model).
pub fn simulate(
    model: &StateSpaceResult,
    inputs: Signals,
    outputs: Signals,
    time: &[f64],
    x0: Option<Vec<f64>>,
    start: usize,
    end: usize,
) -> Result<SimulationResult, String> {
    let end = if end == 0 || end > time.len() { time.len() } else { end };
    if start >= end {
        return Err("Empty simulation range".into());
    }
    let dec = model.decimation_factor.max(1);
    let prep = |sigs: Signals| -> Result<Vec<Vec<f64>>, String> {
        sigs.iter()
            .map(|(_, s)| {
                let w = &s[start..end];
                let m = mean(w);
                let z: Vec<f64> = w.iter().map(|v| v - m).collect();
                if dec > 1 {
                    decimate(&z, dec)
                } else {
                    Ok(z)
                }
            })
            .collect()
    };
    let ucols = prep(inputs)?;
    let ycols = prep(outputs)?;
    let samples = ucols.first().map(|c| c.len()).unwrap_or(0);
    let u = DMatrix::from_fn(samples, ucols.len(), |r, c| ucols[c][r]);
    let yref = DMatrix::from_fn(samples, ycols.len(), |r, c| ycols[c][r]);
    let time_sim: Vec<f64> = time[start..end].iter().step_by(dec).take(samples).copied().collect();

    let (a, b, c, d) = model.matrices();
    let n = a.nrows();
    let x0v = match x0 {
        Some(v) => DVector::from_vec(v),
        None => estimate_x0(model, &u, &yref, 50.min(samples)).unwrap_or_else(|_| DVector::zeros(n)),
    };
    let ysim = super::sysid::simulate_ss(&a, &b, &c, &d, &u, Some(&x0v));
    let outputs = model
        .output_names
        .iter()
        .enumerate()
        .map(|(j, name)| (name.clone(), yref.column(j).iter().copied().collect(), ysim.column(j).iter().copied().collect()))
        .collect();
    Ok(SimulationResult { time: time_sim, outputs, x0: x0v.iter().copied().collect() })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::models::now_iso;

    #[test]
    fn x0_recovered() {
        let model = StateSpaceResult {
            name: "m".into(),
            a: vec![vec![0.9]],
            b: vec![vec![0.5]],
            c: vec![vec![1.0]],
            d: vec![vec![0.0]],
            input_names: vec!["u".into()],
            output_names: vec!["y".into()],
            method: "N4SID".into(),
            order: 1,
            decimation_factor: 1,
            dt: 1.0,
            metrics: vec![],
            timestamp: now_iso(),
        };
        let (a, b, c, d) = model.matrices();
        let u = DMatrix::from_fn(100, 1, |r, _| ((r * 37) % 11) as f64 - 5.0);
        let x0 = DVector::from_vec(vec![3.0]);
        let y = crate::core::sysid::simulate_ss(&a, &b, &c, &d, &u, Some(&x0));
        let est = estimate_x0(&model, &u, &y, 50).unwrap();
        assert!((est[0] - 3.0).abs() < 1e-8);
    }
}
