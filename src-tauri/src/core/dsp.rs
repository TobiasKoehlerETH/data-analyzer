//! Signal-processing primitives that mirror the scipy.signal behaviour used by the
//! original application: Butterworth / Chebyshev-I design (SOS), `sosfiltfilt`,
//! `iirnotch`, Savitzky-Golay, `medfilt`, Welch PSD, `find_peaks` (prominence),
//! FFT-based convolution and `decimate`.

use num_complex::Complex64;
use realfft::RealFftPlanner;
use rustfft::FftPlanner;
use std::f64::consts::PI;

/// Second-order section: [b0, b1, b2, a0, a1, a2] with a0 == 1.
pub type Sos = [f64; 6];

// ---------------------------------------------------------------------------
// Filter design
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BandType {
    Low,
    High,
    BandPass,
    BandStop,
}

struct Zpk {
    z: Vec<Complex64>,
    p: Vec<Complex64>,
    k: f64,
}

fn prod(v: &[Complex64]) -> Complex64 {
    v.iter().fold(Complex64::new(1.0, 0.0), |acc, x| acc * x)
}

fn buttap(n: usize) -> Zpk {
    let p = (0..n)
        .map(|i| {
            let m = -(n as f64) + 1.0 + 2.0 * i as f64;
            -(Complex64::new(0.0, PI * m / (2.0 * n as f64))).exp()
        })
        .collect();
    Zpk { z: vec![], p, k: 1.0 }
}

fn cheb1ap(n: usize, rp: f64) -> Zpk {
    let eps = (10f64.powf(0.1 * rp) - 1.0).sqrt();
    let mu = (1.0 / eps).asinh() / n as f64;
    let p: Vec<Complex64> = (0..n)
        .map(|i| {
            let m = -(n as f64) + 1.0 + 2.0 * i as f64;
            let theta = PI * m / (2.0 * n as f64);
            -(Complex64::new(mu, theta)).sinh()
        })
        .collect();
    let neg: Vec<Complex64> = p.iter().map(|x| -x).collect();
    let mut k = prod(&neg).re;
    if n % 2 == 0 {
        k /= (1.0 + eps * eps).sqrt();
    }
    Zpk { z: vec![], p, k }
}

fn lp2lp(zpk: Zpk, wo: f64) -> Zpk {
    let degree = zpk.p.len() as i32 - zpk.z.len() as i32;
    Zpk {
        z: zpk.z.iter().map(|z| z * wo).collect(),
        p: zpk.p.iter().map(|p| p * wo).collect(),
        k: zpk.k * wo.powi(degree),
    }
}

fn lp2hp(zpk: Zpk, wo: f64) -> Zpk {
    let degree = zpk.p.len() - zpk.z.len();
    let negz: Vec<Complex64> = zpk.z.iter().map(|x| -x).collect();
    let negp: Vec<Complex64> = zpk.p.iter().map(|x| -x).collect();
    let k = zpk.k * (prod(&negz) / prod(&negp)).re;
    let mut z: Vec<Complex64> = zpk.z.iter().map(|z| wo / z).collect();
    z.extend(std::iter::repeat(Complex64::new(0.0, 0.0)).take(degree));
    Zpk { z, p: zpk.p.iter().map(|p| wo / p).collect(), k }
}

fn lp2bp(zpk: Zpk, wo: f64, bw: f64) -> Zpk {
    let degree = zpk.p.len() - zpk.z.len();
    let w2 = Complex64::new(wo * wo, 0.0);
    let split = |v: &[Complex64]| -> Vec<Complex64> {
        let lp: Vec<Complex64> = v.iter().map(|x| x * (bw / 2.0)).collect();
        let mut out: Vec<Complex64> = lp.iter().map(|x| x + (x * x - w2).sqrt()).collect();
        out.extend(lp.iter().map(|x| x - (x * x - w2).sqrt()));
        out
    };
    let mut z = split(&zpk.z);
    z.extend(std::iter::repeat(Complex64::new(0.0, 0.0)).take(degree));
    Zpk { z, p: split(&zpk.p), k: zpk.k * bw.powi(degree as i32) }
}

