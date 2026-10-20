//! Central data store for the aligned signals the analysis pages work on.

use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::sync::Arc;

use super::csv_parser::ParseResult;
use super::dsp::median;

pub const SIGNAL_GROUPS: &[(&str, &[&str])] = &[
    ("Motor", &["motor", "shaft_rpm", "shaft_speed"]),
    ("Leakage", &["leak", "leakage"]),
    ("Temperature", &["t_left", "t_right", "t_probe", "temperature", "temp"]),
    ("Pressure", &["pressure"]),
    ("Vibration", &["vibration"]),
    ("Heater", &["heater"]),
    ("Setpoint", &["setpoint"]),
    ("Cooling", &["water_valve"]),
    ("Limits", &["max_", "min_"]),
];

#[derive(Debug, Clone, Serialize)]
pub struct SignalInfo {
    pub column: String,
    pub name: String,
    pub unit: String,
    pub group: String,
    pub index: usize,
    pub label: String,
}

/// Parses a header like `Motor_Torque [Nm]` into (name, unit, group).
pub fn parse_signal_name(col: &str) -> (String, String, String) {
    let trimmed = col.trim_end();
    // Units in brackets ("Torque [Nm]") or parentheses ("Force (mN)").
    let split_unit = |open_c: char, close_c: char| -> Option<(String, String)> {
        if !trimmed.ends_with(close_c) {
            return None;
        }
        let open = trimmed.rfind(open_c)?;
        let unit = &trimmed[open + 1..trimmed.len() - 1];
        if unit.contains(close_c) || open == 0 {
            return None;
        }
        Some((trimmed[..open].trim().to_string(), unit.trim().to_string()))
    };
    let (name, unit) = split_unit('[', ']').or_else(|| split_unit('(', ')')).unwrap_or_else(|| (col.trim().to_string(), String::new()));
    let lower = col.to_lowercase();
    let group = SIGNAL_GROUPS
        .iter()
        .find(|(_, kws)| kws.iter().any(|k| lower.contains(k)))
        .map(|(g, _)| g.to_string())
        .unwrap_or_else(|| "Other".into());
    (name, unit, group)
}

