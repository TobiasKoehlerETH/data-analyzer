//! Correlation analysis: Pearson/Spearman matrix, FFT-based cross-correlation and ranking.

use serde::Serialize;
use std::sync::Arc;

use super::cache::{CacheManager, CacheValue, ALL_SIGNALS};
use super::dsp::{fftconvolve, mean, std};

#[derive(Debug, Clone, Serialize)]
pub struct CorrelationPair {
    pub signal_a: String,
    pub signal_b: String,
    pub pearson_r: f64,
    pub spearman_r: f64,
    pub lag_samples: i64,
    pub lag_seconds: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct CorrelationResult {
    pub columns: Vec<String>,
    pub pearson_matrix: Vec<Vec<f64>>,
    pub spearman_matrix: Vec<Vec<f64>>,
    pub top_pairs: Vec<CorrelationPair>,
}

/// numpy.corrcoef(data, rowvar=False) for a list of equally long columns.
pub fn corrcoef(cols: &[&[f64]]) -> Vec<Vec<f64>> {
    let k = cols.len();
    let centered: Vec<Vec<f64>> = cols
        .iter()
        .map(|c| {
            let m = mean(c);
            c.iter().map(|v| v - m).collect()
        })
        .collect();
    let mut cov = vec![vec![0.0; k]; k];
    for i in 0..k {
        for j in i..k {
            let s: f64 = centered[i].iter().zip(centered[j].iter()).map(|(a, b)| a * b).sum();
            cov[i][j] = s;
            cov[j][i] = s;
        }
    }
    let mut r = vec![vec![0.0; k]; k];
    for i in 0..k {
        for j in 0..k {
            let v = cov[i][j] / (cov[i][i].sqrt() * cov[j][j].sqrt());
            r[i][j] = if v.is_nan() { v } else { v.clamp(-1.0, 1.0) };
        }
    }
    r
}

/// scipy.stats.rankdata(method="average")
pub fn rankdata(x: &[f64]) -> Vec<f64> {
    let n = x.len();
    let mut idx: Vec<usize> = (0..n).collect();
    idx.sort_by(|&a, &b| x[a].total_cmp(&x[b]));
    let mut ranks = vec![0.0; n];
    let mut i = 0;
    while i < n {
        let mut j = i;
        while j + 1 < n && x[idx[j + 1]] == x[idx[i]] {
            j += 1;
        }
        let r = (i + j) as f64 / 2.0 + 1.0;
        for k in i..=j {
            ranks[idx[k]] = r;
        }
        i = j + 1;
    }
    ranks
}

pub fn compute_correlation_matrix(
    signals: &[(String, Arc<Vec<f64>>)],
    cache: Option<&CacheManager>,
) -> Arc<CorrelationResult> {
    let key = CacheManager::make_key(ALL_SIGNALS, "correlation_matrix", &[]);
    if let Some(c) = cache {
        if let Some(CacheValue::Correlation(v)) = c.get(&key) {
            return v;
        }
    }
    let columns: Vec<String> = signals.iter().map(|(n, _)| n.clone()).collect();
    let n = columns.len();
    let refs: Vec<&[f64]> = signals.iter().map(|(_, d)| d.as_slice()).collect();
    let pearson = corrcoef(&refs);

    // Spearman on (sub-sampled) ranks; NaNs propagate as in scipy.
    let rows = refs.first().map(|r| r.len()).unwrap_or(0);
    let sub_idx: Vec<usize> = if rows > 20000 {
        (0..20000).map(|i| ((i as f64) * (rows - 1) as f64 / 19999.0) as usize).collect()
    } else {
        (0..rows).collect()
    };
    let ranked: Vec<Vec<f64>> = refs
        .iter()
        .map(|c| {
            let sub: Vec<f64> = sub_idx.iter().map(|&i| c[i]).collect();
            if sub.iter().any(|v| v.is_nan()) {
                vec![f64::NAN; sub.len()]
            } else {
                rankdata(&sub)
            }
        })
        .collect();
    let rrefs: Vec<&[f64]> = ranked.iter().map(|v| v.as_slice()).collect();
    let spearman = corrcoef(&rrefs);

    let mut pairs = Vec::with_capacity(n * n.saturating_sub(1) / 2);
    for i in 0..n {
        for j in i + 1..n {
            pairs.push(CorrelationPair {
                signal_a: columns[i].clone(),
                signal_b: columns[j].clone(),
                pearson_r: pearson[i][j],
                spearman_r: spearman[i][j],
                lag_samples: 0,
                lag_seconds: 0.0,
            });
        }
    }
    let key_abs = |p: &CorrelationPair| if p.pearson_r.is_nan() { -1.0 } else { p.pearson_r.abs() };
    pairs.sort_by(|a, b| key_abs(b).total_cmp(&key_abs(a)));
    pairs.truncate(20);

    let result = Arc::new(CorrelationResult { columns, pearson_matrix: pearson, spearman_matrix: spearman, top_pairs: pairs });
    if let Some(c) = cache {
        c.set(key, CacheValue::Correlation(result.clone()));
    }
    result
}

/// Normalised cross-correlation via FFT; returns (lags, corr) optionally restricted to ±max_lag.
pub fn compute_cross_correlation(a: &[f64], b: &[f64], max_lag: Option<usize>) -> (Vec<i64>, Vec<f64>) {
    let (ma, sa) = (mean(a), std(a) + 1e-30);
    let (mb, sb) = (mean(b), std(b) + 1e-30);
    let an: Vec<f64> = a.iter().map(|v| (v - ma) / sa).collect();
    let bn: Vec<f64> = b.iter().rev().map(|v| (v - mb) / sb).collect();
    let n = an.len();
    let corr: Vec<f64> = fftconvolve(&an, &bn).into_iter().map(|v| v / n as f64).collect();
    let lags: Vec<i64> = (0..corr.len()).map(|i| i as i64 - (n as i64 - 1)).collect();
    match max_lag {
        Some(ml) => {
            let center = n - 1;
            let start = center.saturating_sub(ml);
            let end = (center + ml + 1).min(corr.len());
            (lags[start..end].to_vec(), corr[start..end].to_vec())
        }
        None => (lags, corr),
    }
}

pub fn compute_lagged_correlations(
    signals: &dyn Fn(&str) -> Option<Arc<Vec<f64>>>,
    pairs: &mut [CorrelationPair],
    fs: f64,
    max_lag_seconds: f64,
) {
    let max_lag = (max_lag_seconds * fs) as usize;
    for pair in pairs.iter_mut() {
        let (Some(a), Some(b)) = (signals(&pair.signal_a), signals(&pair.signal_b)) else { continue };
        let (lags, corr) = compute_cross_correlation(&a, &b, Some(max_lag));
        if let Some((idx, _)) = corr.iter().enumerate().max_by(|x, y| x.1.abs().total_cmp(&y.1.abs())) {
            pair.lag_samples = lags[idx];
            pair.lag_seconds = lags[idx] as f64 / fs;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sig(v: Vec<f64>) -> Arc<Vec<f64>> {
        Arc::new(v)
    }

    #[test]
    fn perfect_correlation() {
        let x: Vec<f64> = (0..100).map(|i| i as f64).collect();
        let y: Vec<f64> = x.iter().map(|v| v * 2.0 + 1.0).collect();
        let r = compute_correlation_matrix(&[("a".into(), sig(x)), ("b".into(), sig(y))], None);
        assert!((r.pearson_matrix[0][1] - 1.0).abs() < 0.01);
        assert!((r.spearman_matrix[0][1] - 1.0).abs() < 1e-12);
    }

    #[test]
    fn top_pairs_sorted() {
        let x: Vec<f64> = (0..500).map(|i| i as f64).collect();
        let c: Vec<f64> = (0..500).map(|i| ((i * 7919) % 101) as f64).collect();
        let r = compute_correlation_matrix(
            &[("a".into(), sig(x.clone())), ("b".into(), sig(x.iter().map(|v| v * 2.0).collect())), ("c".into(), sig(c))],
            None,
        );
        assert_eq!(r.top_pairs.len(), 3);
        assert!(r.top_pairs[0].pearson_r.abs() >= r.top_pairs[2].pearson_r.abs());
        assert_eq!((r.top_pairs[0].signal_a.as_str(), r.top_pairs[0].signal_b.as_str()), ("a", "b"));
    }

    #[test]
    fn cross_corr_no_lag() {
        let x: Vec<f64> = (0..200).map(|i| (i as f64 * 4.0 * std::f64::consts::PI / 199.0).sin()).collect();
        let (lags, corr) = compute_cross_correlation(&x, &x, Some(50));
        let peak = corr.iter().enumerate().max_by(|a, b| a.1.total_cmp(b.1)).unwrap().0;
        assert!(lags[peak].abs() < 2);
    }

    #[test]
    fn cross_corr_with_lag() {
        let mut x = vec![0.0; 200];
        x[100] = 1.0;
        let mut y = vec![0.0; 200];
        y[110] = 1.0;
        let (lags, corr) = compute_cross_correlation(&x, &y, Some(50));
        let peak = corr.iter().enumerate().max_by(|a, b| a.1.total_cmp(b.1)).unwrap().0;
        assert!((lags[peak].abs() - 10).abs() < 2);
    }

    #[test]
    fn ranks_with_ties() {
        assert_eq!(rankdata(&[10.0, 20.0, 10.0, 30.0]), vec![1.5, 3.0, 1.5, 4.0]);
    }
}
