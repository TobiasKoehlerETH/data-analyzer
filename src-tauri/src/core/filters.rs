//! Filter model (FilterStep / FilterChain / FilterSuggestion), individual filters,
//! chain application and PSD-based auto-suggestion.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::path::Path;

use super::cache::CacheManager;
use super::dsp::{butter_sos, iirnotch, medfilt, savgol_filter, sosfiltfilt, std, BandType};
use super::spectrum::{compute_psd, detect_peaks, estimate_knee_frequency, estimate_noise_floor};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FilterType {
    Lowpass,
    Highpass,
    Bandpass,
    Bandstop,
    Savgol,
    MovingAverage,
    ExpMovingAverage,
    Median,
    Notch,
}

impl FilterType {
    pub const ALL: [FilterType; 9] = [
        FilterType::Lowpass,
        FilterType::Highpass,
        FilterType::Bandpass,
        FilterType::Bandstop,
        FilterType::Savgol,
        FilterType::MovingAverage,
        FilterType::ExpMovingAverage,
        FilterType::Median,
        FilterType::Notch,
    ];

    pub fn value(&self) -> &'static str {
        match self {
            FilterType::Lowpass => "lowpass",
            FilterType::Highpass => "highpass",
            FilterType::Bandpass => "bandpass",
            FilterType::Bandstop => "bandstop",
            FilterType::Savgol => "savgol",
            FilterType::MovingAverage => "moving_average",
            FilterType::ExpMovingAverage => "exp_moving_average",
            FilterType::Median => "median",
            FilterType::Notch => "notch",
        }
    }

    /// `value.replace("_", " ").title()` as in the original UI.
    pub fn title(&self) -> String {
        self.value()
            .split('_')
            .map(|w| {
                let mut c = w.chars();
                match c.next() {
                    Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
                    None => String::new(),
                }
            })
            .collect::<Vec<_>>()
            .join(" ")
    }
}

const INT_PARAMS: &[&str] = &["order", "window", "polyorder"];

