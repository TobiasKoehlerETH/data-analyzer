//! MATLAB-style variable workspace: columns imported from any number of files live
//! side by side as named vectors. The analysis dataset is built from it (row-aligned,
//! NaN-padded), with one optional variable acting as the time axis.

use serde::Serialize;
use serde_json::{Map, Value};
use std::path::Path;
use std::sync::Arc;

use super::csv_parser::{parse_file_with, ImportOptions, ParseResult};
use super::dataset::time_axis;

#[derive(Debug, Clone)]
pub struct Variable {
    pub name: String,
    pub data: Arc<Vec<f64>>,
    /// "file.csv · column" (sheet included for workbooks).
    pub source: String,
    /// Imported values, kept so edits can be reset.
    pub original: Arc<Vec<f64>>,
    /// Applied edits, in order (e.g. "offset +2", "normalize 0–1").
    pub edits: Vec<String>,
}

/// Value edits that can be applied to a variable.
#[derive(Debug, Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "snake_case", tag = "op", content = "value")]
pub enum Edit {
    Offset(f64),
    Scale(f64),
    Normalize,
    Zscore,
    Demean,
    ZeroStart,
    Invert,
    /// Keep every k-th point.
    Downsample(f64),
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

impl Edit {
    fn apply(&self, v: &[f64]) -> Result<(Vec<f64>, String), String> {
        let (mean, sd, lo, hi) = finite_stats(v);
        let map = |f: &dyn Fn(f64) -> f64| v.iter().map(|x| f(*x)).collect::<Vec<f64>>();
        Ok(match *self {
            Edit::Offset(c) => (map(&|x| x + c), format!("offset {c:+}")),
            Edit::Scale(k) => (map(&|x| x * k), format!("scale ×{k}")),
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
            Edit::Downsample(k) => {
                let k = k.round();
                if !(k >= 2.0) {
                    return Err("Downsample factor must be 2 or more.".into());
                }
                (v.iter().step_by(k as usize).copied().collect(), format!("downsample ÷{k}"))
            }
        })
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct VariableInfo {
    pub name: String,
    pub len: usize,
    pub source: String,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub is_time: bool,
    pub edits: Vec<String>,
}

#[derive(Default)]
pub struct Workspace {
    pub vars: Vec<Variable>,
    pub time_var: Option<String>,
}

fn file_name(path: &str) -> String {
    Path::new(path).file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| path.to_string())
}

impl Workspace {
    pub fn get(&self, name: &str) -> Option<&Variable> {
        self.vars.iter().find(|v| v.name == name)
    }

    fn unique_name(&self, base: &str) -> String {
        let base = if base.trim().is_empty() { "var" } else { base.trim() };
        if self.get(base).is_none() {
            return base.to_string();
        }
        (2..).map(|i| format!("{base} ({i})")).find(|n| self.get(n).is_none()).unwrap()
    }

    pub fn add(&mut self, name: &str, data: Vec<f64>, source: String) -> String {
        let name = self.unique_name(name);
        let data = Arc::new(data);
        self.vars.push(Variable { name: name.clone(), original: data.clone(), data, source, edits: vec![] });
        name
    }

    pub fn edit(&mut self, name: &str, edit: Edit) -> Result<(), String> {
        let v = self.vars.iter_mut().find(|v| v.name == name).ok_or("Variable not found.")?;
        let (data, label) = edit.apply(&v.data)?;
        v.data = Arc::new(data);
        v.edits.push(label);
        Ok(())
    }

    /// Back to the imported values.
    pub fn reset(&mut self, name: &str) -> Result<(), String> {
        let v = self.vars.iter_mut().find(|v| v.name == name).ok_or("Variable not found.")?;
        v.data = v.original.clone();
        v.edits.clear();
        Ok(())
    }

    pub fn duplicate(&mut self, name: &str) -> Result<String, String> {
        let v = self.get(name).ok_or("Variable not found.")?.clone();
        let new = self.unique_name(&format!("{name} copy"));
        self.vars.push(Variable { name: new.clone(), ..v });
        Ok(new)
    }

    pub fn remove(&mut self, names: &[String]) {
        self.vars.retain(|v| !names.contains(&v.name));
        if self.time_var.as_ref().map(|t| names.contains(t)).unwrap_or(false) {
            self.time_var = None;
        }
    }

    pub fn rename(&mut self, old: &str, new: &str) -> Result<(), String> {
        let new = new.trim();
        if new.is_empty() {
            return Err("Name cannot be empty.".into());
        }
        if old != new && self.get(new).is_some() {
            return Err(format!("A variable named '{new}' already exists."));
        }
        let v = self.vars.iter_mut().find(|v| v.name == old).ok_or("Variable not found.")?;
        v.name = new.to_string();
        if self.time_var.as_deref() == Some(old) {
            self.time_var = Some(new.to_string());
        }
        Ok(())
    }

    pub fn set_time(&mut self, name: Option<String>) -> Result<(), String> {
        if let Some(n) = &name {
            if self.get(n).is_none() {
                return Err("Variable not found.".into());
            }
        }
        self.time_var = name;
        Ok(())
    }

    pub fn info(&self) -> Vec<VariableInfo> {
        self.vars
            .iter()
            .map(|v| {
                let finite = v.data.iter().copied().filter(|x| x.is_finite());
                let (mut lo, mut hi) = (f64::INFINITY, f64::NEG_INFINITY);
                for x in finite {
                    lo = lo.min(x);
                    hi = hi.max(x);
                }
                VariableInfo {
                    name: v.name.clone(),
                    len: v.data.len(),
                    source: v.source.clone(),
                    min: lo.is_finite().then_some(lo),
                    max: hi.is_finite().then_some(hi),
                    is_time: self.time_var.as_deref() == Some(v.name.as_str()),
                    edits: v.edits.clone(),
                }
            })
            .collect()
    }

