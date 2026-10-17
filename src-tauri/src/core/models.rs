//! State-space model dataclasses and the model library (CRUD, JSON persistence, comparison).
//! The JSON layout is identical to the Python application so libraries are interchangeable.

use nalgebra::DMatrix;
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct OutputMetrics {
    pub name: String,
    #[serde(default)]
    pub rmse: f64,
    #[serde(default)]
    pub nrmse: f64,
    #[serde(default)]
    pub mae: f64,
    #[serde(default)]
    pub r_squared: f64,
    #[serde(default)]
    pub vaf: f64,
}

pub type Matrix = Vec<Vec<f64>>;

pub fn to_dmatrix(m: &Matrix, rows: usize, cols: usize) -> DMatrix<f64> {
    DMatrix::from_fn(rows, cols, |r, c| m.get(r).and_then(|row| row.get(c)).copied().unwrap_or(0.0))
}

pub fn from_dmatrix(m: &DMatrix<f64>) -> Matrix {
    (0..m.nrows()).map(|r| (0..m.ncols()).map(|c| m[(r, c)]).collect()).collect()
}

fn default_method() -> String {
    "N4SID".into()
}
fn default_one() -> usize {
    1
}
fn default_dt() -> f64 {
    1.0
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StateSpaceResult {
    pub name: String,
    #[serde(rename = "A")]
    pub a: Matrix,
    #[serde(rename = "B")]
    pub b: Matrix,
    #[serde(rename = "C")]
    pub c: Matrix,
    #[serde(rename = "D")]
    pub d: Matrix,
    pub input_names: Vec<String>,
    pub output_names: Vec<String>,
    #[serde(default = "default_method")]
    pub method: String,
    #[serde(default)]
    pub order: usize,
    #[serde(default = "default_one")]
    pub decimation_factor: usize,
    #[serde(default = "default_dt")]
    pub dt: f64,
    #[serde(default)]
    pub metrics: Vec<OutputMetrics>,
    #[serde(default)]
    pub timestamp: String,
}

pub fn now_iso() -> String {
    chrono::Local::now().format("%Y-%m-%dT%H:%M:%S%.6f").to_string()
}

impl StateSpaceResult {
    pub fn n_states(&self) -> usize {
        self.a.len()
    }
    pub fn n_inputs(&self) -> usize {
        self.input_names.len()
    }
    pub fn n_outputs(&self) -> usize {
        self.output_names.len()
    }
    pub fn best_vaf(&self) -> f64 {
        self.metrics.iter().map(|m| m.vaf).fold(None, |a: Option<f64>, v| Some(a.map_or(v, |a| a.max(v)))).unwrap_or(0.0)
    }
    pub fn mean_vaf(&self) -> f64 {
        if self.metrics.is_empty() {
            return 0.0;
        }
        self.metrics.iter().map(|m| m.vaf).sum::<f64>() / self.metrics.len() as f64
    }
    pub fn matrices(&self) -> (DMatrix<f64>, DMatrix<f64>, DMatrix<f64>, DMatrix<f64>) {
        let (n, m, l) = (self.n_states(), self.n_inputs(), self.n_outputs());
        (to_dmatrix(&self.a, n, n), to_dmatrix(&self.b, n, m), to_dmatrix(&self.c, l, n), to_dmatrix(&self.d, l, m))
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ModelSummary {
    pub name: String,
    pub method: String,
    pub order: usize,
    pub n_inputs: usize,
    pub n_outputs: usize,
    pub decimation_factor: usize,
    pub mean_vaf: f64,
    pub best_vaf: f64,
    pub timestamp: String,
}

impl From<&StateSpaceResult> for ModelSummary {
    fn from(m: &StateSpaceResult) -> Self {
        ModelSummary {
            name: m.name.clone(),
            method: m.method.clone(),
            order: m.order,
            n_inputs: m.n_inputs(),
            n_outputs: m.n_outputs(),
            decimation_factor: m.decimation_factor,
            mean_vaf: m.mean_vaf(),
            best_vaf: m.best_vaf(),
            timestamp: m.timestamp.clone(),
        }
    }
}

#[derive(Serialize, Deserialize)]
struct LibraryFile {
    #[serde(default)]
    models: Vec<StateSpaceResult>,
}

/// Ordered model collection (insertion order, unique names).
#[derive(Default)]
pub struct ModelLibrary {
    models: Vec<StateSpaceResult>,
}

impl ModelLibrary {
    pub fn models(&self) -> &[StateSpaceResult] {
        &self.models
    }

    pub fn names(&self) -> Vec<String> {
        self.models.iter().map(|m| m.name.clone()).collect()
    }

    pub fn get(&self, name: &str) -> Option<&StateSpaceResult> {
        self.models.iter().find(|m| m.name == name)
    }

    pub fn get_mut(&mut self, name: &str) -> Option<&mut StateSpaceResult> {
        self.models.iter_mut().find(|m| m.name == name)
    }

    /// Adds a model, renaming to `name_2`, `name_3`, … on collision. Returns the final name.
    pub fn add(&mut self, mut model: StateSpaceResult) -> String {
        if self.get(&model.name).is_some() {
            let base = model.name.clone();
            let mut i = 2;
            let mut name = base.clone();
            while self.get(&name).is_some() {
                name = format!("{base}_{i}");
                i += 1;
            }
            model.name = name;
        }
        let name = model.name.clone();
        self.models.push(model);
        name
    }

    pub fn remove(&mut self, name: &str) -> bool {
        let before = self.models.len();
        self.models.retain(|m| m.name != name);
        before != self.models.len()
    }

    pub fn rename(&mut self, old: &str, new: &str) -> bool {
        if self.get(new).is_some() || self.get(old).is_none() || new.is_empty() {
            return false;
        }
        if let Some(m) = self.get_mut(old) {
            m.name = new.to_string();
        }
        true
    }

    pub fn duplicate(&mut self, name: &str) -> Option<String> {
        let mut copy = self.get(name)?.clone();
        copy.name = format!("{name}_copy");
        Some(self.add(copy))
    }

    pub fn clear(&mut self) {
        self.models.clear();
    }

    pub fn save_library(&self, path: &Path) -> Result<(), String> {
        let file = LibraryFile { models: self.models.clone() };
        let s = serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?;
        std::fs::write(path, s).map_err(|e| format!("Cannot write {}: {e}", path.display()))
    }

    pub fn load_library(&mut self, path: &Path) -> Result<usize, String> {
        let s = std::fs::read_to_string(path).map_err(|e| format!("Cannot read {}: {e}", path.display()))?;
        let file: LibraryFile = serde_json::from_str(&s).map_err(|e| format!("Invalid model library: {e}"))?;
        self.models.clear();
        for m in file.models {
            // Python semantics: dict keyed by name, later entries overwrite earlier ones.
            self.models.retain(|x| x.name != m.name);
            self.models.push(m);
        }
        Ok(self.models.len())
    }

    /// Side-by-side comparison rows (ordered key/value pairs per model).
    pub fn compare(&self, names: &[String]) -> Vec<Vec<(String, String)>> {
        names
            .iter()
            .filter_map(|n| self.get(n))
            .map(|m| {
                let mut row = vec![
                    ("Name".to_string(), m.name.clone()),
                    ("Method".to_string(), m.method.clone()),
                    ("Order".to_string(), m.order.to_string()),
                    ("Inputs".to_string(), m.n_inputs().to_string()),
                    ("Outputs".to_string(), m.n_outputs().to_string()),
                    ("Decimation".to_string(), m.decimation_factor.to_string()),
                    ("Mean VAF".to_string(), format!("{:.2}%", m.mean_vaf())),
                    ("Best VAF".to_string(), format!("{:.2}%", m.best_vaf())),
                ];
                for om in &m.metrics {
                    row.push((format!("RMSE_{}", om.name), format!("{:.4}", om.rmse)));
                    row.push((format!("R²_{}", om.name), format!("{:.4}", om.r_squared)));
                }
                row
            })
            .collect()
    }
}
