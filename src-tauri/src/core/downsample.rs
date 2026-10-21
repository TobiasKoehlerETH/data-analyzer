//! Display downsampling. Plots request only the visible window at screen resolution;
//! min/max ("peak") decimation keeps transient spikes visible when zoomed out.

use super::dsp::searchsorted;

/// Index range [i0, i1) covering [t0, t1] plus one sample on each side.
pub fn window_indices(t: &[f64], range: Option<(f64, f64)>) -> (usize, usize) {
    match range {
        Some((t0, t1)) if t.len() > 1 && t0 <= t1 => {
            let i0 = searchsorted(t, t0).saturating_sub(1);
            let i1 = (searchsorted(t, t1) + 1).min(t.len());
            (i0, i1.max(i0))
        }
        _ => (0, t.len()),
    }
}

/// Widens [i0, i1) to the nearest valid sample on each side. A signal with most rows missing
/// (a downsampled one) can have no valid sample inside a zoomed window; the line that crosses
/// it still needs the valid samples just outside.
pub fn extend_to_finite(y: &[f64], i0: usize, i1: usize) -> (usize, usize) {
    let (mut a, mut b) = (i0.min(y.len()), i1.min(y.len()));
    while a > 0 {
        a -= 1;
        if y[a].is_finite() {
            break;
        }
    }
    while b < y.len() {
        let valid = y[b].is_finite();
        b += 1;
        if valid {
            break;
        }
    }
    (a, b)
}

/// Peak-preserving decimation of `y` over `x` in [i0, i1) to at most `max_points` points.
pub fn minmax(x: &[f64], y: &[f64], i0: usize, i1: usize, max_points: usize) -> (Vec<f64>, Vec<f64>) {
    let i1 = i1.min(x.len());
    let idx = minmax_indices(y, i0, i1, max_points);
    (idx.iter().map(|&(i, _)| x[i]).collect(), idx.iter().map(|&(i, ok)| if ok { y[i] } else { f64::NAN }).collect())
}

/// Sample indices kept by [`minmax`]: per bucket the minimum and maximum in time order.
/// A bucket without finite values yields its first index flagged `false` (shown as a gap).
pub fn minmax_indices(y: &[f64], i0: usize, i1: usize, max_points: usize) -> Vec<(usize, bool)> {
    let i1 = i1.min(y.len());
    let n = i1.saturating_sub(i0);
    if n <= max_points.max(4) {
        return (i0..i1).map(|i| (i, true)).collect();
    }
    let buckets = (max_points / 2).max(2);
    let mut out = Vec::with_capacity(buckets * 2);
    for b in 0..buckets {
        let s = i0 + b * n / buckets;
        let e = i0 + (b + 1) * n / buckets;
        if s >= e {
            continue;
        }
        let (mut imin, mut imax) = (usize::MAX, usize::MAX);
        for i in s..e {
            let v = y[i];
            if !v.is_finite() {
                continue;
            }
            if imin == usize::MAX || v < y[imin] {
                imin = i;
            }
            if imax == usize::MAX || v > y[imax] {
                imax = i;
            }
        }
        if imin == usize::MAX {
            out.push((s, false));
            continue;
        }
        let (a, b2) = if imin <= imax { (imin, imax) } else { (imax, imin) };
        out.push((a, true));
        if b2 != a {
            out.push((b2, true));
        }
    }
    out
}

/// Stride decimation (`data[::step]`) used by the filter preview.
pub fn stride(n: usize, max_points: usize) -> usize {
    if n <= max_points {
        1
    } else {
        (n / max_points).max(1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_window_between_two_sparse_points_still_reaches_them() {
        let mut y = vec![f64::NAN; 100];
        y[10] = 1.0;
        y[90] = 2.0;
        assert_eq!(extend_to_finite(&y, 40, 60), (10, 91), "reaches the valid samples on both sides");
        assert_eq!(extend_to_finite(&y, 0, 5), (0, 11), "nothing before the start, the next one after");
        let dense = vec![1.0; 10];
        assert_eq!(extend_to_finite(&dense, 3, 6), (2, 7), "a dense signal gains one sample each side");
    }

    #[test]
    fn keeps_spike() {
        let x: Vec<f64> = (0..100_000).map(|i| i as f64).collect();
        let mut y = vec![0.0; 100_000];
        y[54_321] = 10.0;
        let (_, ys) = minmax(&x, &y, 0, x.len(), 1000);
        assert!(ys.len() <= 1000);
        assert!(ys.iter().any(|v| *v == 10.0));
    }

    #[test]
    fn window() {
        let t: Vec<f64> = (0..10).map(|i| i as f64).collect();
        assert_eq!(window_indices(&t, Some((2.5, 5.5))), (2, 7));
        assert_eq!(window_indices(&t, None), (0, 10));
    }
}
