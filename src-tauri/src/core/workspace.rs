//! Variable workspace: columns imported from any number of files ("sources"). Every source
//! keeps its own time base; the analysis dataset is built on a common time grid. Each variable
//! carries a replayable pipeline of steps (edits and filters) on top of its imported values,
//! which is what undo, recipes and project files are built on.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use super::csv_parser::{parse_file_with, ImportOptions, ParseResult};
use super::par;
use super::dataset::{sample_rate_of, Dataset, SharedParts};
use super::filters::{apply_steps, FilterStep};

/// Upper bound on the common grid; longer spans get a coarser step.
/// Longest common grid. Files at very different rates are thinned to this, so every page stays quick.
const MAX_GRID: usize = 1_000_000;
/// Half-width of the Hampel window (11 samples).
const HAMPEL_HALF: usize = 5;

/// How variables from different sources are placed on the common grid.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Align {
    /// Each source's own time (plus its shift), starting from its own zero.
    #[default]
    Time,
    /// Absolute clock time for sources with timestamps.
    Clock,
    /// By row number, ignoring time (legacy behaviour).
    Row,
}

// ---------------------------------------------------------------------------
// Pipeline steps
// ---------------------------------------------------------------------------

/// One replayable processing step. Times are in the variable's own time base.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "op", content = "value")]
pub enum Edit {
    Offset(f64),
    Scale(f64),
    Normalize,
    Zscore,
    Demean,
    ZeroStart,
    Invert,
    /// Mark samples with `start <= t <= end` as missing.
    ClearRange((f64, f64)),
    /// Mark every sample outside the time range as missing.
    KeepRange((f64, f64)),
    /// Mark individual samples (by time) as missing, e.g. outliers picked on a plot.
    ClearPoints(Vec<f64>),
    /// Hampel filter: mark points further than k robust sigmas from the local median as missing.
    Despike(f64),
    /// Linearly interpolate interior gaps; leading and trailing gaps stay missing.
    FillGaps,
    /// One digital filter (lowpass, notch, …) at the variable's sample rate.
    Filter(FilterStep),
    /// Block average: the rows are split into `rows / factor` equal blocks; each block's mean
    /// sits at its middle row and every other row becomes missing. The factor may be fractional
    /// (a variable of another length gives `rows / its rows`).
    Downsample(f64),
}

/// The row ranges of a downsample: `rows / factor` equal blocks (the factor may be fractional).
fn downsample_blocks(n: usize, factor: f64) -> Result<Vec<(usize, usize)>, String> {
    if !(factor > 1.0) || !factor.is_finite() {
        return Err("The downsample factor must be greater than 1.".into());
    }
    let m = ((n as f64 / factor).round() as usize).max(1);
    if m >= n {
        return Err("The factor is too small to remove any rows.".into());
    }
    Ok((0..m).map(|b| (b * n / m, (b + 1) * n / m)).collect())
}

fn median_of(v: &mut [f64]) -> f64 {
    let n = v.len();
    let (below, mid, _) = v.select_nth_unstable_by(n / 2, |a, b| a.total_cmp(b));
    if n % 2 == 1 {
        *mid
    } else {
        (below.iter().copied().fold(f64::NEG_INFINITY, f64::max) + *mid) / 2.0
    }
}

fn finite_stats(v: &[f64]) -> (f64, f64, f64, f64) {
    let f: Vec<f64> = v.iter().copied().filter(|x| x.is_finite()).collect();
    if f.is_empty() {
        return (f64::NAN, f64::NAN, f64::NAN, f64::NAN);
    }
    let n = f.len() as f64;
    let mean = f.iter().sum::<f64>() / n;
    let sd = (f.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / n).sqrt();
    let lo = f.iter().copied().fold(f64::INFINITY, f64::min);
    let hi = f.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    (mean, sd, lo, hi)
}

/// Rows flagged by a Hampel filter. The local spread is floored at the noise level
/// estimated from first differences, so flat or quantised stretches are not flagged.
fn hampel(v: &[f64], k: f64) -> Vec<usize> {
    let mut diffs: Vec<f64> = v.windows(2).map(|w| (w[1] - w[0]).abs()).filter(|d| d.is_finite()).collect();
    let noise = if diffs.is_empty() { 0.0 } else { 1.4826 * median_of(&mut diffs) / std::f64::consts::SQRT_2 };
    drop(diffs);
    let chunks = par::chunks_for(v.len(), 50_000);
    let per = v.len().div_ceil(chunks).max(1);
    par::par_map(chunks, |c| {
        let mut out = Vec::new();
        let mut win = [0.0f64; 2 * HAMPEL_HALF + 1];
        let mut dev = [0.0f64; 2 * HAMPEL_HALF + 1];
        for i in (c * per)..((c + 1) * per).min(v.len()) {
            if !v[i].is_finite() {
                continue;
            }
            let lo = i.saturating_sub(HAMPEL_HALF);
            let hi = (i + HAMPEL_HALF + 1).min(v.len());
            let mut m = 0;
            for x in &v[lo..hi] {
                if x.is_finite() {
                    win[m] = *x;
                    m += 1;
                }
            }
            if m < 3 {
                continue;
            }
            let med = median_of(&mut win[..m]);
            for j in 0..m {
                dev[j] = (win[j] - med).abs();
            }
            let sigma = (1.4826 * median_of(&mut dev[..m])).max(noise);
            if sigma > 0.0 && (v[i] - med).abs() > k * sigma {
                out.push(i);
            }
        }
        out
    })
    .concat()
}

/// Compact number for step labels ("12.5", "0.000125").
fn num(x: f64) -> String {
    let s = format!("{:.6}", x);
    let s = s.trim_end_matches('0').trim_end_matches('.');
    if s == "-0" { "0".into() } else { s.into() }
}

fn plural(n: usize, word: &str) -> String {
    format!("{n} {word}{}", if n == 1 { "" } else { "s" })
}

impl Edit {
    /// The time of the rows this step leaves, for a step that changes the number of rows.
    pub fn new_time(&self, t: &[f64]) -> Option<Vec<f64>> {
        match self {
            Edit::Downsample(f) => downsample_blocks(t.len(), *f).ok().map(|blocks| blocks.iter().map(|&(lo, hi)| t[(lo + hi) / 2]).collect()),
            _ => None,
        }
    }

    /// How the step reads in a block diagram: family, title and parameter lines.
    pub fn block(&self) -> (&'static str, String, Vec<String>) {
        let range = |a: &f64, b: &f64| vec![format!("{} → {}", num(a.min(*b)), num(a.max(*b)))];
        match self {
            Edit::Offset(c) => ("adjust", "Offset".into(), vec![format!("{}{}", if *c >= 0.0 { "+" } else { "−" }, num(c.abs()))]),
            Edit::Scale(k) => ("adjust", "Gain".into(), vec![format!("× {}", num(*k))]),
            Edit::Normalize => ("adjust", "Normalize".into(), vec!["to 0 … 1".into()]),
            Edit::Zscore => ("adjust", "Z-score".into(), vec!["mean 0, σ 1".into()]),
            Edit::Demean => ("adjust", "Remove mean".into(), vec![]),
            Edit::ZeroStart => ("adjust", "Start at zero".into(), vec![]),
            Edit::Invert => ("adjust", "Invert sign".into(), vec!["× −1".into()]),
            Edit::ClearRange((a, b)) => ("clean", "Remove range".into(), range(a, b)),
            Edit::KeepRange((a, b)) => ("clean", "Keep range".into(), range(a, b)),
            Edit::ClearPoints(t) => ("clean", "Remove points".into(), vec![plural(t.len(), "point")]),
            Edit::Despike(k) => ("clean", "Remove spikes".into(), vec![format!("Hampel, k = {}σ", num(*k))]),
            Edit::FillGaps => ("clean", "Fill gaps".into(), vec!["linear".into()]),
            Edit::Downsample(f) => ("adjust", "Downsample".into(), vec![format!("÷ {}", num(*f))]),
            Edit::Filter(step) => {
                let d = step.describe();
                let mut parts = d.split(", ").map(str::to_string);
                ("filter", parts.next().unwrap_or_default(), parts.collect())
            }
        }
    }

    /// Manual picks (individual points) are tied to one file and are left out of recipes.
    pub fn is_manual(&self) -> bool {
        matches!(self, Edit::ClearPoints(_))
    }

    pub fn is_filter(&self) -> bool {
        matches!(self, Edit::Filter(_))
    }

    /// The step moved by `dt` in time (for edits picked on a shifted axis).
    pub fn shifted(&self, dt: f64) -> Edit {
        match self {
            Edit::ClearRange((a, b)) => Edit::ClearRange((a + dt, b + dt)),
            Edit::KeepRange((a, b)) => Edit::KeepRange((a + dt, b + dt)),
            Edit::ClearPoints(ts) => Edit::ClearPoints(ts.iter().map(|t| t + dt).collect()),
            other => other.clone(),
        }
    }

    /// Like [`Edit::apply`], for re-running a stored pipeline: a step that finds nothing to do
    /// (no spikes, no gaps, an empty selection) passes the values through instead of failing,
    /// so deleting or editing an earlier block never breaks the ones after it.
    pub fn apply_stored(&self, v: &[f64], t: &[f64]) -> Result<(Vec<f64>, String), String> {
        match self.apply(v, t) {
            Err(_) if self.idle_label().is_some() => Ok((v.to_vec(), format!("{} (nothing to do)", self.idle_label().unwrap()))),
            r => r,
        }
    }

    /// Name of a step that can legitimately find nothing to do.
    fn idle_label(&self) -> Option<String> {
        match self {
            Edit::ClearRange((a, b)) => Some(format!("remove t {}…{}", num(a.min(*b)), num(a.max(*b)))),
            Edit::KeepRange((a, b)) => Some(format!("keep t {}…{}", num(a.min(*b)), num(a.max(*b)))),
            Edit::ClearPoints(_) => Some("remove points".into()),
            Edit::Despike(k) if *k > 0.0 => Some(format!("remove spikes (> {} σ)", num(*k))),
            Edit::FillGaps => Some("fill gaps".into()),
            _ => None,
        }
    }

    pub fn apply(&self, v: &[f64], t: &[f64]) -> Result<(Vec<f64>, String), String> {
        let (mean, sd, lo, hi) = finite_stats(v);
        let map = |f: &dyn Fn(f64) -> f64| v.iter().map(|x| f(*x)).collect::<Vec<f64>>();
        let in_time = |i: usize, a: f64, b: f64| t.get(i).is_some_and(|ti| *ti >= a.min(b) && *ti <= a.max(b));
        Ok(match self {
            Edit::Offset(c) => (map(&|x| x + c), format!("offset {}{}", if *c >= 0.0 { "+" } else { "" }, num(*c))),
            Edit::Scale(k) => (map(&|x| x * k), format!("scale ×{}", num(*k))),
            Edit::Normalize => {
                if !(hi > lo) {
                    return Err("Cannot normalize a constant variable.".into());
                }
                (map(&|x| (x - lo) / (hi - lo)), "normalize 0–1".into())
            }
            Edit::Zscore => {
                if !(sd > 0.0) {
                    return Err("Cannot standardize a constant variable.".into());
                }
                (map(&|x| (x - mean) / sd), "z-score".into())
            }
            Edit::Demean => (map(&|x| x - mean), "remove mean".into()),
            Edit::ZeroStart => {
                let first = v.iter().copied().find(|x| x.is_finite()).unwrap_or(0.0);
                (map(&|x| x - first), "start at zero".into())
            }
            Edit::Invert => (map(&|x| -x), "invert sign".into()),
            Edit::ClearRange((a, b)) => {
                let mut out = v.to_vec();
                let mut n = 0;
                for (i, x) in out.iter_mut().enumerate() {
                    if in_time(i, *a, *b) {
                        *x = f64::NAN;
                        n += 1;
                    }
                }
                if n == 0 {
                    return Err("The selection contains no samples.".into());
                }
                (out, format!("remove t {}…{}", num(a.min(*b)), num(a.max(*b))))
            }
            Edit::KeepRange((a, b)) => {
                if !(0..v.len()).any(|i| in_time(i, *a, *b)) {
                    return Err("The selection contains no samples.".into());
                }
                let out = v.iter().enumerate().map(|(i, x)| if in_time(i, *a, *b) { *x } else { f64::NAN }).collect();
                (out, format!("keep t {}…{}", num(a.min(*b)), num(a.max(*b))))
            }
            Edit::ClearPoints(times) => {
                let mut out = v.to_vec();
                let mut n = 0;
                for i in nearest_samples(t, times) {
                    if out[i].is_finite() {
                        out[i] = f64::NAN;
                        n += 1;
                    }
                }
                if n == 0 {
                    return Err("The selection contains no points.".into());
                }
                (out, format!("remove {}", plural(n, "point")))
            }
            Edit::Despike(k) => {
                if !(*k > 0.0) {
                    return Err("The spike threshold must be positive.".into());
                }
                let rows = hampel(v, *k);
                if rows.is_empty() {
                    return Err(format!("No spikes beyond {} σ found.", num(*k)));
                }
                let mut out = v.to_vec();
                for &i in &rows {
                    out[i] = f64::NAN;
                }
                (out, format!("remove {} (> {} σ)", plural(rows.len(), "spike"), num(*k)))
            }
            Edit::FillGaps => {
                let mut out = v.to_vec();
                let mut filled = 0;
                let mut prev: Option<usize> = None;
                for i in 0..out.len() {
                    if !out[i].is_finite() {
                        continue;
                    }
                    if let Some(p) = prev {
                        for j in p + 1..i {
                            out[j] = out[p] + (out[i] - out[p]) * (j - p) as f64 / (i - p) as f64;
                            filled += 1;
                        }
                    }
                    prev = Some(i);
                }
                if filled == 0 {
                    return Err("There are no gaps between valid values.".into());
                }
                (out, format!("fill {}", plural(filled, "gap value")))
            }
            Edit::Downsample(f) => {
                let blocks = downsample_blocks(v.len(), *f)?;
                let out: Vec<f64> = blocks
                    .iter()
                    .map(|&(lo, hi)| {
                        let (sum, n) = v[lo..hi].iter().filter(|x| x.is_finite()).fold((0.0, 0usize), |(s, n), x| (s + x, n + 1));
                        if n == 0 { f64::NAN } else { sum / n as f64 }
                    })
                    .collect();
                let label = format!("downsample ÷{} ({} rows)", num(*f), out.len());
                (out, label)
            }
            Edit::Filter(step) => {
                let fs = sample_rate_of(t);
                (apply_steps(v, std::iter::once(step), fs)?, format!("filter: {}", step.describe()))
            }
        })
    }
}

