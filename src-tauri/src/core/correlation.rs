//! Correlation analysis: Pearson/Spearman matrix, FFT-based cross-correlation and ranking.

use super::par::par_map;
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

/// Pearson r of two columns over the rows where both values are valid (NaN when fewer than two
/// rows remain or a column is constant there).
pub fn pearson_pair(a: &[f64], b: &[f64]) -> f64 {
    let (mut n, mut sa, mut sb) = (0.0, 0.0, 0.0);
    for (x, y) in a.iter().zip(b) {
        if x.is_finite() && y.is_finite() {
            n += 1.0;
            sa += x;
            sb += y;
        }
    }
    if n < 2.0 {
        return f64::NAN;
    }
    let (ma, mb) = (sa / n, sb / n);
    let (mut saa, mut sbb, mut sab) = (0.0, 0.0, 0.0);
    for (x, y) in a.iter().zip(b) {
        if x.is_finite() && y.is_finite() {
            let (dx, dy) = (x - ma, y - mb);
            saa += dx * dx;
            sbb += dy * dy;
            sab += dx * dy;
        }
    }
    let v = sab / (saa.sqrt() * sbb.sqrt());
    if v.is_nan() { v } else { v.clamp(-1.0, 1.0) }
}

/// Pearson matrix that uses, for each pair, only the rows where both signals are valid. Signals from
/// files that overlap only partly (or that were cleaned) therefore still correlate.
pub fn corrcoef_pairwise(cols: &[&[f64]]) -> Vec<Vec<f64>> {
    let k = cols.len();
    let rows = par_map(k, |i| (i..k).map(|j| pearson_pair(cols[i], cols[j])).collect::<Vec<f64>>());
    let mut r = vec![vec![0.0; k]; k];
    for (i, row) in rows.iter().enumerate() {
        for (d, v) in row.iter().enumerate() {
            r[i][i + d] = *v;
            r[i + d][i] = *v;
        }
    }
    r
}

/// Spearman matrix over the rows where both signals of a pair are valid (ranks are taken on those rows).
/// Signals without missing values are ranked once, in parallel, and reused by every pair.
pub fn spearman_pairwise(cols: &[Vec<f64>]) -> Vec<Vec<f64>> {
    let k = cols.len();
    let complete: Vec<bool> = cols.iter().map(|c| c.iter().all(|v| v.is_finite())).collect();
    let ranks: Vec<Option<Vec<f64>>> = par_map(k, |i| complete[i].then(|| rankdata(&cols[i])));
    let pair = |i: usize, j: usize| -> f64 {
        if let (Some(a), Some(b)) = (&ranks[i], &ranks[j]) {
            return pearson_pair(a, b);
        }
        let (mut a, mut b) = (Vec::new(), Vec::new());
        for (x, y) in cols[i].iter().zip(&cols[j]) {
            if x.is_finite() && y.is_finite() {
                a.push(*x);
                b.push(*y);
            }
        }
        if a.len() < 2 { f64::NAN } else { pearson_pair(&rankdata(&a), &rankdata(&b)) }
    };
    let rows: Vec<Vec<f64>> = par_map(k, |i| (i..k).map(|j| pair(i, j)).collect());
    let mut r = vec![vec![0.0; k]; k];
    for (i, row) in rows.iter().enumerate() {
        for (d, v) in row.iter().enumerate() {
            r[i][i + d] = *v;
            r[i + d][i] = *v;
        }
    }
    r
}