fn lp2bs(zpk: Zpk, wo: f64, bw: f64) -> Zpk {
    let degree = zpk.p.len() - zpk.z.len();
    let w2 = Complex64::new(wo * wo, 0.0);
    let negz: Vec<Complex64> = zpk.z.iter().map(|x| -x).collect();
    let negp: Vec<Complex64> = zpk.p.iter().map(|x| -x).collect();
    let k = zpk.k * (prod(&negz) / prod(&negp)).re;
    let zhp: Vec<Complex64> = zpk.z.iter().map(|z| (bw / 2.0) / z).collect();
    let php: Vec<Complex64> = zpk.p.iter().map(|p| (bw / 2.0) / p).collect();
    let split = |lp: &[Complex64]| -> Vec<Complex64> {
        let mut out: Vec<Complex64> = lp.iter().map(|x| x + (x * x - w2).sqrt()).collect();
        out.extend(lp.iter().map(|x| x - (x * x - w2).sqrt()));
        out
    };
    let mut z = split(&zhp);
    // Zeros at infinity move to the centre of the stop band.
    z.extend(std::iter::repeat(Complex64::new(0.0, wo)).take(degree));
    z.extend(std::iter::repeat(Complex64::new(0.0, -wo)).take(degree));
    Zpk { z, p: split(&php), k }
}

fn bilinear(zpk: Zpk, fs: f64) -> Zpk {
    let fs2 = Complex64::new(2.0 * fs, 0.0);
    let degree = zpk.p.len() - zpk.z.len();
    let mut z: Vec<Complex64> = zpk.z.iter().map(|z| (fs2 + z) / (fs2 - z)).collect();
    let p: Vec<Complex64> = zpk.p.iter().map(|p| (fs2 + p) / (fs2 - p)).collect();
    z.extend(std::iter::repeat(Complex64::new(-1.0, 0.0)).take(degree));
    let nz: Vec<Complex64> = zpk.z.iter().map(|z| fs2 - z).collect();
    let np: Vec<Complex64> = zpk.p.iter().map(|p| fs2 - p).collect();
    let k = zpk.k * (prod(&nz) / prod(&np)).re;
    Zpk { z, p, k }
}

/// Splits roots into real roots and one representative (imag > 0) of each conjugate pair.
fn split_roots(v: &[Complex64]) -> (Vec<f64>, Vec<Complex64>) {
    let mut reals = Vec::new();
    let mut cplx = Vec::new();
    for r in v {
        let tol = 1e-9 * r.norm().max(1e-300);
        if r.im.abs() <= tol.max(1e-14) {
            reals.push(r.re);
        } else if r.im > 0.0 {
            cplx.push(*r);
        }
    }
    (reals, cplx)
}

/// Quadratic factors (each [1, c1, c2]) from roots, closest-to-unit-circle first.
fn root_pairs(v: &[Complex64]) -> Vec<([f64; 3], Complex64)> {
    let (mut reals, cplx) = split_roots(v);
    let mut out: Vec<([f64; 3], Complex64)> = cplx
        .iter()
        .map(|r| ([1.0, -2.0 * r.re, r.norm_sqr()], *r))
        .collect();
    reals.sort_by(|a, b| (1.0 - a.abs()).abs().partial_cmp(&(1.0 - b.abs()).abs()).unwrap());
    let mut i = 0;
    while i < reals.len() {
        if i + 1 < reals.len() {
            let (a, b) = (reals[i], reals[i + 1]);
            out.push(([1.0, -(a + b), a * b], Complex64::new(a, 0.0)));
            i += 2;
        } else {
            out.push(([1.0, -reals[i], 0.0], Complex64::new(reals[i], 0.0)));
            i += 1;
        }
    }
    out
}