fn fmt_num(v: &Value) -> String {
    match v.as_f64() {
        Some(f) if f.fract() == 0.0 && f.abs() < 1e15 => format!("{}", f as i64),
        Some(f) => format!("{f}"),
        None => v.to_string(),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FilterStep {
    pub filter_type: FilterType,
    #[serde(default)]
    pub params: Map<String, Value>,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool {
    true
}

impl FilterStep {
    pub fn new(filter_type: FilterType, params: &[(&str, f64)]) -> Self {
        let mut step = FilterStep { filter_type, params: Map::new(), enabled: true };
        for (k, v) in params {
            step.set_param(k, *v);
        }
        step
    }

    pub fn set_param(&mut self, key: &str, v: f64) {
        let value = if INT_PARAMS.contains(&key) && v.fract() == 0.0 {
            Value::from(v as i64)
        } else {
            serde_json::Number::from_f64(v).map(Value::Number).unwrap_or(Value::Null)
        };
        self.params.insert(key.to_string(), value);
    }

    pub fn param(&self, key: &str, default: f64) -> f64 {
        self.params.get(key).and_then(|v| v.as_f64()).unwrap_or(default)
    }

    /// Normalises integer parameters so JSON files stay compatible with the Python app.
    pub fn normalized(mut self) -> Self {
        let keys: Vec<String> = self.params.keys().cloned().collect();
        for k in keys {
            if let Some(v) = self.params.get(&k).and_then(|v| v.as_f64()) {
                self.set_param(&k, v);
            }
        }
        self
    }

    pub fn describe(&self) -> String {
        let mut parts = vec![self.filter_type.title()];
        if let Some(v) = self.params.get("cutoff").and_then(|v| v.as_f64()) {
            parts.push(format!("fc={v:.4} Hz"));
        }
        if let Some(v) = self.params.get("order") {
            parts.push(format!("order={}", fmt_num(v)));
        }
        if let Some(v) = self.params.get("window") {
            parts.push(format!("win={}", fmt_num(v)));
        }
        if let Some(v) = self.params.get("freq").and_then(|v| v.as_f64()) {
            parts.push(format!("f0={v:.4} Hz"));
        }
        parts.join(", ")
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct FilterChain {
    #[serde(default)]
    pub steps: Vec<FilterStep>,
}

impl FilterChain {
    pub fn enabled_steps(&self) -> impl Iterator<Item = &FilterStep> {
        self.steps.iter().filter(|s| s.enabled)
    }

    pub fn has_enabled(&self) -> bool {
        self.steps.iter().any(|s| s.enabled)
    }

    pub fn save_json(&self, path: &Path) -> Result<(), String> {
        let normalized = FilterChain { steps: self.steps.iter().cloned().map(FilterStep::normalized).collect() };
        let s = serde_json::to_string_pretty(&normalized).map_err(|e| e.to_string())?;
        std::fs::write(path, s).map_err(|e| format!("Cannot write {}: {e}", path.display()))
    }

    pub fn load_json(path: &Path) -> Result<FilterChain, String> {
        let s = std::fs::read_to_string(path).map_err(|e| format!("Cannot read {}: {e}", path.display()))?;
        let chain: FilterChain = serde_json::from_str(&s).map_err(|e| format!("Invalid filter chain: {e}"))?;
        Ok(FilterChain { steps: chain.steps.into_iter().map(FilterStep::normalized).collect() })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FilterSuggestion {
    pub filter_type: FilterType,
    pub params: Map<String, Value>,
    pub reason: String,
    pub estimated_improvement: f64,
}

impl FilterSuggestion {
    pub fn to_step(&self) -> FilterStep {
        FilterStep { filter_type: self.filter_type, params: self.params.clone(), enabled: true }
    }
}

// ---------------------------------------------------------------------------
// Individual filters
// ---------------------------------------------------------------------------

type FResult = Result<Vec<f64>, String>;

pub fn apply_lowpass(x: &[f64], fs: f64, cutoff: f64, order: usize) -> FResult {
    let nyq = fs / 2.0;
    if cutoff >= nyq || cutoff <= 0.0 {
        return Ok(x.to_vec());
    }
    sosfiltfilt(&butter_sos(order, &[cutoff / nyq], BandType::Low), x)
}

pub fn apply_highpass(x: &[f64], fs: f64, cutoff: f64, order: usize) -> FResult {
    let nyq = fs / 2.0;
    if cutoff <= 0.0 || cutoff >= nyq {
        return Ok(x.to_vec());
    }
    sosfiltfilt(&butter_sos(order, &[cutoff / nyq], BandType::High), x)
}

fn band_edges(fs: f64, low: f64, high: f64) -> Option<[f64; 2]> {
    let nyq = fs / 2.0;
    let lo = (low / nyq).max(1e-6);
    let hi = (high / nyq).min(0.9999);
    if lo >= hi {
        None
    } else {
        Some([lo, hi])
    }
}

pub fn apply_bandpass(x: &[f64], fs: f64, low: f64, high: f64, order: usize) -> FResult {
    match band_edges(fs, low, high) {
        Some(w) => sosfiltfilt(&butter_sos(order, &w, BandType::BandPass), x),
        None => Ok(x.to_vec()),
    }
}

pub fn apply_bandstop(x: &[f64], fs: f64, low: f64, high: f64, order: usize) -> FResult {
    match band_edges(fs, low, high) {
        Some(w) => sosfiltfilt(&butter_sos(order, &w, BandType::BandStop), x),
        None => Ok(x.to_vec()),
    }
}

fn odd_window(window: usize, len: usize) -> usize {
    let w = if window % 2 == 1 { window } else { window + 1 };
    let w = w.min(len);
    if w % 2 == 0 {
        w.saturating_sub(1)
    } else {
        w
    }
}

pub fn apply_savgol(x: &[f64], window: usize, polyorder: usize) -> FResult {
    let w = odd_window(window, x.len());
    if w <= polyorder {
        return Ok(x.to_vec());
    }
    Ok(savgol_filter(x, w, polyorder))
}

pub fn apply_moving_average(x: &[f64], window: usize) -> FResult {
    let n = x.len();
    if window < 2 || window > n {
        return Ok(x.to_vec());
    }
    let pad = window / 2;
    let mut padded = Vec::with_capacity(n + 2 * pad);
    padded.extend(std::iter::repeat(x[0]).take(pad));
    padded.extend_from_slice(x);
    padded.extend(std::iter::repeat(x[n - 1]).take(pad));
    let mut out = Vec::with_capacity(n);
    let mut acc: f64 = padded[..window].iter().sum();
    out.push(acc / window as f64);
    for i in 1..n {
        acc += padded[i + window - 1] - padded[i - 1];
        out.push(acc / window as f64);
    }
    Ok(out)
}

pub fn apply_exp_moving_average(x: &[f64], alpha: f64) -> FResult {
    let alpha = alpha.clamp(0.001, 1.0);
    let mut out = Vec::with_capacity(x.len());
    if let Some(&first) = x.first() {
        out.push(first);
        for i in 1..x.len() {
            let prev = out[i - 1];
            out.push(alpha * x[i] + (1.0 - alpha) * prev);
        }
    }
    Ok(out)
}

pub fn apply_median(x: &[f64], window: usize) -> FResult {
    let w = odd_window(window, x.len());
    if w < 3 {
        return Ok(x.to_vec());
    }
    Ok(medfilt(x, w))
}

pub fn apply_notch(x: &[f64], fs: f64, freq: f64, q: f64) -> FResult {
    if freq <= 0.0 || freq >= fs / 2.0 {
        return Ok(x.to_vec());
    }
    sosfiltfilt(&[iirnotch(freq, q, fs)], x)
}

fn as_usize(v: f64) -> usize {
    if v.is_finite() && v > 0.0 {
        v.round() as usize
    } else {
        0
    }
}

pub fn apply_step(x: &[f64], step: &FilterStep, fs: f64) -> FResult {
    let p = |k: &str, d: f64| step.param(k, d);
    match step.filter_type {
        FilterType::Lowpass => apply_lowpass(x, fs, p("cutoff", 0.1), as_usize(p("order", 4.0))),
        FilterType::Highpass => apply_highpass(x, fs, p("cutoff", 0.01), as_usize(p("order", 4.0))),
        FilterType::Bandpass => apply_bandpass(x, fs, p("low", 0.01), p("high", 0.1), as_usize(p("order", 4.0))),
        FilterType::Bandstop => apply_bandstop(x, fs, p("low", 0.01), p("high", 0.1), as_usize(p("order", 4.0))),
        FilterType::Savgol => apply_savgol(x, as_usize(p("window", 51.0)), as_usize(p("polyorder", 3.0))),
        FilterType::MovingAverage => apply_moving_average(x, as_usize(p("window", 21.0))),
        FilterType::ExpMovingAverage => apply_exp_moving_average(x, p("alpha", 0.1)),
        FilterType::Median => apply_median(x, as_usize(p("window", 5.0))),
        FilterType::Notch => apply_notch(x, fs, p("freq", 0.1), p("Q", 30.0)),
    }
}

pub fn apply_steps<'a>(x: &[f64], steps: impl Iterator<Item = &'a FilterStep>, fs: f64) -> FResult {
    let mut result = x.to_vec();
    for step in steps {
        result = apply_step(&result, step, fs).map_err(|e| format!("{}: {e}", step.describe()))?;
    }
    Ok(result)
}

pub fn apply_chain(x: &[f64], chain: &FilterChain, fs: f64) -> FResult {
    apply_steps(x, chain.enabled_steps(), fs)
}

fn round_to(v: f64, digits: i32) -> f64 {
    let m = 10f64.powi(digits);
    (v * m).round() / m
}

pub fn suggest_filters(x: &[f64], fs: f64, cache: Option<&CacheManager>, name: &str) -> Vec<FilterSuggestion> {
    let mut out: Vec<FilterSuggestion> = Vec::new();
    if x.len() < 4 {
        return out;
    }
    let psd = compute_psd(x, fs, None, cache, name);
    let noise_floor = estimate_noise_floor(&psd, 0.25);
    let knee = estimate_knee_frequency(&psd, 2.0);

    // 1. Noise floor → low-pass at the knee frequency
    if knee < fs / 2.0 * 0.8 {
        let (mut sig_p, mut noise_p) = (0.0, 0.0);
        for (f, p) in psd.freqs.iter().zip(psd.psd.iter()) {
            if *f <= knee {
                sig_p += p;
            } else {
                noise_p += p;
            }
        }
        let total = sig_p + noise_p;
        let improvement = if total > 0.0 { noise_p / total * 100.0 } else { 0.0 };
        if improvement > 1.0 {
            let s = FilterStep::new(FilterType::Lowpass, &[("cutoff", round_to(knee, 4)), ("order", 4.0)]);
            out.push(FilterSuggestion {
                filter_type: FilterType::Lowpass,
                params: s.params,
                reason: format!(
                    "Low-pass at {knee:.4} Hz — removes high-frequency noise ({improvement:.1}% of power is above knee)"
                ),
                estimated_improvement: improvement,
            });
        }
    }

    // 2. Outlier spikes (> 4σ from rolling median)
    let mut window = 101.min(x.len() / 10);
    if window % 2 == 0 {
        window += 1;
    }
    if window >= 3 {
        let rolling = medfilt(x, window);
        let residuals: Vec<f64> = x.iter().zip(rolling.iter()).map(|(a, b)| (a - b).abs()).collect();
        let sd = std(&residuals);
        if sd > 0.0 {
            let n_out = residuals.iter().filter(|r| **r > 4.0 * sd).count();
            if n_out > 0 {
                let ratio = n_out as f64 / x.len() as f64 * 100.0;
                let mut spike = 11.min(window);
                if spike % 2 == 0 {
                    spike += 1;
                }
                let s = FilterStep::new(FilterType::Median, &[("window", spike as f64)]);
                out.push(FilterSuggestion {
                    filter_type: FilterType::Median,
                    params: s.params,
                    reason: format!(
                        "Median filter (window={spike}) — {n_out} outlier spikes detected ({ratio:.2}% of data)"
                    ),
                    estimated_improvement: ratio,
                });
            }
        }
    }

    // 3. Periodic interference peaks → notch
    for peak in detect_peaks(&psd, 10.0, 0.001).iter().take(3) {
        let s = FilterStep::new(FilterType::Notch, &[("freq", round_to(peak.frequency, 4)), ("Q", 30.0)]);
        out.push(FilterSuggestion {
            filter_type: FilterType::Notch,
            params: s.params,
            reason: format!(
                "Notch filter at {:.4} Hz — periodic interference (prominence={})",
                peak.frequency,
                py_exp(peak.prominence)
            ),
            estimated_improvement: peak.prominence / (noise_floor + 1e-30),
        });
    }

    // 4. Low-frequency drift → high-pass
    if psd.freqs.len() > 10 {
        let fmax = *psd.freqs.last().unwrap();
        let (mut low, mut mid) = (Vec::new(), Vec::new());
        let mut hp_cutoff = 0.0;
        for (f, p) in psd.freqs.iter().zip(psd.psd.iter()) {
            if *f < fmax * 0.05 {
                low.push(*p);
                hp_cutoff = *f;
            } else {
                mid.push(*p);
            }
        }
        if !low.is_empty() && !mid.is_empty() {
            let low_p = low.iter().sum::<f64>() / low.len() as f64;
            let mid_p = mid.iter().sum::<f64>() / mid.len() as f64;
            if mid_p > 0.0 && low_p / mid_p > 20.0 {
                let ratio = low_p / mid_p;
                let s = FilterStep::new(FilterType::Highpass, &[("cutoff", round_to(hp_cutoff, 6)), ("order", 2.0)]);
                out.push(FilterSuggestion {
                    filter_type: FilterType::Highpass,
                    params: s.params,
                    reason: format!(
                        "High-pass at {hp_cutoff:.6} Hz — removes slow drift (low-freq power is {ratio:.0}x higher)"
                    ),
                    estimated_improvement: ratio.min(50.0),
                });
            }
        }
    }

    out.sort_by(|a, b| b.estimated_improvement.total_cmp(&a.estimated_improvement));
    out
}

/// Formats numbers like Python's `{:.2e}` (two-digit exponent).
pub fn py_exp(v: f64) -> String {
    let s = format!("{v:.2e}");
    match s.split_once('e') {
        Some((m, e)) => {
            let (sign, digits) = if let Some(d) = e.strip_prefix('-') { ('-', d) } else { ('+', e) };
            format!("{m}e{sign}{digits:0>2}")
        }
        None => s,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f64::consts::PI;

    fn tvec(fs: f64, secs: f64) -> Vec<f64> {
        (0..(fs * secs) as usize).map(|i| i as f64 / fs).collect()
    }

    #[test]
    fn lowpass_removes_high_freq() {
        let fs = 100.0;
        let x: Vec<f64> = tvec(fs, 10.0).iter().map(|t| (2.0 * PI * t).sin() + 0.5 * (2.0 * PI * 40.0 * t).sin()).collect();
        let y = apply_lowpass(&x, fs, 5.0, 4).unwrap();
        assert!(std(&y) < std(&x));
    }

    #[test]
    fn highpass_removes_low_freq() {
        let fs = 100.0;
        let x: Vec<f64> = tvec(fs, 10.0).iter().map(|t| (2.0 * PI * 0.1 * t).sin() + (2.0 * PI * 20.0 * t).sin()).collect();
        let y = apply_highpass(&x, fs, 5.0, 4).unwrap();
        assert!(std(&y) < std(&x));
    }

    #[test]
    fn median_removes_spike() {
        let mut x = vec![0.0; 100];
        x[50] = 100.0;
        let y = apply_median(&x, 5).unwrap();
        assert!(y[50] < 1.0);
    }

    #[test]
    fn savgol_and_moving_average_preserve_length() {
        let x: Vec<f64> = (0..200).map(|i| (i as f64 * 0.1).sin()).collect();
        assert_eq!(apply_savgol(&x, 51, 3).unwrap().len(), 200);
        assert_eq!(apply_moving_average(&x, 21).unwrap().len(), 200);
        assert_eq!(apply_moving_average(&x, 20).unwrap().len(), 200);
    }

    #[test]
    fn chain_respects_enabled() {
        let x: Vec<f64> = (0..500).map(|i| (i as f64 * 0.3).sin()).collect();
        let mut chain = FilterChain::default();
        chain.steps.push(FilterStep::new(FilterType::MovingAverage, &[("window", 11.0)]));
        chain.steps[0].enabled = false;
        assert_eq!(apply_chain(&x, &chain, 1.0).unwrap(), x);
    }

    #[test]
    fn chain_json_roundtrip_keeps_ints() {
        let mut chain = FilterChain::default();
        chain.steps.push(FilterStep::new(FilterType::Lowpass, &[("cutoff", 0.05), ("order", 4.0)]));
        let s = serde_json::to_string(&chain).unwrap();
        assert!(s.contains("\"order\":4"));
        assert!(s.contains("\"filter_type\":\"lowpass\""));
        let back: FilterChain = serde_json::from_str(&s).unwrap();
        assert_eq!(back.steps[0].describe(), "Lowpass, fc=0.0500 Hz, order=4");
    }

    #[test]
    fn suggest_notch_for_sinusoid() {
        let fs = 10.0;
        let x: Vec<f64> = (0..5000)
            .map(|i| {
                let t = i as f64 / fs;
                (2.0 * PI * 2.0 * t).sin() + 0.01 * ((i * 7919 % 1000) as f64 / 1000.0 - 0.5)
            })
            .collect();
        let s = suggest_filters(&x, fs, None, "");
        assert!(s.iter().any(|s| s.filter_type == FilterType::Notch));
    }

    #[test]
    fn py_exp_format() {
        assert_eq!(py_exp(12345.0), "1.23e+04");
        assert_eq!(py_exp(0.000123), "1.23e-04");
    }
}
