//! Readers for binary data formats: Parquet, MATLAB (.mat v5, and v7.3 through HDF5), HDF5 and
//! LabVIEW TDMS. Each produces the same `ParseResult` as the text/Excel parser, so imports,
//! alignment and recipes treat every format alike. All readers are pure Rust.

use serde_json::{Map, Value};
use std::path::Path;

use super::csv_parser::{is_time_name, ParseResult, PreviewResult};

pub const BINARY_EXTENSIONS: &[&str] = &["parquet", "mat", "h5", "hdf5", "tdms"];

/// Arrays with more columns than this are not split into channels (images, matrices).
const MAX_SPLIT: usize = 64;

pub fn is_binary(path: &Path) -> bool {
    path.extension().is_some_and(|e| BINARY_EXTENSIONS.contains(&e.to_string_lossy().to_lowercase().as_str()))
}

/// Columns collected from a file before they become a `ParseResult`.
#[derive(Default)]
struct Columns {
    numeric: Vec<(String, Vec<f64>)>,
    text: Vec<(String, Vec<String>)>,
    /// Datetime columns as Unix seconds.
    datetime: Vec<(String, Vec<f64>)>,
    /// Time base from file metadata (e.g. TDMS waveform increment), seconds per sample.
    increment: Option<f64>,
    metadata: Map<String, Value>,
}

impl Columns {
    fn finish(mut self, file_type: &str) -> Result<ParseResult, String> {
        let n_rows = self
            .numeric
            .iter()
            .map(|(_, v)| v.len())
            .chain(self.text.iter().map(|(_, v)| v.len()))
            .chain(self.datetime.iter().map(|(_, v)| v.len()))
            .max()
            .unwrap_or(0);
        if n_rows == 0 {
            return Err(format!("No numeric data found in this {file_type} file."));
        }
        for (_, v) in self.numeric.iter_mut().chain(self.datetime.iter_mut()) {
            v.resize(n_rows, f64::NAN);
        }
        for (_, v) in &mut self.text {
            v.resize(n_rows, String::new());
        }
        // Time axis: a datetime column, else a numeric column named like time, else the
        // metadata increment.
        let (mut time, mut time_column, mut time_origin) = (None, None, None);
        if let Some((name, v)) = self.datetime.first() {
            let t0 = v.iter().copied().find(|x| x.is_finite()).unwrap_or(0.0);
            time = Some(v.iter().map(|x| x - t0).collect::<Vec<f64>>());
            time_column = Some(name.clone());
            time_origin = Some(t0);
        } else if let Some(k) = self.numeric.iter().position(|(n, _)| is_time_name(n.rsplit('/').next().unwrap_or(n))) {
            let (name, v) = self.numeric.remove(k);
            time = Some(v);
            time_column = Some(name);
        } else if let Some(dt) = self.increment.filter(|d| *d > 0.0) {
            time = Some((0..n_rows).map(|i| i as f64 * dt).collect());
        }
        if self.numeric.is_empty() && self.text.is_empty() {
            return Err(format!("No numeric data found in this {file_type} file."));
        }
        Ok(ParseResult {
            columns: self.numeric,
            time_column,
            time,
            time_origin,
            text_columns: self.text,
            metadata: self.metadata,
            header_row: 0,
            delimiter: ',',
            encoding: "binary".into(),
            is_raser_format: false,
            n_rows,
            delimiter_desc: "—".into(),
            file_type: file_type.into(),
            sheet: None,
        })
    }
}

pub fn parse(path: &Path) -> Result<ParseResult, String> {
    let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    match ext.as_str() {
        "parquet" => parquet(path)?.finish("Parquet"),
        "mat" => match matlab(path) {
            Ok(c) => c.finish("MATLAB"),
            // MATLAB v7.3 files are HDF5 containers.
            Err(e) => hdf5(path).map_err(|_| e)?.finish("MATLAB v7.3"),
        },
        "h5" | "hdf5" => hdf5(path)?.finish("HDF5"),
        "tdms" => tdms(path)?.finish("TDMS"),
        _ => Err(format!("Unsupported file type: .{ext}")),
    }
}

