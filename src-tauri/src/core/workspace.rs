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
use super::dataset::sample_rate_of;
use super::filters::{apply_steps, FilterStep};

/// Upper bound on the common grid; longer spans get a coarser step.
const MAX_GRID: usize = 4_000_000;
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
}

fn median_of(v: &mut [f64]) -> f64 {
    v.sort_by(|a, b| a.total_cmp(b));
    let n = v.len();
    if n % 2 == 1 { v[n / 2] } else { (v[n / 2 - 1] + v[n / 2]) / 2.0 }
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
    let mut out = Vec::new();
    for i in 0..v.len() {
        if !v[i].is_finite() {
            continue;
        }
        let lo = i.saturating_sub(HAMPEL_HALF);
        let hi = (i + HAMPEL_HALF + 1).min(v.len());
        let mut win: Vec<f64> = v[lo..hi].iter().copied().filter(|x| x.is_finite()).collect();
        if win.len() < 3 {
            continue;
        }
        let med = median_of(&mut win);
        let mut dev: Vec<f64> = win.iter().map(|x| (x - med).abs()).collect();
        let sigma = (1.4826 * median_of(&mut dev)).max(noise);
        if sigma > 0.0 && (v[i] - med).abs() > k * sigma {
            out.push(i);
        }
    }
    out
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

/// Applies `steps` to `original` in order. Returns the result and one label per step.
pub fn replay(original: &[f64], steps: &[Edit], t: &[f64]) -> Result<(Vec<f64>, Vec<String>), String> {
    let mut data = original.to_vec();
    let mut labels = Vec::with_capacity(steps.len());
    for (i, s) in steps.iter().enumerate() {
        let (d, label) = s.apply(&data, t).map_err(|e| format!("Step {} failed: {e}", i + 1))?;
        data = d;
        labels.push(label);
    }
    Ok((data, labels))
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
    /// Name suffix for variables from batch imports ("Pressure · run3").
    pub suffix: Option<String>,
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

#[derive(Debug, Clone, Serialize)]
pub struct SourceInfo {
    pub id: u32,
    pub name: String,
    pub path: String,
    pub rows: usize,
    pub time_var: Option<String>,
    pub origin: Option<f64>,
    pub offset: f64,
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
    next_source: u32,
}

fn file_name(path: &str) -> String {
    Path::new(path).file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| path.to_string())
}

fn file_stem(path: &str) -> String {
    Path::new(path).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| path.to_string())
}

