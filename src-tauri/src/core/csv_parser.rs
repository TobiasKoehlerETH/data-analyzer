//! CSV parser with auto-detection and Raser DataLog format support.
//!
//! Auto-detects encoding, delimiter, header row and metadata. Parses timestamp
//! columns and keeps fully numeric columns as signals; non-numeric columns are
//! stashed in the metadata.

use chrono::{NaiveDate, NaiveDateTime, NaiveTime};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::path::Path;

pub const HEAD_LINES: usize = 40;
/// Raw lines shown in the import-settings grid.
pub const RAW_PREVIEW_LINES: usize = 80;

/// User overrides for the automatic detection (all optional; `None` = auto).
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct ImportOptions {
    /// Delimiter override: ",", ";", "\t", "|", " " (whitespace).
    pub delimiter: Option<String>,
    /// 0-based line (or sheet row) holding the column names.
    pub header_row: Option<usize>,
    /// The file has no header line: columns are named "Column 1", "Column 2", …
    pub no_header: bool,
    /// 0-based line where the data starts (default: line after the header).
    pub data_start: Option<usize>,
    /// 0-based lines to ignore inside the data block.
    pub skip_rows: Vec<usize>,
    /// 0-based columns to ignore.
    pub skip_columns: Vec<usize>,
    /// Time axis: None = auto, Some(-1) = none (sample index), Some(k) = column k.
    pub time_column: Option<i64>,
}

const NA_VALUES: &[&str] = &[
    "", "#N/A", "#N/A N/A", "#NA", "-1.#IND", "-1.#QNAN", "-NaN", "-nan", "1.#IND", "1.#QNAN", "<NA>",
    "N/A", "NA", "NULL", "NaN", "None", "n/a", "nan", "null",
];

#[derive(Debug, Clone)]
pub struct ParseResult {
    /// Ordered numeric signal columns (timestamp column excluded).
    pub columns: Vec<(String, Vec<f64>)>,
    /// Name of the parsed timestamp/time column, if any.
    pub time_column: Option<String>,
    /// Time in seconds (relative to the first timestamp for datetimes, raw for numeric time columns).
    pub time: Option<Vec<f64>>,
    /// Absolute start of a datetime time column (Unix seconds, naive times read as UTC).
    pub time_origin: Option<f64>,
    /// Non-numeric columns (labels, states, IDs); missing cells are empty strings.
    pub text_columns: Vec<(String, Vec<String>)>,
    pub metadata: Map<String, Value>,
    pub header_row: usize,
    pub delimiter: char,
    pub encoding: String,
    pub is_raser_format: bool,
    pub n_rows: usize,
    pub delimiter_desc: String,
    pub file_type: String,
    pub sheet: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PreviewResult {
    pub encoding: String,
    pub delimiter: String,
    pub header_row: usize,
    pub is_raser_format: bool,
    pub metadata: Map<String, Value>,
    pub headers: Vec<String>,
    pub rows: Vec<Vec<String>>,
    pub file_type: String,
    pub sheets: Vec<String>,
    pub sheet: Option<String>,
    /// First lines of the file split into cells (for the import-settings grid).
    pub raw: Vec<Vec<String>>,
    pub n_lines: usize,
    pub data_start: usize,
    pub no_header: bool,
    /// Column index (in `headers` before skipping) used as the time axis, if any.
    pub time_column_index: Option<usize>,
    pub time_column: Option<String>,
    /// Indices into `headers` that were ignored (by option or because they are empty).
    pub skipped_columns: Vec<usize>,
    /// Indices into `headers` that are numeric signals.
    pub numeric_columns: Vec<usize>,
    /// Indices into `headers` that hold text (imported as categories).
    pub text_columns: Vec<usize>,
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

pub fn detect_encoding_bytes(raw: &[u8]) -> String {
    let sample = &raw[..raw.len().min(65536)];
    if sample.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return "utf-8-sig".into();
    }
    if sample.starts_with(&[0xFF, 0xFE]) || sample.starts_with(&[0xFE, 0xFF]) {
        return "utf-16".into();
    }
    // ASCII / valid UTF-8 (allowing a truncated trailing sequence) → utf-8
    match std::str::from_utf8(sample) {
        Ok(_) => return "utf-8".into(),
        Err(e) if e.error_len().is_none() && e.valid_up_to() + 4 >= sample.len() => return "utf-8".into(),
        Err(_) => {}
    }
    let mut det = chardetng::EncodingDetector::new();
    det.feed(sample, raw.len() <= 65536);
    let enc = det.guess(None, true);
    let name = enc.name().to_lowercase();
    // Validate that the guess decodes the sample cleanly; otherwise fall back to latin-1.
    let (_, _, had_errors) = enc.decode(sample);
    if had_errors {
        return "latin-1".into();
    }
    name
}

pub fn detect_encoding(path: &Path) -> std::io::Result<String> {
    let raw = std::fs::read(path)?;
    Ok(detect_encoding_bytes(&raw))
}

pub fn decode_bytes(raw: &[u8], encoding: &str) -> String {
    match encoding {
        "utf-8-sig" => String::from_utf8_lossy(raw.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(raw)).into_owned(),
        "utf-8" => String::from_utf8_lossy(raw).into_owned(),
        "utf-16" => {
            let enc = if raw.starts_with(&[0xFE, 0xFF]) { encoding_rs::UTF_16BE } else { encoding_rs::UTF_16LE };
            enc.decode(raw).0.into_owned()
        }
        "latin-1" => encoding_rs::WINDOWS_1252.decode(raw).0.into_owned(),
        other => encoding_rs::Encoding::for_label(other.as_bytes())
            .unwrap_or(encoding_rs::WINDOWS_1252)
            .decode(raw)
            .0
            .into_owned(),
    }
}

// ---------------------------------------------------------------------------
// Format detection
// ---------------------------------------------------------------------------

/// Equivalent of `re.match(r"Log\s+V\d+\.\d+", line)`.
fn is_log_version_line(line: &str) -> bool {
    let Some(rest) = line.strip_prefix("Log") else { return false };
    let trimmed = rest.trim_start();
    if trimmed.len() == rest.len() {
        return false;
    }
    let Some(rest) = trimmed.strip_prefix('V') else { return false };
    let major = rest.chars().take_while(|c| c.is_ascii_digit()).count();
    if major == 0 {
        return false;
    }
    let Some(rest) = rest[major..].strip_prefix('.') else { return false };
    rest.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false)
}