/// Preview for the import page: the first 100 rows of every column.
pub fn preview(path: &Path) -> Result<PreviewResult, String> {
    let p = parse(path)?;
    let mut headers = Vec::new();
    let mut cells: Vec<Vec<String>> = Vec::new();
    let fmt = |x: f64| if x.is_finite() { format!("{}", (x * 1e9).round() / 1e9) } else { String::new() };
    let rows = p.n_rows.min(100);
    let mut time_column_index = None;
    if let (Some(name), Some(t)) = (&p.time_column, &p.time) {
        time_column_index = Some(0);
        headers.push(name.clone());
        cells.push(match p.time_origin {
            Some(o) => t[..rows]
                .iter()
                .map(|x| chrono::DateTime::from_timestamp_millis(((o + x) * 1000.0).round() as i64).map(|d| d.naive_utc().to_string()).unwrap_or_default())
                .collect(),
            None => t[..rows].iter().map(|x| fmt(*x)).collect(),
        });
    }
    let first_numeric = headers.len();
    for (name, v) in &p.columns {
        headers.push(name.clone());
        cells.push(v[..rows].iter().map(|x| fmt(*x)).collect());
    }
    let first_text = headers.len();
    for (name, v) in &p.text_columns {
        headers.push(name.clone());
        cells.push(v[..rows].to_vec());
    }
    let rows_out: Vec<Vec<String>> = (0..rows).map(|r| cells.iter().map(|c| c[r].clone()).collect()).collect();
    Ok(PreviewResult {
        encoding: p.encoding,
        delimiter: "—".into(),
        header_row: 0,
        is_raser_format: false,
        metadata: p.metadata,
        raw: std::iter::once(headers.clone()).chain(rows_out.iter().take(20).cloned()).collect(),
        headers,
        rows: rows_out,
        file_type: p.file_type,
        sheets: vec![],
        sheet: None,
        n_lines: p.n_rows + 1,
        data_start: 1,
        no_header: false,
        time_column_index,
        time_column: p.time_column,
        skipped_columns: vec![],
        numeric_columns: (first_numeric..first_text).collect(),
        text_columns: (first_text..first_text + p.text_columns.len()).collect(),
    })
}

/// Splits a column-major (or row-major) 2-D array into named columns.
fn split_2d(cols: &mut Columns, name: &str, data: &[f64], rows: usize, ncols: usize, column_major: bool) {
    if ncols == 1 || rows == 1 {
        cols.numeric.push((name.to_string(), data.to_vec()));
        return;
    }
    let (n, k, transposed) = if rows >= ncols { (rows, ncols, false) } else { (ncols, rows, true) };
    if k > MAX_SPLIT {
        cols.metadata.insert(format!("skipped {name}"), Value::String(format!("{rows}×{ncols} array")));
        return;
    }
    for j in 0..k {
        let column: Vec<f64> = (0..n)
            .map(|i| {
                let (r, c) = if transposed { (j, i) } else { (i, j) };
                if column_major { data[r + c * rows] } else { data[r * ncols + c] }
            })
            .collect();
        cols.numeric.push((format!("{name}[{}]", j + 1), column));
    }
}

// -- Parquet ------------------------------------------------------------------