fn zpk2sos(zpk: Zpk) -> Vec<Sos> {
    let mut pole_pairs = root_pairs(&zpk.p);
    let mut zero_pairs = root_pairs(&zpk.z);
    // Poles closest to the unit circle go last (scipy convention); pair each with nearest zeros.
    pole_pairs.sort_by(|a, b| {
        (1.0 - a.1.norm()).abs().partial_cmp(&(1.0 - b.1.norm()).abs()).unwrap()
    });
    let n_sec = pole_pairs.len().max(zero_pairs.len()).max(1);
    let mut sections: Vec<Sos> = Vec::with_capacity(n_sec);
    for pp in pole_pairs.iter() {
        let zsec = if zero_pairs.is_empty() {
            [1.0, 0.0, 0.0]
        } else {
            let (idx, _) = zero_pairs
                .iter()
                .enumerate()
                .map(|(i, z)| (i, (z.1 - pp.1).norm()))
                .min_by(|a, b| a.1.partial_cmp(&b.1).unwrap())
                .unwrap();
            zero_pairs.remove(idx).0
        };
        sections.push([zsec[0], zsec[1], zsec[2], 1.0, pp.0[1], pp.0[2]]);
    }
    for zp in zero_pairs {
        sections.push([zp.0[0], zp.0[1], zp.0[2], 1.0, 0.0, 0.0]);
    }
    sections.reverse();
    if let Some(first) = sections.first_mut() {
        first[0] *= zpk.k;
        first[1] *= zpk.k;
        first[2] *= zpk.k;
    }
    sections
}

fn digital_from_prototype(proto: Zpk, wn: &[f64], btype: BandType) -> Vec<Sos> {
    // scipy: fs = 2 (normalised), warped = 2*fs*tan(pi*Wn/fs)
    let fs = 2.0;
    let warped: Vec<f64> = wn.iter().map(|w| 2.0 * fs * (PI * w / fs).tan()).collect();
    let analog = match btype {
        BandType::Low => lp2lp(proto, warped[0]),
        BandType::High => lp2hp(proto, warped[0]),
        BandType::BandPass => {
            let bw = warped[1] - warped[0];
            let wo = (warped[0] * warped[1]).sqrt();
            lp2bp(proto, wo, bw)
        }
        BandType::BandStop => {
            let bw = warped[1] - warped[0];
            let wo = (warped[0] * warped[1]).sqrt();
            lp2bs(proto, wo, bw)
        }
    };
    zpk2sos(bilinear(analog, fs))
}

/// scipy.signal.butter(order, wn, btype, output="sos"); `wn` normalised to Nyquist.
pub fn butter_sos(order: usize, wn: &[f64], btype: BandType) -> Vec<Sos> {
    digital_from_prototype(buttap(order.max(1)), wn, btype)
}

/// scipy.signal.cheby1(order, rp, wn, output="sos") lowpass; `wn` normalised to Nyquist.
pub fn cheby1_lowpass_sos(order: usize, rp: f64, wn: f64) -> Vec<Sos> {
    digital_from_prototype(cheb1ap(order.max(1), rp), &[wn], BandType::Low)
}