pub fn detect_raser_format(lines: &[String]) -> (bool, Map<String, Value>) {
    let mut meta = Map::new();
    if lines.len() < 3 || !lines[0].starts_with("sep=") {
        return (false, meta);
    }
    let is_log = is_log_version_line(&lines[1]);
    if !is_log {
        return (false, meta);
    }
    meta.insert("format".into(), Value::String("RaserDataLog".into()));
    meta.insert("log_version".into(), Value::String(lines[1].trim().to_string()));
    for line in &lines[2..] {
        if line.trim().is_empty() {
            continue;
        }
        if line.contains(';') && line.matches(';').count() > 1 {
            break;
        }
        if line.contains(':') && !line.contains(';') {
            let (k, v) = line.split_once(':').unwrap();
            meta.insert(k.trim().to_string(), Value::String(v.trim().to_string()));
        }
    }
    (true, meta)
}

pub fn detect_delimiter(lines: &[String], is_raser: bool) -> char {
    if is_raser {
        if let Some(c) = lines.first().and_then(|l| l.strip_prefix("sep=")).and_then(|r| r.chars().next()) {
            return c;
        }
    }
    let data: Vec<&String> = lines.iter().filter(|l| !l.trim().is_empty() && !l.starts_with('#')).collect();
    if data.is_empty() {
        return ',';
    }
    let sample: Vec<&String> = data[data.len().saturating_sub(10)..].to_vec();
    // Sniffer-like: a delimiter is a candidate when its per-line count is consistent.
    let mut candidates: Vec<char> = Vec::new();
    for d in [';', ',', '\t', '|'] {
        let counts: Vec<usize> = sample.iter().map(|l| l.matches(d).count()).collect();
        let mut freq: HashMap<usize, usize> = HashMap::new();
        for c in &counts {
            *freq.entry(*c).or_default() += 1;
        }
        let (mode, mode_n) = freq.iter().max_by_key(|(c, n)| (**n, **c)).map(|(c, n)| (*c, *n)).unwrap();
        if mode > 0 && mode_n as f64 / counts.len() as f64 >= 0.9 {
            candidates.push(d);
        }
    }
    if candidates.len() == 1 {
        return candidates[0];
    }
    if candidates.contains(&';') && candidates.contains(&',') {
        // Commas inside semicolon-separated data are decimal separators.
        return ';';
    }
    for d in [',', '\t', ';', '|'] {
        if candidates.contains(&d) {
            return d;
        }
    }
    for d in [';', ',', '\t', '|'] {
        let counts: Vec<usize> = sample.iter().map(|l| l.matches(d).count()).collect();
        if counts.iter().min().copied().unwrap_or(0) > 0 && counts.iter().max() == counts.iter().min() {
            return d;
        }
    }
    ','
}

fn is_numeric_str(s: &str) -> bool {
    let s = s.trim().trim_matches('"').trim_matches('\'');
    if s.is_empty() {
        return false;
    }
    s.replace(',', ".").parse::<f64>().is_ok()
}

pub fn find_header_row(lines: &[String], delimiter: char) -> usize {
    if lines.is_empty() {
        return 0;
    }
    let counts: Vec<usize> = lines.iter().map(|l| l.matches(delimiter).count()).collect();
    let tail = &counts[counts.len().saturating_sub(10)..];
    let tail: Vec<usize> = tail.iter().copied().filter(|&c| c > 0).collect();
    if tail.is_empty() {
        return 0;
    }
    // Counter.most_common(1): highest count, ties broken by first occurrence.
    let mut order: Vec<usize> = Vec::new();
    let mut freq: HashMap<usize, usize> = HashMap::new();
    for c in &tail {
        if !freq.contains_key(c) {
            order.push(*c);
        }
        *freq.entry(*c).or_default() += 1;
    }
    let best = order.iter().map(|c| freq[c]).max().unwrap();
    let target = *order.iter().find(|c| freq[*c] == best).unwrap();
    for (i, (count, line)) in counts.iter().zip(lines).enumerate() {
        if *count != target {
            continue;
        }
        let parts: Vec<&str> = line.split(delimiter).map(|p| p.trim()).filter(|p| !p.is_empty()).collect();
        if parts.is_empty() {
            continue;
        }
        let numeric = parts.iter().filter(|p| is_numeric_str(p)).count();
        if (numeric as f64) < parts.len() as f64 * 0.5 {
            return i;
        }
    }
    // No text line has exactly the data delimiter count: the header may carry extra
    // trailing fields (e.g. "…,Time to connect (s),0.152"). Use the text line right
    // above the first data line when it is at least as wide as the data.
    let first = counts.iter().position(|&c| c == target).unwrap_or(0);
    if first > 0 {
        let prev = &lines[first - 1];
        let parts: Vec<&str> = prev.split(delimiter).map(|p| p.trim()).filter(|p| !p.is_empty()).collect();
        let numeric = parts.iter().filter(|p| is_numeric_str(p)).count();
        if counts[first - 1] >= target && !parts.is_empty() && (numeric as f64) < parts.len() as f64 * 0.5 {
            return first - 1;
        }
    }
    first
}