fn parquet(path: &Path) -> Result<Columns, String> {
    use parquet::file::reader::{FileReader, SerializedFileReader};
    use parquet::record::Field;
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let reader = SerializedFileReader::new(file).map_err(|e| format!("Not a Parquet file: {e}"))?;
    let n = reader.metadata().file_metadata().num_rows().max(0) as usize;
    let schema = reader.metadata().file_metadata().schema_descr_ptr();
    // Column kinds are decided from the first non-null value of each column.
    enum Kind {
        Num(Vec<f64>),
        Text(Vec<String>),
        Time(Vec<f64>),
        Unknown,
    }
    let names: Vec<String> = schema.columns().iter().map(|c| c.path().string()).collect();
    let mut kinds: Vec<Kind> = names.iter().map(|_| Kind::Unknown).collect();
    let mut row_index = 0;
    for row in reader.into_iter() {
        let row = row.map_err(|e| e.to_string())?;
        for (k, (_, field)) in row.get_column_iter().enumerate() {
            let Some(kind) = kinds.get_mut(k) else { continue };
            let num = match field {
                Field::Bool(b) => Some(*b as u8 as f64),
                Field::Byte(x) => Some(*x as f64),
                Field::Short(x) => Some(*x as f64),
                Field::Int(x) => Some(*x as f64),
                Field::Long(x) => Some(*x as f64),
                Field::UByte(x) => Some(*x as f64),
                Field::UShort(x) => Some(*x as f64),
                Field::UInt(x) => Some(*x as f64),
                Field::ULong(x) => Some(*x as f64),
                Field::Float(x) => Some(*x as f64),
                Field::Double(x) => Some(*x),
                Field::Float16(x) => Some(f64::from(*x)),
                _ => None,
            };
            let time = match field {
                Field::Date(d) => Some(*d as f64 * 86_400.0),
                Field::TimestampMillis(ms) => Some(*ms as f64 / 1e3),
                Field::TimestampMicros(us) => Some(*us as f64 / 1e6),
                _ => None,
            };
            let text = match field {
                Field::Str(s) => Some(s.clone()),
                _ => None,
            };
            if matches!(kind, Kind::Unknown) && !matches!(field, Field::Null) {
                *kind = if time.is_some() {
                    Kind::Time(vec![f64::NAN; row_index])
                } else if num.is_some() {
                    Kind::Num(vec![f64::NAN; row_index])
                } else if text.is_some() {
                    Kind::Text(vec![String::new(); row_index])
                } else {
                    Kind::Unknown
                };
            }
            match kind {
                Kind::Num(v) => v.push(num.unwrap_or(f64::NAN)),
                Kind::Time(v) => v.push(time.unwrap_or(f64::NAN)),
                Kind::Text(v) => v.push(text.unwrap_or_default()),
                Kind::Unknown => {}
            }
        }
        row_index += 1;
    }
    let mut cols = Columns::default();
    for (name, kind) in names.into_iter().zip(kinds) {
        match kind {
            Kind::Num(v) => cols.numeric.push((name, v)),
            Kind::Text(v) => cols.text.push((name, v)),
            Kind::Time(v) => cols.datetime.push((name, v)),
            Kind::Unknown => {}
        }
    }
    cols.metadata.insert("rows".into(), Value::from(n));
    Ok(cols)
}

// -- MATLAB -------------------------------------------------------------------

fn matlab(path: &Path) -> Result<Columns, String> {
    use matfile::NumericData as D;
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mat = matfile::MatFile::parse(std::io::BufReader::new(file)).map_err(|e| format!("Cannot read MATLAB file: {e:?}"))?;
    let mut cols = Columns::default();
    for a in mat.arrays() {
        let data: Vec<f64> = match a.data() {
            D::Double { real, .. } => real.clone(),
            D::Single { real, .. } => real.iter().map(|x| *x as f64).collect(),
            D::Int8 { real, .. } => real.iter().map(|x| *x as f64).collect(),
            D::UInt8 { real, .. } => real.iter().map(|x| *x as f64).collect(),
            D::Int16 { real, .. } => real.iter().map(|x| *x as f64).collect(),
            D::UInt16 { real, .. } => real.iter().map(|x| *x as f64).collect(),
            D::Int32 { real, .. } => real.iter().map(|x| *x as f64).collect(),
            D::UInt32 { real, .. } => real.iter().map(|x| *x as f64).collect(),
            D::Int64 { real, .. } => real.iter().map(|x| *x as f64).collect(),
            D::UInt64 { real, .. } => real.iter().map(|x| *x as f64).collect(),
        };
        let size = a.size();
        if size.len() != 2 {
            cols.metadata.insert(format!("skipped {}", a.name()), Value::String(format!("{}-D array", size.len())));
            continue;
        }
        split_2d(&mut cols, a.name(), &data, size[0], size[1], true);
    }
    Ok(cols)
}

// -- HDF5 ---------------------------------------------------------------------

fn hdf5(path: &Path) -> Result<Columns, String> {
    let file = hdf5_reader::Hdf5File::open(path).map_err(|e| format!("Cannot read HDF5 file: {e}"))?;
    let mut cols = Columns::default();
    let root = file.root_group().map_err(|e| e.to_string())?;
    let mut stack = vec![(String::new(), root)];
    let mut visited = 0;
    while let Some((prefix, group)) = stack.pop() {
        visited += 1;
        if visited > 10_000 {
            break;
        }
        let (groups, datasets) = group.members().map_err(|e| e.to_string())?;
        for g in groups {
            let name = format!("{prefix}/{}", g.name());
            stack.push((name, g));
        }
        for ds in datasets {
            let name = format!("{prefix}/{}", ds.name()).trim_start_matches('/').to_string();
            if let Err(e) = hdf5_dataset(&mut cols, &name, &ds) {
                cols.metadata.insert(format!("skipped {name}"), Value::String(e));
            }
        }
    }
    cols.numeric.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(cols)
}