/// scipy.stats.rankdata(method="average")
pub fn rankdata(x: &[f64]) -> Vec<f64> {
    let n = x.len();
    // Sorting (value, row) pairs keeps the comparisons in cache; ties are averaged below.
    let mut idx: Vec<(f64, usize)> = x.iter().copied().zip(0..n).collect();
    idx.sort_unstable_by(|a, b| a.0.total_cmp(&b.0));
    let mut ranks = vec![0.0; n];
    let mut i = 0;
    while i < n {
        let mut j = i;
        while j + 1 < n && idx[j + 1].0 == idx[i].0 {
            j += 1;
        }
        let r = (i + j) as f64 / 2.0 + 1.0;
        for k in i..=j {
            ranks[idx[k].1] = r;
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
    // Complete data keeps the numpy.corrcoef path; missing values switch to pairwise-complete rows.
    let has_gaps = refs.iter().any(|c| c.iter().any(|v| !v.is_finite()));
    let pearson = if has_gaps { corrcoef_pairwise(&refs) } else { corrcoef(&refs) };

    // Spearman on (sub-sampled) ranks.
    let rows = refs.first().map(|r| r.len()).unwrap_or(0);
    let sub_idx: Vec<usize> = if rows > 20000 {
        (0..20000).map(|i| ((i as f64) * (rows - 1) as f64 / 19999.0) as usize).collect()
    } else {
        (0..rows).collect()
    };
    let subs: Vec<Vec<f64>> = refs.iter().map(|c| sub_idx.iter().map(|&i| c[i]).collect()).collect();
    let spearman = if subs.iter().any(|s| s.iter().any(|v| !v.is_finite())) {
        spearman_pairwise(&subs)
    } else {
        let ranked: Vec<Vec<f64>> = subs.iter().map(|s| rankdata(s)).collect();
        let rrefs: Vec<&[f64]> = ranked.iter().map(|v| v.as_slice()).collect();
        corrcoef(&rrefs)
    };

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
    // Missing samples (files that cover different spans, gaps) count as zero, so one gap does not
    // blank the whole curve. Like the full-data version, every lag is divided by one constant,
    // √(Na·Nb) of the finite counts, which keeps |r| ≤ 1 and lets lags with little overlap fade.
    let finite = |x: &[f64]| x.iter().copied().filter(|v| v.is_finite()).collect::<Vec<f64>>();
    let (fa, fb) = (finite(a), finite(b));
    let (ma, sa) = (mean(&fa), std(&fa) + 1e-30);
    let (mb, sb) = (mean(&fb), std(&fb) + 1e-30);
    let z = |v: f64, m: f64, s: f64| if v.is_finite() { (v - m) / s } else { 0.0 };
    let an: Vec<f64> = a.iter().map(|&v| z(v, ma, sa)).collect();
    let bn: Vec<f64> = b.iter().rev().map(|&v| z(v, mb, sb)).collect();
    let n = an.len();
    let corr: Vec<f64> = if fa.len() == a.len() && fb.len() == b.len() {
        fftconvolve(&an, &bn).into_iter().map(|v| v / n as f64).collect()
    } else {
        let mask = |x: &mut dyn Iterator<Item = &f64>| x.map(|v| if v.is_finite() { 1.0 } else { 0.0 }).collect::<Vec<f64>>();
        let counts: Vec<f64> = fftconvolve(&mask(&mut a.iter()), &mask(&mut b.iter().rev())).into_iter().map(f64::round).collect();
        let norm = ((fa.len() * fb.len()) as f64).sqrt().max(1.0);
        // Lags where fewer than 10 pairs overlap say nothing.
        fftconvolve(&an, &bn).into_iter().zip(counts).map(|(v, c)| if c >= 10.0 { v / norm } else { f64::NAN }).collect()
    };
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
        if let Some((idx, _)) = corr.iter().enumerate().filter(|x| x.1.is_finite()).max_by(|x, y| x.1.abs().total_cmp(&y.1.abs())) {
            pair.lag_samples = lags[idx];
            pair.lag_seconds = lags[idx] as f64 / fs;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cross_correlation_skips_missing_samples() {
        // b is a delayed by 5 samples; both miss their ends, as two files over different spans do.
        let s = |i: usize| (i as f64 * 0.07).sin() + 0.3 * (i as f64 * 0.31).cos();
        let mut a: Vec<f64> = (0..400).map(s).collect();
        let mut b: Vec<f64> = (0..400).map(|i| if i >= 5 { s(i - 5) } else { f64::NAN }).collect();
        a[..20].fill(f64::NAN);
        b[380..].fill(f64::NAN);
        let (lags, corr) = compute_cross_correlation(&a, &b, Some(50));
        assert!(corr.iter().all(|c| c.is_finite()), "no lag is blanked by the gaps");
        let best = corr.iter().enumerate().max_by(|x, y| x.1.total_cmp(y.1)).unwrap().0;
        assert_eq!(lags[best].abs(), 5);
        assert!(corr[best] > 0.9 && corr[best] <= 1.0, "{}", corr[best]);
    }

    #[test]
    fn missing_rows_are_skipped_pair_by_pair() {
        let a: Vec<f64> = (0..100).map(f64::from).collect();
        let mut b: Vec<f64> = a.iter().map(|x| 2.0 * x + 1.0).collect();
        for v in b.iter_mut().skip(90) {
            *v = f64::NAN;
        }
        let m = corrcoef_pairwise(&[&a, &b]);
        assert!((m[0][1] - 1.0).abs() < 1e-12, "{}", m[0][1]);
        assert!(corrcoef(&[&a, &b])[0][1].is_nan(), "the plain version is spoiled by one gap");
        let s = spearman_pairwise(&[a.clone(), b.clone()]);
        assert!((s[0][1] - 1.0).abs() < 1e-12);
        assert!(pearson_pair(&a, &[1.0; 100]).is_nan(), "a constant column has no correlation");
    }


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