// ---------------------------------------------------------------------------
// Value parsing
// ---------------------------------------------------------------------------

fn is_na(s: &str) -> bool {
    NA_VALUES.contains(&s)
}

fn parse_number(s: &str, allow_decimal_comma: bool) -> Option<f64> {
    let t = s.trim();
    if let Ok(v) = t.parse::<f64>() {
        return Some(v);
    }
    if allow_decimal_comma && t.matches(',').count() == 1 && !t.contains('.') {
        return t.replace(',', ".").parse::<f64>().ok();
    }
    match t.to_ascii_lowercase().as_str() {
        "inf" | "+inf" | "infinity" => Some(f64::INFINITY),
        "-inf" | "-infinity" => Some(f64::NEG_INFINITY),
        _ => None,
    }
}

/// Parses the timestamp layouts used by the original parser (see `_parse_timestamp`):
/// `%Y %m %d %H:%M:%S:%f`, ISO `%Y-%m-%d %H:%M:%S(.%f)`, `%Y/%m/%d …`, `%d.%m.%Y …`, `%d/%m/%Y …`
/// and date-only / `T`-separated variants.
pub fn parse_timestamp(s: &str) -> Option<NaiveDateTime> {
    let s = s.trim().trim_matches('"');
    if s.is_empty() {
        return None;
    }
    let mut nums: Vec<&str> = Vec::new();
    let mut seps: Vec<char> = Vec::new();
    let mut start = None;
    for (i, c) in s.char_indices() {
        if c.is_ascii_digit() {
            if start.is_none() {
                start = Some(i);
            }
        } else {
            if let Some(st) = start.take() {
                nums.push(&s[st..i]);
            }
            if nums.is_empty() {
                return None;
            }
            seps.push(c);
        }
    }
    if let Some(st) = start {
        nums.push(&s[st..]);
    }
    if nums.len() < 3 || nums.len() > 7 {
        return None;
    }
    let (y, m, d) = if nums[0].len() == 4 {
        (nums[0], nums[1], nums[2])
    } else if nums[2].len() == 4 && matches!(seps.first(), Some('.') | Some('/') | Some('-')) {
        (nums[2], nums[1], nums[0])
    } else {
        return None;
    };
    let date = NaiveDate::from_ymd_opt(y.parse().ok()?, m.parse().ok()?, d.parse().ok()?)?;
    let get = |i: usize| -> Option<u32> { nums.get(i).map(|v| v.parse().ok()).unwrap_or(Some(0)) };
    let (h, mi, sec) = (get(3)?, get(4)?, get(5)?);
    let nanos = match nums.get(6) {
        Some(frac) => {
            let digits: String = frac.chars().take(9).collect();
            let v: u64 = digits.parse().ok()?;
            (v * 10u64.pow(9 - digits.len() as u32)) as u32
        }
        None => 0,
    };
    let time = NaiveTime::from_hms_nano_opt(h, mi, sec, nanos)?;
    Some(NaiveDateTime::new(date, time))
}

fn seconds_since(t: &NaiveDateTime, epoch: &NaiveDateTime) -> f64 {
    let d = *t - *epoch;
    d.num_seconds() as f64 + (d.subsec_nanos() as f64) * 1e-9
}

// ---------------------------------------------------------------------------
// Table reading
// ---------------------------------------------------------------------------

struct RawTable {
    headers: Vec<String>,
    rows: Vec<Vec<String>>,
}

struct TableSpec<'a> {
    header_row: usize,
    no_header: bool,
    data_start: usize,
    skip_rows: &'a [usize],
}

/// Splits one line into fields (quote-aware only when the line contains a quote).
fn split_line(line: &str, delimiter: char, quoting: bool) -> Vec<String> {
    if !quoting || !line.contains('"') {
        return line.split(delimiter).map(|s| s.to_string()).collect();
    }
    let mut rdr = csv::ReaderBuilder::new().delimiter(delimiter as u8).has_headers(false).flexible(true).quoting(true).from_reader(line.as_bytes());
    match rdr.records().next() {
        Some(Ok(r)) => r.iter().map(|s| s.to_string()).collect(),
        _ => line.split(delimiter).map(|s| s.to_string()).collect(),
    }
}

fn read_table(text: &str, spec: &TableSpec, delimiter: char, max_rows: Option<usize>, quoting: bool) -> Result<RawTable, String> {
    let first_line = if spec.no_header { spec.data_start } else { spec.header_row };
    let mut lines = text.lines().enumerate().skip(first_line).map(|(i, l)| (i, l.trim_end_matches('\r')));
    let mut headers: Vec<String> = if spec.no_header {
        Vec::new()
    } else {
        loop {
            match lines.next() {
                Some((_, l)) if l.trim().is_empty() => continue,
                Some((_, l)) => break split_line(l, delimiter, quoting).into_iter().map(|s| s.trim().trim_matches('"').to_string()).collect(),
                None => return Err("File contains no header row".into()),
            }
        }
    };
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut ncol = headers.len();
    for (line_no, line) in lines {
        if line_no < spec.data_start || spec.skip_rows.contains(&line_no) || line.trim().is_empty() {
            continue;
        }
        let fields = split_line(line, delimiter, quoting);
        if spec.no_header {
            ncol = ncol.max(fields.len());
        } else if fields.len() > ncol && fields.iter().skip(ncol).any(|f| !f.trim().is_empty()) {
            // pandas: on_bad_lines="warn" skips rows with too many fields,
            // unless the extra fields are empty (trailing delimiter).
            continue;
        }
        let take = if spec.no_header { fields.len() } else { ncol };
        rows.push(fields.into_iter().take(take).collect());
        if let Some(m) = max_rows {
            if rows.len() >= m {
                break;
            }
        }
    }
    if spec.no_header {
        headers = (1..=ncol).map(|i| format!("Column {i}")).collect();
    }
    for r in rows.iter_mut() {
        r.resize(ncol, String::new());
    }
    // Disambiguate headers like pandas (empty → "Unnamed: i", duplicates → "x.1").
    let mut seen: HashMap<String, usize> = HashMap::new();
    let headers = headers
        .into_iter()
        .enumerate()
        .map(|(i, h)| {
            let base = if h.is_empty() { format!("Unnamed: {i}") } else { h };
            let n = seen.entry(base.clone()).or_insert(0);
            let name = if *n == 0 { base.clone() } else { format!("{base}.{n}") };
            *n += 1;
            name
        })
        .collect();
    Ok(RawTable { headers, rows })
}