/// Indices of the samples nearest to `times` (within half a sample interval).
fn nearest_samples(t: &[f64], times: &[f64]) -> Vec<usize> {
    let mut order: Vec<usize> = (0..t.len()).filter(|&i| t[i].is_finite()).collect();
    order.sort_by(|&a, &b| t[a].total_cmp(&t[b]));
    if order.is_empty() {
        return vec![];
    }
    let mut steps: Vec<f64> = order.windows(2).map(|w| t[w[1]] - t[w[0]]).filter(|d| *d > 0.0).collect();
    let tol = if steps.is_empty() { f64::INFINITY } else { median_of(&mut steps) / 2.0 };
    times
        .iter()
        .filter_map(|&x| {
            let k = order.partition_point(|&i| t[i] < x);
            let candidates = [k.checked_sub(1), Some(k)];
            candidates
                .into_iter()
                .flatten()
                .filter_map(|k| order.get(k).copied())
                .min_by(|&a, &b| (t[a] - x).abs().total_cmp(&(t[b] - x).abs()))
                .filter(|&i| (t[i] - x).abs() <= tol)
        })
        .collect()
}

/// The result of running a pipeline.
pub struct Replayed {
    pub data: Vec<f64>,
    pub labels: Vec<String>,
    /// The time of each row after the steps, when a step changed the number of rows (None = unchanged).
    pub time: Option<Vec<f64>>,
}

/// Applies `steps` to `original` in order, following the time of the rows through steps that change them.
pub fn replay_t(original: &[f64], steps: &[Edit], t: &[f64]) -> Result<Replayed, String> {
    let mut data = original.to_vec();
    let mut labels = Vec::with_capacity(steps.len());
    let mut time: Option<Vec<f64>> = None;
    for (i, s) in steps.iter().enumerate() {
        let tt: &[f64] = time.as_deref().unwrap_or(t);
        let (d, label) = s.apply_stored(&data, tt).map_err(|e| format!("Step {} failed: {e}", i + 1))?;
        if let Some(nt) = s.new_time(tt) {
            time = Some(nt);
        }
        data = d;
        labels.push(label);
    }
    Ok(Replayed { data, labels, time })
}

/// Applies `steps` to `original` in order. Returns the result and one label per step.
pub fn replay(original: &[f64], steps: &[Edit], t: &[f64]) -> Result<(Vec<f64>, Vec<String>), String> {
    replay_t(original, steps, t).map(|r| (r.data, r.labels))
}

// ---------------------------------------------------------------------------
// Workspace model
// ---------------------------------------------------------------------------

/// One imported file (or worksheet) with its own time base.
#[derive(Debug, Clone)]
pub struct Source {
    pub id: u32,
    pub name: String,
    pub path: String,
    pub sheet: Option<String>,
    pub options: ImportOptions,
    pub n_rows: usize,
    /// Time in seconds of every row (parsed time column, or the row number).
    pub time: Arc<Vec<f64>>,
    /// Unix seconds at t = 0 when the time column holds timestamps.
    pub origin: Option<f64>,
    /// Column the parser used as time, if any.
    pub time_column: Option<String>,
    /// Variable providing this source's time (shown with a clock in the UI).
    pub time_var: Option<String>,
    /// Shift added to this source's time when aligning (seconds).
    pub offset: f64,
    /// Seconds per row, when the time comes from a conversion factor instead of a time column.
    pub row_step: Option<f64>,
    /// Seconds per unit of the time column (1 = seconds, 60 = minutes, 3600 = hours, 86400 = days).
    pub time_scale: f64,
    /// Name suffix for variables from batch imports ("Pressure · run3").
    pub suffix: Option<String>,
}

impl Source {
    /// Time in seconds of a column that holds this file's time in its own unit.
    fn scaled(&self, data: &Arc<Vec<f64>>) -> Arc<Vec<f64>> {
        if self.time_scale == 1.0 { data.clone() } else { Arc::new(data.iter().map(|t| t * self.time_scale).collect()) }
    }

