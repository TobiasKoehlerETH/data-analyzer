//! Descriptive statistics, outlier detection, normal distribution helpers and
//! the Shapiro-Wilk normality test (port of AS R94 / scipy `swilk`).

use serde::Serialize;
use std::sync::Arc;

use super::cache::{CacheManager, CacheValue, ALL_SIGNALS};
use super::dsp::{mean, percentile_sorted, std};

#[derive(Debug, Clone, Serialize)]
pub struct StatRow {
    pub signal: String,
    pub count: usize,
    pub mean: f64,
    pub std: f64,
    pub min: f64,
    pub q1: f64,
    pub median: f64,
    pub q3: f64,
    pub max: f64,
    pub skew: f64,
    pub kurtosis: f64,
}

/// scipy.stats.skew (bias=True)
pub fn skew(x: &[f64]) -> f64 {
    let m = mean(x);
    let n = x.len() as f64;
    let m2 = x.iter().map(|v| (v - m).powi(2)).sum::<f64>() / n;
    let m3 = x.iter().map(|v| (v - m).powi(3)).sum::<f64>() / n;
    if m2 <= f64::EPSILON * m.abs().max(1e-300) {
        return f64::NAN;
    }
    m3 / m2.powf(1.5)
}

/// scipy.stats.kurtosis (fisher=True, bias=True)
pub fn kurtosis(x: &[f64]) -> f64 {
    let m = mean(x);
    let n = x.len() as f64;
    let m2 = x.iter().map(|v| (v - m).powi(2)).sum::<f64>() / n;
    let m4 = x.iter().map(|v| (v - m).powi(4)).sum::<f64>() / n;
    if m2 <= f64::EPSILON * m.abs().max(1e-300) {
        return f64::NAN;
    }
    m4 / (m2 * m2) - 3.0
}

/// `percentile_sorted` without sorting: selects the two neighbouring values (the slice is reordered).
fn percentile_select(v: &mut [f64], q: f64) -> f64 {
    let pos = q / 100.0 * (v.len() - 1) as f64;
    let (lo, hi) = (pos.floor() as usize, pos.ceil() as usize);
    let (_, a, right) = v.select_nth_unstable_by(lo, |a, b| a.total_cmp(b));
    let a = *a;
    let b = if hi > lo { right.iter().copied().fold(f64::INFINITY, f64::min) } else { a };
    a + (b - a) * (pos - lo as f64)
}

pub fn compute_descriptive_stats(signals: &[(String, Arc<Vec<f64>>)], cache: Option<&CacheManager>) -> Arc<Vec<StatRow>> {
    let key = CacheManager::make_key(ALL_SIGNALS, "descriptive_stats", &[]);
    if let Some(c) = cache {
        if let Some(CacheValue::Stats(v)) = c.get(&key) {
            return v;
        }
    }
    let row_of = |(name, data): &(String, Arc<Vec<f64>>)| -> Option<StatRow> {
        let clean: Vec<f64> = data.iter().copied().filter(|v| v.is_finite()).collect();
        if clean.is_empty() {
            return None;
        }
        let (min, max) = clean.iter().fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), v| (lo.min(*v), hi.max(*v)));
        let mut work = clean.clone();
        Some(StatRow {
            signal: name.clone(),
            count: clean.len(),
            mean: mean(&clean),
            std: std(&clean),
            min,
            q1: percentile_select(&mut work, 25.0),
            median: percentile_select(&mut work, 50.0),
            q3: percentile_select(&mut work, 75.0),
            max,
            skew: skew(&clean),
            kurtosis: kurtosis(&clean),
        })
    };
    // Signals are independent, so they are spread over the available cores (order is kept).
    let threads = std::thread::available_parallelism().map_or(1, |n| n.get()).min(signals.len().max(1));
    let chunk = signals.len().div_ceil(threads.max(1)).max(1);
    let rows: Vec<StatRow> = std::thread::scope(|sc| {
        let handles: Vec<_> = signals.chunks(chunk).map(|part| sc.spawn(|| part.iter().filter_map(&row_of).collect::<Vec<_>>())).collect();
        handles.into_iter().flat_map(|h| h.join().unwrap_or_default()).collect()
    });
    let rows = Arc::new(rows);
    if let Some(c) = cache {
        c.set(key, CacheValue::Stats(rows.clone()));
    }
    rows
}

#[derive(Debug, Clone, Serialize)]
pub struct OutlierResult {
    pub indices: Vec<usize>,
    pub method: String,
    pub threshold: f64,
    pub count: usize,
}