fn hdf5_dataset(cols: &mut Columns, name: &str, ds: &hdf5_reader::Dataset) -> Result<(), String> {
    use hdf5_reader::Datatype as T;
    let shape: Vec<usize> = ds.shape().iter().map(|d| *d as usize).collect();
    macro_rules! read {
        ($t:ty) => {
            ds.read_array::<$t>().map_err(|e| e.to_string())?.iter().map(|x| *x as f64).collect::<Vec<f64>>()
        };
    }
    let data: Vec<f64> = match ds.dtype() {
        T::FloatingPoint { size: 8, .. } => read!(f64),
        T::FloatingPoint { size: 4, .. } => read!(f32),
        T::FixedPoint { size: 1, signed: true, .. } => read!(i8),
        T::FixedPoint { size: 1, signed: false, .. } => read!(u8),
        T::FixedPoint { size: 2, signed: true, .. } => read!(i16),
        T::FixedPoint { size: 2, signed: false, .. } => read!(u16),
        T::FixedPoint { size: 4, signed: true, .. } => read!(i32),
        T::FixedPoint { size: 4, signed: false, .. } => read!(u32),
        T::FixedPoint { size: 8, signed: true, .. } => read!(i64),
        T::FixedPoint { size: 8, signed: false, .. } => read!(u64),
        T::String { .. } | T::VarLen { .. } => {
            if shape.len() == 1 && shape[0] > 1 {
                cols.text.push((name.to_string(), ds.read_strings().map_err(|e| e.to_string())?));
            }
            return Ok(());
        }
        other => return Err(format!("unsupported type {other:?}")),
    };
    match shape.len() {
        0 => {}
        1 => cols.numeric.push((name.to_string(), data)),
        2 => split_2d(cols, name, &data, shape[0], shape[1], false),
        n => return Err(format!("{n}-D array")),
    }
    Ok(())
}

// -- TDMS ---------------------------------------------------------------------