/// scipy.signal.iirnotch(w0, Q, fs) as a single SOS section.
pub fn iirnotch(freq: f64, q: f64, fs: f64) -> Sos {
    let w0 = 2.0 * freq / fs;
    let bw = w0 / q * PI;
    let w0 = w0 * PI;
    let gb = 1.0 / 2f64.sqrt();
    let beta = ((1.0 - gb * gb).sqrt() / gb) * (bw / 2.0).tan();
    let gain = 1.0 / (1.0 + beta);
    [gain, -2.0 * gain * w0.cos(), gain, 1.0, -2.0 * gain * w0.cos(), 2.0 * gain - 1.0]
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

/// Steady-state initial conditions of one biquad for a unit step (scipy.signal.lfilter_zi).
fn biquad_zi(s: &Sos) -> [f64; 2] {
    let (b0, b1, b2, a1, a2) = (s[0], s[1], s[2], s[4], s[5]);
    // Solve [[1+a1, -1], [a2, 1]] zi = [b1 - a1*b0, b2 - a2*b0]
    let r0 = b1 - a1 * b0;
    let r1 = b2 - a2 * b0;
    let det = (1.0 + a1) + a2;
    if det.abs() < 1e-300 {
        return [0.0, 0.0];
    }
    let z0 = (r0 + r1) / det;
    let z1 = r1 - a2 * z0;
    [z0, z1]
}

/// scipy.signal.sosfilt_zi
pub fn sosfilt_zi(sos: &[Sos]) -> Vec<[f64; 2]> {
    let mut scale = 1.0;
    sos.iter()
        .map(|s| {
            let zi = biquad_zi(s);
            let out = [zi[0] * scale, zi[1] * scale];
            let bsum = s[0] + s[1] + s[2];
            let asum = s[3] + s[4] + s[5];
            scale *= bsum / asum;
            out
        })
        .collect()
}

/// Direct-form II transposed cascade, in place.
pub fn sosfilt_inplace(sos: &[Sos], x: &mut [f64], zi: &mut [[f64; 2]]) {
    for v in x.iter_mut() {
        let mut xin = *v;
        for (s, z) in sos.iter().zip(zi.iter_mut()) {
            let y = s[0] * xin + z[0];
            z[0] = s[1] * xin - s[4] * y + z[1];
            z[1] = s[2] * xin - s[5] * y;
            xin = y;
        }
        *v = xin;
    }
}

fn odd_ext(x: &[f64], n: usize) -> Vec<f64> {
    let len = x.len();
    let mut out = Vec::with_capacity(len + 2 * n);
    for i in (1..=n).rev() {
        out.push(2.0 * x[0] - x[i]);
    }
    out.extend_from_slice(x);
    for i in 1..=n {
        out.push(2.0 * x[len - 1] - x[len - 1 - i]);
    }
    out
}

/// scipy.signal.sosfiltfilt with padtype="odd" and default padlen.
pub fn sosfiltfilt(sos: &[Sos], x: &[f64]) -> Result<Vec<f64>, String> {
    if sos.is_empty() {
        return Ok(x.to_vec());
    }
    let mut ntaps = 2 * sos.len() + 1;
    let zb = sos.iter().filter(|s| s[2] == 0.0).count();
    let za = sos.iter().filter(|s| s[5] == 0.0).count();
    ntaps -= zb.min(za);
    let edge = 3 * ntaps;
    if x.len() <= edge {
        return Err(format!(
            "The length of the input vector x must be greater than padlen, which is {edge}."
        ));
    }
    let mut ext = odd_ext(x, edge);
    let zi0 = sosfilt_zi(sos);
    let x0 = ext[0];
    let mut zi: Vec<[f64; 2]> = zi0.iter().map(|z| [z[0] * x0, z[1] * x0]).collect();
    sosfilt_inplace(sos, &mut ext, &mut zi);
    ext.reverse();
    let y0 = ext[0];
    let mut zi: Vec<[f64; 2]> = zi0.iter().map(|z| [z[0] * y0, z[1] * y0]).collect();
    sosfilt_inplace(sos, &mut ext, &mut zi);
    ext.reverse();
    Ok(ext[edge..ext.len() - edge].to_vec())
}

/// Least-squares polynomial coefficients (lowest power first) of degree `order` fitted to (t, y).
pub fn polyfit(t: &[f64], y: &[f64], order: usize) -> Vec<f64> {
    let ncoef = order + 1;
    let a = nalgebra::DMatrix::from_fn(t.len(), ncoef, |i, j| t[i].powi(j as i32));
    let b = nalgebra::DVector::from_column_slice(y);
    let svd = a.svd(true, true);
    match svd.solve(&b, 1e-12) {
        Ok(c) => c.iter().copied().collect(),
        Err(_) => vec![0.0; ncoef],
    }
}

fn polyval(c: &[f64], t: f64) -> f64 {
    c.iter().rev().fold(0.0, |acc, &ci| acc * t + ci)
}

/// Savitzky-Golay smoothing coefficients for the window centre.
pub fn savgol_coeffs(window: usize, polyorder: usize) -> Vec<f64> {
    let half = (window / 2) as f64;
    let a = nalgebra::DMatrix::from_fn(window, polyorder + 1, |i, j| (i as f64 - half).powi(j as i32));
    let pinv = a.clone().pseudo_inverse(1e-12).unwrap_or_else(|_| nalgebra::DMatrix::zeros(polyorder + 1, window));
    (0..window).map(|i| pinv[(0, i)]).collect()
}

/// scipy.signal.savgol_filter(x, window, polyorder) with mode="interp".
pub fn savgol_filter(x: &[f64], window: usize, polyorder: usize) -> Vec<f64> {
    let n = x.len();
    let half = window / 2;
    let c = savgol_coeffs(window, polyorder);
    let mut y = vec![0.0; n];
    for k in half..n.saturating_sub(half) {
        let mut acc = 0.0;
        for (i, ci) in c.iter().enumerate() {
            acc += ci * x[k + i - half];
        }
        y[k] = acc;
    }
    let t: Vec<f64> = (0..window).map(|i| i as f64).collect();
    let left = polyfit(&t, &x[..window], polyorder);
    for k in 0..half {
        y[k] = polyval(&left, k as f64);
    }
    let right = polyfit(&t, &x[n - window..], polyorder);
    for k in 0..half {
        let pos = window - half + k;
        y[n - half + k] = polyval(&right, pos as f64);
    }
    y
}

/// scipy.signal.medfilt(x, kernel_size): zero-padded running median (odd kernel).
pub fn medfilt(x: &[f64], kernel: usize) -> Vec<f64> {
    let n = x.len();
    let half = kernel / 2;
    let get = |i: isize| -> f64 {
        if i < 0 || i as usize >= n {
            0.0
        } else {
            x[i as usize]
        }
    };
    let mut window: Vec<f64> = (0..kernel).map(|j| get(j as isize - half as isize)).collect();
    window.sort_by(|a, b| a.total_cmp(b));
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        out.push(window[half]);
        if i + 1 == n {
            break;
        }
        let old = get(i as isize - half as isize);
        let new = get(i as isize + half as isize + 1);
        let pos = window.partition_point(|v| v.total_cmp(&old) == std::cmp::Ordering::Less);
        window.remove(pos.min(window.len() - 1));
        let ins = window.partition_point(|v| v.total_cmp(&new) == std::cmp::Ordering::Less);
        window.insert(ins, new);
    }
    out
}