    /// Row i at i units, for a file without a time column.
    fn index_time(&self) -> Arc<Vec<f64>> {
        Arc::new((0..self.n_rows).map(|i| i as f64 * self.time_scale).collect())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case", tag = "type")]
pub enum Kind {
    Imported { source: u32, column: String },
    /// Evaluated on the common grid from other variables.
    Derived { formula: String },
}

#[derive(Debug, Clone)]
pub struct Variable {
    pub name: String,
    pub kind: Kind,
    /// Imported values, or the formula result for derived variables.
    pub original: Arc<Vec<f64>>,
    /// Values after the pipeline.
    pub data: Arc<Vec<f64>>,
    pub steps: Vec<Edit>,
    /// One label per step ("offset +2", "filter: Lowpass fc=…").
    pub edits: Vec<String>,
    /// Why a derived variable could not be evaluated.
    pub error: Option<String>,
    /// The time of each row of `data` when a step (downsample) changed the rows; None = the file's time.
    pub time: Option<Arc<Vec<f64>>>,
}

/// A text column (labels, states, IDs) used for grouping.
#[derive(Debug, Clone)]
pub struct TextVariable {
    pub name: String,
    pub source: u32,
    pub column: String,
    pub values: Arc<Vec<String>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct VariableInfo {
    pub name: String,
    pub len: usize,
    /// "file.csv · column", "= formula" or "text · file.csv".
    pub source: String,
    pub source_id: Option<u32>,
    /// "imported", "derived" or "text".
    pub kind: String,
    pub formula: Option<String>,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub is_time: bool,
    pub edits: Vec<String>,
    pub can_undo: bool,
    pub error: Option<String>,
}

/// What one pipeline block did to the values it received.
#[derive(Debug, Clone, Serialize)]
pub struct StageInfo {
    pub label: String,
    /// The step itself, on the aligned time axis.
    pub step: Edit,
    /// Rows after this block.
    pub rows: usize,
    /// Missing samples after this block.
    pub missing: usize,
    /// Samples that were valid before and are missing now.
    pub removed: usize,
    /// Samples that were missing before and are valid now.
    pub filled: usize,
    /// Samples valid before and after whose value moved.
    pub changed: usize,
    /// Root-mean-square movement of those samples.
    pub rms_change: Option<f64>,
}

impl StageInfo {
    /// One line on what the block did to the samples.
    pub fn effect(&self) -> String {
        let mut parts: Vec<String> = Vec::new();
        if self.removed > 0 {
            parts.push(format!("−{} removed", self.removed));
        }
        if self.filled > 0 {
            parts.push(format!("+{} filled", self.filled));
        }
        if self.changed > 0 {
            parts.push(format!("{} changed", self.changed));
        }
        if parts.is_empty() { "no change".into() } else { parts.join(" · ") }
    }
}

/// Where one row of a file sits in time.
#[derive(Debug, Clone, Serialize)]
pub struct TimeMap {
    /// 1-based row in the file.
    pub row: usize,
    pub rows: usize,
    /// Seconds on the aligned axis (any shift of the file included).
    pub time: f64,
    /// Clock time (UTC) when the file has timestamps.
    pub clock: Option<String>,
}

/// A variable's pipeline, block by block.
#[derive(Debug, Clone, Serialize)]
pub struct Pipeline {
    /// "file.csv · column" or "= formula".
    pub source: String,
    /// "imported" or "derived".
    pub kind: String,
    pub rows: usize,
    /// Missing samples in the imported values.
    pub missing: usize,
    pub stages: Vec<StageInfo>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SourceInfo {
    pub id: u32,
    pub name: String,
    pub path: String,
    pub rows: usize,
    pub time_var: Option<String>,
    pub origin: Option<f64>,
    pub offset: f64,
    /// Seconds per row when the time comes from a conversion factor.
    pub row_step: Option<f64>,
    /// Seconds per unit of the time column.
    pub time_scale: f64,
    pub start: Option<f64>,
    pub duration: f64,
    pub sample_rate: f64,
}

/// A reusable processing recipe: steps per column name plus derived variables.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Recipe {
    pub name: String,
    #[serde(default)]
    pub columns: Vec<RecipeColumn>,
    #[serde(default)]
    pub derived: Vec<RecipeDerived>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecipeColumn {
    pub column: String,
    pub steps: Vec<Edit>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecipeDerived {
    pub name: String,
    /// Formula over column names (and earlier derived names).
    pub formula: String,
    #[serde(default)]
    pub steps: Vec<Edit>,
}

/// A saved session: where the data came from and how it was processed.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    pub version: u32,
    #[serde(default)]
    pub align: Align,
    #[serde(default)]
    pub grid_step: Option<f64>,
    pub sources: Vec<ProjectSource>,
    pub variables: Vec<ProjectVariable>,
    #[serde(default)]
    pub auto_recipe: Option<Recipe>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectSource {
    pub id: u32,
    pub path: String,
    #[serde(default)]
    pub sheet: Option<String>,
    #[serde(default)]
    pub options: ImportOptions,
    #[serde(default)]
    pub offset: f64,
    #[serde(default)]
    pub suffix: Option<String>,
    #[serde(default)]
    pub time_var: Option<String>,
    #[serde(default)]
    pub row_step: Option<f64>,
    #[serde(default = "one")]
    pub time_scale: f64,
}

fn one() -> f64 {
    1.0
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectVariable {
    pub name: String,
    pub kind: ProjectKind,
    #[serde(default)]
    pub steps: Vec<Edit>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "type")]
pub enum ProjectKind {
    Imported { source: u32, column: String },
    Derived { formula: String },
    Text { source: u32, column: String },
}

#[derive(Default)]
pub struct Workspace {
    pub sources: Vec<Source>,
    pub vars: Vec<Variable>,
    pub texts: Vec<TextVariable>,
    pub align: Align,
    /// Fixed step for the common grid (seconds); None = finest source step.
    pub grid_step: Option<f64>,
    /// Applied to every newly imported file.
    pub auto_recipe: Option<Recipe>,
    /// Common time grid of the last build.
    pub grid: Arc<Vec<f64>>,
    /// What `grid` was built from; while it is unchanged the grid and the aligned columns stay valid.
    grid_key: String,
    /// Keeps the time axes behind `grid_key` alive, so their addresses cannot be reused.
    grid_times: Vec<Arc<Vec<f64>>>,
    /// Sample rate of `grid`.
    grid_rate: f64,
    aligned_cache: HashMap<String, AlignedColumn>,
    text_cache: HashMap<String, AlignedText>,
    next_source: u32,
}

/// A signal aligned onto the grid, valid while its inputs are the same allocations.
struct AlignedColumn {
    values: Arc<Vec<f64>>,
    time: Option<Arc<Vec<f64>>>,
    grid: Arc<Vec<f64>>,
    shift: u64,
    out: Arc<Vec<f64>>,
}

struct AlignedText {
    values: Arc<Vec<String>>,
    time: Arc<Vec<f64>>,
    grid: Arc<Vec<f64>>,
    shift: u64,
    out: Arc<Vec<String>>,
}

fn same_time(a: &Option<Arc<Vec<f64>>>, b: &Option<Arc<Vec<f64>>>) -> bool {
    match (a, b) {
        (Some(a), Some(b)) => Arc::ptr_eq(a, b),
        (None, None) => true,
        _ => false,
    }
}

fn file_name(path: &str) -> String {
    Path::new(path).file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| path.to_string())
}

fn file_stem(path: &str) -> String {
    Path::new(path).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| path.to_string())
}

/// A time axis prepared for interpolation: its finite samples in time order and the largest
/// step that is still bridged. Every signal of a file shares it, so it is built once.
pub struct Axis<'a> {
    t: std::borrow::Cow<'a, [f64]>,
    order: Vec<usize>,
    gap: f64,
}

impl<'a> Axis<'a> {
    pub fn new(t: std::borrow::Cow<'a, [f64]>) -> Axis<'a> {
        let mut order: Vec<usize> = (0..t.len()).filter(|&i| t[i].is_finite()).collect();
        if !order.windows(2).all(|w| t[w[0]] <= t[w[1]]) {
            order.sort_by(|&a, &b| t[a].total_cmp(&t[b]));
        }
        let mut steps: Vec<f64> = order.windows(2).map(|w| t[w[1]] - t[w[0]]).filter(|d| *d > 0.0).collect();
        let gap = if steps.is_empty() { f64::INFINITY } else { 3.0 * median_of(&mut steps) };
        Axis { t, order, gap }
    }
}

/// The step of a uniform grid (None when the grid is not uniform).
fn uniform_cell(grid: &[f64]) -> Option<f64> {
    let cell = grid.windows(2).next().map(|w| w[1] - w[0]).unwrap_or(0.0);
    let uniform = cell > 0.0 && grid.windows(2).all(|w| ((w[1] - w[0]) - cell).abs() <= 1e-6 * cell);
    uniform.then_some(cell)
}

/// Linear interpolation of (t, v) onto `grid`. Samples further apart than three typical
/// intervals are not bridged; points outside the source span are missing.
pub fn interp_onto(t: &[f64], v: &[f64], grid: &[f64]) -> Vec<f64> {
    let n = t.len().min(v.len());
    interp_axis(&Axis::new(std::borrow::Cow::Borrowed(&t[..n])), v, grid, uniform_cell(grid))
}

fn interp_axis(axis: &Axis, v: &[f64], grid: &[f64], cell: Option<f64>) -> Vec<f64> {
    let (t, order, gap) = (&axis.t, &axis.order, axis.gap);
    let mut out = vec![f64::NAN; grid.len()];
    if order.is_empty() || v.len() < t.len() {
        return out;
    }
    let mut k = 0;
    for (g, o) in grid.iter().zip(out.iter_mut()) {
        while k + 1 < order.len() && t[order[k + 1]] <= *g {
            k += 1;
        }
        let (i0, ti0) = (order[k], t[order[k]]);
        if *g == ti0 {
            *o = v[i0];
            continue;
        }
        if *g < ti0 || k + 1 >= order.len() {
            continue;
        }
        let i1 = order[k + 1];
        let (t1, v0, v1) = (t[i1], v[i0], v[i1]);
        if t1 - ti0 > gap || !v0.is_finite() || !v1.is_finite() {
            continue;
        }
        *o = v0 + (v1 - v0) * (g - ti0) / (t1 - ti0);
    }
    // A grid at least twice as coarse as the data averages each grid cell (a boxcar
    // anti-alias filter) instead of picking single samples, so resampling does not alias.
    // Only uniform grids (the workspace's) qualify; points left missing above stay missing.
    if let Some(cell) = cell.filter(|c| gap.is_finite() && *c >= 2.0 * gap / 3.0) {
        let h = cell / 2.0;
        let (mut lo, mut hi) = (0, 0);
        for (g, o) in grid.iter().zip(out.iter_mut()) {
            while lo < order.len() && t[order[lo]] < g - h {
                lo += 1;
            }
            hi = hi.max(lo);
            while hi < order.len() && t[order[hi]] < g + h {
                hi += 1;
            }
            let (sum, n) = order[lo..hi].iter().map(|&i| v[i]).filter(|x| x.is_finite()).fold((0.0, 0), |(s, n), x| (s + x, n + 1));
            if n > 0 && o.is_finite() {
                *o = sum / n as f64;
            }
        }
    }
    out
}

/// Zero-order hold of text values onto `grid` (last sample at or before each grid time).
fn hold_onto(t: &[f64], v: &[String], grid: &[f64]) -> Vec<String> {
    let mut order: Vec<usize> = (0..t.len().min(v.len())).filter(|&i| t[i].is_finite()).collect();
    order.sort_by(|&a, &b| t[a].total_cmp(&t[b]));
    let last = order.last().map(|&i| t[i]).unwrap_or(f64::NEG_INFINITY);
    let mut k = 0;
    grid.iter()
        .map(|g| {
            if order.is_empty() || *g < t[order[0]] || *g > last {
                return String::new();
            }
            while k + 1 < order.len() && t[order[k + 1]] <= *g {
                k += 1;
            }
            v[order[k]].clone()
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Formulas
// ---------------------------------------------------------------------------

const FUNCTIONS: &[&str] = &[
    "sqrt", "exp", "ln", "abs", "sin", "cos", "tan", "asin", "acos", "atan", "atan2", "sinh", "cosh", "tanh", "floor", "ceil",
    "round", "signum", "max", "min", "pi", "e",
];

/// Splits a formula into text and variable references: `"Any name"` or a bare identifier.
fn tokens(formula: &str) -> Vec<(bool, String)> {
    let mut out = Vec::new();
    let chars: Vec<char> = formula.chars().collect();
    let mut i = 0;
    let mut text = String::new();
    while i < chars.len() {
        let c = chars[i];
        if c == '"' {
            let end = chars[i + 1..].iter().position(|&d| d == '"').map(|p| i + 1 + p).unwrap_or(chars.len());
            if !text.is_empty() {
                out.push((false, std::mem::take(&mut text)));
            }
            out.push((true, chars[i + 1..end].iter().collect()));
            i = end + 1;
        } else if (c == 'e' || c == 'E') && text.chars().last().is_some_and(|p| p.is_ascii_digit() || p == '.') {
            // Exponent of a number literal (2e3, 1.5E-4).
            text.push(c);
            i += 1;
        } else if c.is_alphabetic() || c == '_' {
            let start = i;
            while i < chars.len() && (chars[i].is_alphanumeric() || chars[i] == '_') {
                i += 1;
            }
            let word: String = chars[start..i].iter().collect();
            if FUNCTIONS.contains(&word.as_str()) {
                text.push_str(&word);
            } else {
                if !text.is_empty() {
                    out.push((false, std::mem::take(&mut text)));
                }
                out.push((true, word));
            }
        } else {
            text.push(c);
            i += 1;
        }
    }
    if !text.is_empty() {
        out.push((false, text));
    }
    out
}

/// Formula text referring to `name`: bare when it is a plain identifier, quoted otherwise.
fn reference(name: &str) -> String {
    let plain = name.chars().next().is_some_and(|c| c.is_alphabetic() || c == '_')
        && name.chars().all(|c| c.is_alphanumeric() || c == '_')
        && !FUNCTIONS.contains(&name);
    if plain { name.to_string() } else { format!("\"{name}\"") }
}

/// Rewrites variable references through `map` (unmapped names stay as written).
pub fn rename_refs(formula: &str, map: &dyn Fn(&str) -> Option<String>) -> String {
    tokens(formula)
        .into_iter()
        .map(|(is_ref, s)| if is_ref { map(&s).map(|n| reference(&n)).unwrap_or_else(|| reference(&s)) } else { s })
        .collect()
}

/// Names a formula refers to.
pub fn formula_refs(formula: &str) -> Vec<String> {
    tokens(formula).into_iter().filter(|(r, _)| *r).map(|(_, s)| s).collect()
}

/// Evaluates `formula` row by row; `t` refers to the grid time unless a variable is named "t".
pub fn evaluate(formula: &str, vars: &HashMap<String, Arc<Vec<f64>>>, grid: &[f64]) -> Result<Vec<f64>, String> {
    let mut inputs: Vec<&[f64]> = Vec::new();
    let mut names: Vec<String> = Vec::new();
    let mut expr = String::new();
    for (is_ref, s) in tokens(formula) {
        if !is_ref {
            expr.push_str(&s);
            continue;
        }
        let data: &[f64] = match vars.get(&s) {
            Some(v) => v,
            None if s == "t" => grid,
            None => return Err(format!("Unknown variable '{s}'. Put names with spaces or units in double quotes, e.g. \"Pressure [bar]\".")),
        };
        let k = match names.iter().position(|n| n == &s) {
            Some(k) => k,
            None => {
                names.push(s.clone());
                inputs.push(data);
                names.len() - 1
            }
        };
        expr.push_str(&format!("__v{k}"));
    }
    if names.is_empty() {
        return Err("Use at least one variable in the formula.".into());
    }
    let parsed: meval::Expr = expr.parse().map_err(|e| format!("Invalid formula: {e}"))?;
    let placeholders: Vec<String> = (0..names.len()).map(|k| format!("__v{k}")).collect();
    let refs: Vec<&str> = placeholders.iter().map(String::as_str).collect();
    let f = parsed.bindn(&refs).map_err(|e| format!("Invalid formula: {e}"))?;
    let mut args = vec![0.0; inputs.len()];
    Ok((0..grid.len())
        .map(|i| {
            for (a, input) in args.iter_mut().zip(&inputs) {
                *a = input.get(i).copied().unwrap_or(f64::NAN);
            }
            let y = f(&args);
            if y.is_finite() { y } else { f64::NAN }
        })
        .collect())
}

// ---------------------------------------------------------------------------
// Workspace operations
// ---------------------------------------------------------------------------

impl Workspace {
    pub fn get(&self, name: &str) -> Option<&Variable> {
        self.vars.iter().find(|v| v.name == name)
    }

    fn get_mut(&mut self, name: &str) -> Result<&mut Variable, String> {
        self.vars.iter_mut().find(|v| v.name == name).ok_or_else(|| format!("Variable '{name}' not found."))
    }

    pub fn source(&self, id: u32) -> Option<&Source> {
        self.sources.iter().find(|s| s.id == id)
    }

    fn exists(&self, name: &str) -> bool {
        self.get(name).is_some() || self.texts.iter().any(|t| t.name == name)
    }

    fn unique_name(&self, base: &str) -> String {
        let base = if base.trim().is_empty() { "var" } else { base.trim() };
        if !self.exists(base) {
            return base.to_string();
        }
        (2..).map(|i| format!("{base} ({i})")).find(|n| !self.exists(n)).unwrap()
    }

    pub fn is_time_var(&self, name: &str) -> bool {
        self.sources.iter().any(|s| s.time_var.as_deref() == Some(name))
    }

    /// The time of the file's rows (or the grid for derived signals): where a pipeline starts.
    pub fn base_time(&self, v: &Variable) -> Arc<Vec<f64>> {
        match &v.kind {
            Kind::Imported { source, .. } => self.source(*source).map(|s| s.time.clone()).unwrap_or_default(),
            Kind::Derived { .. } => self.grid.clone(),
        }
    }

    /// The time of each row of the variable's current values (shorter after a downsample).
    pub fn local_time(&self, v: &Variable) -> Arc<Vec<f64>> {
        v.time.clone().unwrap_or_else(|| self.base_time(v))
    }

    /// Shift from a variable's own time to the aligned (displayed) time.
    pub fn shift_of(&self, v: &Variable) -> f64 {
        match &v.kind {
            Kind::Imported { source, .. } => self.source(*source).map(|s| self.source_shift(s)).unwrap_or(0.0),
            Kind::Derived { .. } => 0.0,
        }
    }

    fn min_origin(&self) -> Option<f64> {
        self.sources.iter().filter_map(|s| s.origin).reduce(f64::min)
    }

    /// Shift from a source's own time to the aligned time (offset, plus the clock difference).
    pub fn source_shift(&self, s: &Source) -> f64 {
        match self.align {
            Align::Row => 0.0,
            Align::Time => s.offset,
            Align::Clock => s.offset + match (s.origin, self.min_origin()) {
                (Some(o), Some(m)) => o - m,
                _ => 0.0,
            },
        }
    }

    fn add_var(&mut self, name: &str, kind: Kind, data: Vec<f64>) -> String {
        let name = self.unique_name(name);
        let data = Arc::new(data);
        self.vars.push(Variable { name: name.clone(), kind, original: data.clone(), data, steps: vec![], edits: vec![], error: None, time: None });
        name
    }

    /// Imports `columns` (preview header names) of one file as a new source. Text columns
    /// become text variables. Returns the created names and any recipe warnings.
    pub fn import(&mut self, path: &str, sheet: Option<&str>, opts: &ImportOptions, columns: &[String], suffix: Option<String>) -> Result<(Vec<String>, Vec<String>), String> {
        if columns.is_empty() {
            return Err("Tick at least one column to import.".into());
        }
        let parsed = parse_file_with(Path::new(path), sheet, opts)?;
        self.import_parsed(path, sheet.or(parsed.sheet.as_deref()).map(str::to_string), opts.clone(), parsed, columns, suffix, None)
    }

    #[allow(clippy::too_many_arguments)]
    fn import_parsed(
        &mut self,
        path: &str,
        sheet: Option<String>,
        options: ImportOptions,
        parsed: ParseResult,
        columns: &[String],
        suffix: Option<String>,
        id: Option<u32>,
    ) -> Result<(Vec<String>, Vec<String>), String> {
        let n_rows = parsed.n_rows;
        let time = parsed.time.clone().unwrap_or_else(|| (0..n_rows).map(|i| i as f64).collect());
        let id = id.unwrap_or(self.next_source);
        self.next_source = self.next_source.max(id + 1);
        let mut name = match &sheet {
            Some(s) => format!("{} [{s}]", file_name(path)),
            None => file_name(path),
        };
        if self.sources.iter().any(|s| s.name == name) {
            name = format!("{name} ({})", self.sources.len() + 1);
        }
        let mut source = Source {
            id,
            name,
            path: path.to_string(),
            sheet,
            options,
            n_rows,
            time: Arc::new(time.clone()),
            origin: parsed.time_origin,
            time_column: parsed.time_column.clone(),
            time_var: None,
            offset: 0.0,
            row_step: None,
            time_scale: 1.0,
            suffix: suffix.clone(),
        };
        let label = |c: &str| match &suffix {
            Some(s) => format!("{c} · {s}"),
            None => c.to_string(),
        };
        let mut added = Vec::new();
        for col in columns {
            if parsed.time_column.as_deref() == Some(col.as_str()) {
                let name = self.add_var(&label(col), Kind::Imported { source: id, column: col.clone() }, time.clone());
                source.time_var = Some(name.clone());
                added.push(name);
            } else if let Some((_, v)) = parsed.columns.iter().find(|(c, _)| c == col) {
                added.push(self.add_var(&label(col), Kind::Imported { source: id, column: col.clone() }, v.clone()));
            } else if let Some((_, v)) = parsed.text_columns.iter().find(|(c, _)| c == col) {
                let name = self.unique_name(&label(col));
                self.texts.push(TextVariable { name: name.clone(), source: id, column: col.clone(), values: Arc::new(v.clone()) });
                added.push(name);
            } else {
                return Err(format!("Column '{col}' was not found with the current import settings."));
            }
        }
        self.sources.push(source);
        let warnings = match self.auto_recipe.clone() {
            Some(r) => self.apply_recipe(&r, Some(id)),
            None => vec![],
        };
        Ok((added, warnings))
    }

    /// Imports every data file in `paths` as its own source ("Pressure · run3"), taking the
    /// listed columns (or all of them) and applying the automatic recipe.
    pub fn import_batch(&mut self, paths: &[String], columns: Option<&[String]>) -> (Vec<String>, Vec<String>) {
        let mut added = Vec::new();
        let mut warnings = Vec::new();
        for path in paths {
            let opts = ImportOptions::default();
            let result = parse_file_with(Path::new(path), None, &opts).and_then(|parsed| {
                let available: Vec<String> = parsed
                    .time_column
                    .iter()
                    .cloned()
                    .chain(parsed.columns.iter().map(|(c, _)| c.clone()))
                    .chain(parsed.text_columns.iter().map(|(c, _)| c.clone()))
                    .collect();
                let cols: Vec<String> = match columns {
                    Some(want) => available.iter().filter(|c| want.contains(c)).cloned().collect(),
                    None => available,
                };
                if cols.is_empty() {
                    return Err("none of the requested columns are present".into());
                }
                let sheet = parsed.sheet.clone();
                self.import_parsed(path, sheet, opts.clone(), parsed, &cols, Some(file_stem(path)), None)
            });
            match result {
                Ok((a, w)) => {
                    added.extend(a);
                    warnings.extend(w.into_iter().map(|w| format!("{}: {w}", file_name(path))));
                }
                Err(e) => warnings.push(format!("{}: {e}", file_name(path))),
            }
        }
        (added, warnings)
    }

    /// Re-runs a variable's pipeline from its original values.
    fn rebuild_var(&mut self, name: &str) -> Result<(), String> {
        let v = self.get(name).ok_or("Variable not found.")?;
        let t = self.base_time(v);
        let r = replay_t(&v.original, &v.steps, &t)?;
        if r.time.is_some() && matches!(v.kind, Kind::Derived { .. }) {
            return Err("Downsample is not available for formula signals.".into());
        }
        let v = self.get_mut(name)?;
        v.data = Arc::new(r.data);
        v.edits = r.labels;
        v.time = r.time.map(Arc::new);
        self.refresh_time(name);
        Ok(())
    }

    /// Keeps a source's time in step with its time variable.
    fn refresh_time(&mut self, name: &str) {
        let Some(v) = self.get(name) else { return };
        let data = v.data.clone();
        if let Some(s) = self.sources.iter_mut().find(|s| s.time_var.as_deref() == Some(name)) {
            if data.len() == s.n_rows {
                s.time = s.scaled(&data);
            }
        }
    }

    /// Appends a step. `shift` converts times picked on the aligned axis to the variable's own time.
    pub fn edit(&mut self, name: &str, edit: Edit) -> Result<(), String> {
        let v = self.get(name).ok_or("Variable not found.")?;
        let edit = edit.shifted(-self.shift_of(v));
        self.push_step(name, edit)
    }

    /// Applies a step (in the variable's own time) to its current values and appends it.
    fn push_step(&mut self, name: &str, edit: Edit) -> Result<(), String> {
        let v = self.get(name).ok_or("Variable not found.")?;
        if matches!(edit, Edit::Downsample(_)) && matches!(v.kind, Kind::Derived { .. }) {
            return Err("Downsample is not available for formula signals.".into());
        }
        let t = self.local_time(v);
        let (data, label) = edit.apply(&v.data, &t)?;
        let new_time = edit.new_time(&t);
        let v = self.get_mut(name)?;
        v.data = Arc::new(data);
        if let Some(nt) = new_time {
            v.time = Some(Arc::new(nt));
        }
        v.steps.push(edit);
        v.edits.push(label);
        self.refresh_time(name);
        Ok(())
    }

    /// The values `edit` would produce, without adding it (live previews), and their time when the
    /// step changes the number of rows. Times are in the variable's own base.
    pub fn preview(&self, name: &str, edit: &Edit) -> Result<(Vec<f64>, Option<Vec<f64>>), String> {
        let v = self.get(name).ok_or("Variable not found.")?;
        let edit = edit.shifted(-self.shift_of(v));
        let t = self.local_time(v);
        Ok((edit.apply(&v.data, &t)?.0, edit.new_time(&t)))
    }

    /// The pipeline block by block, with what each block changed.
    pub fn pipeline(&self, name: &str) -> Result<Pipeline, String> {
        let v = self.get(name).ok_or("Variable not found.")?;
        let base = self.base_time(v);
        let shift = self.shift_of(v);
        let mut data = v.original.to_vec();
        let mut time: Option<Vec<f64>> = None;
        let missing = data.iter().filter(|x| !x.is_finite()).count();
        let mut stages = Vec::with_capacity(v.steps.len());
        for (i, s) in v.steps.iter().enumerate() {
            let tt: &[f64] = time.as_deref().unwrap_or(&base);
            let (next, label) = s.apply_stored(&data, tt).map_err(|e| format!("Step {} failed: {e}", i + 1))?;
            if let Some(nt) = s.new_time(tt) {
                time = Some(nt);
            }
            let (mut removed, mut filled, mut changed, mut sq) = (0usize, 0usize, 0usize, 0.0f64);
            // A step that changes the number of rows has no row-by-row comparison.
            for (a, b) in data.iter().zip(&next).filter(|_| next.len() == data.len()) {
                match (a.is_finite(), b.is_finite()) {
                    (true, false) => removed += 1,
                    (false, true) => filled += 1,
                    (true, true) if a != b => {
                        changed += 1;
                        sq += (b - a).powi(2);
                    }
                    _ => {}
                }
            }
            stages.push(StageInfo {
                label,
                step: s.shifted(shift),
                rows: next.len(),
                missing: next.iter().filter(|x| !x.is_finite()).count(),
                removed,
                filled,
                changed,
                rms_change: (changed > 0).then(|| (sq / changed as f64).sqrt()),
            });
            data = next;
        }
        let (source, kind) = match &v.kind {
            Kind::Imported { source, column } => (format!("{} · {column}", self.source(*source).map(|s| s.name.as_str()).unwrap_or_default()), "imported"),
            Kind::Derived { formula } => (format!("= {formula}"), "derived"),
        };
        Ok(Pipeline { source, kind: kind.into(), rows: data.len(), missing, stages })
    }

    /// The values after the first `count` blocks (0 = the imported values).
    pub fn stage_values(&self, name: &str, count: usize) -> Result<(Vec<f64>, Vec<f64>), String> {
        let v = self.get(name).ok_or("Variable not found.")?;
        let count = count.min(v.steps.len());
        let base = self.base_time(v);
        let r = replay_t(&v.original, &v.steps[..count], &base)?;
        let shift = self.shift_of(v);
        let t = r.time.unwrap_or_else(|| base.to_vec());
        Ok((r.data, t.iter().map(|x| x + shift).collect()))
    }

    /// Swaps in a new step list and rebuilds; the old list comes back if the new one fails.
    fn set_steps(&mut self, name: &str, steps: Vec<Edit>) -> Result<(), String> {
        let v = self.get_mut(name)?;
        let old = std::mem::replace(&mut v.steps, steps);
        if let Err(e) = self.rebuild_var(name) {
            self.get_mut(name)?.steps = old;
            self.rebuild_var(name)?;
            return Err(e);
        }
        Ok(())
    }

    /// Deletes block `index` from the pipeline.
    pub fn remove_step(&mut self, name: &str, index: usize) -> Result<(), String> {
        let mut steps = self.get(name).ok_or("Variable not found.")?.steps.clone();
        if index >= steps.len() {
            return Err("No such block.".into());
        }
        steps.remove(index);
        self.set_steps(name, steps)
    }

    /// Moves block `from` so it sits at position `to`.
    pub fn move_step(&mut self, name: &str, from: usize, to: usize) -> Result<(), String> {
        let mut steps = self.get(name).ok_or("Variable not found.")?.steps.clone();
        if from >= steps.len() || to >= steps.len() {
            return Err("No such block.".into());
        }
        let s = steps.remove(from);
        steps.insert(to, s);
        self.set_steps(name, steps)
    }

    /// Replaces block `index` (new parameters; times on the aligned axis).
    pub fn replace_step(&mut self, name: &str, index: usize, edit: Edit) -> Result<(), String> {
        let v = self.get(name).ok_or("Variable not found.")?;
        let mut steps = v.steps.clone();
        if index >= steps.len() {
            return Err("No such block.".into());
        }
        steps[index] = edit.shifted(-self.shift_of(v));
        self.set_steps(name, steps)
    }

    /// Maps a row of file `id` to its time, or a time to the nearest row.
    pub fn time_map(&self, id: u32, row: Option<usize>, time: Option<f64>) -> Result<TimeMap, String> {
        let s = self.source(id).ok_or("File not found.")?;
        let n = s.time.len();
        if n == 0 {
            return Err("The file has no rows.".into());
        }
        let shift = self.source_shift(s);
        let idx = match (row, time) {
            (Some(r), _) => r.clamp(1, n) - 1,
            (None, Some(t)) => (0..n)
                .filter(|&i| s.time[i].is_finite())
                .min_by(|&a, &b| (s.time[a] + shift - t).abs().total_cmp(&(s.time[b] + shift - t).abs()))
                .unwrap_or(0),
            (None, None) => 0,
        };
        let local = s.time[idx];
        let clock = s
            .origin
            .and_then(|o| chrono::DateTime::<chrono::Utc>::from_timestamp_millis(((o + local) * 1000.0).round() as i64))
            .map(|d| d.format("%Y-%m-%d %H:%M:%S%.3f").to_string());
        Ok(TimeMap { row: idx + 1, rows: n, time: local + shift, clock })
    }

    /// Reverts the most recent step.
    pub fn undo(&mut self, name: &str) -> Result<(), String> {
        let v = self.get_mut(name)?;
        v.steps.pop().ok_or("Nothing to undo.")?;
        self.rebuild_var(name)
    }

    /// Removes every filter step (the Filter page's "clear").
    pub fn remove_filters(&mut self, name: &str) -> Result<(), String> {
        let v = self.get_mut(name)?;
        let before = v.steps.len();
        v.steps.retain(|s| !s.is_filter());
        if v.steps.len() == before {
            return Err("No filters applied to this signal.".into());
        }
        self.rebuild_var(name)
    }

    /// Back to the imported values.
    pub fn reset(&mut self, name: &str) -> Result<(), String> {
        let v = self.get_mut(name)?;
        v.steps.clear();
        self.rebuild_var(name)
    }

    pub fn duplicate(&mut self, name: &str) -> Result<String, String> {
        let v = self.get(name).ok_or("Variable not found.")?.clone();
        let new = self.unique_name(&format!("{name} copy"));
        self.vars.push(Variable { name: new.clone(), ..v });
        Ok(new)
    }

    pub fn add_derived(&mut self, name: &str, formula: &str) -> Result<String, String> {
        let name = name.trim();
        if name.is_empty() {
            return Err("Name the new variable.".into());
        }
        if self.exists(name) {
            return Err(format!("A variable named '{name}' already exists."));
        }
        // Validate against the current grid before adding.
        let inputs = self.aligned_inputs()?;
        evaluate(formula, &inputs, &self.grid)?;
        Ok(self.add_var(name, Kind::Derived { formula: formula.trim().to_string() }, vec![]))
    }

    pub fn set_formula(&mut self, name: &str, formula: &str) -> Result<(), String> {
        let v = self.get_mut(name)?;
        match &mut v.kind {
            Kind::Derived { formula: f } => *f = formula.trim().to_string(),
            _ => return Err("Only derived variables have a formula.".into()),
        }
        Ok(())
    }

    pub fn remove(&mut self, names: &[String]) {
        self.vars.retain(|v| !names.contains(&v.name));
        self.texts.retain(|t| !names.contains(&t.name));
        for s in &mut self.sources {
            if s.time_var.as_ref().is_some_and(|t| names.contains(t)) {
                s.time_var = None;
                s.time = s.index_time();
                s.origin = None;
            }
        }
        // Drop sources nothing refers to any more.
        let used: Vec<u32> = self
            .vars
            .iter()
            .filter_map(|v| match v.kind {
                Kind::Imported { source, .. } => Some(source),
                _ => None,
            })
            .chain(self.texts.iter().map(|t| t.source))
            .collect();
        self.sources.retain(|s| used.contains(&s.id));
    }

    pub fn remove_source(&mut self, id: u32) {
        let names: Vec<String> = self
            .vars
            .iter()
            .filter(|v| matches!(v.kind, Kind::Imported { source, .. } if source == id))
            .map(|v| v.name.clone())
            .chain(self.texts.iter().filter(|t| t.source == id).map(|t| t.name.clone()))
            .collect();
        self.remove(&names);
        self.sources.retain(|s| s.id != id);
    }

    pub fn rename(&mut self, old: &str, new: &str) -> Result<(), String> {
        let new = new.trim();
        if new.is_empty() {
            return Err("Name cannot be empty.".into());
        }
        if old != new && self.exists(new) {
            return Err(format!("A variable named '{new}' already exists."));
        }
        if let Some(t) = self.texts.iter_mut().find(|t| t.name == old) {
            t.name = new.to_string();
            return Ok(());
        }
        self.get_mut(old)?.name = new.to_string();
        for s in &mut self.sources {
            if s.time_var.as_deref() == Some(old) {
                s.time_var = Some(new.to_string());
            }
        }
        for v in &mut self.vars {
            if let Kind::Derived { formula } = &mut v.kind {
                *formula = rename_refs(formula, &|n| (n == old).then(|| new.to_string()));
            }
        }
        Ok(())
    }

    /// Makes `name` the time base of its source (`on`), or reverts that source to row numbers.
    pub fn set_time(&mut self, name: &str, on: bool) -> Result<(), String> {
        let v = self.get(name).ok_or("Variable not found.")?;
        let Kind::Imported { source, column } = &v.kind else {
            return Err("Only imported variables can be a time axis.".into());
        };
        let (source, column, data) = (*source, column.clone(), v.data.clone());
        let s = self.sources.iter_mut().find(|s| s.id == source).ok_or("Source not found.")?;
        if on {
            if data.len() != s.n_rows {
                return Err("The time variable must have one value per row.".into());
            }
            if s.time_column.as_deref() != Some(column.as_str()) {
                s.origin = None;
            }
            s.time = s.scaled(&data);
            s.time_var = Some(name.to_string());
            s.row_step = None;
        } else if s.time_var.as_deref() == Some(name) {
            s.time_var = None;
            s.time = s.index_time();
            s.origin = None;
        }
        Ok(())
    }

    /// Time from a conversion factor: row i is at i × `step` seconds (None goes back to a time
    /// column, or to the row number when the file has none).
    pub fn set_row_step(&mut self, id: u32, step: Option<f64>) -> Result<(), String> {
        if step.is_some_and(|k| !(k > 0.0) || !k.is_finite()) {
            return Err("Seconds per row must be a positive number.".into());
        }
        let s = self.sources.iter_mut().find(|s| s.id == id).ok_or("File not found.")?;
        match step {
            Some(k) => {
                s.row_step = Some(k);
                s.time_var = None;
                s.origin = None;
                s.time = Arc::new((0..s.n_rows).map(|i| i as f64 * k).collect());
            }
            None => {
                s.row_step = None;
                s.time = s.index_time();
                // Go back to the file's own time column when it is still around.
                let column = s.time_column.clone();
                let var = self.vars.iter().find(|v| matches!(&v.kind, Kind::Imported { source, column: c } if *source == id && Some(c) == column.as_ref())).map(|v| v.name.clone());
                if let Some(name) = var {
                    let _ = self.set_time(&name, true);
                }
            }
        }
        Ok(())
    }

    /// The unit a file's time column is given in, as seconds per unit (60 for minutes).
    pub fn set_time_unit(&mut self, id: u32, scale: f64) -> Result<(), String> {
        if !(scale > 0.0) || !scale.is_finite() {
            return Err("The time unit must be a positive number of seconds.".into());
        }
        let time_var = self.sources.iter().find(|s| s.id == id).ok_or("File not found.")?.time_var.clone();
        let data = time_var.and_then(|n| self.get(&n).map(|v| v.data.clone()));
        let s = self.sources.iter_mut().find(|s| s.id == id).ok_or("File not found.")?;
        s.time_scale = scale;
        if s.row_step.is_none() {
            s.time = match data {
                Some(d) if d.len() == s.n_rows => s.scaled(&d),
                _ => s.index_time(),
            };
        }
        Ok(())
    }

    pub fn set_offset(&mut self, id: u32, offset: f64) -> Result<(), String> {
        if !offset.is_finite() {
            return Err("The shift must be a number.".into());
        }
        self.sources.iter_mut().find(|s| s.id == id).ok_or("Source not found.")?.offset = offset;
        Ok(())
    }

    pub fn set_align(&mut self, align: Align, grid_step: Option<f64>) -> Result<(), String> {
        if grid_step.is_some_and(|s| !(s > 0.0)) {
            return Err("The grid step must be positive.".into());
        }
        self.align = align;
        self.grid_step = grid_step;
        Ok(())
    }

    // -- Alignment ---------------------------------------------------------

    fn signal_vars(&self) -> Vec<&Variable> {
        self.vars.iter().filter(|v| !self.is_time_var(&v.name)).collect()
    }

    fn effective_time(&self, s: &Source) -> Vec<f64> {
        let shift = self.source_shift(s);
        s.time.iter().map(|t| t + shift).collect()
    }

    /// Sources that supply at least one signal (all of them when none does).
    fn used_sources(&self) -> Vec<&Source> {
        let signals = self.signal_vars();
        let used: Vec<&Source> = self
            .sources
            .iter()
            .filter(|s| signals.iter().any(|v| matches!(v.kind, Kind::Imported { source, .. } if source == s.id)))
            .collect();
        if used.is_empty() { self.sources.iter().collect() } else { used }
    }

    /// Everything the grid depends on, as a comparable key (plus the time axes it names).
    fn grid_signature(&self) -> (String, Vec<Arc<Vec<f64>>>) {
        let mut key = format!("{:?}|{:?}", self.align, self.grid_step.map(f64::to_bits));
        let mut times = Vec::new();
        for s in self.used_sources() {
            key.push_str(&format!("|{}:{}:{}:{}", s.id, Arc::as_ptr(&s.time) as usize, self.source_shift(s).to_bits(), s.n_rows));
            times.push(s.time.clone());
        }
        (key, times)
    }

    /// Common grid for the current sources: a source's own time when only one is involved
    /// (or all share it), otherwise a uniform grid over the union at the finest step.
    fn make_grid(&self) -> Vec<f64> {
        let used = self.used_sources();
        if self.align == Align::Row {
            let n = used.iter().map(|s| s.n_rows).max().unwrap_or(0);
            if used.len() == 1 {
                let mut t = self.effective_time(used[0]);
                let step = if t.len() >= 2 { t[t.len() - 1] - t[t.len() - 2] } else { 1.0 };
                while t.len() < n {
                    let last = t.last().copied().unwrap_or(-step);
                    t.push(last + step);
                }
                return t;
            }
            return (0..n).map(|i| i as f64).collect();
        }
        let times: Vec<Vec<f64>> = used.iter().map(|s| self.effective_time(s)).collect();
        if self.grid_step.is_none() && times.iter().all(|t| t == &times[0]) {
            return times.into_iter().next().unwrap_or_default();
        }
        let mut lo = f64::INFINITY;
        let mut hi = f64::NEG_INFINITY;
        let mut finest = f64::INFINITY;
        for t in &times {
            for x in t.iter().filter(|x| x.is_finite()) {
                lo = lo.min(*x);
                hi = hi.max(*x);
            }
            let rate = sample_rate_of(t);
            if rate > 0.0 {
                finest = finest.min(1.0 / rate);
            }
        }
        if !lo.is_finite() || !(hi > lo) {
            return times.into_iter().next().unwrap_or_default();
        }
        let mut step = self.grid_step.unwrap_or(finest);
        if !(step > 0.0) || !step.is_finite() {
            step = 1.0;
        }
        if (hi - lo) / step + 1.0 > MAX_GRID as f64 {
            step = (hi - lo) / (MAX_GRID - 1) as f64;
        }
        let n = ((hi - lo) / step).floor() as usize + 1;
        (0..n).map(|i| lo + i as f64 * step).collect()
    }

    /// A variable's values (pipeline output, or `original`) on the current grid.
    pub fn aligned(&self, v: &Variable, original: bool) -> Vec<f64> {
        let values = if original { &v.original } else { &v.data };
        match &v.kind {
            Kind::Derived { .. } => values.to_vec(),
            Kind::Imported { source, .. } => {
                let Some(s) = self.source(*source) else { return vec![f64::NAN; self.grid.len()] };
                if self.align == Align::Row {
                    let mut out = values.to_vec();
                    out.resize(self.grid.len(), f64::NAN);
                    return out;
                }
                // A downsampled signal has its own, shorter rows; the imported values keep the file's.
                let t: Vec<f64> = match v.time.as_ref().filter(|_| !original) {
                    Some(own) => {
                        let shift = self.source_shift(s);
                        own.iter().map(|x| x + shift).collect()
                    }
                    None => self.effective_time(s),
                };
                if t.as_slice() == self.grid.as_slice() {
                    return values.to_vec();
                }
                interp_onto(&t, values, &self.grid)
            }
        }
    }

    /// What a cached aligned column depends on besides its values: the time axis and the file's shift.
    fn column_key(&self, v: &Variable) -> (Option<Arc<Vec<f64>>>, u64) {
        match &v.kind {
            Kind::Imported { source, .. } => match self.source(*source) {
                Some(s) => (v.time.clone().or_else(|| Some(s.time.clone())), self.source_shift(s).to_bits()),
                None => (None, 0),
            },
            Kind::Derived { .. } => (None, 0),
        }
    }

    /// The cached column of variable `idx` when nothing it depends on has changed.
    fn cached_column(&self, idx: usize) -> Option<Arc<Vec<f64>>> {
        let v = &self.vars[idx];
        let e = self.aligned_cache.get(&v.name)?;
        let (time, shift) = self.column_key(v);
        (Arc::ptr_eq(&e.values, &v.data) && Arc::ptr_eq(&e.grid, &self.grid) && same_time(&e.time, &time) && e.shift == shift).then(|| e.out.clone())
    }

    /// A variable's pipeline output on the grid, reused until its values, time axis or the grid change.
    fn aligned_arc(&mut self, idx: usize) -> Arc<Vec<f64>> {
        if matches!(self.vars[idx].kind, Kind::Derived { .. }) {
            return self.vars[idx].data.clone();
        }
        if let Some(out) = self.cached_column(idx) {
            return out;
        }
        self.align_stale();
        self.cached_column(idx).unwrap_or_else(|| Arc::new(self.aligned(&self.vars[idx], false)))
    }

    /// Puts every imported signal whose cached column is out of date onto the grid. The signals of
    /// a file share one prepared time axis, and the work is spread over the cores.
    fn align_stale(&mut self) {
        let stale: Vec<usize> =
            (0..self.vars.len()).filter(|&i| matches!(self.vars[i].kind, Kind::Imported { .. }) && self.cached_column(i).is_none()).collect();
        if stale.is_empty() {
            return;
        }
        let grid: &[f64] = &self.grid;
        let outs: Vec<Arc<Vec<f64>>> = if self.align == Align::Row {
            par::par_map(stale.len(), |j| {
                let mut out = self.vars[stale[j]].data.to_vec();
                out.resize(grid.len(), f64::NAN);
                Arc::new(out)
            })
        } else {
            // One axis per (file, own time axis).
            let mut keys: Vec<(u32, usize, usize)> = Vec::new();
            let mut which = Vec::with_capacity(stale.len());
            for &i in &stale {
                let v = &self.vars[i];
                let Kind::Imported { source, .. } = &v.kind else { unreachable!() };
                let ptr = v.time.as_ref().map_or(0, |t| Arc::as_ptr(t) as usize);
                let k = match keys.iter().position(|(s, p, _)| s == source && *p == ptr) {
                    Some(k) => k,
                    None => {
                        keys.push((*source, ptr, i));
                        keys.len() - 1
                    }
                };
                which.push(k);
            }
            let axes: Vec<Option<(Axis, bool)>> = par::par_map(keys.len(), |k| {
                let (sid, _, rep) = keys[k];
                let s = self.source(sid)?;
                let t: Vec<f64> = match &self.vars[rep].time {
                    Some(own) => {
                        let shift = self.source_shift(s);
                        own.iter().map(|x| x + shift).collect()
                    }
                    None => self.effective_time(s),
                };
                let same = t.as_slice() == grid;
                Some((Axis::new(std::borrow::Cow::Owned(t)), same))
            });
            let cell = uniform_cell(grid);
            par::par_map(stale.len(), |j| {
                let values = &self.vars[stale[j]].data;
                Arc::new(match &axes[which[j]] {
                    None => vec![f64::NAN; grid.len()],
                    Some((_, true)) => values.to_vec(),
                    Some((axis, false)) => interp_axis(axis, values, grid, cell),
                })
            })
        };
        for (j, out) in stale.into_iter().zip(outs) {
            let v = &self.vars[j];
            let (time, shift) = self.column_key(v);
            let entry = AlignedColumn { values: v.data.clone(), time, grid: self.grid.clone(), shift, out };
            self.aligned_cache.insert(v.name.clone(), entry);
        }
    }

    /// A text variable held onto the grid, reused like `aligned_arc`.
    fn aligned_text(&mut self, idx: usize) -> Option<Arc<Vec<String>>> {
        let tv = &self.texts[idx];
        let s = self.source(tv.source)?;
        let (time, shift) = (s.time.clone(), self.source_shift(s).to_bits());
        if let Some(e) = self.text_cache.get(&tv.name) {
            if Arc::ptr_eq(&e.values, &tv.values) && Arc::ptr_eq(&e.grid, &self.grid) && Arc::ptr_eq(&e.time, &time) && e.shift == shift {
                return Some(e.out.clone());
            }
        }
        let out = Arc::new(if self.align == Align::Row {
            let mut v = tv.values.to_vec();
            v.resize(self.grid.len(), String::new());
            v
        } else {
            hold_onto(&self.effective_time(s), &tv.values, &self.grid)
        });
        let (name, values) = (tv.name.clone(), tv.values.clone());
        self.text_cache.insert(name, AlignedText { values, time, grid: self.grid.clone(), shift, out: out.clone() });
        Some(out)
    }

    fn aligned_inputs(&self) -> Result<HashMap<String, Arc<Vec<f64>>>, String> {
        Ok(self
            .vars
            .iter()
            .filter(|v| matches!(v.kind, Kind::Imported { .. }) || v.error.is_none())
            .map(|v| (v.name.clone(), Arc::new(self.aligned(v, false))))
            .collect())
    }

    /// Recomputes the grid and every derived variable (in creation order).
    fn refresh(&mut self) {
        let (key, times) = self.grid_signature();
        if key != self.grid_key || self.grid.is_empty() {
            self.grid = Arc::new(self.make_grid());
            self.grid_rate = sample_rate_of(&self.grid);
            self.grid_key = key;
            self.grid_times = times;
        }
        self.align_stale();
        let mut inputs: HashMap<String, Arc<Vec<f64>>> = HashMap::new();
        for i in 0..self.vars.len() {
            if matches!(self.vars[i].kind, Kind::Imported { .. }) {
                let a = self.aligned_arc(i);
                inputs.insert(self.vars[i].name.clone(), a);
                continue;
            }
            let v = &self.vars[i];
            match &v.kind {
                Kind::Imported { .. } => {}
                Kind::Derived { formula } => {
                    let result = evaluate(formula, &inputs, &self.grid).and_then(|o| {
                        let (d, labels) = replay(&o, &v.steps, &self.grid)?;
                        if d.len() != o.len() {
                            return Err("Downsample is not available for formula signals.".to_string());
                        }
                        Ok((o, d, labels))
                    });
                    let n = self.grid.len();
                    let v = &mut self.vars[i];
                    match result {
                        Ok((o, d, labels)) => {
                            v.original = Arc::new(o);
                            v.data = Arc::new(d);
                            v.edits = labels;
                            v.error = None;
                        }
                        Err(e) => {
                            v.original = Arc::new(vec![f64::NAN; n]);
                            v.data = v.original.clone();
                            v.error = Some(e);
                        }
                    }
                    inputs.insert(v.name.clone(), v.data.clone());
                }
            }
        }
    }

    /// The analysis dataset on the common grid. Columns are shared with the caches below, so an
    /// edit re-aligns only the signal it changed (None without numeric signals).
    pub fn to_dataset(&mut self, path: &str) -> Option<Dataset> {
        self.refresh();
        let signal_idx: Vec<usize> = (0..self.vars.len()).filter(|&i| !self.is_time_var(&self.vars[i].name)).collect();
        if signal_idx.is_empty() {
            return None;
        }
        let columns: Vec<(String, Arc<Vec<f64>>)> = signal_idx.iter().map(|&i| (self.vars[i].name.clone(), self.aligned_arc(i))).collect();
        let texts: Vec<(String, Arc<Vec<String>>)> =
            (0..self.texts.len()).filter_map(|i| self.aligned_text(i).map(|t| (self.texts[i].name.clone(), t))).collect();
        let time_origin = match self.align {
            Align::Clock => self.min_origin(),
            Align::Time if self.sources.len() == 1 => self.sources[0].origin.map(|o| o - self.sources[0].offset),
            _ => None,
        };
        let mut metadata = Map::new();
        metadata.insert(
            "variables".into(),
            Value::Array(self.info().iter().map(|v| Value::String(format!("{} ← {}", v.name, v.source))).collect()),
        );
        metadata.insert("alignment".into(), Value::String(format!("{:?}", self.align).to_lowercase()));
        Some(Dataset::from_shared(path, SharedParts { time: self.grid.clone(), sample_rate: self.grid_rate, columns, texts, time_origin, metadata }))
    }

    /// Row-aligned dataset of all signals on the common grid (None without numeric signals).
    pub fn to_parse(&mut self) -> Option<ParseResult> {
        self.refresh();
        let idx: Vec<usize> = (0..self.vars.len()).filter(|&i| !self.is_time_var(&self.vars[i].name)).collect();
        if idx.is_empty() {
            return None;
        }
        let columns: Vec<(String, Vec<f64>)> = idx.iter().map(|&i| (self.vars[i].name.clone(), self.aligned_arc(i).to_vec())).collect();
        let text_columns = self
            .texts
            .iter()
            .filter_map(|tv| {
                let s = self.source(tv.source)?;
                Some((tv.name.clone(), if self.align == Align::Row {
                    let mut v = tv.values.to_vec();
                    v.resize(self.grid.len(), String::new());
                    v
                } else {
                    hold_onto(&self.effective_time(s), &tv.values, &self.grid)
                }))
            })
            .collect();
        let time_origin = match self.align {
            Align::Clock => self.min_origin(),
            Align::Time if self.sources.len() == 1 => self.sources[0].origin.map(|o| o - self.sources[0].offset),
            _ => None,
        };
        let mut metadata = Map::new();
        metadata.insert(
            "variables".into(),
            Value::Array(self.info().iter().map(|v| Value::String(format!("{} ← {}", v.name, v.source))).collect()),
        );
        metadata.insert("alignment".into(), Value::String(format!("{:?}", self.align).to_lowercase()));
        Some(ParseResult {
            columns,
            time_column: None,
            time: Some(self.grid.to_vec()),
            time_origin,
            text_columns,
            metadata,
            header_row: 0,
            delimiter: ',',
            encoding: "—".into(),
            is_raser_format: false,
            n_rows: self.grid.len(),
            delimiter_desc: "—".into(),
            file_type: "Workspace".into(),
            sheet: None,
        })
    }

    // -- Views ----------------------------------------------------------------

    pub fn info(&self) -> Vec<VariableInfo> {
        let mut out: Vec<VariableInfo> = self
            .vars
            .iter()
            .map(|v| {
                let (mut lo, mut hi) = (f64::INFINITY, f64::NEG_INFINITY);
                for x in v.data.iter().copied().filter(|x| x.is_finite()) {
                    lo = lo.min(x);
                    hi = hi.max(x);
                }
                let (source, source_id, kind, formula) = match &v.kind {
                    Kind::Imported { source, column } => {
                        let file = self.source(*source).map(|s| s.name.clone()).unwrap_or_default();
                        (format!("{file} · {column}"), Some(*source), "imported", None)
                    }
                    Kind::Derived { formula } => (format!("= {formula}"), None, "derived", Some(formula.clone())),
                };
                VariableInfo {
                    name: v.name.clone(),
                    len: v.data.len(),
                    source,
                    source_id,
                    kind: kind.into(),
                    formula,
                    min: lo.is_finite().then_some(lo),
                    max: hi.is_finite().then_some(hi),
                    is_time: self.is_time_var(&v.name),
                    edits: v.edits.clone(),
                    can_undo: !v.steps.is_empty(),
                    error: v.error.clone(),
                }
            })
            .collect();
        out.extend(self.texts.iter().map(|t| {
            let file = self.source(t.source).map(|s| s.name.clone()).unwrap_or_default();
            VariableInfo {
                name: t.name.clone(),
                len: t.values.len(),
                source: format!("{file} · {} (text)", t.column),
                source_id: Some(t.source),
                kind: "text".into(),
                formula: None,
                min: None,
                max: None,
                is_time: false,
                edits: vec![],
                can_undo: false,
                error: None,
            }
        }));
        out
    }

    pub fn source_info(&self) -> Vec<SourceInfo> {
        self.sources
            .iter()
            .map(|s| {
                let finite: Vec<f64> = s.time.iter().copied().filter(|t| t.is_finite()).collect();
                let start = finite.iter().copied().reduce(f64::min);
                let end = finite.iter().copied().reduce(f64::max);
                SourceInfo {
                    id: s.id,
                    name: s.name.clone(),
                    path: s.path.clone(),
                    rows: s.n_rows,
                    time_var: s.time_var.clone(),
                    origin: s.origin,
                    offset: s.offset,
                    row_step: s.row_step,
                    time_scale: s.time_scale,
                    start,
                    duration: match (start, end) {
                        (Some(a), Some(b)) => b - a,
                        _ => 0.0,
                    },
                    sample_rate: sample_rate_of(&s.time),
                }
            })
            .collect()
    }

    /// Variables with at least one step (shown as "edited").
    pub fn edited_names(&self) -> Vec<String> {
        self.vars.iter().filter(|v| !v.steps.is_empty()).map(|v| v.name.clone()).collect()
    }

    // -- Recipes --------------------------------------------------------------

    /// Steps of the given variables (or all) keyed by column name, plus derived variables
    /// with formulas written over column names. Manual point picks are left out.
    pub fn make_recipe(&self, name: &str, only: Option<&[String]>) -> Recipe {
        let wanted = |n: &str| only.is_none_or(|o| o.iter().any(|x| x == n));
        let mut columns: Vec<RecipeColumn> = Vec::new();
        let mut derived = Vec::new();
        let mut names: HashMap<String, String> = HashMap::new();
        for v in &self.vars {
            match &v.kind {
                Kind::Imported { column, .. } => {
                    names.insert(v.name.clone(), column.clone());
                    let steps: Vec<Edit> = v.steps.iter().filter(|s| !s.is_manual()).cloned().collect();
                    if wanted(&v.name) && !steps.is_empty() && !columns.iter().any(|c| &c.column == column) {
                        columns.push(RecipeColumn { column: column.clone(), steps });
                    }
                }
                Kind::Derived { formula } => {
                    if wanted(&v.name) {
                        derived.push(RecipeDerived {
                            name: v.name.clone(),
                            formula: rename_refs(formula, &|n| names.get(n).cloned()),
                            steps: v.steps.iter().filter(|s| !s.is_manual()).cloned().collect(),
                        });
                    }
                    names.insert(v.name.clone(), v.name.clone());
                }
            }
        }
        Recipe { name: name.into(), columns, derived }
    }

    /// Applies a recipe to the variables of one source (or every source). Steps that do not
    /// apply are skipped and reported.
    pub fn apply_recipe(&mut self, recipe: &Recipe, source: Option<u32>) -> Vec<String> {
        let mut warnings = Vec::new();
        let targets: Vec<(String, String, u32)> = self
            .vars
            .iter()
            .filter_map(|v| match &v.kind {
                Kind::Imported { source: s, column } if source.is_none_or(|x| x == *s) => Some((v.name.clone(), column.clone(), *s)),
                _ => None,
            })
            .collect();
        for rc in &recipe.columns {
            for (name, _, _) in targets.iter().filter(|(_, c, _)| c == &rc.column) {
                for step in &rc.steps {
                    if let Err(e) = self.edit_local(name, step.clone()) {
                        warnings.push(format!("{name}: {e}"));
                    }
                }
            }
        }
        let sources: Vec<Option<u32>> = match source {
            Some(s) => vec![Some(s)],
            None => vec![None],
        };
        for s in sources {
            let suffix = s.and_then(|id| self.source(id)).and_then(|x| x.suffix.clone());
            let named = |n: &str| match &suffix {
                Some(sfx) => format!("{n} · {sfx}"),
                None => n.to_string(),
            };
            for rd in &recipe.derived {
                let name = named(&rd.name);
                if self.exists(&name) {
                    warnings.push(format!("'{name}' already exists; derived variable skipped."));
                    continue;
                }
                let formula = rename_refs(&rd.formula, &|n| {
                    if recipe.derived.iter().any(|d| d.name == n) {
                        return Some(named(n));
                    }
                    targets.iter().find(|(_, c, src)| c == n && s.is_none_or(|x| x == *src)).map(|(name, _, _)| name.clone())
                });
                let name = self.add_var(&name, Kind::Derived { formula }, vec![]);
                self.get_mut(&name).unwrap().steps = rd.steps.clone();
            }
        }
        warnings
    }

    /// Adds a step given in the variable's own time base (recipes and projects).
    fn edit_local(&mut self, name: &str, edit: Edit) -> Result<(), String> {
        self.push_step(name, edit)
    }

    // -- Projects -------------------------------------------------------------

    pub fn to_project(&self) -> Project {
        Project {
            version: 1,
            align: self.align,
            grid_step: self.grid_step,
            sources: self
                .sources
                .iter()
                .map(|s| ProjectSource {
                    id: s.id,
                    path: s.path.clone(),
                    sheet: s.sheet.clone(),
                    options: s.options.clone(),
                    offset: s.offset,
                    suffix: s.suffix.clone(),
                    time_var: s.time_var.clone(),
                    row_step: s.row_step,
                    time_scale: s.time_scale,
                })
                .collect(),
            variables: self
                .vars
                .iter()
                .map(|v| ProjectVariable {
                    name: v.name.clone(),
                    kind: match &v.kind {
                        Kind::Imported { source, column } => ProjectKind::Imported { source: *source, column: column.clone() },
                        Kind::Derived { formula } => ProjectKind::Derived { formula: formula.clone() },
                    },
                    steps: v.steps.clone(),
                })
                .chain(self.texts.iter().map(|t| ProjectVariable {
                    name: t.name.clone(),
                    kind: ProjectKind::Text { source: t.source, column: t.column.clone() },
                    steps: vec![],
                }))
                .collect(),
            auto_recipe: self.auto_recipe.clone(),
        }
    }

    /// Rebuilds a workspace from a project by re-reading its files. Files are looked up at
    /// their saved path, then next to the project file. Problems are reported, not fatal.
    pub fn from_project(project: &Project, project_dir: Option<&Path>) -> (Workspace, Vec<String>) {
        let mut ws = Workspace { align: project.align, grid_step: project.grid_step, ..Default::default() };
        let mut warnings = Vec::new();
        for ps in &project.sources {
            let mut path = std::path::PathBuf::from(&ps.path);
            if !path.exists() {
                if let Some(alt) = project_dir.map(|d| d.join(file_name(&ps.path))).filter(|p| p.exists()) {
                    path = alt;
                }
            }
            let path_str = path.to_string_lossy().into_owned();
            let parsed = match parse_file_with(&path, ps.sheet.as_deref(), &ps.options) {
                Ok(p) => p,
                Err(e) => {
                    warnings.push(format!("{}: {e}", file_name(&ps.path)));
                    continue;
                }
            };
            let n_rows = parsed.n_rows;
            let time = parsed.time.clone().unwrap_or_else(|| (0..n_rows).map(|i| i as f64).collect());
            ws.sources.push(Source {
                id: ps.id,
                name: match &ps.sheet {
                    Some(s) => format!("{} [{s}]", file_name(&path_str)),
                    None => file_name(&path_str),
                },
                path: path_str,
                sheet: ps.sheet.clone(),
                options: ps.options.clone(),
                n_rows,
                time: Arc::new(time.iter().map(|t| t * ps.time_scale.max(f64::MIN_POSITIVE)).collect()),
                origin: parsed.time_origin,
                time_column: parsed.time_column.clone(),
                time_var: None,
                offset: ps.offset,
                row_step: ps.row_step.filter(|k| *k > 0.0 && k.is_finite()),
                time_scale: if ps.time_scale > 0.0 && ps.time_scale.is_finite() { ps.time_scale } else { 1.0 },
                suffix: ps.suffix.clone(),
            });
            ws.next_source = ws.next_source.max(ps.id + 1);
            for pv in &project.variables {
                match &pv.kind {
                    ProjectKind::Imported { source, column } if *source == ps.id => {
                        let data = if parsed.time_column.as_deref() == Some(column.as_str()) {
                            Some(time.clone())
                        } else {
                            parsed.columns.iter().find(|(c, _)| c == column).map(|(_, v)| v.clone())
                        };
                        match data {
                            Some(d) => {
                                let d = Arc::new(d);
                                ws.vars.push(Variable {
                                    name: pv.name.clone(),
                                    kind: Kind::Imported { source: *source, column: column.clone() },
                                    original: d.clone(),
                                    data: d,
                                    steps: vec![],
                                    edits: vec![],
                                    error: None,
                                    time: None,
                                });
                            }
                            None => warnings.push(format!("{}: column '{column}' is missing.", file_name(&ps.path))),
                        }
                    }
                    ProjectKind::Text { source, column } if *source == ps.id => {
                        if let Some((_, v)) = parsed.text_columns.iter().find(|(c, _)| c == column) {
                            ws.texts.push(TextVariable { name: pv.name.clone(), source: *source, column: column.clone(), values: Arc::new(v.clone()) });
                        }
                    }
                    _ => {}
                }
            }
        }
        // Derived variables keep their place in the order; steps are replayed afterwards.
        let mut ordered = Vec::new();
        for pv in &project.variables {
            match &pv.kind {
                ProjectKind::Derived { formula } => {
                    ws.vars.push(Variable {
                        name: pv.name.clone(),
                        kind: Kind::Derived { formula: formula.clone() },
                        original: Arc::default(),
                        data: Arc::default(),
                        steps: pv.steps.clone(),
                        edits: vec![],
                        error: None,
                        time: None,
                    });
                    ordered.push(pv.name.clone());
                }
                ProjectKind::Imported { .. } if ws.get(&pv.name).is_some() => ordered.push(pv.name.clone()),
                _ => {}
            }
        }
        ws.vars.sort_by_key(|v| ordered.iter().position(|n| n == &v.name).unwrap_or(usize::MAX));
        for pv in &project.variables {
            if let ProjectKind::Imported { .. } = pv.kind {
                if ws.get(&pv.name).is_none() {
                    continue;
                }
                for step in &pv.steps {
                    if let Err(e) = ws.edit_local(&pv.name, step.clone()) {
                        warnings.push(format!("{}: {e}", pv.name));
                    }
                }
            }
        }
        for ps in &project.sources {
            if let Some(tv) = &ps.time_var {
                if let Err(e) = ws.set_time(tv, true) {
                    warnings.push(format!("{tv}: {e}"));
                }
            }
        }
        ws.auto_recipe = project.auto_recipe.clone();
        (ws, warnings)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write(name: &str, content: &str) -> String {
        let p = std::env::temp_dir().join(format!("da_ws_{}_{name}", std::process::id()));
        std::fs::File::create(&p).unwrap().write_all(content.as_bytes()).unwrap();
        p.to_string_lossy().into_owned()
    }

    fn import(ws: &mut Workspace, path: &str, cols: &[&str]) -> Vec<String> {
        let cols: Vec<String> = cols.iter().map(|c| c.to_string()).collect();
        ws.import(path, None, &ImportOptions::default(), &cols, None).unwrap().0
    }

    #[test]
    fn editing_one_signal_reuses_the_others() {
        let a = write("cache_a.csv", "time,a\n0,0\n1,10\n2,20\n3,30\n");
        let b = write("cache_b.csv", "time,b\n0,5\n0.5,6\n1,7\n1.5,8\n2,9\n2.5,10\n3,11\n");
        let mut ws = Workspace::default();
        import(&mut ws, &a, &["time", "a"]);
        import(&mut ws, &b, &["time", "b"]);
        let first = ws.to_dataset("Workspace").unwrap();
        ws.edit("a", Edit::Offset(1.0)).unwrap();
        let second = ws.to_dataset("Workspace").unwrap();
        assert!(Arc::ptr_eq(&first.get_signal("b").unwrap(), &second.get_signal("b").unwrap()), "b was not touched, so it is not recomputed");
        assert!(Arc::ptr_eq(&first.time, &second.time), "the grid is reused");
        assert_ne!(first.get_signal("a").unwrap()[0], second.get_signal("a").unwrap()[0]);
        // The shared build agrees with the plain one.
        let plain = ws.to_parse().unwrap();
        for (name, values) in &plain.columns {
            let shared = second.get_signal(name).unwrap();
            assert_eq!(values.len(), shared.len());
            for (x, y) in values.iter().zip(shared.iter()) {
                assert!(x == y || (x.is_nan() && y.is_nan()), "{name} differs");
            }
        }
        std::fs::remove_file(a).ok();
        std::fs::remove_file(b).ok();
    }

    #[test]
    fn a_step_with_nothing_to_do_passes_through_when_replayed() {
        let a = write("idle.csv", "time,x\n0,1\n1,2\n2,3\n3,4\n");
        let mut ws = Workspace::default();
        import(&mut ws, &a, &["time", "x"]);
        assert!(ws.edit("x", Edit::FillGaps).is_err(), "adding it interactively still reports why");
        ws.edit("x", Edit::Offset(1.0)).unwrap();
        ws.get_mut("x").unwrap().steps.insert(0, Edit::FillGaps);
        ws.rebuild_var("x").unwrap();
        let p = ws.pipeline("x").unwrap();
        assert!(p.stages[0].label.contains("nothing to do"));
        assert_eq!(ws.get("x").unwrap().data[0], 2.0);
        // Deleting the step that made it meaningful no longer breaks the pipeline.
        ws.remove_step("x", 1).unwrap();
        std::fs::remove_file(a).ok();
    }

    #[test]
    fn a_conversion_factor_replaces_the_time_column() {
        let a = write("step.csv", "time,x\n0,1\n5,2\n10,3\n15,4\n");
        let mut ws = Workspace::default();
        import(&mut ws, &a, &["time", "x"]);
        assert_eq!(ws.time_map(0, Some(4), None).unwrap().time, 15.0, "from the time column");
        ws.set_row_step(0, Some(0.01)).unwrap();
        assert!((ws.time_map(0, Some(4), None).unwrap().time - 0.03).abs() < 1e-12, "from the factor");
        assert!(ws.sources[0].time_var.is_none());
        assert!(ws.set_row_step(0, Some(0.0)).is_err());
        ws.set_row_step(0, None).unwrap();
        assert_eq!(ws.time_map(0, Some(4), None).unwrap().time, 15.0, "back to the time column");
        std::fs::remove_file(a).ok();
    }

    #[test]
    fn a_100_hz_and_a_10_hz_file_end_up_the_same_length() {
        let force: String = std::iter::once("time,force\n".to_string()).chain((0..1000).map(|i| format!("{},{}\n", i as f64 * 0.01, i))).collect();
        let sensor: String = std::iter::once("time,sensor\n".to_string()).chain((0..100).map(|i| format!("{},{}\n", i as f64 * 0.1, i))).collect();
        let (f, s) = (write("hz100.csv", &force), write("hz10.csv", &sensor));
        let mut ws = Workspace::default();
        import(&mut ws, &f, &["time", "force"]);
        import(&mut ws, &s, &["time", "sensor"]);
        let fine = ws.to_parse().unwrap();
        assert_eq!(fine.columns[0].1.len(), fine.columns[1].1.len(), "one shared grid either way");
        // The slower file's step: the 100 Hz signal is averaged down to the 10 Hz grid.
        ws.set_align(Align::Time, Some(0.1)).unwrap();
        let p = ws.to_parse().unwrap();
        let (a, b) = (&p.columns[0].1, &p.columns[1].1);
        assert_eq!(a.len(), b.len());
        assert!((99..=100).contains(&a.len()), "{} rows", a.len());
        let mid = a.len() / 2;
        assert!((a[mid] - mid as f64 * 10.0).abs() < 6.0, "the 100 Hz signal is the average of its block, not a single sample");
        std::fs::remove_file(f).ok();
        std::fs::remove_file(s).ok();
    }

    #[test]
    fn a_time_column_in_minutes_can_be_read_as_minutes() {
        let a = write("minutes.csv", "time,x\n0,1\n1,2\n2,3\n3,4\n");
        let mut ws = Workspace::default();
        import(&mut ws, &a, &["time", "x"]);
        assert_eq!(ws.time_map(0, Some(3), None).unwrap().time, 2.0, "read as seconds");
        ws.set_time_unit(0, 60.0).unwrap();
        assert_eq!(ws.time_map(0, Some(3), None).unwrap().time, 120.0, "read as minutes");
        assert!(ws.set_time_unit(0, 0.0).is_err());
        // The unit survives saving and opening a project.
        let (mut reopened, warnings) = Workspace::from_project(&ws.to_project(), None);
        assert!(warnings.is_empty(), "{warnings:?}");
        reopened.to_parse();
        assert_eq!(reopened.time_map(0, Some(3), None).unwrap().time, 120.0);
        std::fs::remove_file(a).ok();
    }

    fn ramp_file(name: &str, rows: usize, dt: f64) -> String {
        let body: String = (0..rows).map(|i| format!("{},{}\n", i as f64 * dt, i as f64 * dt * 10.0)).collect();
        write(name, &format!("time,x\n{body}"))
    }

    #[test]
    fn downsample_gives_a_shorter_signal_with_its_own_rows() {
        let f = ramp_file("ds_a.csv", 10, 1.0);
        let mut ws = Workspace::default();
        import(&mut ws, &f, &["time", "x"]);
        ws.edit("x", Edit::Downsample(2.5)).unwrap();
        let v = ws.get("x").unwrap();
        assert_eq!(v.data.len(), 4, "10 rows / 2.5 = 4 rows, exactly");
        assert_eq!(v.original.len(), 10, "the imported values are untouched");
        let t = ws.local_time(v);
        assert_eq!(t.len(), 4, "one time per row");
        // Blocks [0,2) [2,5) [5,7) [7,10): the mean sits at the block's middle row.
        assert_eq!(t.as_slice(), &[1.0, 3.0, 6.0, 8.0]);
        let expect = [5.0, 30.0, 55.0, 80.0]; // means of x = 10·t over each block
        for (a, b) in v.data.iter().zip(expect) {
            assert!((a - b).abs() < 1e-9, "{a} vs {b}");
        }
        assert_eq!(ws.info().iter().find(|i| i.name == "x").unwrap().len, 4, "the list shows the new length");
        std::fs::remove_file(f).ok();
    }

    #[test]
    fn steps_after_a_downsample_work_on_the_new_rows() {
        let f = ramp_file("ds_b.csv", 1000, 0.01);
        let mut ws = Workspace::default();
        import(&mut ws, &f, &["time", "x"]);
        ws.edit("x", Edit::Downsample(10.0)).unwrap();
        // Later steps see the new sample rate: 100 Hz / 10 = 10 Hz.
        let rate = sample_rate_of(&ws.local_time(ws.get("x").unwrap()));
        assert!((rate - 10.0).abs() < 1e-6, "{rate} Hz");
        let lp = |c: f64| {
            let mut p = serde_json::Map::new();
            p.insert("cutoff".into(), serde_json::json!(c));
            p.insert("order".into(), serde_json::json!(2));
            Edit::Filter(FilterStep { filter_type: crate::core::filters::FilterType::Lowpass, params: p, enabled: true })
        };
        ws.edit("x", lp(1.0)).unwrap();
        // A range is given in time and cuts the downsampled rows.
        ws.edit("x", Edit::ClearRange((0.0, 2.0))).unwrap();
        let v = ws.get("x").unwrap();
        let t = ws.local_time(v);
        assert_eq!((v.data.len(), t.len()), (100, 100));
        assert!(v.data.iter().zip(t.iter()).all(|(y, t)| (*t > 2.0) == y.is_finite() || *t <= 2.0 && !y.is_finite()), "rows up to 2 s are missing");
        // The pipeline view reports the rows after each block.
        let p = ws.pipeline("x").unwrap();
        assert_eq!(p.rows, 100);
        assert_eq!(p.stages[0].rows, 100);
        std::fs::remove_file(f).ok();
    }

    #[test]
    fn undo_and_reset_bring_the_rows_back() {
        let f = ramp_file("ds_c.csv", 40, 1.0);
        let mut ws = Workspace::default();
        import(&mut ws, &f, &["time", "x"]);
        ws.edit("x", Edit::Downsample(4.0)).unwrap();
        assert_eq!(ws.get("x").unwrap().data.len(), 10);
        ws.undo("x").unwrap();
        let v = ws.get("x").unwrap();
        assert_eq!((v.data.len(), ws.local_time(v).len()), (40, 40));
        ws.edit("x", Edit::Downsample(4.0)).unwrap();
        ws.reset("x").unwrap();
        assert_eq!(ws.get("x").unwrap().data.len(), 40);
        // Deleting the step from the middle of a pipeline re-runs the rest on the right rows.
        ws.edit("x", Edit::Downsample(2.0)).unwrap();
        ws.edit("x", Edit::Offset(1.0)).unwrap();
        ws.remove_step("x", 0).unwrap();
        assert_eq!(ws.get("x").unwrap().data.len(), 40);
        std::fs::remove_file(f).ok();
    }

    #[test]
    fn a_downsampled_signal_is_saved_and_reopened_with_its_rows() {
        let f = ramp_file("ds_d.csv", 60, 1.0);
        let mut ws = Workspace::default();
        import(&mut ws, &f, &["time", "x"]);
        ws.edit("x", Edit::Downsample(3.0)).unwrap();
        let (reopened, warnings) = Workspace::from_project(&ws.to_project(), None);
        assert!(warnings.is_empty(), "{warnings:?}");
        let (a, b) = (ws.get("x").unwrap(), reopened.get("x").unwrap());
        assert_eq!(b.data.len(), 20);
        assert_eq!(a.data.as_slice(), b.data.as_slice());
        assert_eq!(ws.local_time(a).as_slice(), reopened.local_time(b).as_slice());
        std::fs::remove_file(f).ok();
    }

    #[test]
    fn a_downsampled_signal_lines_up_with_a_faster_file_on_the_grid() {
        // x = 10·t at 100 Hz, downsampled by 4, next to a 30 Hz file: the two files' grid is the fine one.
        let f = ramp_file("ds_e.csv", 400, 0.01);
        let g = ramp_file("ds_e2.csv", 120, 1.0 / 30.0);
        let mut ws = Workspace::default();
        import(&mut ws, &f, &["time", "x"]);
        let names = ws.import(&g, None, &ImportOptions::default(), &["x".to_string()], None).unwrap().0;
        ws.edit("x", Edit::Downsample(4.0)).unwrap();
        let p = ws.to_parse().unwrap();
        let col = &p.columns.iter().find(|(n, _)| n == "x").unwrap().1;
        let t = p.time.as_ref().unwrap();
        // Between its first and last kept rows the line is the ramp itself.
        let checked = col.iter().zip(t.iter()).filter(|(y, t)| y.is_finite() && **t > 0.1 && **t < 3.8).count();
        assert!(checked > 300, "{checked} rows");
        for (y, t) in col.iter().zip(t.iter()).filter(|(y, t)| y.is_finite() && **t > 0.1 && **t < 3.8) {
            assert!((y - 10.0 * t).abs() < 0.2, "x({t}) = {y}");
        }
        assert_eq!(names.len(), 1);
        std::fs::remove_file(f).ok();
        std::fs::remove_file(g).ok();
    }

    #[test]
    fn by_row_alignment_counts_the_new_rows() {
        let f = ramp_file("ds_f.csv", 12, 1.0);
        let mut ws = Workspace::default();
        import(&mut ws, &f, &["time", "x"]);
        ws.edit("x", Edit::Downsample(3.0)).unwrap();
        ws.set_align(Align::Row, None).unwrap();
        let p = ws.to_parse().unwrap();
        let col = &p.columns[0].1;
        assert_eq!(col.iter().filter(|y| y.is_finite()).count(), 4, "rows 1 to 4 hold the signal");
        assert!(col[..4].iter().all(|y| y.is_finite()) && col[4..].iter().all(|y| y.is_nan()));
        std::fs::remove_file(f).ok();
    }

    #[test]
    fn downsample_refuses_bad_factors_and_formula_signals() {
        let f = ramp_file("ds_g.csv", 20, 1.0);
        let mut ws = Workspace::default();
        import(&mut ws, &f, &["time", "x"]);
        for bad in [1.0, 0.5, -2.0, f64::NAN, 1.01] {
            assert!(ws.edit("x", Edit::Downsample(bad)).is_err(), "factor {bad}");
        }
        assert_eq!(ws.get("x").unwrap().data.len(), 20, "a refused step changes nothing");
        ws.add_derived("y", "x * 2").unwrap();
        assert!(ws.edit("y", Edit::Downsample(2.0)).is_err());
        std::fs::remove_file(f).ok();
    }

    #[test]
    fn downsample_averages_around_missing_values() {
        let v = vec![1.0, f64::NAN, 3.0, f64::NAN, f64::NAN, f64::NAN, 7.0, 9.0];
        let (out, _) = Edit::Downsample(2.0).apply(&v, &[0.0; 8]).unwrap();
        assert_eq!(out.len(), 4);
        assert_eq!(out[0], 1.0);
        assert_eq!(out[1], 3.0);
        assert!(out[2].is_nan(), "a block with nothing valid stays missing");
        assert_eq!(out[3], 8.0);
    }

    #[test]
    fn rows_map_to_time_and_back() {
        let a = write("map.csv", "time,x\n0,1\n0.5,2\n1.0,3\n1.5,4\n");
        let mut ws = Workspace::default();
        import(&mut ws, &a, &["time", "x"]);
        let m = ws.time_map(0, Some(3), None).unwrap();
        assert_eq!((m.row, m.rows, m.time), (3, 4, 1.0));
        assert_eq!(ws.time_map(0, None, Some(1.4)).unwrap().row, 4);
        assert_eq!(ws.time_map(0, Some(99), None).unwrap().row, 4, "rows are clamped to the file");
        std::fs::remove_file(a).ok();
    }

    #[test]
    fn single_source_keeps_its_own_time() {
        let a = write("one.csv", "time,x,state\n0,1,on\n0.5,2,on\n1.0,3,off\n");
        let mut ws = Workspace::default();
        assert_eq!(import(&mut ws, &a, &["time", "x", "state"]), vec!["time", "x", "state"]);
        let p = ws.to_parse().unwrap();
        assert_eq!(p.time.as_deref(), Some(&[0.0, 0.5, 1.0][..]));
        assert_eq!(p.columns, vec![("x".to_string(), vec![1.0, 2.0, 3.0])]);
        assert_eq!(p.text_columns[0].1, vec!["on", "on", "off"]);
        assert!(ws.info().iter().any(|v| v.name == "time" && v.is_time));
        std::fs::remove_file(a).ok();
    }

    #[test]
    fn sources_align_on_a_common_time_grid() {
        // Same signal logged at 1 Hz and 2 Hz, the second starting 1 s later.
        let a = write("slow.csv", "time,a\n0,0\n1,10\n2,20\n3,30\n");
        let b = write("fast.csv", "time,b\n1,100\n1.5,105\n2,110\n2.5,115\n3,120\n");
        let mut ws = Workspace::default();
        import(&mut ws, &a, &["time", "a"]);
        import(&mut ws, &b, &["time", "b"]);
        let p = ws.to_parse().unwrap();
        assert_eq!(p.time.as_ref().unwrap(), &vec![0.0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0]);
        let a_on_grid = &p.columns[0].1;
        assert_eq!(a_on_grid[1], 5.0, "a interpolated between its samples");
        assert!(p.columns[1].1[0].is_nan(), "b missing before it starts");
        assert_eq!(p.columns[1].1[3], 105.0);
        // Shifting the second source by -1 s lines up both starts.
        ws.set_offset(1, -1.0).unwrap();
        let p = ws.to_parse().unwrap();
        assert_eq!(p.columns[1].1[0], 100.0);
        // Row alignment restores the legacy behaviour.
        ws.set_align(Align::Row, None).unwrap();
        let p = ws.to_parse().unwrap();
        assert_eq!(p.n_rows, 5);
        assert_eq!(p.columns[0].1[0], 0.0);
        assert_eq!(p.columns[1].1[0], 100.0);
        std::fs::remove_file(a).ok();
        std::fs::remove_file(b).ok();
    }

    #[test]
    fn coarser_grid_averages_instead_of_aliasing() {
        // +1/−1 at 10 Hz is pure Nyquist content; resampled to 5 Hz it must average out.
        let t: Vec<f64> = (0..100).map(|i| i as f64 * 0.1).collect();
        let v: Vec<f64> = (0..100).map(|i| if i % 2 == 0 { 1.0 } else { -1.0 }).collect();
        let grid: Vec<f64> = (1..49).map(|i| i as f64 * 0.2 + 0.05).collect();
        let out = interp_onto(&t, &v, &grid);
        assert!(out.iter().all(|x| x.abs() < 1e-9), "{out:?}");
        // A finer grid still interpolates.
        let fine = interp_onto(&t, &v, &[0.05]);
        assert!(fine[0].abs() < 1e-9 && interp_onto(&t, &v, &[0.0, 0.025])[1] == 0.5);
    }

    #[test]
    fn interpolation_does_not_bridge_logging_gaps() {
        let t = [0.0, 1.0, 2.0, 10.0, 11.0];
        let v = [0.0, 1.0, 2.0, 10.0, 11.0];
        let out = interp_onto(&t, &v, &[0.5, 5.0, 10.5, 12.0]);
        assert_eq!(out[0], 0.5);
        assert!(out[1].is_nan() && out[3].is_nan());
        assert_eq!(out[2], 10.5);
    }

    #[test]
    fn pipeline_steps_undo_and_filters() {
        let a = write("pipe.csv", &format!("time,s\n{}", (0..200).map(|i| format!("{},{}\n", i as f64 * 0.01, if i == 50 { 9.0 } else { (i as f64 * 0.05).sin() })).collect::<String>()));
        let mut ws = Workspace::default();
        import(&mut ws, &a, &["time", "s"]);
        ws.edit("s", Edit::Despike(4.0)).unwrap();
        assert!(ws.get("s").unwrap().data[50].is_nan());
        ws.edit("s", Edit::FillGaps).unwrap();
        ws.edit("s", Edit::ClearRange((0.0, 0.045))).unwrap();
        assert!(ws.get("s").unwrap().data[..5].iter().all(|x| x.is_nan()) && ws.get("s").unwrap().data[5].is_finite());
        ws.edit("s", Edit::ClearPoints(vec![1.0, 1.5])).unwrap();
        assert!(ws.get("s").unwrap().data[100].is_nan() && ws.get("s").unwrap().data[150].is_nan());
        let step: FilterStep = serde_json::from_value(serde_json::json!({"filter_type": "lowpass", "params": {"cutoff": 5.0, "order": 2}})).unwrap();
        ws.edit("s", Edit::Filter(step)).unwrap();
        assert_eq!(ws.get("s").unwrap().edits.len(), 5);
        assert!(ws.get("s").unwrap().edits[4].starts_with("filter:"));
        ws.remove_filters("s").unwrap();
        assert_eq!(ws.get("s").unwrap().steps.len(), 4);
        ws.undo("s").unwrap();
        assert!(ws.get("s").unwrap().data[100].is_finite());
        ws.reset("s").unwrap();
        assert_eq!(ws.get("s").unwrap().data[50], 9.0);
        assert!(ws.undo("s").is_err());
        std::fs::remove_file(a).ok();
    }

    #[test]
    fn derived_variables_follow_renames_and_edits() {
        let a = write("power.csv", "time,Voltage [V],I\n0,10,1\n1,10,2\n2,12,2\n");
        let mut ws = Workspace::default();
        import(&mut ws, &a, &["time", "Voltage [V]", "I"]);
        ws.to_parse();
        ws.add_derived("P", "\"Voltage [V]\" * I").unwrap();
        let p = ws.to_parse().unwrap();
        assert_eq!(p.columns.iter().find(|(c, _)| c == "P").unwrap().1, vec![10.0, 20.0, 24.0]);
        ws.rename("I", "Current").unwrap();
        assert_eq!(ws.get("P").unwrap().kind, Kind::Derived { formula: "\"Voltage [V]\" * Current".into() });
        ws.edit("Current", Edit::Scale(2.0)).unwrap();
        let p = ws.to_parse().unwrap();
        assert_eq!(p.columns.iter().find(|(c, _)| c == "P").unwrap().1, vec![20.0, 40.0, 48.0]);
        assert!(ws.add_derived("Q", "missing * 2").is_err());
        ws.add_derived("Q", "sqrt(P) + t").unwrap();
        ws.remove(&["Current".into()]);
        ws.to_parse();
        assert!(ws.get("P").unwrap().error.is_some(), "a removed input is reported");
        std::fs::remove_file(a).ok();
    }

    #[test]
    fn recipes_and_projects_replay_processing() {
        let a = write("run1.csv", "time,p,q\n0,1,5\n1,2,5\n2,3,5\n");
        let b = write("run2.csv", "time,p,q\n0,10,1\n1,20,1\n2,30,1\n");
        let mut ws = Workspace::default();
        import(&mut ws, &a, &["time", "p", "q"]);
        ws.edit("p", Edit::Offset(1.0)).unwrap();
        ws.edit("p", Edit::ClearPoints(vec![1.0])).unwrap();
        ws.to_parse();
        ws.add_derived("ratio", "p / q").unwrap();
        let recipe = ws.make_recipe("clean", None);
        assert_eq!(recipe.columns.len(), 1);
        assert_eq!(recipe.columns[0].steps.len(), 1, "manual point picks are not part of recipes");
        assert_eq!(recipe.derived[0].formula, "p / q");

        // Batch import with the recipe applied automatically.
        let mut runs = Workspace { auto_recipe: Some(recipe.clone()), ..Default::default() };
        let (added, warnings) = runs.import_batch(&[a.clone(), b.clone()], None);
        assert!(warnings.is_empty(), "{warnings:?}");
        assert!(added.contains(&format!("p · {}", file_stem(&b))));
        let ratio2 = format!("ratio · {}", file_stem(&b));
        runs.to_parse();
        assert_eq!(runs.get(&ratio2).unwrap().data.as_slice(), &[11.0, 21.0, 31.0]);

        // Project round trip.
        let json = serde_json::to_string(&ws.to_project()).unwrap();
        let project: Project = serde_json::from_str(&json).unwrap();
        let (mut reopened, warnings) = Workspace::from_project(&project, None);
        assert!(warnings.is_empty(), "{warnings:?}");
        assert_eq!(reopened.get("p").unwrap().edits, ws.get("p").unwrap().edits);
        reopened.to_parse();
        ws.to_parse();
        assert_eq!(format!("{:?}", reopened.get("ratio").unwrap().data), format!("{:?}", ws.get("ratio").unwrap().data));
        assert_eq!(evaluate("2e3 * x + 1.5E-1", &HashMap::from([("x".to_string(), Arc::new(vec![1.0]))]), &[0.0]).unwrap(), vec![2000.15]);
        std::fs::remove_file(a).ok();
        std::fs::remove_file(b).ok();
    }
}