pub fn detect_outliers_iqr(data: &[f64], factor: f64) -> OutlierResult {
    let mut clean: Vec<f64> = data.iter().copied().filter(|v| v.is_finite()).collect();
    clean.sort_by(|a, b| a.total_cmp(b));
    let q1 = percentile_sorted(&clean, 25.0);
    let q3 = percentile_sorted(&clean, 75.0);
    let iqr = q3 - q1;
    let (lo, hi) = (q1 - factor * iqr, q3 + factor * iqr);
    let indices: Vec<usize> = data.iter().enumerate().filter(|(_, v)| **v < lo || **v > hi).map(|(i, _)| i).collect();
    OutlierResult { count: indices.len(), indices, method: "IQR".into(), threshold: factor }
}

pub fn detect_outliers_zscore(data: &[f64], threshold: f64) -> OutlierResult {
    let clean: Vec<f64> = data.iter().copied().filter(|v| v.is_finite()).collect();
    let m = mean(&clean);
    let s = std(&clean);
    if s == 0.0 {
        return OutlierResult { indices: vec![], method: "Z-score".into(), threshold, count: 0 };
    }
    let indices: Vec<usize> = data.iter().enumerate().filter(|(_, v)| ((**v - m) / s).abs() > threshold).map(|(i, _)| i).collect();
    OutlierResult { count: indices.len(), indices, method: "Z-score".into(), threshold }
}

// ---------------------------------------------------------------------------
// Normal distribution
// ---------------------------------------------------------------------------

pub fn norm_pdf(x: f64, mu: f64, sigma: f64) -> f64 {
    let z = (x - mu) / sigma;
    (-0.5 * z * z).exp() / (sigma * (2.0 * std::f64::consts::PI).sqrt())
}

pub fn norm_cdf(x: f64) -> f64 {
    0.5 * libm::erfc(-x / std::f64::consts::SQRT_2)
}

/// Upper tail P(Z > (x - mu) / sigma).
pub fn norm_sf(x: f64, mu: f64, sigma: f64) -> f64 {
    0.5 * libm::erfc((x - mu) / sigma / std::f64::consts::SQRT_2)
}

/// Inverse standard normal CDF (Acklam's algorithm + one Halley refinement step).
pub fn norm_ppf(p: f64) -> f64 {
    if p <= 0.0 {
        return f64::NEG_INFINITY;
    }
    if p >= 1.0 {
        return f64::INFINITY;
    }
    const A: [f64; 6] = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
    const B: [f64; 5] = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
    const C: [f64; 6] = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
    const D: [f64; 4] = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
    let plow = 0.02425;
    let x = if p < plow {
        let q = (-2.0 * p.ln()).sqrt();
        (((((C[0] * q + C[1]) * q + C[2]) * q + C[3]) * q + C[4]) * q + C[5]) / ((((D[0] * q + D[1]) * q + D[2]) * q + D[3]) * q + 1.0)
    } else if p <= 1.0 - plow {
        let q = p - 0.5;
        let r = q * q;
        (((((A[0] * r + A[1]) * r + A[2]) * r + A[3]) * r + A[4]) * r + A[5]) * q / (((((B[0] * r + B[1]) * r + B[2]) * r + B[3]) * r + B[4]) * r + 1.0)
    } else {
        let q = (-2.0 * (1.0 - p).ln()).sqrt();
        -(((((C[0] * q + C[1]) * q + C[2]) * q + C[3]) * q + C[4]) * q + C[5]) / ((((D[0] * q + D[1]) * q + D[2]) * q + D[3]) * q + 1.0)
    };
    let e = norm_cdf(x) - p;
    let u = e * (2.0 * std::f64::consts::PI).sqrt() * (x * x / 2.0).exp();
    x - u / (1.0 + x * u / 2.0)
}

// ---------------------------------------------------------------------------
// Shapiro-Wilk
// ---------------------------------------------------------------------------

fn poly(cc: &[f64], x: f64) -> f64 {
    let nord = cc.len();
    let mut ret = cc[0];
    if nord > 1 {
        let mut p = x * cc[nord - 1];
        for j in (1..nord - 1).rev() {
            p = (p + cc[j]) * x;
        }
        ret += p;
    }
    ret
}

