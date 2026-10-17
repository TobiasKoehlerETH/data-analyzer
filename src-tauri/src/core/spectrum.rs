//! Spectrum analysis: FFT, PSD (Welch) and peak detection with caching.

use serde::Serialize;
use std::sync::Arc;

use super::cache::{CacheManager, CacheValue};
use super::dsp::{find_peaks_prominence, mean, median, rfft, rfftfreq, welch};

#[derive(Debug, Clone, Serialize)]
pub struct SpectrumResult {
    pub freqs: Vec<f64>,
    pub magnitude: Vec<f64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PsdResult {
    pub freqs: Vec<f64>,
    pub psd: Vec<f64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PeakInfo {
    pub frequency: f64,
    pub amplitude: f64,
    pub prominence: f64,
}

pub fn compute_fft(signal: &[f64], fs: f64, cache: Option<&CacheManager>, name: &str) -> Arc<SpectrumResult> {
    let key = CacheManager::make_key(name, "fft", &[("fs", fs)]);
    if let (Some(c), false) = (cache, name.is_empty()) {
        if let Some(CacheValue::Fft(v)) = c.get(&key) {
            return v;
        }
    }
    let n = signal.len();
    let m = mean(signal);
    let centered: Vec<f64> = signal.iter().map(|v| v - m).collect();
    let spec = rfft(&centered);
    let magnitude = spec.iter().map(|c| c.norm() * 2.0 / n as f64).collect();
    let result = Arc::new(SpectrumResult { freqs: rfftfreq(n, fs), magnitude });
    if let (Some(c), false) = (cache, name.is_empty()) {
        c.set(key, CacheValue::Fft(result.clone()));
    }
    result
}

pub fn default_nperseg(n: usize) -> usize {
    n.min(256.max(n / 8))
}

pub fn compute_psd(
    signal: &[f64],
    fs: f64,
    nperseg: Option<usize>,
    cache: Option<&CacheManager>,
    name: &str,
) -> Arc<PsdResult> {
    let nperseg = nperseg.unwrap_or_else(|| default_nperseg(signal.len()));
    let key = CacheManager::make_key(name, "psd", &[("fs", fs), ("nperseg", nperseg as f64)]);
    if let (Some(c), false) = (cache, name.is_empty()) {
        if let Some(CacheValue::Psd(v)) = c.get(&key) {
            return v;
        }
    }
    let (freqs, psd) = welch(signal, fs, nperseg);
    let result = Arc::new(PsdResult { freqs, psd });
    if let (Some(c), false) = (cache, name.is_empty()) {
        c.set(key, CacheValue::Psd(result.clone()));
    }
    result
}

pub fn detect_peaks(psd: &PsdResult, prominence_factor: f64, min_freq: f64) -> Vec<PeakInfo> {
    let (freqs, vals): (Vec<f64>, Vec<f64>) =
        psd.freqs.iter().zip(psd.psd.iter()).filter(|(f, _)| **f >= min_freq).map(|(f, p)| (*f, *p)).unzip();
    if vals.len() < 3 {
        return vec![];
    }
    let threshold = median(&vals) * prominence_factor;
    let (idx, prom) = find_peaks_prominence(&vals, threshold);
    let mut peaks: Vec<PeakInfo> = idx
        .iter()
        .zip(prom.iter())
        .map(|(&i, &p)| PeakInfo { frequency: freqs[i], amplitude: vals[i], prominence: p })
        .collect();
    peaks.sort_by(|a, b| b.prominence.total_cmp(&a.prominence));
    peaks
}

pub fn estimate_noise_floor(psd: &PsdResult, upper_fraction: f64) -> f64 {
    if psd.freqs.len() < 2 {
        return 0.0;
    }
    let max_f = *psd.freqs.last().unwrap();
    let cutoff = max_f * (1.0 - upper_fraction);
    let upper: Vec<f64> = psd.freqs.iter().zip(psd.psd.iter()).filter(|(f, _)| **f >= cutoff).map(|(_, p)| *p).collect();
    if upper.len() < 2 {
        return median(&psd.psd);
    }
    median(&upper)
}

pub fn estimate_knee_frequency(psd: &PsdResult, noise_factor: f64) -> f64 {
    let threshold = estimate_noise_floor(psd, 0.25) * noise_factor;
    for i in (0..psd.freqs.len()).rev() {
        if psd.psd[i] > threshold {
            return psd.freqs[i];
        }
    }
    *psd.freqs.last().unwrap_or(&0.0)
}