/// Splits the first lines into cells for the import-settings grid.
fn raw_grid(text: &str, delimiter: char, quoting: bool, n: usize) -> Vec<Vec<String>> {
    text.lines()
        .take(n)
        .map(|line| {
            let mut rdr = csv::ReaderBuilder::new()
                .delimiter(delimiter as u8)
                .has_headers(false)
                .flexible(true)
                .quoting(quoting)
                .from_reader(line.as_bytes());
            match rdr.records().next() {
                Some(Ok(r)) => r.iter().map(|c| c.trim().to_string()).collect(),
                _ => vec![line.to_string()],
            }
        })
        .collect()
}

/// True for time-axis column names such as "Time", "time (s)", "Timestamp", "Zeit [s]", "t [s]".
pub fn is_time_name(header: &str) -> bool {
    let h = header.to_lowercase();
    let base = h.split(['[', '(']).next().unwrap_or("").trim().to_string();
    matches!(base.as_str(), "timestamp" | "time" | "date" | "datetime" | "zeit" | "t" | "time_s" | "elapsed time" | "elapsed")
}

fn head_lines(text: &str, n: usize) -> Vec<String> {
    text.lines().take(n).map(|l| l.trim_end_matches(['\r', '\n']).to_string()).collect()
}

struct Detected {
    encoding: String,
    text: String,
    is_raser: bool,
    metadata: Map<String, Value>,
    delimiter: char,
    header_row: usize,
    /// Human-readable delimiter / source description.
    delimiter_desc: String,
    file_type: String,
    sheets: Vec<String>,
    sheet: Option<String>,
    quoting: bool,
}

pub const EXCEL_EXTENSIONS: &[&str] = &["xlsx", "xlsm", "xlsb", "xls", "ods"];

pub fn is_excel(path: &Path) -> bool {
    path.extension()
        .map(|e| EXCEL_EXTENSIONS.contains(&e.to_string_lossy().to_lowercase().as_str()))
        .unwrap_or(false)
}

fn cell_to_string(c: &calamine::Data) -> String {
    use calamine::Data;
    let s = match c {
        Data::Empty | Data::Error(_) => String::new(),
        Data::String(s) => s.clone(),
        Data::Float(f) => {
            if f.fract() == 0.0 && f.abs() < 1e15 {
                format!("{}", *f as i64)
            } else {
                format!("{f}")
            }
        }
        Data::Int(i) => i.to_string(),
        Data::Bool(b) => if *b { "TRUE".into() } else { "FALSE".into() },
        Data::DateTime(dt) => match dt.as_datetime() {
            Some(t) => t.format("%Y-%m-%d %H:%M:%S%.3f").to_string(),
            None => dt.as_f64().to_string(),
        },
        Data::DateTimeIso(s) | Data::DurationIso(s) => s.clone(),
    };
    s.replace(['\t', '\n', '\r'], " ")
}

/// Reads one worksheet into tab-separated text (trailing empty cells trimmed per row),
/// so spreadsheets go through the same header / metadata detection as text files.
fn excel_to_text(path: &Path, sheet: Option<&str>) -> Result<(String, Vec<String>, String), String> {
    use calamine::{open_workbook_auto, Reader};
    let mut wb = open_workbook_auto(path).map_err(|e| format!("Cannot open workbook {}: {e}", path.display()))?;
    let sheets = wb.sheet_names().to_vec();
    if sheets.is_empty() {
        return Err("Workbook contains no worksheets".into());
    }
    let pick: Vec<String> = match sheet {
        Some(s) if sheets.iter().any(|x| x == s) => vec![s.to_string()],
        Some(s) => return Err(format!("Worksheet '{s}' not found")),
        None => sheets.clone(),
    };
    // Default: first sheet that contains data.
    for name in pick {
        let range = wb.worksheet_range(&name).map_err(|e| format!("Cannot read sheet '{name}': {e}"))?;
        if range.is_empty() {
            continue;
        }
        let mut text = String::new();
        for row in range.rows() {
            let mut cells: Vec<String> = row.iter().map(cell_to_string).collect();
            while cells.last().map(|c| c.trim().is_empty()).unwrap_or(false) {
                cells.pop();
            }
            text.push_str(&cells.join("\t"));
            text.push('\n');
        }
        return Ok((text, sheets, name));
    }
    Err("Workbook contains no data".into())
}

/// Whitespace-separated text (e.g. .txt / .dat exports): every data line has the same
/// number (> 1) of whitespace-separated fields.
fn looks_whitespace_delimited(lines: &[String]) -> bool {
    let data: Vec<&String> = lines.iter().filter(|l| !l.trim().is_empty() && !l.starts_with('#')).collect();
    if data.len() < 2 {
        return false;
    }
    let tail = &data[data.len().saturating_sub(10)..];
    let counts: Vec<usize> = tail.iter().map(|l| l.split_whitespace().count()).collect();
    counts.iter().all(|&c| c > 1 && c == counts[0])
}