/// Shapiro-Wilk test → (W, p-value). Mirrors scipy.stats.shapiro for 3 ≤ n ≤ 5000.
pub fn shapiro(data: &[f64]) -> Option<(f64, f64)> {
    let mut x: Vec<f64> = data.iter().copied().filter(|v| v.is_finite()).collect();
    let n = x.len();
    if n < 3 {
        return None;
    }
    x.sort_by(|a, b| a.total_cmp(b));
    let m0 = mean(&x);
    for v in x.iter_mut() {
        *v -= m0;
    }
    let an = n as f64;
    let nn2 = n / 2;
    const SMALL: f64 = 1e-19;
    const G: [f64; 2] = [-2.273, 0.459];
    const C1: [f64; 6] = [0.0, 0.221157, -0.147981, -2.07119, 4.434685, -2.706056];
    const C2: [f64; 6] = [0.0, 0.042981, -0.293762, -1.752461, 5.682633, -3.582633];
    const C3: [f64; 4] = [0.544, -0.39978, 0.025054, -6.714e-4];
    const C4: [f64; 4] = [1.3822, -0.77857, 0.062767, -0.0020322];
    const C5: [f64; 4] = [-1.5861, -0.31082, -0.083751, 0.0038915];
    const C6: [f64; 3] = [-0.4803, -0.082676, 0.0030302];

    let mut a = vec![0.0; nn2.max(1)];
    if n == 3 {
        a[0] = 0.5f64.sqrt();
    } else {
        let an25 = an + 0.25;
        let m: Vec<f64> = (1..=nn2).map(|i| norm_ppf((i as f64 - 0.375) / an25)).collect();
        let summ2 = 2.0 * m.iter().map(|v| v * v).sum::<f64>();
        let ssumm2 = summ2.sqrt();
        let rsn = 1.0 / an.sqrt();
        let a1 = poly(&C1, rsn) - m[0] / ssumm2;
        let (i1, fac) = if n > 5 {
            let a2 = -m[1] / ssumm2 + poly(&C2, rsn);
            let fac = ((summ2 - 2.0 * m[0] * m[0] - 2.0 * m[1] * m[1]) / (1.0 - 2.0 * a1 * a1 - 2.0 * a2 * a2)).sqrt();
            a[1] = a2;
            (3, fac)
        } else {
            (2, ((summ2 - 2.0 * m[0] * m[0]) / (1.0 - 2.0 * a1 * a1)).sqrt())
        };
        a[0] = a1;
        for i in i1..=nn2 {
            a[i - 1] = -m[i - 1] / fac;
        }
    }

    let range = x[n - 1] - x[0];
    if range < SMALL {
        return None;
    }
    // Full antisymmetric coefficient vector for the sorted sample.
    let mut coef = vec![0.0; n];
    for i in 0..nn2 {
        coef[i] = -a[i];
        coef[n - 1 - i] = a[i];
    }
    let xs: Vec<f64> = x.iter().map(|v| v / range).collect();
    let sa = mean(&coef);
    let sx = mean(&xs);
    let (mut ssa, mut ssx, mut sax) = (0.0, 0.0, 0.0);
    for i in 0..n {
        let asa = coef[i] - sa;
        let xsx = xs[i] - sx;
        ssa += asa * asa;
        ssx += xsx * xsx;
        sax += asa * xsx;
    }
    let ssassx = (ssa * ssx).sqrt();
    let w1 = (ssassx - sax) * (ssassx + sax) / (ssa * ssx);
    let w = 1.0 - w1;

    if n == 3 {
        let pi6 = 1.909_859_317_102_74;
        let stqr = 1.047_197_551_196_6;
        let pw = (pi6 * (w.sqrt().asin() - stqr)).max(0.0);
        return Some((w, pw));
    }
    let mut y = w1.ln();
    let xx = an.ln();
    let (m, s) = if n <= 11 {
        let gamma = poly(&G, an);
        if y >= gamma {
            return Some((w, 1e-99));
        }
        y = -(gamma - y).ln();
        (poly(&C3, an), poly(&C4, an).exp())
    } else {
        (poly(&C5, xx), poly(&C6, xx).exp())
    };
    Some((w, norm_sf(y, m, s)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ppf_roundtrip() {
        for p in [1e-6, 0.01, 0.2, 0.5, 0.8, 0.975, 1.0 - 1e-6] {
            assert!((norm_cdf(norm_ppf(p)) - p).abs() < 1e-12);
        }
        assert!((norm_ppf(0.975) - 1.959963984540054).abs() < 1e-9);
    }

    #[test]
    fn skew_kurtosis_basic() {
        let x = [1.0, 2.0, 3.0, 4.0, 10.0];
        // scipy.stats.skew([1,2,3,4,10]) = 1.1384199576606167; kurtosis = -0.212
        assert!((skew(&x) - 1.1384199576606167).abs() < 1e-12);
        assert!((kurtosis(&x) - (-0.212)).abs() < 1e-12);
    }
}
