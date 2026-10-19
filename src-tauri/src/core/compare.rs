//! Multi-file comparison: fuzzy signal matching, time alignment and difference statistics.

use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Arc;

use super::csv_parser::parse_csv;
use super::dataset::time_axis;
use super::dsp::{interp, mean};

/// Categorical chart palette in its validated, colour-blind-safe order (see src/lib/chart.ts).
pub const FILE_COLORS: &[&str] = &[
    "#ff2400", "#2a78d6", "#1baf7a", "#6250d6", "#eda100", "#e87ba4", "#008300",
];

pub const MATCH_THRESHOLD: f64 = 0.7;

#[derive(Debug, Clone)]
pub struct CompareFile {
    pub file_id: String,
    pub path: String,
    pub short_name: String,
    pub time: Arc<Vec<f64>>,
    pub signals: HashMap<String, Arc<Vec<f64>>>,
    pub columns: Vec<String>,
    pub offset: f64,
    pub color: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SignalMapping {
    pub canonical_name: String,
    /// file_id → column
    pub file_columns: Vec<(String, String)>,
}

impl SignalMapping {
    fn get(&self, fid: &str) -> Option<&String> {
        self.file_columns.iter().find(|(f, _)| f == fid).map(|(_, c)| c)
    }
    fn set(&mut self, fid: &str, col: &str) {
        match self.file_columns.iter_mut().find(|(f, _)| f == fid) {
            Some(e) => e.1 = col.to_string(),
            None => self.file_columns.push((fid.to_string(), col.to_string())),
        }
    }
    fn remove(&mut self, fid: &str) {
        self.file_columns.retain(|(f, _)| f != fid);
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct CompareStatistics {
    pub signal: String,
    pub file_name: String,
    pub rmse: f64,
    pub max_deviation: f64,
    pub r_squared: f64,
    pub mean_error: f64,
}

#[derive(Default)]
pub struct CompareManager {
    pub files: HashMap<String, CompareFile>,
    pub file_order: Vec<String>,
    pub mappings: Vec<SignalMapping>,
    color_idx: usize,
    id_counter: u64,
}

/// Canonical name: column name without the trailing `[unit]`.
pub fn canonical_name(col: &str) -> String {
    let t = col.trim_end();
    if t.ends_with(']') {
        if let Some(open) = t.rfind('[') {
            return t[..open].trim().to_string();
        }
    }
    col.trim().to_string()
}

/// difflib.SequenceMatcher(None, a, b).ratio()
pub fn sequence_ratio(a: &str, b: &str) -> f64 {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let total = a.len() + b.len();
    if total == 0 {
        return 1.0;
    }
    let mut b2j: HashMap<char, Vec<usize>> = HashMap::new();
    for (j, c) in b.iter().enumerate() {
        b2j.entry(*c).or_default().push(j);
    }
    if b.len() >= 200 {
        let ntest = b.len() / 100 + 1;
        b2j.retain(|_, v| v.len() <= ntest);
    }
    let find_longest = |alo: usize, ahi: usize, blo: usize, bhi: usize| -> (usize, usize, usize) {
        let (mut besti, mut bestj, mut bestsize) = (alo, blo, 0usize);
        let mut j2len: HashMap<usize, usize> = HashMap::new();
        for i in alo..ahi {
            let mut new: HashMap<usize, usize> = HashMap::new();
            if let Some(js) = b2j.get(&a[i]) {
                for &j in js {
                    if j < blo {
                        continue;
                    }
                    if j >= bhi {
                        break;
                    }
                    let k = j.checked_sub(1).and_then(|p| j2len.get(&p)).copied().unwrap_or(0) + 1;
                    new.insert(j, k);
                    if k > bestsize {
                        besti = i + 1 - k;
                        bestj = j + 1 - k;
                        bestsize = k;
                    }
                }
            }
            j2len = new;
        }
        (besti, bestj, bestsize)
    };
    let mut matches = 0;
    let mut queue = vec![(0, a.len(), 0, b.len())];
    while let Some((alo, ahi, blo, bhi)) = queue.pop() {
        let (i, j, k) = find_longest(alo, ahi, blo, bhi);
        if k > 0 {
            matches += k;
            if alo < i && blo < j {
                queue.push((alo, i, blo, j));
            }
            if i + k < ahi && j + k < bhi {
                queue.push((i + k, ahi, j + k, bhi));
            }
        }
    }
    2.0 * matches as f64 / total as f64
}

impl CompareManager {
    pub fn reference(&self) -> Option<&CompareFile> {
        self.file_order.first().and_then(|f| self.files.get(f))
    }

    fn new_id(&mut self, path: &str) -> String {
        use std::hash::{Hash, Hasher};
        self.id_counter += 1;
        let mut h = std::collections::hash_map::DefaultHasher::new();
        (path, self.id_counter, std::time::SystemTime::now()).hash(&mut h);
        format!("{:08x}", h.finish() as u32)
    }

    pub fn add_file(&mut self, path: &str) -> Result<String, String> {
        let parsed = parse_csv(Path::new(path))?;
        let n_rows = parsed.n_rows;
        let time = time_axis(parsed.time, n_rows);
        let mut signals = HashMap::new();
        let mut columns = Vec::new();
        for (c, v) in parsed.columns {
            columns.push(c.clone());
            signals.insert(c, Arc::new(v));
        }
        let file_id = self.new_id(path);
        let color = FILE_COLORS[self.color_idx % FILE_COLORS.len()].to_string();
        self.color_idx += 1;
        let short_name = Path::new(path).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| path.to_string());
        self.files.insert(
            file_id.clone(),
            CompareFile { file_id: file_id.clone(), path: path.to_string(), short_name, time: Arc::new(time), signals, columns, offset: 0.0, color },
        );
        self.file_order.push(file_id.clone());
        self.auto_match_signals();
        Ok(file_id)
    }

    pub fn remove_file(&mut self, fid: &str) {
        if self.files.remove(fid).is_some() {
            self.file_order.retain(|f| f != fid);
            for m in self.mappings.iter_mut() {
                m.remove(fid);
            }
            self.mappings.retain(|m| !m.file_columns.is_empty());
        }
    }

    pub fn clear(&mut self) {
        self.files.clear();
        self.file_order.clear();
        self.mappings.clear();
        self.color_idx = 0;
    }

    pub fn set_offset(&mut self, fid: &str, offset: f64) {
        if let Some(f) = self.files.get_mut(fid) {
            f.offset = offset;
        }
    }

    pub fn aligned_time(&self, fid: &str) -> Option<Vec<f64>> {
        self.files.get(fid).map(|f| f.time.iter().map(|t| t + f.offset).collect())
    }

    /// Time of the first threshold crossing (linear interpolation), 0 if none.
    pub fn detect_trigger_offset(&self, fid: &str, col: &str, threshold: f64, rising: bool) -> f64 {
        let Some(f) = self.files.get(fid) else { return 0.0 };
        let Some(data) = f.signals.get(col) else { return 0.0 };
        let t = &f.time;
        for i in 0..data.len().saturating_sub(1) {
            let (d0, d1) = (data[i], data[i + 1]);
            let hit = if rising { d0 < threshold && d1 >= threshold } else { d0 > threshold && d1 <= threshold };
            if hit {
                let frac = if (d1 - d0).abs() > 1e-12 { (threshold - d0) / (d1 - d0) } else { 0.0 };
                return t[i] + frac * (t[i + 1] - t[i]);
            }
        }
        0.0
    }

    pub fn align_by_trigger(&mut self, signal: &str, threshold: f64, rising: bool) {
        let Some(ref_id) = self.file_order.first().cloned() else { return };
        let Some(ref_col) = self.resolve_column(&ref_id, signal) else { return };
        let ref_time = self.detect_trigger_offset(&ref_id, &ref_col, threshold, rising);
        for fid in self.file_order.clone() {
            let Some(col) = self.resolve_column(&fid, signal) else { continue };
            let t = self.detect_trigger_offset(&fid, &col, threshold, rising);
            self.set_offset(&fid, ref_time - t);
        }
    }

    /// Click-to-align: offsets so every file's clicked time maps onto the reference click.
    pub fn align_by_clicks(&mut self, clicks: &[(String, f64)]) {
        let Some(ref_id) = self.file_order.first().cloned() else { return };
        let Some(ref_click) = clicks.iter().find(|(f, _)| *f == ref_id).map(|(_, t)| *t) else { return };
        for (fid, t) in clicks {
            // Clicks are recorded on the aligned time axis.
            let current = self.files.get(fid).map(|f| f.offset).unwrap_or(0.0);
            let ref_offset = self.files.get(&ref_id).map(|f| f.offset).unwrap_or(0.0);
            let raw_t = t - current;
            let raw_ref = ref_click - ref_offset;
            self.set_offset(fid, raw_ref - raw_t);
        }
    }

    pub fn resolve_column(&self, fid: &str, canonical: &str) -> Option<String> {
        let f = self.files.get(fid)?;
        if f.signals.contains_key(canonical) {
            return Some(canonical.to_string());
        }
        self.mappings.iter().find(|m| m.canonical_name == canonical).and_then(|m| m.get(fid)).cloned()
    }

    /// (common time, target − reference) on the reference time grid.
    pub fn compute_difference(&self, canonical: &str, ref_id: &str, tgt_id: &str) -> Option<(Vec<f64>, Vec<f64>)> {
        let r = self.files.get(ref_id)?;
        let t = self.files.get(tgt_id)?;
        let rc = self.resolve_column(ref_id, canonical)?;
        let tc = self.resolve_column(tgt_id, canonical)?;
        let rt: Vec<f64> = r.time.iter().map(|v| v + r.offset).collect();
        let tt: Vec<f64> = t.time.iter().map(|v| v + t.offset).collect();
        let (rd, td) = (r.signals.get(&rc)?, t.signals.get(&tc)?);
        let t_min = rt.first()?.max(*tt.first()?);
        let t_max = rt.last()?.min(*tt.last()?);
        if t_min >= t_max {
            return None;
        }
        let (common, ref_vals): (Vec<f64>, Vec<f64>) =
            rt.iter().zip(rd.iter()).filter(|(x, _)| **x >= t_min && **x <= t_max).map(|(x, y)| (*x, *y)).unzip();
        let tgt = interp(&common, &tt, td);
        Some((common, tgt.iter().zip(ref_vals.iter()).map(|(a, b)| a - b).collect()))
    }

    pub fn compute_statistics(&self, canonical: &str, ref_id: &str, tgt_id: &str) -> Option<CompareStatistics> {
        let (common, diff) = self.compute_difference(canonical, ref_id, tgt_id)?;
        let r = self.files.get(ref_id)?;
        let t = self.files.get(tgt_id)?;
        let n = diff.len().max(1) as f64;
        let rmse = (diff.iter().map(|d| d * d).sum::<f64>() / n).sqrt();
        let max_dev = diff.iter().fold(0.0f64, |a, d| a.max(d.abs()));
        let mean_err = mean(&diff);
        let rc = self.resolve_column(ref_id, canonical)?;
        let rd = r.signals.get(&rc)?;
        let (t_min, t_max) = (common[0], common[common.len() - 1]);
        let ref_vals: Vec<f64> = r.time.iter().zip(rd.iter()).filter(|(x, _)| {
            let x = **x + r.offset;
            x >= t_min && x <= t_max
        }).map(|(_, y)| *y).collect();
        let ss_res: f64 = diff.iter().map(|d| d * d).sum();
        let m = mean(&ref_vals);
        let ss_tot: f64 = ref_vals.iter().map(|v| (v - m).powi(2)).sum();
        let r_squared = if ss_tot > 1e-12 { 1.0 - ss_res / ss_tot } else { 0.0 };
        Some(CompareStatistics { signal: canonical.to_string(), file_name: t.short_name.clone(), rmse, max_deviation: max_dev, r_squared, mean_error: mean_err })
    }

    /// Canonical names that exist in at least two files.
    pub fn mapped_signals(&self) -> Vec<String> {
        self.mappings.iter().filter(|m| m.file_columns.len() >= 2).map(|m| m.canonical_name.clone()).collect()
    }

    pub fn set_signal_mapping(&mut self, canonical: &str, fid: &str, column: Option<&str>) {
        if let Some(m) = self.mappings.iter_mut().find(|m| m.canonical_name == canonical) {
            match column {
                Some(c) => m.set(fid, c),
                None => m.remove(fid),
            }
            return;
        }
        if let Some(c) = column {
            self.mappings.push(SignalMapping { canonical_name: canonical.to_string(), file_columns: vec![(fid.to_string(), c.to_string())] });
        }
    }

    fn auto_match_signals(&mut self) {
        let Some(ref_id) = self.file_order.first().cloned() else {
            self.mappings.clear();
            return;
        };
        let ref_cols = self.files[&ref_id].columns.clone();
        let mut existing: HashSet<String> = self.mappings.iter().map(|m| m.canonical_name.clone()).collect();
        for col in &ref_cols {
            let canonical = canonical_name(col);
            if !existing.contains(&canonical) {
                self.mappings.push(SignalMapping { canonical_name: canonical.clone(), file_columns: vec![(ref_id.clone(), col.clone())] });
                existing.insert(canonical);
            } else if let Some(m) = self.mappings.iter_mut().find(|m| m.canonical_name == canonical) {
                m.set(&ref_id, col);
            }
        }
        for fid in self.file_order.iter().skip(1).cloned().collect::<Vec<_>>() {
            let cols = self.files[&fid].columns.clone();
            let mut matched: HashSet<String> = HashSet::new();
            for mapping in self.mappings.iter_mut() {
                if let Some(c) = mapping.get(&fid) {
                    matched.insert(c.clone());
                    continue;
                }
                let canon_lower = mapping.canonical_name.to_lowercase();
                let mut best_score = 0.0;
                let mut best_col: Option<String> = None;
                for col in &cols {
                    if matched.contains(col) {
                        continue;
                    }
                    let col_canon = canonical_name(col).to_lowercase();
                    if col_canon == canon_lower {
                        best_col = Some(col.clone());
                        break;
                    }
                    let score = sequence_ratio(&canon_lower, &col_canon);
                    if score > best_score && score >= MATCH_THRESHOLD {
                        best_score = score;
                        best_col = Some(col.clone());
                    }
                }
                if let Some(c) = best_col {
                    mapping.set(&fid, &c);
                    matched.insert(c);
                }
            }
        }
    }

    /// File whose trace is closest (in y) to a click at (t, y) on `canonical`.
    pub fn nearest_file(&self, canonical: &str, t: f64, y: f64) -> Option<String> {
        let mut best: Option<(String, f64)> = None;
        for fid in &self.file_order {
            let Some(col) = self.resolve_column(fid, canonical) else { continue };
            let f = &self.files[fid];
            let Some(data) = f.signals.get(&col) else { continue };
            let aligned: Vec<f64> = f.time.iter().map(|v| v + f.offset).collect();
            if aligned.is_empty() {
                continue;
            }
            let idx = super::dsp::searchsorted(&aligned, t).min(aligned.len() - 1);
            let dist = (data[idx] - y).abs();
            if best.as_ref().map(|(_, d)| dist < *d).unwrap_or(true) {
                best = Some((fid.clone(), dist));
            }
        }
        best.map(|(f, _)| f)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ratio_matches_difflib() {
        // difflib.SequenceMatcher(None, "motor_torque", "motor_torq").ratio() == 0.9090909090909091
        assert!((sequence_ratio("motor_torque", "motor_torq") - 0.9090909090909091).abs() < 1e-12);
        // difflib.SequenceMatcher(None, "abcd", "bcda").ratio() == 0.75
        assert!((sequence_ratio("abcd", "bcda") - 0.75).abs() < 1e-12);
        assert_eq!(sequence_ratio("", ""), 1.0);
        assert!((sequence_ratio("t_left", "t_right") - 0.46153846153846156).abs() < 1e-12);
    }

    #[test]
    fn canonical() {
        assert_eq!(canonical_name("Motor_Torque [Nm]"), "Motor_Torque");
        assert_eq!(canonical_name("Pressure"), "Pressure");
    }
}