fn delimiter_consistent(d: char, lines: &[String]) -> bool {
    let data: Vec<&String> = lines.iter().filter(|l| !l.trim().is_empty()).collect();
    let tail = &data[data.len().saturating_sub(10)..];
    !tail.is_empty() && tail.iter().all(|l| l.matches(d).count() > 0)
}

fn detect(path: &Path, sheet: Option<&str>, opts: &ImportOptions) -> Result<Detected, String> {
    if !path.exists() {
        return Err(format!("File not found: {}", path.display()));
    }
    if is_excel(path) {
        let (text, sheets, name) = excel_to_text(path, sheet)?;
        let head = head_lines(&text, HEAD_LINES);
        let (is_raser, metadata) = detect_raser_format(&head);
        let header_row = opts.header_row.unwrap_or_else(|| find_header_row(&head, '\t'));
        return Ok(Detected {
            encoding: "binary (spreadsheet)".into(),
            text,
            is_raser,
            metadata,
            delimiter: '\t',
            header_row,
            delimiter_desc: format!("worksheet '{name}'"),
            file_type: "Excel workbook".into(),
            sheets,
            sheet: Some(name),
            quoting: false,
        });
    }
    let raw = std::fs::read(path).map_err(|e| format!("Cannot read {}: {e}", path.display()))?;
    let encoding = detect_encoding_bytes(&raw);
    let mut text = decode_bytes(&raw, &encoding);
    let mut head = head_lines(&text, HEAD_LINES);
    let (is_raser, metadata) = detect_raser_format(&head);
    let forced = opts.delimiter.as_deref().filter(|d| !d.is_empty() && *d != "auto");
    let mut delimiter = match forced {
        Some("\\t") | Some("\t") | Some("tab") => '\t',
        Some(" ") | Some("whitespace") => ' ',
        Some(d) => d.chars().next().unwrap(),
        None => detect_delimiter(&head, is_raser),
    };
    let mut delimiter_desc = delimiter_label(delimiter);
    let want_ws = delimiter == ' ' || (forced.is_none() && !is_raser && !delimiter_consistent(delimiter, &head) && looks_whitespace_delimited(&head));
    if want_ws {
        // Normalise runs of blanks to single tabs.
        text = text.lines().map(|l| l.split_whitespace().collect::<Vec<_>>().join("\t")).collect::<Vec<_>>().join("\n");
        head = head_lines(&text, HEAD_LINES);
        delimiter = '\t';
        delimiter_desc = "whitespace".into();
    }
    let header_row = opts.header_row.unwrap_or_else(|| find_header_row(&head, delimiter));
    let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    let file_type = match ext.as_str() {
        "csv" => "CSV",
        "tsv" | "tab" => "TSV",
        "txt" | "dat" | "log" | "asc" => "Text",
        _ => "Delimited text",
    };
    Ok(Detected {
        encoding,
        text,
        is_raser,
        metadata,
        delimiter,
        header_row,
        delimiter_desc,
        file_type: file_type.into(),
        sheets: vec![],
        sheet: None,
        quoting: true,
    })
}

pub fn delimiter_label(d: char) -> String {
    match d {
        '\t' => "\\t".into(),
        c => c.to_string(),
    }
}

fn table_spec<'a>(det: &Detected, opts: &'a ImportOptions) -> TableSpec<'a> {
    let data_start = opts.data_start.unwrap_or(if opts.no_header { det.header_row } else { det.header_row + 1 });
    TableSpec { header_row: det.header_row, no_header: opts.no_header, data_start, skip_rows: &opts.skip_rows }
}

/// Column typing shared by preview and parse: (numeric columns, time column index).
fn classify(table: &RawTable, decimal_comma: bool, opts: &ImportOptions) -> (Vec<usize>, HashMap<usize, Vec<f64>>, Option<usize>) {
    let ncol = table.headers.len();
    let cols: Vec<usize> = (0..ncol)
        .filter(|c| !opts.skip_columns.contains(c))
        .filter(|&c| table.rows.iter().any(|r| !is_na(r[c].trim())))
        .collect();
    let mut numeric: HashMap<usize, Vec<f64>> = HashMap::new();
    for &c in &cols {
        let mut vals = Vec::with_capacity(table.rows.len());
        let mut ok = true;
        for r in &table.rows {
            let v = r[c].trim();
            if is_na(v) {
                vals.push(f64::NAN);
            } else if let Some(x) = parse_number(v, decimal_comma) {
                vals.push(x);
            } else {
                ok = false;
                break;
            }
        }
        if ok {
            numeric.insert(c, vals);
        }
    }
    let ts_col = match opts.time_column {
        Some(k) if k < 0 => None,
        Some(k) => Some(k as usize).filter(|k| cols.contains(k)),
        None => cols.iter().copied().find(|&c| is_time_name(&table.headers[c])).or_else(|| cols.first().copied().filter(|c| !numeric.contains_key(c))),
    };
    (cols, numeric, ts_col)
}

/// A non-numeric column whose values are mostly not numbers (labels, states, IDs).
fn is_text_column(table: &RawTable, c: usize, decimal_comma: bool) -> bool {
    let values: Vec<&str> = table.rows.iter().map(|r| r[c].trim()).filter(|s| !is_na(s)).collect();
    let num_ok = values.iter().filter(|s| parse_number(s, decimal_comma).is_some()).count();
    !values.is_empty() && (num_ok as f64) / (table.rows.len().max(1) as f64) < 0.5
}