fn tdms(path: &Path) -> Result<Columns, String> {
    use tdms::data_type::TdmsDataType as T;
    let file = tdms::TDMSFile::from_path(path).map_err(|e| format!("Cannot read TDMS file: {e:?}"))?;
    let mut cols = Columns::default();
    let groups = file.groups();
    let several = groups.len() > 1;
    for group in &groups {
        for (_, channel) in file.channels(group) {
            let short = |s: &str| s.rsplit('/').next().unwrap_or(s).trim_matches('\'').to_string();
            let name = if several { format!("{}/{}", short(&channel.group_path), short(&channel.path)) } else { short(&channel.path) };
            if cols.increment.is_none() {
                cols.increment = channel.properties.iter().find(|p| p.name == "wf_increment").and_then(|p| {
                    let b = p.value.value.as_ref()?;
                    let arr: [u8; 8] = b.get(..8)?.try_into().ok()?;
                    Some(match p.value.endianness {
                        tdms::segment::Endianness::Little => f64::from_le_bytes(arr),
                        tdms::segment::Endianness::Big => f64::from_be_bytes(arr),
                    })
                });
            }
            let label = name.clone();
            let err = move |e: tdms::TdmsError| format!("{label}: {e:?}");
            let data: Vec<f64> = match channel.data_type {
                T::DoubleFloat(_) | T::DoubleFloatWithUnit(_) => file.channel_data_double_float(channel).map_err(err)?.collect(),
                T::SingleFloat(_) | T::SingleFloatWithUnit(_) => file.channel_data_single_float(channel).map_err(err)?.map(|x| x as f64).collect(),
                T::I8(_) => file.channel_data_i8(channel).map_err(err)?.map(|x| x as f64).collect(),
                T::I16(_) => file.channel_data_i16(channel).map_err(err)?.map(|x| x as f64).collect(),
                T::I32(_) => file.channel_data_i32(channel).map_err(err)?.map(|x| x as f64).collect(),
                T::I64(_) => file.channel_data_i64(channel).map_err(err)?.map(|x| x as f64).collect(),
                T::U8(_) => file.channel_data_u8(channel).map_err(err)?.map(|x| x as f64).collect(),
                T::U16(_) => file.channel_data_u16(channel).map_err(err)?.map(|x| x as f64).collect(),
                T::U32(_) => file.channel_data_u32(channel).map_err(err)?.map(|x| x as f64).collect(),
                T::U64(_) => file.channel_data_u64(channel).map_err(err)?.map(|x| x as f64).collect(),
                T::Boolean(_) => file.channel_data_bool(channel).map_err(err)?.map(|x| x as u8 as f64).collect(),
                T::TimeStamp(_) => {
                    // LabVIEW epoch is 1904-01-01; fractions are 2^-64 s.
                    const LABVIEW_TO_UNIX: f64 = 2_082_844_800.0;
                    let v = file.channel_data_timestamp(channel).map_err(err)?.map(|t| t.0 as f64 - LABVIEW_TO_UNIX + t.1 as f64 / 18_446_744_073_709_551_616.0).collect();
                    cols.datetime.push((name, v));
                    continue;
                }
                T::String => {
                    cols.text.push((name, file.channel_data_string(channel).map_err(err)?.collect()));
                    continue;
                }
                _ => {
                    cols.metadata.insert(format!("skipped {name}"), Value::String(format!("{:?}", channel.data_type)));
                    continue;
                }
            };
            if !data.is_empty() {
                cols.numeric.push((name, data));
            }
        }
    }
    Ok(cols)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> std::path::PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/formats").join(name)
    }

    fn col<'a>(p: &'a ParseResult, name: &str) -> &'a Vec<f64> {
        &p.columns.iter().find(|(c, _)| c == name).unwrap_or_else(|| panic!("{name} not in {:?}", p.columns.iter().map(|c| &c.0).collect::<Vec<_>>())).1
    }

    #[test]
    fn parquet_with_timestamps_and_text() {
        let p = parse(&fixture("sample.parquet")).unwrap();
        assert_eq!(p.n_rows, 50);
        assert_eq!(p.time_column.as_deref(), Some("timestamp"));
        assert_eq!(p.time_origin, Some(1_790_845_200.0));
        assert!((p.time.as_ref().unwrap()[10] - 1.0).abs() < 1e-9);
        assert!((col(&p, "pressure")[0] - 5.0).abs() < 1e-12);
        assert_eq!(col(&p, "flow")[3], 13.0);
        assert_eq!(p.text_columns[0].0, "state");
        assert_eq!(p.text_columns[0].1[25], "run");
        assert_eq!(preview(&fixture("sample.parquet")).unwrap().text_columns, vec![3]);
    }

    #[test]
    fn hdf5_groups_and_matrices() {
        let p = parse(&fixture("sample.h5")).unwrap();
        assert_eq!(p.time_column.as_deref(), Some("run/time"));
        assert!((col(&p, "run/pressure")[0] - 5.0).abs() < 1e-6);
        assert_eq!(col(&p, "run/flow")[3], 13.0);
        assert!((col(&p, "matrix[2]")[1] - 2.0 * col(&p, "matrix[1]")[1]).abs() < 1e-12);
    }

    #[test]
    fn matlab_vectors_and_columns() {
        let p = parse(&fixture("sample.mat")).unwrap();
        assert_eq!(p.time_column.as_deref(), Some("t"));
        assert_eq!(p.n_rows, 50);
        assert_eq!(col(&p, "flow")[3], 13.0);
        assert!((col(&p, "xy[2]")[7] + col(&p, "xy[1]")[7]).abs() < 1e-12);
    }

    #[test]
    fn tdms_waveforms() {
        let p = parse(&fixture("sample.tdms")).unwrap();
        assert_eq!(p.n_rows, 50);
        assert!((p.time.as_ref().unwrap()[10] - 1.0).abs() < 1e-12, "time from wf_increment");
        assert!((col(&p, "Pressure")[0] - 5.0).abs() < 1e-12);
        assert_eq!(col(&p, "Flow")[3], 13.0);
    }
}