pub fn signal_label(name: &str, unit: &str) -> String {
    if unit.is_empty() {
        name.to_string()
    } else {
        format!("{name} [{unit}]")
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct DatasetInfo {
    pub path: String,
    pub n_samples: usize,
    pub n_signals: usize,
    pub sample_rate: f64,
    pub duration: f64,
    pub signals: Vec<SignalInfo>,
    pub metadata: Map<String, Value>,
    pub encoding: String,
    pub delimiter: String,
    pub header_row: usize,
    pub is_raser_format: bool,
    pub file_type: String,
    pub sheet: Option<String>,
    /// Signals with processing steps (Prepare edits or filters).
    pub edited: Vec<String>,
    /// Unix seconds at t = 0 when the time axis comes from timestamps.
    pub time_origin: Option<f64>,
    /// Text variables available for grouping.
    pub texts: Vec<String>,
}

pub struct Dataset {
    pub path: String,
    pub time: Arc<Vec<f64>>,
    pub signals: Vec<SignalInfo>,
    raw: HashMap<String, Arc<Vec<f64>>>,
    texts: Vec<(String, Arc<Vec<String>>)>,
    pub edited: Vec<String>,
    pub time_origin: Option<f64>,
    pub metadata: Map<String, Value>,
    pub sample_rate: f64,
    encoding: String,
    delimiter: String,
    header_row: usize,
    is_raser: bool,
    file_type: String,
    sheet: Option<String>,
}

/// Columns that already live behind shared pointers (the workspace's aligned signals).
pub struct SharedParts {
    pub time: Arc<Vec<f64>>,
    pub sample_rate: f64,
    pub columns: Vec<(String, Arc<Vec<f64>>)>,
    pub texts: Vec<(String, Arc<Vec<String>>)>,
    pub time_origin: Option<f64>,
    pub metadata: Map<String, Value>,
}

pub fn time_axis(parse_time: Option<Vec<f64>>, n_rows: usize) -> Vec<f64> {
    parse_time.unwrap_or_else(|| (0..n_rows).map(|i| i as f64).collect())
}

pub fn sample_rate_of(time: &[f64]) -> f64 {
    if time.len() > 1 {
        let diffs: Vec<f64> = time.windows(2).map(|w| w[1] - w[0]).filter(|d| d.is_finite()).collect();
        if !diffs.is_empty() {
            let dt = median(&diffs);
            if dt > 0.0 {
                return 1.0 / dt;
            }
        }
    }
    1.0
}

impl Dataset {
    /// A workspace dataset: no column is copied, so an edit costs only what it changed.
    pub fn from_shared(path: &str, parts: SharedParts) -> Dataset {
        let mut signals = Vec::new();
        let mut raw = HashMap::new();
        for (idx, (col, values)) in parts.columns.into_iter().enumerate() {
            let (name, unit, group) = parse_signal_name(&col);
            let label = signal_label(&name, &unit);
            signals.push(SignalInfo { column: col.clone(), name, unit, group, index: idx, label });
            raw.insert(col, values);
        }
        Dataset {
            path: path.to_string(),
            time: parts.time,
            signals,
            raw,
            texts: parts.texts,
            edited: vec![],
            time_origin: parts.time_origin,
            metadata: parts.metadata,
            sample_rate: parts.sample_rate,
            encoding: "—".into(),
            delimiter: "—".into(),
            header_row: 0,
            is_raser: false,
            file_type: "Workspace".into(),
            sheet: None,
        }
    }

    pub fn from_parse(path: &str, parse: ParseResult) -> Dataset {
        let time = time_axis(parse.time, parse.n_rows);
        let sample_rate = sample_rate_of(&time);
        let mut signals = Vec::new();
        let mut raw = HashMap::new();
        for (idx, (col, values)) in parse.columns.into_iter().enumerate() {
            let (name, unit, group) = parse_signal_name(&col);
            let label = signal_label(&name, &unit);
            signals.push(SignalInfo { column: col.clone(), name, unit, group, index: idx, label });
            raw.insert(col, Arc::new(values));
        }
        Dataset {
            path: path.to_string(),
            time: Arc::new(time),
            signals,
            raw,
            texts: parse.text_columns.into_iter().map(|(n, v)| (n, Arc::new(v))).collect(),
            edited: vec![],
            time_origin: parse.time_origin,
            metadata: parse.metadata,
            sample_rate,
            encoding: parse.encoding,
            delimiter: parse.delimiter_desc,
            header_row: parse.header_row,
            is_raser: parse.is_raser_format,
            file_type: parse.file_type,
            sheet: parse.sheet,
        }
    }

    pub fn n_samples(&self) -> usize {
        self.time.len()
    }

    pub fn info(&self) -> DatasetInfo {
        let duration = match (self.time.first(), self.time.last()) {
            (Some(a), Some(b)) => b - a,
            _ => 0.0,
        };
        DatasetInfo {
            path: self.path.clone(),
            n_samples: self.n_samples(),
            n_signals: self.signals.len(),
            sample_rate: self.sample_rate,
            duration,
            signals: self.signals.clone(),
            metadata: self.metadata.clone(),
            encoding: self.encoding.clone(),
            delimiter: self.delimiter.clone(),
            header_row: self.header_row,
            is_raser_format: self.is_raser,
            file_type: self.file_type.clone(),
            sheet: self.sheet.clone(),
            edited: self.edited.clone(),
            time_origin: self.time_origin,
            texts: self.texts.iter().map(|(n, _)| n.clone()).collect(),
        }
    }

    pub fn signal_info(&self, col: &str) -> Option<&SignalInfo> {
        self.signals.iter().find(|s| s.column == col)
    }

    pub fn label(&self, col: &str) -> String {
        self.signal_info(col).map(|s| s.label.clone()).unwrap_or_else(|| col.to_string())
    }

    pub fn short_name(&self, col: &str) -> String {
        self.signal_info(col).map(|s| s.name.clone()).unwrap_or_else(|| col.to_string())
    }

    pub fn columns(&self) -> Vec<String> {
        self.signals.iter().map(|s| s.column.clone()).collect()
    }

    pub fn get_signal(&self, col: &str) -> Option<Arc<Vec<f64>>> {
        self.raw.get(col).cloned()
    }

    pub fn get_text(&self, name: &str) -> Option<Arc<Vec<String>>> {
        self.texts.iter().find(|(n, _)| n == name).map(|(_, v)| v.clone())
    }

    /// All signals in column order.
    pub fn all_signals(&self) -> Vec<(String, Arc<Vec<f64>>)> {
        self.signals.iter().filter_map(|s| self.get_signal(&s.column).map(|d| (s.column.clone(), d))).collect()
    }

    pub fn select(&self, cols: &[String]) -> Result<Vec<(String, Arc<Vec<f64>>)>, String> {
        cols.iter()
            .map(|c| self.get_signal(c).map(|d| (c.clone(), d)).ok_or_else(|| format!("Signal '{c}' not found in loaded data.")))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signal_name_parsing() {
        assert_eq!(parse_signal_name("Motor_Torque [Nm]"), ("Motor_Torque".into(), "Nm".into(), "Motor".into()));
        assert_eq!(parse_signal_name("T_Left [degC]").2, "Temperature");
        assert_eq!(parse_signal_name("Foo").1, "");
        assert_eq!(parse_signal_name("Max_Pressure [bar]").2, "Pressure");
        assert_eq!(parse_signal_name("Leakage [ml]").2, "Leakage");
        assert_eq!(parse_signal_name("Force (mN)"), ("Force".into(), "mN".into(), "Other".into()));
        assert_eq!(parse_signal_name("MCU Temperature (C)").2, "Temperature");
    }
}