// ---------------------------------------------------------------------------
// FFT helpers
// ---------------------------------------------------------------------------

/// One-sided FFT of a real signal (numpy.fft.rfft).
pub fn rfft(x: &[f64]) -> Vec<Complex64> {
    if x.is_empty() {
        return vec![];
    }
    let mut planner = RealFftPlanner::<f64>::new();
    let r2c = planner.plan_fft_forward(x.len());
    let mut input = x.to_vec();
    let mut output = r2c.make_output_vec();
    r2c.process(&mut input, &mut output).expect("rfft");
    output
}

/// numpy.fft.rfftfreq(n, d=1/fs)
pub fn rfftfreq(n: usize, fs: f64) -> Vec<f64> {
    (0..n / 2 + 1).map(|k| k as f64 * fs / n as f64).collect()
}

/// Full linear convolution via FFT (scipy.signal.fftconvolve(a, b, mode="full")).
pub fn fftconvolve(a: &[f64], b: &[f64]) -> Vec<f64> {
    if a.is_empty() || b.is_empty() {
        return vec![];
    }
    let n_out = a.len() + b.len() - 1;
    let nfft = n_out.next_power_of_two();
    let mut planner = FftPlanner::<f64>::new();
    let fwd = planner.plan_fft_forward(nfft);
    let inv = planner.plan_fft_inverse(nfft);
    let mut fa: Vec<Complex64> = a.iter().map(|&v| Complex64::new(v, 0.0)).collect();
    fa.resize(nfft, Complex64::new(0.0, 0.0));
    let mut fb: Vec<Complex64> = b.iter().map(|&v| Complex64::new(v, 0.0)).collect();
    fb.resize(nfft, Complex64::new(0.0, 0.0));
    fwd.process(&mut fa);
    fwd.process(&mut fb);
    for (x, y) in fa.iter_mut().zip(fb.iter()) {
        *x *= y;
    }
    inv.process(&mut fa);
    fa.iter().take(n_out).map(|c| c.re / nfft as f64).collect()
}

