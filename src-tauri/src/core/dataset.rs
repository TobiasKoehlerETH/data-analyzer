//! Central data store for loaded signals, filtered views, filter chains and metadata.

use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::sync::Arc;

use super::cache::CacheManager;
use super::csv_parser::ParseResult;
use super::dsp::median;
use super::filters::FilterChain;

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
    pub filtered: Vec<String>,
}

pub struct Dataset {
    pub path: String,
    pub time: Arc<Vec<f64>>,
    pub signals: Vec<SignalInfo>,
    raw: HashMap<String, Arc<Vec<f64>>>,
    filtered: HashMap<String, Arc<Vec<f64>>>,
    chains: HashMap<String, FilterChain>,
    pub metadata: Map<String, Value>,
    pub sample_rate: f64,
    encoding: String,
    delimiter: String,
    header_row: usize,
    is_raser: bool,
    file_type: String,
    sheet: Option<String>,
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
            filtered: HashMap::new(),
            chains: HashMap::new(),
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
        let mut filtered: Vec<String> = self.filtered.keys().cloned().collect();
        filtered.sort();
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
            filtered,
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

    /// Filtered view if one exists, raw data otherwise.
    pub fn get_signal(&self, col: &str) -> Option<Arc<Vec<f64>>> {
        self.filtered.get(col).or_else(|| self.raw.get(col)).cloned()
    }

    pub fn get_raw(&self, col: &str) -> Option<Arc<Vec<f64>>> {
        self.raw.get(col).cloned()
    }

    pub fn has_filtered(&self, col: &str) -> bool {
        self.filtered.contains_key(col)
    }

    pub fn set_filtered(&mut self, col: &str, data: Vec<f64>, chain: FilterChain, cache: &CacheManager) {
        self.filtered.insert(col.to_string(), Arc::new(data));
        self.chains.insert(col.to_string(), chain);
        cache.invalidate_signal(col);
    }

    pub fn clear_filtered(&mut self, col: &str, cache: &CacheManager) {
        self.filtered.remove(col);
        self.chains.remove(col);
        cache.invalidate_signal(col);
    }

    pub fn filter_chain(&self, col: &str) -> Option<&FilterChain> {
        self.chains.get(col)
    }

    /// All signals (filtered where applicable), in column order.
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