/// Linear interpolation of (t, v) onto `grid`. Samples further apart than three typical
/// intervals are not bridged; points outside the source span are missing.
pub fn interp_onto(t: &[f64], v: &[f64], grid: &[f64]) -> Vec<f64> {
    let mut order: Vec<usize> = (0..t.len().min(v.len())).filter(|&i| t[i].is_finite()).collect();
    if !order.windows(2).all(|w| t[w[0]] <= t[w[1]]) {
        order.sort_by(|&a, &b| t[a].total_cmp(&t[b]));
    }
    let mut out = vec![f64::NAN; grid.len()];
    if order.is_empty() {
        return out;
    }
    let mut steps: Vec<f64> = order.windows(2).map(|w| t[w[1]] - t[w[0]]).filter(|d| *d > 0.0).collect();
    let gap = if steps.is_empty() { f64::INFINITY } else { 3.0 * median_of(&mut steps) };
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

    /// Time base a variable's steps work in: its source's time, or the grid for derived ones.
    pub fn local_time(&self, v: &Variable) -> Arc<Vec<f64>> {
        match &v.kind {
            Kind::Imported { source, .. } => self.source(*source).map(|s| s.time.clone()).unwrap_or_default(),
            Kind::Derived { .. } => self.grid.clone(),
        }
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

    fn source_shift(&self, s: &Source) -> f64 {
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
        self.vars.push(Variable { name: name.clone(), kind, original: data.clone(), data, steps: vec![], edits: vec![], error: None });
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
        let t = self.local_time(v);
        let (data, labels) = replay(&v.original, &v.steps, &t)?;
        let v = self.get_mut(name)?;
        v.data = Arc::new(data);
        v.edits = labels;
        self.refresh_time(name);
        Ok(())
    }

    /// Keeps a source's time in step with its time variable.
    fn refresh_time(&mut self, name: &str) {
        let Some(v) = self.get(name) else { return };
        let data = v.data.clone();
        if let Some(s) = self.sources.iter_mut().find(|s| s.time_var.as_deref() == Some(name)) {
            if data.len() == s.n_rows {
                s.time = data;
            }
        }
    }

    /// Appends a step. `shift` converts times picked on the aligned axis to the variable's own time.
    pub fn edit(&mut self, name: &str, edit: Edit) -> Result<(), String> {
        let v = self.get(name).ok_or("Variable not found.")?;
        let edit = edit.shifted(-self.shift_of(v));
        let t = self.local_time(v);
        let (data, label) = edit.apply(&v.data, &t)?;
        let v = self.get_mut(name)?;
        v.data = Arc::new(data);
        v.steps.push(edit);
        v.edits.push(label);
        self.refresh_time(name);
        Ok(())
    }

    /// The values `edit` would produce, without adding it (live previews).
    pub fn preview(&self, name: &str, edit: &Edit) -> Result<Vec<f64>, String> {
        let v = self.get(name).ok_or("Variable not found.")?;
        let edit = edit.shifted(-self.shift_of(v));
        Ok(edit.apply(&v.data, &self.local_time(v))?.0)
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
                s.time = Arc::new((0..s.n_rows).map(|i| i as f64).collect());
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
            s.time = data;
            s.time_var = Some(name.to_string());
        } else if s.time_var.as_deref() == Some(name) {
            s.time_var = None;
            s.time = Arc::new((0..s.n_rows).map(|i| i as f64).collect());
            s.origin = None;
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

    /// Common grid for the current sources: a source's own time when only one is involved
    /// (or all share it), otherwise a uniform grid over the union at the finest step.
    fn make_grid(&self) -> Vec<f64> {
        let used: Vec<&Source> = self
            .sources
            .iter()
            .filter(|s| self.signal_vars().iter().any(|v| matches!(v.kind, Kind::Imported { source, .. } if source == s.id)))
            .collect();
        let used = if used.is_empty() { self.sources.iter().collect() } else { used };
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
                let t = self.effective_time(s);
                if t.as_slice() == self.grid.as_slice() {
                    return values.to_vec();
                }
                interp_onto(&t, values, &self.grid)
            }
        }
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
        self.grid = Arc::new(self.make_grid());
        let mut inputs: HashMap<String, Arc<Vec<f64>>> = HashMap::new();
        for i in 0..self.vars.len() {
            let v = &self.vars[i];
            match &v.kind {
                Kind::Imported { .. } => {
                    inputs.insert(v.name.clone(), Arc::new(self.aligned(v, false)));
                }
                Kind::Derived { formula } => {
                    let result = evaluate(formula, &inputs, &self.grid).and_then(|o| {
                        let (d, labels) = replay(&o, &v.steps, &self.grid)?;
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

    /// Row-aligned dataset of all signals on the common grid (None without numeric signals).
    pub fn to_parse(&mut self) -> Option<ParseResult> {
        self.refresh();
        let signals = self.signal_vars();
        if signals.is_empty() {
            return None;
        }
        let columns: Vec<(String, Vec<f64>)> = signals.iter().map(|v| (v.name.clone(), self.aligned(v, false))).collect();
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
        let v = self.get(name).ok_or("Variable not found.")?;
        let t = self.local_time(v);
        let (data, label) = edit.apply(&v.data, &t)?;
        let v = self.get_mut(name)?;
        v.data = Arc::new(data);
        v.steps.push(edit);
        v.edits.push(label);
        self.refresh_time(name);
        Ok(())
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
                time: Arc::new(time.clone()),
                origin: parsed.time_origin,
                time_column: parsed.time_column.clone(),
                time_var: None,
                offset: ps.offset,
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