// ---------------------------------------------------------------------------
// Welch PSD and peak finding
// ---------------------------------------------------------------------------

fn detrend_linear(seg: &mut [f64]) {
    let n = seg.len() as f64;
    if seg.len() < 2 {
        if let Some(v) = seg.first_mut() {
            *v = 0.0;
        }
        return;
    }
    let mean_t = (n - 1.0) / 2.0;
    let mean_y = seg.iter().sum::<f64>() / n;
    let mut sxy = 0.0;
    let mut sxx = 0.0;
    for (i, &y) in seg.iter().enumerate() {
        let dt = i as f64 - mean_t;
        sxy += dt * (y - mean_y);
        sxx += dt * dt;
    }
    let slope = if sxx > 0.0 { sxy / sxx } else { 0.0 };
    for (i, y) in seg.iter_mut().enumerate() {
        *y -= mean_y + slope * (i as f64 - mean_t);
    }
}

/// scipy.signal.welch(x, fs, nperseg, detrend="linear") with Hann window and 50% overlap.
pub fn welch(x: &[f64], fs: f64, nperseg: usize) -> (Vec<f64>, Vec<f64>) {
    let nperseg = nperseg.min(x.len()).max(1);
    let noverlap = nperseg / 2;
    let step = (nperseg - noverlap).max(1);
    let nseg = if x.len() >= noverlap { (x.len() - noverlap) / step } else { 0 }.max(1);
    let win: Vec<f64> = (0..nperseg)
        .map(|i| 0.5 - 0.5 * (2.0 * PI * i as f64 / nperseg as f64).cos())
        .collect();
    let win = if nperseg == 1 { vec![1.0] } else { win };
    let wss: f64 = win.iter().map(|w| w * w).sum();
    let scale = 1.0 / (fs * wss);
    let mut planner = RealFftPlanner::<f64>::new();
    let r2c = planner.plan_fft_forward(nperseg);
    let nfreq = nperseg / 2 + 1;
    let mut acc = vec![0.0; nfreq];
    let mut buf = vec![0.0; nperseg];
    let mut spec = r2c.make_output_vec();
    for s in 0..nseg {
        let start = s * step;
        if start + nperseg > x.len() {
            break;
        }
        buf.copy_from_slice(&x[start..start + nperseg]);
        detrend_linear(&mut buf);
        for (b, w) in buf.iter_mut().zip(win.iter()) {
            *b *= w;
        }
        r2c.process(&mut buf, &mut spec).expect("welch fft");
        for (a, c) in acc.iter_mut().zip(spec.iter()) {
            *a += c.norm_sqr() * scale;
        }
    }
    let last = if nperseg % 2 == 0 { nfreq - 1 } else { nfreq };
    for (i, a) in acc.iter_mut().enumerate() {
        *a /= nseg as f64;
        if i > 0 && i < last {
            *a *= 2.0;
        }
    }
    (rfftfreq(nperseg, fs), acc)
}

/// Local maxima indices including plateau midpoints (scipy _local_maxima_1d).
pub fn local_maxima(x: &[f64]) -> Vec<usize> {
    let mut peaks = Vec::new();
    if x.len() < 3 {
        return peaks;
    }
    let i_max = x.len() - 1;
    let mut i = 1;
    while i < i_max {
        if x[i - 1] < x[i] {
            let mut ahead = i + 1;
            while ahead < i_max && x[ahead] == x[i] {
                ahead += 1;
            }
            if x[ahead] < x[i] {
                peaks.push((i + ahead - 1) / 2);
                i = ahead;
            }
        }
        i += 1;
    }
    peaks
}