    /// Imports `columns` (preview header names) of one file as new variables.
    /// Returns the created variable names; the file's time column becomes the time axis
    /// when the workspace has none yet.
    pub fn import(&mut self, path: &str, sheet: Option<&str>, opts: &ImportOptions, columns: &[String]) -> Result<Vec<String>, String> {
        if columns.is_empty() {
            return Err("Tick at least one column to import.".into());
        }
        let parsed = parse_file_with(Path::new(path), sheet, opts)?;
        let time = time_axis(parsed.time.clone(), parsed.n_rows);
        let file = match sheet.or(parsed.sheet.as_deref()) {
            Some(s) => format!("{} [{s}]", file_name(path)),
            None => file_name(path),
        };
        let mut added = Vec::new();
        for col in columns {
            let (data, is_time) = if parsed.time_column.as_deref() == Some(col.as_str()) {
                (time.clone(), true)
            } else {
                match parsed.columns.iter().find(|(c, _)| c == col) {
                    Some((_, v)) => (v.clone(), false),
                    None => return Err(format!("Column '{col}' is not numeric (or not found) with the current import settings.")),
                }
            };
            let name = self.add(col, data, format!("{file} · {col}"));
            if is_time && self.time_var.is_none() {
                self.time_var = Some(name.clone());
            }
            added.push(name);
        }
        Ok(added)
    }

    /// Row-aligned dataset of all non-time variables (shorter vectors padded with NaN).
    pub fn to_parse(&self) -> Option<ParseResult> {
        let signals: Vec<&Variable> = self.vars.iter().filter(|v| Some(&v.name) != self.time_var.as_ref()).collect();
        if signals.is_empty() {
            return None;
        }
        let n_rows = self.vars.iter().map(|v| v.data.len()).max().unwrap_or(0);
        let pad = |d: &[f64]| {
            let mut v = d.to_vec();
            v.resize(n_rows, f64::NAN);
            v
        };
        let time = self.time_var.as_ref().and_then(|t| self.get(t)).map(|t| {
            // Extend a shorter time vector by its last step so every row has a time.
            let mut v = t.data.to_vec();
            let step = if v.len() >= 2 { v[v.len() - 1] - v[v.len() - 2] } else { 1.0 };
            while v.len() < n_rows {
                let last = v.last().copied().unwrap_or(-step);
                v.push(last + step);
            }
            v
        });
        let mut metadata = Map::new();
        metadata.insert(
            "variables".into(),
            Value::Array(self.vars.iter().map(|v| Value::String(format!("{} ← {}", v.name, v.source))).collect()),
        );
        Some(ParseResult {
            columns: signals.iter().map(|v| (v.name.clone(), pad(&v.data))).collect(),
            time_column: self.time_var.clone(),
            time,
            metadata,
            header_row: 0,
            delimiter: ',',
            encoding: "—".into(),
            is_raser_format: false,
            n_rows,
            delimiter_desc: "—".into(),
            file_type: "Workspace".into(),
            sheet: None,
        })
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

    #[test]
    fn import_from_several_files() {
        let a = write("a.csv", "junk\ntime,x,y,z\n0,1,10,5\n1,2,20,6\n2,3,30,7\n");
        let b = write("b.csv", "x,w\n100,7\n200,8\n300,9\n400,10\n");
        let mut ws = Workspace::default();
        let opts = ImportOptions { header_row: Some(1), ..Default::default() };
        let added = ws.import(&a, None, &opts, &["time".into(), "x".into(), "y".into(), "z".into()]).unwrap();
        assert_eq!(added, vec!["time", "x", "y", "z"]);
        assert_eq!(ws.time_var.as_deref(), Some("time"));
        let added = ws.import(&b, None, &ImportOptions::default(), &["x".into()]).unwrap();
        assert_eq!(added, vec!["x (2)"]);
        let p = ws.to_parse().unwrap();
        assert_eq!(p.n_rows, 4);
        assert_eq!(p.columns.len(), 4);
        assert!(p.columns[0].1[3].is_nan());
        assert_eq!(p.time.as_ref().unwrap(), &vec![0.0, 1.0, 2.0, 3.0]);
        ws.rename("x (2)", "x_b").unwrap();
        assert!(ws.rename("x_b", "y").is_err());
        ws.edit("x_b", Edit::Offset(-100.0)).unwrap();
        ws.edit("x_b", Edit::Normalize).unwrap();
        assert_eq!(ws.get("x_b").unwrap().data.as_slice(), &[0.0, 1.0 / 3.0, 2.0 / 3.0, 1.0]);
        assert_eq!(ws.get("x_b").unwrap().edits, vec!["offset -100", "normalize 0–1"]);
        ws.edit("x_b", Edit::Downsample(2.0)).unwrap();
        assert_eq!(ws.get("x_b").unwrap().data.len(), 2);
        ws.reset("x_b").unwrap();
        assert_eq!(ws.get("x_b").unwrap().data[0], 100.0);
        assert_eq!(ws.duplicate("x_b").unwrap(), "x_b copy");
        ws.remove(&["time".into()]);
        assert!(ws.time_var.is_none());
        assert!(ws.to_parse().unwrap().time.is_none());
        std::fs::remove_file(a).ok();
        std::fs::remove_file(b).ok();
    }
}
