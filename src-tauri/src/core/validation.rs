//! Validation engine: residuals, metrics, ACF, normality tests, input-residual cross-correlation.

use super::dsp::{fftconvolve, mean, std, var};
use super::models::OutputMetrics;
use super::simulation::SimulationResult;
use super::stats::shapiro;
use super::sysid::compute_metrics as sysid_metrics;

#[derive(Debug, Clone)]
pub struct ResidualAnalysis {
    pub output_name: String,
    pub residuals: Vec<f64>,
    pub acf: Vec<f64>,
    pub acf_lags: Vec<usize>,
    pub acf_confidence: f64,
    pub shapiro_stat: f64,
    pub shapiro_p: f64,
    pub metrics: OutputMetrics,
}

#[derive(Debug, Clone, Default)]
pub struct ValidationResult {
    pub analyses: Vec<ResidualAnalysis>,
    /// output → [(input, xcorr)]
    pub input_residual_xcorr: Vec<(String, Vec<(String, Vec<f64>)>)>,
}

pub fn compute_residuals(sim: &SimulationResult) -> Vec<(String, Vec<f64>)> {
    sim.outputs
        .iter()
        .map(|(name, meas, simulated)| (name.clone(), meas.iter().zip(simulated).map(|(a, b)| a - b).collect()))
        .collect()
}

/// Autocorrelation for lags 0..=max_lag, normalised by var·n (np.correlate equivalent via FFT).
pub fn compute_acf(res: &[f64], max_lag: usize) -> (Vec<usize>, Vec<f64>) {
    let n = res.len();
    let max_lag = max_lag.min(n.saturating_sub(1));
    let m = mean(res);
    let r: Vec<f64> = res.iter().map(|v| v - m).collect();
    let v = var(&r);
    let lags: Vec<usize> = (0..=max_lag).collect();
    if v < 1e-30 {
        return (lags, vec![0.0; max_lag + 1]);
    }
    let rev: Vec<f64> = r.iter().rev().copied().collect();
    let full = fftconvolve(&r, &rev);
    let acf = (0..=max_lag).map(|k| full[n - 1 + k] / (v * n as f64)).collect();
    (lags, acf)
}

pub fn compute_metrics(measured: &[f64], simulated: &[f64], name: &str) -> OutputMetrics {
    sysid_metrics(measured, simulated, name)
}

pub fn compute_input_residual_xcorr(
    inputs: &[(String, Vec<f64>)],
    residuals: &[(String, Vec<f64>)],
    max_lag: usize,
) -> Vec<(String, Vec<(String, Vec<f64>)>)> {
    residuals
        .iter()
        .map(|(out, res)| {
            let (mr, sr) = (mean(res), std(res) + 1e-30);
            let rn: Vec<f64> = res.iter().map(|v| (v - mr) / sr).collect();
            let per_input = inputs
                .iter()
                .map(|(inp, data)| {
                    let (mi, si) = (mean(data), std(data) + 1e-30);
                    let inn: Vec<f64> = data.iter().map(|v| (v - mi) / si).collect();
                    let n = rn.len().min(inn.len());
                    let rev: Vec<f64> = inn[..n].iter().rev().copied().collect();
                    let x: Vec<f64> = fftconvolve(&rn[..n], &rev).into_iter().map(|v| v / n as f64).collect();
                    let center = n.saturating_sub(1);
                    let start = center.saturating_sub(max_lag);
                    let end = (center + max_lag + 1).min(x.len());
                    (inp.clone(), x[start..end].to_vec())
                })
                .collect();
            (out.clone(), per_input)
        })
        .collect()
}

pub fn validate(sim: &SimulationResult, inputs: Option<&[(String, Vec<f64>)]>, max_acf_lag: usize) -> ValidationResult {
    let residuals = compute_residuals(sim);
    let analyses = sim
        .outputs
        .iter()
        .zip(residuals.iter())
        .map(|((name, meas, simulated), (_, res))| {
            let metrics = compute_metrics(meas, simulated, name);
            let (acf_lags, acf) = compute_acf(res, max_acf_lag);
            let n = res.len();
            let acf_confidence = if n > 0 { 1.96 / (n as f64).sqrt() } else { 0.0 };
            let (shapiro_stat, shapiro_p) = shapiro(&res[..n.min(5000)]).unwrap_or((0.0, 0.0));
            ResidualAnalysis {
                output_name: name.clone(),
                residuals: res.clone(),
                acf,
                acf_lags,
                acf_confidence,
                shapiro_stat,
                shapiro_p,
                metrics,
            }
        })
        .collect();
    let input_residual_xcorr = match inputs {
        Some(i) if !i.is_empty() => compute_input_residual_xcorr(i, &residuals, 200),
        _ => vec![],
    };
    ValidationResult { analyses, input_residual_xcorr }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lcg(seed: &mut u64) -> f64 {
        *seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        ((*seed >> 11) as f64 / (1u64 << 53) as f64) * 2.0 - 1.0
    }

    #[test]
    fn perfect_and_bad_fit() {
        let y = [1.0, 2.0, 3.0, 4.0, 5.0];
        let m = compute_metrics(&y, &y, "t");
        assert!(m.rmse < 1e-10 && m.vaf > 99.99 && m.r_squared > 0.999);
        let yh = [5.0, 4.0, 3.0, 2.0, 1.0];
        let m = compute_metrics(&y, &yh, "t");
        assert!(m.rmse > 1.0 && m.vaf < 50.0);
    }

    #[test]
    fn white_noise_acf() {
        let mut s = 42;
        let r: Vec<f64> = (0..1000).map(|_| lcg(&mut s)).collect();
        let (_, acf) = compute_acf(&r, 50);
        assert!((acf[0] - 1.0).abs() < 0.01);
        assert!(acf[1..].iter().map(|v| v.abs()).sum::<f64>() / 50.0 < 0.1);
    }

    #[test]
    fn correlated_acf() {
        let mut s = 42;
        let mut r = vec![0.0; 1000];
        for k in 1..1000 {
            r[k] = 0.9 * r[k - 1] + lcg(&mut s);
        }
        let (_, acf) = compute_acf(&r, 50);
        assert!(acf[1] > 0.5);
    }

    #[test]
    fn residuals_correct() {
        let sim = SimulationResult { time: vec![0.0, 1.0, 2.0], outputs: vec![("y".into(), vec![1.0, 2.0, 3.0], vec![1.1, 2.1, 2.9])], x0: vec![0.0] };
        let r = compute_residuals(&sim);
        for (a, b) in r[0].1.iter().zip([-0.1, -0.1, 0.1]) {
            assert!((a - b).abs() < 1e-10);
        }
    }
}