/// Reads the first 100 rows for the File tab preview (with the effective import settings).
pub fn preview_file_with(path: &Path, sheet: Option<&str>, opts: &ImportOptions) -> Result<PreviewResult, String> {
    if super::formats::is_binary(path) {
        return super::formats::preview(path);
    }
    let det = detect(path, sheet, opts)?;
    let spec = table_spec(&det, opts);
    let table = read_table(&det.text, &spec, det.delimiter, Some(100), det.quoting)?;
    let (cols, numeric, ts) = classify(&table, det.delimiter != ',', opts);
    let skipped: Vec<usize> = (0..table.headers.len()).filter(|c| !cols.contains(c)).collect();
    let mut numeric_cols: Vec<usize> = numeric.keys().copied().filter(|c| Some(*c) != ts).collect();
    numeric_cols.sort();
    let text_cols: Vec<usize> = cols.iter().copied().filter(|c| Some(*c) != ts && !numeric.contains_key(c) && is_text_column(&table, *c, det.delimiter != ',')).collect();
    let raw = raw_grid(&det.text, det.delimiter, det.quoting, RAW_PREVIEW_LINES);
    Ok(PreviewResult {
        encoding: det.encoding,
        delimiter: det.delimiter_desc,
        header_row: det.header_row,
        is_raser_format: det.is_raser,
        metadata: det.metadata,
        headers: table.headers.clone(),
        rows: table.rows.iter().map(|r| r.iter().map(|c| c.trim().to_string()).collect()).collect(),
        file_type: det.file_type,
        sheets: det.sheets,
        sheet: det.sheet,
        n_lines: det.text.lines().count(),
        raw,
        data_start: spec.data_start,
        no_header: opts.no_header,
        time_column_index: ts,
        time_column: ts.map(|c| table.headers[c].clone()),
        skipped_columns: skipped,
        numeric_columns: numeric_cols,
        text_columns: text_cols,
    })
}

pub fn preview_file(path: &Path, sheet: Option<&str>) -> Result<PreviewResult, String> {
    preview_file_with(path, sheet, &ImportOptions::default())
}

pub fn preview_csv(path: &Path) -> Result<PreviewResult, String> {
    preview_file(path, None)
}

pub fn parse_csv(path: &Path) -> Result<ParseResult, String> {
    parse_file(path, None)
}

/// Parses CSV / TSV / TXT (any delimiter, incl. whitespace) and Excel workbooks.
pub fn parse_file(path: &Path, sheet: Option<&str>) -> Result<ParseResult, String> {
    parse_file_with(path, sheet, &ImportOptions::default())
}