/// Prominence of each peak (scipy _peak_prominences without wlen).
pub fn peak_prominences(x: &[f64], peaks: &[usize]) -> Vec<f64> {
    peaks
        .iter()
        .map(|&peak| {
            let mut left_min = x[peak];
            let mut i = peak as isize;
            while i >= 0 && x[i as usize] <= x[peak] {
                left_min = left_min.min(x[i as usize]);
                i -= 1;
            }
            let mut right_min = x[peak];
            let mut i = peak;
            while i < x.len() && x[i] <= x[peak] {
                right_min = right_min.min(x[i]);
                i += 1;
            }
            x[peak] - left_min.max(right_min)
        })
        .collect()
}

/// scipy.signal.find_peaks(x, prominence=min_prominence) → (indices, prominences)
pub fn find_peaks_prominence(x: &[f64], min_prominence: f64) -> (Vec<usize>, Vec<f64>) {
    let peaks = local_maxima(x);
    let prom = peak_prominences(x, &peaks);
    peaks
        .into_iter()
        .zip(prom)
        .filter(|(_, p)| *p >= min_prominence)
        .unzip()
}

/// scipy.signal.decimate(x, q, zero_phase=True) — IIR Chebyshev-I order 8, SOS form.
pub fn decimate(x: &[f64], q: usize) -> Result<Vec<f64>, String> {
    if q <= 1 {
        return Ok(x.to_vec());
    }
    let sos = cheby1_lowpass_sos(8, 0.05, 0.8 / q as f64);
    let y = sosfiltfilt(&sos, x)?;
    Ok(y.into_iter().step_by(q).collect())
}

// ---------------------------------------------------------------------------
// Basic numerics
// ---------------------------------------------------------------------------

pub fn mean(x: &[f64]) -> f64 {
    if x.is_empty() {
        return f64::NAN;
    }
    x.iter().sum::<f64>() / x.len() as f64
}

/// Population variance (numpy default ddof=0).
pub fn var(x: &[f64]) -> f64 {
    let m = mean(x);
    x.iter().map(|v| (v - m) * (v - m)).sum::<f64>() / x.len() as f64
}

pub fn std(x: &[f64]) -> f64 {
    var(x).sqrt()
}

pub fn median(x: &[f64]) -> f64 {
    percentile(x, 50.0)
}

/// numpy.percentile with linear interpolation.
pub fn percentile(x: &[f64], q: f64) -> f64 {
    if x.is_empty() {
        return f64::NAN;
    }
    let mut s = x.to_vec();
    s.sort_by(|a, b| a.total_cmp(b));
    percentile_sorted(&s, q)
}

pub fn percentile_sorted(s: &[f64], q: f64) -> f64 {
    let pos = q / 100.0 * (s.len() - 1) as f64;
    let lo = pos.floor() as usize;
    let hi = pos.ceil() as usize;
    let frac = pos - lo as f64;
    s[lo] + (s[hi] - s[lo]) * frac
}

/// numpy.interp (xp increasing).
pub fn interp(x: &[f64], xp: &[f64], fp: &[f64]) -> Vec<f64> {
    let n = xp.len();
    x.iter()
        .map(|&v| {
            if n == 0 {
                return f64::NAN;
            }
            if v <= xp[0] {
                return fp[0];
            }
            if v >= xp[n - 1] {
                return fp[n - 1];
            }
            let j = xp.partition_point(|&a| a <= v);
            let (x0, x1) = (xp[j - 1], xp[j]);
            let (y0, y1) = (fp[j - 1], fp[j]);
            if x1 == x0 {
                y0
            } else {
                y0 + (y1 - y0) * (v - x0) / (x1 - x0)
            }
        })
        .collect()
}

/// numpy.searchsorted(a, v) (side="left").
pub fn searchsorted(a: &[f64], v: f64) -> usize {
    a.partition_point(|&x| x < v)
}