/// Parses with user overrides for header row, data start, ignored rows/columns, delimiter and time column.
pub fn parse_file_with(path: &Path, sheet: Option<&str>, opts: &ImportOptions) -> Result<ParseResult, String> {
    if super::formats::is_binary(path) {
        return super::formats::parse(path);
    }
    let det = detect(path, sheet, opts)?;
    let mut metadata = det.metadata.clone();
    let spec = table_spec(&det, opts);
    let table = read_table(&det.text, &spec, det.delimiter, None, det.quoting)?;
    let n_rows = table.rows.len();
    let ncol = table.headers.len();
    let decimal_comma = det.delimiter != ',';

    let (cols, mut numeric, mut ts_col) = classify(&table, decimal_comma, opts);
    let _ = ncol;
    let mut time: Option<Vec<f64>> = None;
    let mut time_origin: Option<f64> = None;
    if let Some(c) = ts_col {
        if let Some(vals) = numeric.get(&c) {
            // Numeric time column (seconds) is used as the time axis directly.
            time = Some(vals.clone());
        } else {
            let parsed: Vec<Option<NaiveDateTime>> = table.rows.iter().map(|r| parse_timestamp(&r[c])).collect();
            let ok = parsed.iter().filter(|p| p.is_some()).count();
            if ok as f64 > parsed.len() as f64 * 0.5 {
                let epoch = parsed.iter().flatten().next().copied();
                // Template semantics: relative to the first row's timestamp.
                let epoch = parsed.first().copied().flatten().or(epoch).unwrap();
                let utc = epoch.and_utc();
                time_origin = Some(utc.timestamp() as f64 + utc.timestamp_subsec_nanos() as f64 * 1e-9);
                time = Some(parsed.iter().map(|p| p.map(|t| seconds_since(&t, &epoch)).unwrap_or(f64::NAN)).collect());
            } else {
                ts_col = None;
            }
        }
    }

    // Non-numeric columns with < 50 % numeric content become text columns (and are listed in metadata).
    let mut text_columns = Vec::new();
    for &c in &cols {
        if Some(c) == ts_col || numeric.contains_key(&c) {
            continue;
        }
        let values: Vec<&str> = table.rows.iter().map(|r| r[c].trim()).filter(|s| !is_na(s)).collect();
        let num_ok = values.iter().filter(|s| parse_number(s, decimal_comma).is_some()).count();
        if (num_ok as f64) / (n_rows.max(1) as f64) < 0.5 {
            let mut uniq: Vec<String> = Vec::new();
            for v in values {
                if !uniq.iter().any(|u| u == v) {
                    uniq.push(v.to_string());
                    if uniq.len() >= 200 {
                        break;
                    }
                }
            }
            if !uniq.is_empty() {
                text_columns.push((
                    table.headers[c].clone(),
                    table.rows.iter().map(|r| { let v = r[c].trim(); if is_na(v) { String::new() } else { v.to_string() } }).collect(),
                ));
                metadata.insert(
                    format!("column_{}", table.headers[c]),
                    Value::Array(uniq.into_iter().map(Value::String).collect()),
                );
            }
        }
    }

    let columns = cols
        .iter()
        .filter(|&&c| Some(c) != ts_col)
        .filter_map(|&c| numeric.remove(&c).map(|v| (table.headers[c].clone(), v)))
        .collect();

    Ok(ParseResult {
        columns,
        time_column: ts_col.map(|c| table.headers[c].clone()),
        time,
        time_origin,
        text_columns,
        metadata,
        header_row: det.header_row,
        delimiter: det.delimiter,
        encoding: det.encoding,
        is_raser_format: det.is_raser,
        n_rows,
        delimiter_desc: det.delimiter_desc,
        file_type: det.file_type,
        sheet: det.sheet,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_temp(content: &str) -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        let id = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        p.push(format!("da_test_{id}_{}.csv", content.len()));
        let mut f = std::fs::File::create(&p).unwrap();
        f.write_all(content.as_bytes()).unwrap();
        p
    }

    #[test]
    fn utf8_detected() {
        let p = write_temp("a,b,c\n1,2,3\n");
        assert!(detect_encoding(&p).unwrap().contains("utf"));
        std::fs::remove_file(p).ok();
    }

    #[test]
    fn raser_detected() {
        let lines: Vec<String> = ["sep=;", "Log V1.1", "User:TESTER", "Description:Test run", "", "Timestamp;Signal_A [V];Signal_B [mA];"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let (is_raser, meta) = detect_raser_format(&lines);
        assert!(is_raser);
        assert_eq!(meta["User"], "TESTER");
        assert_eq!(meta["format"], "RaserDataLog");
    }

    #[test]
    fn non_raser() {
        let lines: Vec<String> = vec!["a,b,c".into(), "1,2,3".into()];
        assert!(!detect_raser_format(&lines).0);
    }

    #[test]
    fn simple_csv() {
        let p = write_temp("x,y,z\n1.0,2.0,3.0\n4.0,5.0,6.0\n7.0,8.0,9.0\n");
        let r = parse_csv(&p).unwrap();
        assert_eq!(r.n_rows, 3);
        assert_eq!(r.delimiter, ',');
        assert!(!r.is_raser_format);
        assert_eq!(r.columns.len(), 3);
        std::fs::remove_file(p).ok();
    }

    #[test]
    fn semicolon_csv() {
        let p = write_temp("a;b;c\n1;2;3\n4;5;6\n");
        let r = parse_csv(&p).unwrap();
        assert_eq!(r.delimiter, ';');
        assert_eq!(r.columns.len(), 3);
        std::fs::remove_file(p).ok();
    }

    #[test]
    fn raser_csv() {
        let p = write_temp(
            "sep=;\nLog V1.1\nUser:TEST\nDescription:Unit test\n\nTimestamp;Signal_A [V];Signal_B [mA]\n2024 01 01 00:00:00:000;1.5;2.5\n2024 01 01 00:00:01:000;1.6;2.6\n",
        );
        let r = parse_csv(&p).unwrap();
        assert!(r.is_raser_format);
        assert!(r.metadata.contains_key("User"));
        assert_eq!(r.n_rows, 2);
        assert_eq!(r.time.as_ref().unwrap(), &vec![0.0, 1.0]);
        std::fs::remove_file(p).ok();
    }

    #[test]
    fn file_not_found() {
        assert!(parse_csv(Path::new("/nonexistent/path.csv")).is_err());
    }

    #[test]
    fn timestamp_formats() {
        let t = parse_timestamp("2024 01 01 00:00:01:001").unwrap();
        assert_eq!(t.and_utc().timestamp_subsec_millis(), 1);
        assert!(parse_timestamp("2024-01-01 10:00:00.5").is_some());
        assert!(parse_timestamp("31.12.2024 23:59:59").is_some());
        assert!(parse_timestamp("abc").is_none());
        assert!(parse_timestamp("1.5").is_none());
    }

    #[test]
    fn decimal_comma_semicolon() {
        let p = write_temp("a;b\n1,5;2,5\n3,5;4,5\n");
        let r = parse_csv(&p).unwrap();
        assert_eq!(r.delimiter, ';');
        assert_eq!(r.columns[0].1, vec![1.5, 3.5]);
        std::fs::remove_file(p).ok();
    }

    #[test]
    fn whitespace_txt() {
        let p = write_temp("time  temp   pressure\n0.0  20.1  1.0\n1.0  20.3  1.1\n2.0  20.2  1.2\n");
        let r = parse_csv(&p).unwrap();
        assert_eq!(r.delimiter_desc, "whitespace");
        assert_eq!(r.columns.len(), 2);
        assert_eq!(r.time.as_ref().unwrap(), &vec![0.0, 1.0, 2.0]);
        std::fs::remove_file(p).ok();
    }

    #[test]
    fn tab_txt() {
        let p = write_temp("a\tb\n1\t2\n3\t4\n");
        let r = parse_csv(&p).unwrap();
        assert_eq!(r.delimiter, '\t');
        assert_eq!(r.columns.len(), 2);
        std::fs::remove_file(p).ok();
    }

    #[test]
    fn string_column_to_metadata() {
        let p = write_temp("t,v,reason\n1,2,ok\n2,3,stop\n");
        let r = parse_csv(&p).unwrap();
        assert!(r.metadata.contains_key("column_reason"));
        assert_eq!(r.columns.len(), 1);
        assert_eq!(r.time_column.as_deref(), Some("t"));
        std::fs::remove_file(p).ok();
    }
}

#[cfg(test)]
mod excel_tests {
    use super::*;
    use rust_xlsxwriter::{ExcelDateTime, Format, Workbook};

    #[test]
    fn xlsx_with_metadata_dates_and_two_sheets() {
        let mut p = std::env::temp_dir();
        p.push(format!("da_test_{}.xlsx", std::process::id()));
        let mut wb = Workbook::new();
        let empty = wb.add_worksheet();
        empty.set_name("Empty").unwrap();
        let ws = wb.add_worksheet();
        ws.set_name("Run1").unwrap();
        ws.write(0, 0, "User: TEST").unwrap();
        ws.write(1, 0, "Description: bench").unwrap();
        for (c, h) in ["Timestamp", "Torque [Nm]", "Speed [rpm]", "Note"].iter().enumerate() {
            ws.write(3, c as u16, *h).unwrap();
        }
        let fmt = Format::new().set_num_format("yyyy-mm-dd hh:mm:ss");
        for r in 0..5u32 {
            let dt = ExcelDateTime::from_ymd(2024, 1, 1).unwrap().and_hms(0, 0, r as u16).unwrap();
            ws.write_datetime_with_format(4 + r, 0, &dt, &fmt).unwrap();
            ws.write(4 + r, 1, 1.5 + r as f64).unwrap();
            ws.write(4 + r, 2, 1500.0 + r as f64).unwrap();
            ws.write(4 + r, 3, "ok").unwrap();
        }
        let other = wb.add_worksheet();
        other.set_name("Run2").unwrap();
        other.write(0, 0, "x").unwrap();
        other.write(0, 1, "y").unwrap();
        other.write(1, 0, 1.0).unwrap();
        other.write(1, 1, 2.0).unwrap();
        other.write(2, 0, 2.0).unwrap();
        other.write(2, 1, 3.0).unwrap();
        wb.save(&p).unwrap();

        let prev = preview_file(&p, None).unwrap();
        assert_eq!(prev.sheets, vec!["Empty", "Run1", "Run2"]);
        assert_eq!(prev.sheet.as_deref(), Some("Run1"));
        assert_eq!(prev.header_row, 3);
        assert_eq!(prev.headers[1], "Torque [Nm]");

        let r = parse_file(&p, None).unwrap();
        assert_eq!(r.n_rows, 5);
        assert_eq!(r.columns.len(), 2);
        assert_eq!(r.time.as_ref().unwrap(), &vec![0.0, 1.0, 2.0, 3.0, 4.0]);
        assert!(r.metadata.contains_key("column_Note"));

        let r2 = parse_file(&p, Some("Run2")).unwrap();
        assert_eq!(r2.columns.len(), 2);
        assert_eq!(r2.n_rows, 2);
        std::fs::remove_file(p).ok();
    }
}

#[cfg(test)]
mod import_option_tests {
    use super::*;
    use std::io::Write;

    fn write_temp(name: &str, content: &str) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("da_opt_{}_{name}", std::process::id()));
        std::fs::File::create(&p).unwrap().write_all(content.as_bytes()).unwrap();
        p
    }

    #[test]
    fn header_wider_than_data() {
        let p = write_temp("wide.csv", "Time (s),Force (mN),Counts,Time to connect (s),0.152\n0.0,99.0,3563.0\n0.02,103.0,3560.0\n0.04,84.0,3557.0\n");
        let r = parse_file(&p, None).unwrap();
        assert_eq!(r.header_row, 0);
        assert_eq!(r.time_column.as_deref(), Some("Time (s)"));
        assert_eq!(r.columns.len(), 2);
        assert_eq!(r.time.as_ref().unwrap(), &vec![0.0, 0.02, 0.04]);
        std::fs::remove_file(p).ok();
    }

    #[test]
    fn manual_header_data_start_skips() {
        let p = write_temp("manual.csv", "junk line\nanother,junk\nA,B,C\nunits,V,mA\n1,2,3\n4,5,6\n7,8,9\n");
        let opts = ImportOptions { header_row: Some(2), data_start: Some(4), skip_rows: vec![5], skip_columns: vec![2], time_column: Some(-1), ..Default::default() };
        let r = parse_file_with(&p, None, &opts).unwrap();
        assert_eq!(r.n_rows, 2);
        assert_eq!(r.columns.iter().map(|c| c.0.as_str()).collect::<Vec<_>>(), vec!["A", "B"]);
        assert_eq!(r.columns[0].1, vec![1.0, 7.0]);
        assert!(r.time.is_none());
        let prev = preview_file_with(&p, None, &opts).unwrap();
        assert_eq!(prev.skipped_columns, vec![2]);
        assert_eq!(prev.raw.len(), 7);
        std::fs::remove_file(p).ok();
    }

    #[test]
    fn crlf_keeps_first_data_row() {
        let p = write_temp("crlf.csv", &["Time (s),Force (mN),x,extra,0.15", "0.0,99.0,1", "0.02,103.0,2", ""].join("\r\n"));
        let r = parse_file(&p, None).unwrap();
        assert_eq!(r.n_rows, 2);
        assert_eq!(r.time.as_ref().unwrap()[0], 0.0);
        let prev = preview_file(&p, None).unwrap();
        assert_eq!(prev.rows[0][1], "99.0");
        std::fs::remove_file(p).ok();
    }

    #[test]
    fn no_header_and_forced_delimiter() {
        let p = write_temp("nohdr.txt", "1;2;3\n4;5;6\n");
        let opts = ImportOptions { no_header: true, data_start: Some(0), delimiter: Some(";".into()), time_column: Some(0), ..Default::default() };
        let r = parse_file_with(&p, None, &opts).unwrap();
        assert_eq!(r.n_rows, 2);
        assert_eq!(r.columns.len(), 2);
        assert_eq!(r.time.as_ref().unwrap(), &vec![1.0, 4.0]);
        std::fs::remove_file(p).ok();
    }
}
