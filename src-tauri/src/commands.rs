//! Tauri command layer: thin wrappers that call the core engines.
//! Heavy work runs on blocking worker threads and reports progress via the `progress` event.

use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

use crate::core::cache::CacheManager;
use crate::core::compare::{CompareManager, CompareStatistics};
use crate::core::correlation::{compute_correlation_matrix, compute_cross_correlation, compute_lagged_correlations, CorrelationPair};
use crate::core::csv_parser::{preview_file_with, ImportOptions, PreviewResult};
use crate::core::dataset::{Dataset, DatasetInfo};
use crate::core::downsample::{minmax, stride, window_indices};
use crate::core::dsp::{decimate, mean, searchsorted, std};
use crate::core::filters::{apply_chain, apply_steps, suggest_filters, FilterChain, FilterStep};
use crate::core::models::{ModelSummary, OutputMetrics, StateSpaceResult};
use crate::core::report::{self, ComparisonStat, DataSummary, FilterInfo, ModelInfo, Plot, ReportContent, REPORT_PALETTE};
use crate::core::simulation::simulate;
use crate::core::spectrum::{compute_fft, compute_psd, detect_peaks, PeakInfo};
use crate::core::stats::{compute_descriptive_stats, norm_pdf, StatRow};
use crate::core::svgplot::{self, Panel, Series};
use crate::core::sysid::{estimate_decimation_factor, estimate_time, identify_model, SysIdParams};
use crate::core::validation::validate;
use crate::state::AppState;

type AppStateRef<'a> = State<'a, Arc<AppState>>;
type CmdResult<T> = Result<T, String>;

#[tauri::command]
pub async fn curve_fit(request: crate::core::fitting::FitRequest) -> CmdResult<crate::core::fitting::FitResult> {
    blocking(move || crate::core::fitting::fit(request)).await
}

/// Full vectors retain row correspondence, including missing values.
#[tauri::command]
pub async fn analysis_vectors(state: AppStateRef<'_>, columns: Vec<String>) -> CmdResult<serde_json::Value> {
    let st = state.inner().clone();
    blocking(move || with_data(&st, |d| {
        let mut vectors = serde_json::Map::new();
        for c in columns {
            let values = d.get_signal(&c).ok_or_else(|| format!("Column not found: {c}"))?;
            vectors.insert(c, serde_json::json!(*values));
        }
        Ok(serde_json::json!({"time": *d.time, "columns": vectors}))
    })).await
}


#[derive(Clone, Serialize)]
struct ProgressEvent {
    task: String,
    value: i32,
    message: String,
}

fn emit_progress(app: &AppHandle, task: &str, value: i32, message: impl Into<String>) {
    let _ = app.emit("progress", ProgressEvent { task: task.into(), value, message: message.into() });
}

fn with_data<T>(state: &AppState, f: impl FnOnce(&Dataset) -> CmdResult<T>) -> CmdResult<T> {
    let guard = state.data.read().map_err(|_| "Data lock poisoned")?;
    match guard.as_ref() {
        Some(d) => f(d),
        None => Err("No data loaded.".into()),
    }
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> CmdResult<T> + Send + 'static) -> CmdResult<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

#[derive(Serialize)]
pub struct Xy {
    x: Vec<f64>,
    y: Vec<f64>,
}

// ---------------------------------------------------------------------------
// File loading
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn preview_file(path: String, sheet: Option<String>, options: Option<ImportOptions>) -> CmdResult<PreviewResult> {
    blocking(move || preview_file_with(Path::new(&path), sheet.as_deref(), &options.unwrap_or_default())).await
}

/// Makes `ds` the active dataset, resets dependent results and pre-computes stats/correlations.
fn install_dataset(app: &AppHandle, st: &AppState, ds: Dataset) -> CmdResult<DatasetInfo> {
    if ds.signals.is_empty() {
        return Err("No numeric signals found in file.".into());
    }
    st.cache.invalidate_all();
    let signals = ds.all_signals();
    let info = ds.info();
    *st.data.write().unwrap() = Some(ds);
    *st.correlation.lock().unwrap() = None;
    st.simulations.lock().unwrap().clear();
    *st.validation.lock().unwrap() = None;
    st.sysid_results.lock().unwrap().clear();
    emit_progress(app, "load", 80, "Pre-computing statistics...");
    compute_descriptive_stats(&signals, Some(&st.cache));
    emit_progress(app, "load", 90, "Pre-computing correlations...");
    compute_correlation_matrix(&signals, Some(&st.cache));
    emit_progress(app, "load", 100, "Done.");
    Ok(info)
}

// ---------------------------------------------------------------------------
// Workspace (variables imported from any number of files)
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct WorkspaceView {
    variables: Vec<crate::core::workspace::VariableInfo>,
    time_var: Option<String>,
    dataset: Option<DatasetInfo>,
    added: Vec<String>,
}

/// Rebuilds the analysis dataset from the workspace after every change.
fn sync_workspace(app: &AppHandle, st: &AppState, added: Vec<String>) -> CmdResult<WorkspaceView> {
    let (parse, variables, time_var) = {
        let ws = st.workspace.lock().unwrap();
        (ws.to_parse(), ws.info(), ws.time_var.clone())
    };
    let dataset = match parse {
        Some(p) => Some(install_dataset(app, st, Dataset::from_parse("Workspace", p))?),
        None => {
            *st.data.write().unwrap() = None;
            st.cache.invalidate_all();
            None
        }
    };
    Ok(WorkspaceView { variables, time_var, dataset, added })
}

#[tauri::command]
pub async fn workspace_import(app: AppHandle, state: AppStateRef<'_>, path: String, sheet: Option<String>, options: Option<ImportOptions>, columns: Vec<String>) -> CmdResult<WorkspaceView> {
    let st = state.inner().clone();
    blocking(move || {
        emit_progress(&app, "load", 20, "Reading file...");
        let added = st.workspace.lock().unwrap().import(&path, sheet.as_deref(), &options.unwrap_or_default(), &columns)?;
        sync_workspace(&app, &st, added)
    })
    .await
}

#[tauri::command]
pub fn workspace_view(state: AppStateRef<'_>) -> WorkspaceView {
    let ws = state.workspace.lock().unwrap();
    WorkspaceView { variables: ws.info(), time_var: ws.time_var.clone(), dataset: state.data.read().ok().and_then(|d| d.as_ref().map(|d| d.info())), added: vec![] }
}

#[tauri::command]
pub async fn workspace_remove(app: AppHandle, state: AppStateRef<'_>, names: Vec<String>) -> CmdResult<WorkspaceView> {
    let st = state.inner().clone();
    blocking(move || {
        st.workspace.lock().unwrap().remove(&names);
        sync_workspace(&app, &st, vec![])
    })
    .await
}

#[tauri::command]
pub async fn workspace_rename(app: AppHandle, state: AppStateRef<'_>, old: String, new: String) -> CmdResult<WorkspaceView> {
    let st = state.inner().clone();
    blocking(move || {
        st.workspace.lock().unwrap().rename(&old, &new)?;
        sync_workspace(&app, &st, vec![])
    })
    .await
}

#[tauri::command]
pub async fn workspace_set_time(app: AppHandle, state: AppStateRef<'_>, name: Option<String>) -> CmdResult<WorkspaceView> {
    let st = state.inner().clone();
    blocking(move || {
        st.workspace.lock().unwrap().set_time(name)?;
        sync_workspace(&app, &st, vec![])
    })
    .await
}

/// Edit, reset or duplicate one variable: `action` is "edit" (with `edit`), "reset" or "duplicate".
#[tauri::command]
pub async fn workspace_edit(app: AppHandle, state: AppStateRef<'_>, name: String, action: String, edit: Option<crate::core::workspace::Edit>) -> CmdResult<WorkspaceView> {
    let st = state.inner().clone();
    blocking(move || {
        let mut added = vec![];
        {
            let mut ws = st.workspace.lock().unwrap();
            match action.as_str() {
                "edit" => ws.edit(&name, edit.ok_or("No edit given.")?)?,
                "reset" => ws.reset(&name)?,
                "duplicate" => added.push(ws.duplicate(&name)?),
                other => return Err(format!("Unknown action '{other}'")),
            }
        }
        sync_workspace(&app, &st, added)
    })
    .await
}

#[tauri::command]
pub async fn workspace_clear(app: AppHandle, state: AppStateRef<'_>) -> CmdResult<WorkspaceView> {
    let st = state.inner().clone();
    blocking(move || {
        *st.workspace.lock().unwrap() = Default::default();
        sync_workspace(&app, &st, vec![])
    })
    .await
}

/// Writes the active dataset (time + every signal, filtered where applied) as CSV.
#[tauri::command]
pub async fn export_dataset(state: AppStateRef<'_>, path: String) -> CmdResult<usize> {
    let st = state.inner().clone();
    blocking(move || {
        with_data(&st, |d| {
            use std::io::Write;
            let file = std::fs::File::create(&path).map_err(|e| format!("Cannot write {path}: {e}"))?;
            let mut w = std::io::BufWriter::new(file);
            let signals = d.all_signals();
            let quote = |s: &str| if s.contains([',', '"', '\n']) { format!("\"{}\"", s.replace('"', "\"\"")) } else { s.to_string() };
            let header: Vec<String> = std::iter::once("Time [s]".to_string()).chain(signals.iter().map(|(c, _)| quote(c))).collect();
            writeln!(w, "{}", header.join(",")).map_err(|e| e.to_string())?;
            for (i, t) in d.time.iter().enumerate() {
                let mut line = format!("{t}");
                for (_, v) in &signals {
                    line.push(',');
                    if let Some(x) = v.get(i).filter(|x| x.is_finite()) {
                        line.push_str(&x.to_string());
                    }
                }
                writeln!(w, "{line}").map_err(|e| e.to_string())?;
            }
            w.flush().map_err(|e| e.to_string())?;
            Ok(d.time.len())
        })
    })
    .await
}

#[tauri::command]
pub fn dataset_info(state: AppStateRef<'_>) -> Option<DatasetInfo> {
    state.data.read().ok().and_then(|d| d.as_ref().map(|d| d.info()))
}

#[tauri::command]
pub async fn descriptive_stats(state: AppStateRef<'_>) -> CmdResult<Vec<StatRow>> {
    let st = state.inner().clone();
    blocking(move || {
        let signals = with_data(&st, |d| Ok(d.all_signals()))?;
        Ok(compute_descriptive_stats(&signals, Some(&st.cache)).as_ref().clone())
    })
    .await
}

// ---------------------------------------------------------------------------
// Time series
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct SeriesData {
    column: String,
    x: Vec<f64>,
    y: Vec<f64>,
}

#[derive(Serialize)]
pub struct SeriesResponse {
    t_min: f64,
    t_max: f64,
    series: Vec<SeriesData>,
}

#[tauri::command]
pub fn get_series(state: AppStateRef<'_>, columns: Vec<String>, range: Option<[f64; 2]>, max_points: usize) -> CmdResult<SeriesResponse> {
    with_data(&state, |d| {
        let t = &d.time;
        let (i0, i1) = window_indices(t, range.map(|r| (r[0], r[1])));
        let series = columns
            .iter()
            .filter_map(|c| {
                d.get_signal(c).map(|y| {
                    let (x, y) = minmax(t, &y, i0, i1, max_points.max(100));
                    SeriesData { column: c.clone(), x, y }
                })
            })
            .collect();
        Ok(SeriesResponse { t_min: *t.first().unwrap_or(&0.0), t_max: *t.last().unwrap_or(&0.0), series })
    })
}

#[derive(Serialize)]
pub struct ValuesAt {
    t: f64,
    values: Vec<Option<f64>>,
}

#[tauri::command]
pub fn values_at(state: AppStateRef<'_>, columns: Vec<String>, t: f64) -> CmdResult<ValuesAt> {
    with_data(&state, |d| {
        let time = &d.time;
        if time.is_empty() {
            return Err("Empty dataset".into());
        }
        let idx = searchsorted(time, t).min(time.len() - 1);
        let values = columns.iter().map(|c| d.get_signal(c).and_then(|v| v.get(idx).copied())).collect();
        Ok(ValuesAt { t, values })
    })
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct SuggestionDto {
    step: FilterStep,
    reason: String,
    estimated_improvement: f64,
    description: String,
}

#[tauri::command]
pub async fn filter_suggest(state: AppStateRef<'_>, column: String) -> CmdResult<Vec<SuggestionDto>> {
    let st = state.inner().clone();
    blocking(move || {
        let (raw, fs) = with_data(&st, |d| Ok((d.get_raw(&column).ok_or("Unknown signal")?, d.sample_rate)))?;
        Ok(suggest_filters(&raw, fs, Some(&st.cache), &column)
            .into_iter()
            .map(|s| {
                let step = s.to_step();
                SuggestionDto { description: step.describe(), step, reason: s.reason, estimated_improvement: s.estimated_improvement }
            })
            .collect())
    })
    .await
}

#[derive(Serialize)]
pub struct FilterPreview {
    x: Vec<f64>,
    original: Vec<f64>,
    filtered: Option<Vec<f64>>,
    draft: Option<Vec<f64>>,
    error: Option<String>,
}

#[tauri::command]
pub async fn filter_preview(state: AppStateRef<'_>, column: String, chain: FilterChain, draft: Option<FilterStep>) -> CmdResult<FilterPreview> {
    let st = state.inner().clone();
    blocking(move || {
        let (raw, time, fs) = with_data(&st, |d| Ok((d.get_raw(&column).ok_or("Unknown signal")?, d.time.clone(), d.sample_rate)))?;
        let step = stride(raw.len(), 5000);
        let x: Vec<f64> = time.iter().step_by(step).copied().collect();
        let original: Vec<f64> = raw.iter().step_by(step).copied().collect();
        let fs_preview = fs / step as f64;
        let mut error = None;
        let filtered = if chain.has_enabled() {
            match apply_chain(&original, &chain, fs_preview) {
                Ok(v) => Some(v),
                Err(e) => {
                    error = Some(e);
                    None
                }
            }
        } else {
            None
        };
        let draft = match draft {
            Some(dstep) => {
                let steps = chain.enabled_steps().chain(std::iter::once(&dstep));
                match apply_steps(&original, steps, fs_preview) {
                    Ok(v) => Some(v),
                    Err(e) => {
                        error.get_or_insert(e);
                        None
                    }
                }
            }
            None => None,
        };
        Ok(FilterPreview { x, original, filtered, draft, error })
    })
    .await
}

#[tauri::command]
pub async fn filter_apply(state: AppStateRef<'_>, column: String, chain: FilterChain) -> CmdResult<DatasetInfo> {
    let st = state.inner().clone();
    blocking(move || {
        if !chain.has_enabled() {
            return Err("The filter chain has no enabled steps.".into());
        }
        let (raw, fs) = with_data(&st, |d| Ok((d.get_raw(&column).ok_or("Unknown signal")?, d.sample_rate)))?;
        let filtered = apply_chain(&raw, &chain, fs)?;
        let mut guard = st.data.write().unwrap();
        let d = guard.as_mut().ok_or("No data loaded.")?;
        d.set_filtered(&column, filtered, chain, &st.cache);
        Ok(d.info())
    })
    .await
}

#[tauri::command]
pub fn filter_clear(state: AppStateRef<'_>, column: String) -> CmdResult<DatasetInfo> {
    let mut guard = state.data.write().unwrap();
    let d = guard.as_mut().ok_or("No data loaded.")?;
    d.clear_filtered(&column, &state.cache);
    Ok(d.info())
}

#[tauri::command]
pub fn filter_get_chain(state: AppStateRef<'_>, column: String) -> CmdResult<Option<FilterChain>> {
    with_data(&state, |d| Ok(d.filter_chain(&column).cloned()))
}

#[tauri::command]
pub fn filter_save_chain(path: String, chain: FilterChain) -> CmdResult<()> {
    chain.save_json(Path::new(&path))
}

#[tauri::command]
pub fn filter_load_chain(path: String) -> CmdResult<FilterChain> {
    FilterChain::load_json(Path::new(&path))
}

#[tauri::command]
pub fn filter_describe(steps: Vec<FilterStep>) -> Vec<String> {
    steps.iter().map(|s| s.describe()).collect()
}

// ---------------------------------------------------------------------------
// Spectrum
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct SpectrumView {
    fft: Xy,
    psd: Xy,
    psd_filtered: Option<Xy>,
    peaks: Vec<PeakInfo>,
    n_peaks: usize,
    nyquist: f64,
    nperseg_used: usize,
}

fn skip_dc(f: &[f64], v: &[f64], max_points: usize) -> Xy {
    if f.len() <= 1 {
        return Xy { x: vec![], y: vec![] };
    }
    let (x, y) = minmax(&f[1..], &v[1..], 0, f.len() - 1, max_points);
    Xy { x, y }
}

#[tauri::command]
pub async fn spectrum(state: AppStateRef<'_>, column: String, nperseg: usize) -> CmdResult<SpectrumView> {
    let st = state.inner().clone();
    blocking(move || {
        let (raw, filtered, fs) = with_data(&st, |d| {
            let raw = d.get_raw(&column).ok_or("Unknown signal")?;
            let filt = if d.has_filtered(&column) { d.get_signal(&column) } else { None };
            Ok((raw, filt, d.sample_rate))
        })?;
        let fft = compute_fft(&raw, fs, Some(&st.cache), &column);
        let psd = compute_psd(&raw, fs, Some(nperseg), Some(&st.cache), &column);
        let psd_filtered = filtered.map(|f| {
            let p = compute_psd(&f, fs, Some(nperseg), None, "");
            skip_dc(&p.freqs, &p.psd, 6000)
        });
        let peaks = detect_peaks(&psd, 8.0, 0.0);
        Ok(SpectrumView {
            fft: skip_dc(&fft.freqs, &fft.magnitude, 6000),
            psd: skip_dc(&psd.freqs, &psd.psd, 6000),
            psd_filtered,
            n_peaks: peaks.len(),
            peaks: peaks.into_iter().take(5).collect(),
            nyquist: fs / 2.0,
            nperseg_used: nperseg.min(raw.len()),
        })
    })
    .await
}

// ---------------------------------------------------------------------------
// Correlations
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct PairDto {
    signal_a: String,
    signal_b: String,
    name_a: String,
    name_b: String,
    pearson_r: f64,
    spearman_r: f64,
    lag_samples: i64,
    lag_seconds: f64,
}

#[derive(Serialize)]
pub struct CorrelationView {
    columns: Vec<String>,
    names: Vec<String>,
    pearson: Vec<Vec<f64>>,
    spearman: Vec<Vec<f64>>,
    top_pairs: Vec<PairDto>,
}

fn pair_dtos(d: &Dataset, pairs: &[CorrelationPair]) -> Vec<PairDto> {
    pairs
        .iter()
        .map(|p| PairDto {
            signal_a: p.signal_a.clone(),
            signal_b: p.signal_b.clone(),
            name_a: d.short_name(&p.signal_a),
            name_b: d.short_name(&p.signal_b),
            pearson_r: p.pearson_r,
            spearman_r: p.spearman_r,
            lag_samples: p.lag_samples,
            lag_seconds: p.lag_seconds,
        })
        .collect()
}

#[tauri::command]
pub async fn correlation_compute(state: AppStateRef<'_>) -> CmdResult<CorrelationView> {
    let st = state.inner().clone();
    blocking(move || {
        let signals = with_data(&st, |d| Ok(d.all_signals()))?;
        let result = compute_correlation_matrix(&signals, Some(&st.cache));
        // Keep lags from a previous lag analysis of the same matrix (cached result semantics).
        let mut res = result.as_ref().clone();
        if let Some(prev) = st.correlation.lock().unwrap().as_ref() {
            if prev.columns == res.columns {
                for p in res.top_pairs.iter_mut() {
                    if let Some(q) = prev.top_pairs.iter().find(|q| q.signal_a == p.signal_a && q.signal_b == p.signal_b) {
                        p.lag_samples = q.lag_samples;
                        p.lag_seconds = q.lag_seconds;
                    }
                }
            }
        }
        let view = with_data(&st, |d| {
            Ok(CorrelationView {
                names: res.columns.iter().map(|c| d.short_name(c)).collect(),
                columns: res.columns.clone(),
                pearson: res.pearson_matrix.clone(),
                spearman: res.spearman_matrix.clone(),
                top_pairs: pair_dtos(d, &res.top_pairs),
            })
        })?;
        *st.correlation.lock().unwrap() = Some(res);
        Ok(view)
    })
    .await
}

#[derive(Serialize)]
pub struct PairAnalysis {
    label_a: String,
    label_b: String,
    scatter: Xy,
    lags: Vec<f64>,
    corr: Vec<f64>,
    pearson_r: f64,
}

#[tauri::command]
pub async fn correlation_pair(state: AppStateRef<'_>, a: String, b: String) -> CmdResult<PairAnalysis> {
    let st = state.inner().clone();
    blocking(move || {
        let (sa, sb, fs, la, lb) = with_data(&st, |d| {
            Ok((
                d.get_signal(&a).ok_or("Unknown signal")?,
                d.get_signal(&b).ok_or("Unknown signal")?,
                d.sample_rate,
                d.label(&a),
                d.label(&b),
            ))
        })?;
        let n = sa.len();
        let idx: Vec<usize> = if n > 5000 { (0..5000).map(|i| (i as f64 * (n - 1) as f64 / 4999.0) as usize).collect() } else { (0..n).collect() };
        let scatter = Xy { x: idx.iter().map(|&i| sa[i]).collect(), y: idx.iter().map(|&i| sb[i]).collect() };
        let max_lag = (n / 2).min((fs * 300.0) as usize);
        let (lags, corr) = compute_cross_correlation(&sa, &sb, Some(max_lag));
        let lagf: Vec<f64> = lags.iter().map(|v| *v as f64).collect();
        let (lags_ds, corr_ds) = minmax(&lagf, &corr, 0, lagf.len(), 6000);
        let r = crate::core::correlation::corrcoef(&[&sa, &sb])[0][1];
        Ok(PairAnalysis { label_a: la, label_b: lb, scatter, lags: lags_ds, corr: corr_ds, pearson_r: r })
    })
    .await
}

#[tauri::command]
pub async fn correlation_lags(state: AppStateRef<'_>) -> CmdResult<Vec<PairDto>> {
    let st = state.inner().clone();
    blocking(move || {
        let mut corr = st.correlation.lock().unwrap().clone().ok_or("Compute correlations first.")?;
        let fs = with_data(&st, |d| Ok(d.sample_rate))?;
        {
            let guard = st.data.read().unwrap();
            let d = guard.as_ref().ok_or("No data loaded.")?;
            let getter = |c: &str| d.get_signal(c);
            compute_lagged_correlations(&getter, &mut corr.top_pairs, fs, 300.0);
        }
        let dtos = with_data(&st, |d| Ok(pair_dtos(d, &corr.top_pairs)))?;
        *st.correlation.lock().unwrap() = Some(corr);
        Ok(dtos)
    })
    .await
}

// ---------------------------------------------------------------------------
// System identification
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn sysid_auto_decimation(state: AppStateRef<'_>, columns: Vec<String>) -> CmdResult<usize> {
    let st = state.inner().clone();
    blocking(move || {
        let (signals, fs) = with_data(&st, |d| Ok((d.select(&columns)?, d.sample_rate)))?;
        Ok(estimate_decimation_factor(&signals, fs, Some(&st.cache)))
    })
    .await
}

#[tauri::command]
pub fn sysid_estimate_time(n_samples: usize, n_inputs: usize, n_outputs: usize, order_min: usize, order_max: usize) -> f64 {
    estimate_time(n_samples, n_inputs, n_outputs, order_min, order_max)
}

#[derive(Deserialize)]
pub struct IdentifyRequest {
    inputs: Vec<String>,
    outputs: Vec<String>,
    name: String,
    method: String,
    order_min: usize,
    order_max: usize,
    decimation: usize,
    start: usize,
    end: usize,
}

#[derive(Serialize)]
pub struct SysIdRow {
    index: usize,
    name: String,
    order: usize,
    mean_vaf: f64,
    best_vaf: f64,
    metrics: Vec<OutputMetrics>,
}

#[tauri::command]
pub async fn sysid_identify(app: AppHandle, state: AppStateRef<'_>, req: IdentifyRequest) -> CmdResult<Vec<SysIdRow>> {
    let st = state.inner().clone();
    st.sysid_cancel.store(false, Ordering::SeqCst);
    blocking(move || {
        let (inputs, outputs, fs) = with_data(&st, |d| Ok((d.select(&req.inputs)?, d.select(&req.outputs)?, d.sample_rate)))?;
        let params = SysIdParams {
            name: req.name,
            method: req.method,
            order_min: req.order_min.max(1),
            order_max: req.order_max.max(req.order_min.max(1)),
            decimation_factor: req.decimation.max(1),
            start_idx: req.start,
            end_idx: req.end,
        };
        let app2 = app.clone();
        let progress = move |v: i32, m: String| emit_progress(&app2, "sysid", v, m);
        let st2 = st.clone();
        let cancelled = move || st2.sysid_cancel.load(Ordering::SeqCst);
        let results = identify_model(&inputs, &outputs, fs, &params, &progress, &cancelled)?;
        if st.sysid_cancel.load(Ordering::SeqCst) {
            emit_progress(&app, "sysid", 100, "Identification cancelled.");
            return Err("Identification cancelled.".into());
        }
        let rows = results
            .iter()
            .enumerate()
            .map(|(i, m)| SysIdRow { index: i, name: m.name.clone(), order: m.order, mean_vaf: m.mean_vaf(), best_vaf: m.best_vaf(), metrics: m.metrics.clone() })
            .collect();
        *st.sysid_results.lock().unwrap() = results;
        Ok(rows)
    })
    .await
}

#[tauri::command]
pub fn sysid_cancel(state: AppStateRef<'_>) {
    state.sysid_cancel.store(true, Ordering::SeqCst);
}

#[tauri::command]
pub fn sysid_save_result(state: AppStateRef<'_>, index: usize) -> CmdResult<String> {
    let model = state.sysid_results.lock().unwrap().get(index).cloned().ok_or("Result no longer available.")?;
    Ok(state.models.lock().unwrap().add(model))
}

// ---------------------------------------------------------------------------
// Model library
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn models_list(state: AppStateRef<'_>) -> Vec<ModelSummary> {
    state.models.lock().unwrap().models().iter().map(ModelSummary::from).collect()
}

#[tauri::command]
pub fn model_detail(state: AppStateRef<'_>, name: String) -> CmdResult<StateSpaceResult> {
    state.models.lock().unwrap().get(&name).cloned().ok_or_else(|| format!("Model '{name}' not found."))
}

#[tauri::command]
pub fn model_rename(state: AppStateRef<'_>, old: String, new: String) -> CmdResult<()> {
    if state.models.lock().unwrap().rename(&old, new.trim()) {
        Ok(())
    } else {
        Err("Name already exists.".into())
    }
}

#[tauri::command]
pub fn model_duplicate(state: AppStateRef<'_>, names: Vec<String>) -> Vec<String> {
    let mut lib = state.models.lock().unwrap();
    names.iter().filter_map(|n| lib.duplicate(n)).collect()
}

#[tauri::command]
pub fn model_delete(state: AppStateRef<'_>, names: Vec<String>) {
    let mut lib = state.models.lock().unwrap();
    for n in names {
        lib.remove(&n);
    }
}

#[tauri::command]
pub fn models_compare(state: AppStateRef<'_>, names: Vec<String>) -> Vec<Vec<(String, String)>> {
    state.models.lock().unwrap().compare(&names)
}

#[tauri::command]
pub fn model_update_matrices(state: AppStateRef<'_>, name: String, a: Vec<Vec<f64>>, b: Vec<Vec<f64>>, c: Vec<Vec<f64>>, d: Vec<Vec<f64>>) -> CmdResult<()> {
    let mut lib = state.models.lock().unwrap();
    let m = lib.get_mut(&name).ok_or("Model no longer exists.")?;
    m.a = a;
    m.b = b;
    m.c = c;
    m.d = d;
    Ok(())
}

#[tauri::command]
pub fn models_save(state: AppStateRef<'_>, path: String) -> CmdResult<()> {
    state.models.lock().unwrap().save_library(Path::new(&path))
}

#[tauri::command]
pub fn models_load(state: AppStateRef<'_>, path: String) -> CmdResult<usize> {
    state.models.lock().unwrap().load_library(Path::new(&path))
}

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct SimTrace {
    model: String,
    x: Vec<f64>,
    y: Vec<f64>,
}

#[derive(Serialize)]
pub struct SimPlot {
    output: String,
    label: String,
    measured: Xy,
    simulated: Vec<SimTrace>,
}

#[derive(Serialize)]
pub struct SimulationView {
    models: Vec<String>,
    plots: Vec<SimPlot>,
}

fn simulation_view(state: &AppState) -> CmdResult<SimulationView> {
    let sims = state.simulations.lock().unwrap();
    let mut outputs: Vec<String> = Vec::new();
    for (_, r) in sims.iter() {
        for (n, _, _) in &r.outputs {
            if !outputs.contains(n) {
                outputs.push(n.clone());
            }
        }
    }
    let label = |c: &str| -> String { state.data.read().ok().and_then(|d| d.as_ref().map(|d| d.label(c))).unwrap_or_else(|| c.to_string()) };
    let plots = outputs
        .iter()
        .map(|out| {
            let mut measured = Xy { x: vec![], y: vec![] };
            let mut simulated = Vec::new();
            for (j, (model, r)) in sims.iter().enumerate() {
                if let Some((_, meas, sim)) = r.outputs.iter().find(|(n, _, _)| n == out) {
                    if j == 0 || measured.x.is_empty() {
                        let (x, y) = minmax(&r.time, meas, 0, meas.len(), 5000);
                        measured = Xy { x, y };
                    }
                    let (x, y) = minmax(&r.time, sim, 0, sim.len(), 5000);
                    simulated.push(SimTrace { model: model.clone(), x, y });
                }
            }
            SimPlot { output: out.clone(), label: label(out), measured, simulated }
        })
        .collect();
    Ok(SimulationView { models: sims.iter().map(|(m, _)| m.clone()).collect(), plots })
}

#[tauri::command]
pub async fn simulation_run(state: AppStateRef<'_>, model: String, start: usize, end: usize, auto_x0: bool, append: bool) -> CmdResult<SimulationView> {
    let st = state.inner().clone();
    blocking(move || {
        let m = st.models.lock().unwrap().get(&model).cloned().ok_or("Select a model first.")?;
        let (inputs, outputs, time) = with_data(&st, |d| {
            Ok((
                d.select(&m.input_names).map_err(|_| "Input/output signals not found in loaded data.".to_string())?,
                d.select(&m.output_names).map_err(|_| "Input/output signals not found in loaded data.".to_string())?,
                d.time.clone(),
            ))
        })?;
        let x0 = if auto_x0 { None } else { Some(vec![0.0; m.n_states()]) };
        let result = simulate(&m, &inputs, &outputs, &time, x0, start, end)?;
        {
            let mut sims = st.simulations.lock().unwrap();
            if !append {
                sims.clear();
            }
            sims.push((model, result));
        }
        simulation_view(&st)
    })
    .await
}

#[tauri::command]
pub fn simulation_clear(state: AppStateRef<'_>) {
    state.simulations.lock().unwrap().clear();
}

#[tauri::command]
pub fn simulation_view_cmd(state: AppStateRef<'_>) -> CmdResult<SimulationView> {
    simulation_view(&state)
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct XcorrTrace {
    input: String,
    label: String,
    lags: Vec<f64>,
    values: Vec<f64>,
}

#[derive(Serialize)]
pub struct ValidationOutput {
    name: String,
    label: String,
    residuals: Xy,
    hist_centers: Vec<f64>,
    hist_density: Vec<f64>,
    hist_width: f64,
    normal: Xy,
    shapiro_stat: f64,
    shapiro_p: f64,
    acf_lags: Vec<usize>,
    acf: Vec<f64>,
    acf_confidence: f64,
    xcorr: Vec<XcorrTrace>,
    metrics: OutputMetrics,
}

#[derive(Serialize)]
pub struct ValidationView {
    model: String,
    outputs: Vec<ValidationOutput>,
}

fn histogram_density(v: &[f64], bins: usize) -> (Vec<f64>, Vec<f64>, f64) {
    let fin: Vec<f64> = v.iter().copied().filter(|x| x.is_finite()).collect();
    if fin.is_empty() {
        return (vec![], vec![], 0.0);
    }
    let lo = fin.iter().copied().fold(f64::INFINITY, f64::min);
    let mut hi = fin.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    if hi <= lo {
        hi = lo + 1.0;
    }
    let w = (hi - lo) / bins as f64;
    let mut counts = vec![0usize; bins];
    for x in &fin {
        counts[(((x - lo) / w) as usize).min(bins - 1)] += 1;
    }
    let centers = (0..bins).map(|i| lo + (i as f64 + 0.5) * w).collect();
    let dens = counts.iter().map(|c| *c as f64 / (fin.len() as f64 * w)).collect();
    (centers, dens, w)
}

#[tauri::command]
pub async fn validation_run(state: AppStateRef<'_>, model: String) -> CmdResult<ValidationView> {
    let st = state.inner().clone();
    blocking(move || {
        let m = st.models.lock().unwrap().get(&model).cloned().ok_or("Select a model first.")?;
        let (inputs, outputs, time) = with_data(&st, |d| Ok((d.select(&m.input_names)?, d.select(&m.output_names)?, d.time.clone())))?;
        let sim = simulate(&m, &inputs, &outputs, &time, None, 0, 0)?;
        let dec = m.decimation_factor.max(1);
        let sliced: Vec<(String, Vec<f64>)> = inputs
            .iter()
            .map(|(n, d)| {
                let mu = mean(d);
                let z: Vec<f64> = d.iter().map(|v| v - mu).collect();
                Ok((n.clone(), if dec > 1 { decimate(&z, dec)? } else { z }))
            })
            .collect::<CmdResult<_>>()?;
        let val = validate(&sim, Some(&sliced), 100);
        let view = with_data(&st, |d| {
            let outputs = val
                .analyses
                .iter()
                .map(|a| {
                    let xs: Vec<f64> = (0..a.residuals.len()).map(|i| i as f64).collect();
                    let (rx, ry) = minmax(&xs, &a.residuals, 0, xs.len(), 6000);
                    let (centers, dens, w) = histogram_density(&a.residuals, 80);
                    let mu = mean(&a.residuals);
                    let sigma = std(&a.residuals);
                    let nx: Vec<f64> = (0..200).map(|i| mu - 4.0 * sigma + 8.0 * sigma * i as f64 / 199.0).collect();
                    let ny: Vec<f64> = nx.iter().map(|x| if sigma > 0.0 { norm_pdf(*x, mu, sigma) } else { 0.0 }).collect();
                    let xcorr = val
                        .input_residual_xcorr
                        .iter()
                        .find(|(o, _)| *o == a.output_name)
                        .map(|(_, per)| {
                            per.iter()
                                .map(|(inp, vals)| {
                                    let half = (vals.len() / 2) as f64;
                                    XcorrTrace {
                                        input: inp.clone(),
                                        label: d.short_name(inp).chars().take(20).collect(),
                                        lags: (0..vals.len()).map(|i| i as f64 - half).collect(),
                                        values: vals.clone(),
                                    }
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                    ValidationOutput {
                        name: a.output_name.clone(),
                        label: d.short_name(&a.output_name),
                        residuals: Xy { x: rx, y: ry },
                        hist_centers: centers,
                        hist_density: dens,
                        hist_width: w,
                        normal: Xy { x: nx, y: ny },
                        shapiro_stat: a.shapiro_stat,
                        shapiro_p: a.shapiro_p,
                        acf_lags: a.acf_lags.clone(),
                        acf: a.acf.clone(),
                        acf_confidence: a.acf_confidence,
                        xcorr,
                        metrics: a.metrics.clone(),
                    }
                })
                .collect();
            Ok(ValidationView { model: model.clone(), outputs })
        })?;
        *st.validation.lock().unwrap() = Some((model, val));
        Ok(view)
    })
    .await
}

// ---------------------------------------------------------------------------
// Compare
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct CompareFileDto {
    id: String,
    path: String,
    short_name: String,
    color: String,
    offset: f64,
    columns: Vec<String>,
    n_samples: usize,
    t_start: f64,
    t_end: f64,
}

#[derive(Serialize)]
pub struct MappingDto {
    canonical: String,
    file_columns: std::collections::HashMap<String, String>,
}

#[derive(Serialize)]
pub struct CompareStateDto {
    files: Vec<CompareFileDto>,
    mapped_signals: Vec<String>,
    mappings: Vec<MappingDto>,
    errors: Vec<String>,
}

fn compare_dto(c: &CompareManager, errors: Vec<String>) -> CompareStateDto {
    CompareStateDto {
        files: c
            .file_order
            .iter()
            .map(|fid| {
                let f = &c.files[fid];
                CompareFileDto {
                    id: fid.clone(),
                    path: f.path.clone(),
                    short_name: f.short_name.clone(),
                    color: f.color.clone(),
                    offset: f.offset,
                    columns: f.columns.clone(),
                    n_samples: f.time.len(),
                    t_start: f.time.first().copied().unwrap_or(0.0),
                    t_end: f.time.last().copied().unwrap_or(0.0),
                }
            })
            .collect(),
        mapped_signals: c.mapped_signals(),
        mappings: c
            .mappings
            .iter()
            .map(|m| MappingDto { canonical: m.canonical_name.clone(), file_columns: m.file_columns.iter().cloned().collect() })
            .collect(),
        errors,
    }
}

#[tauri::command]
pub async fn compare_add_files(app: AppHandle, state: AppStateRef<'_>, paths: Vec<String>) -> CmdResult<CompareStateDto> {
    let st = state.inner().clone();
    blocking(move || {
        let mut errors = Vec::new();
        let n = paths.len().max(1);
        for (i, p) in paths.iter().enumerate() {
            emit_progress(&app, "compare", (i * 100 / n) as i32, format!("Loading {p}..."));
            if let Err(e) = st.compare.lock().unwrap().add_file(p) {
                errors.push(format!("Could not load {p}:\n{e}"));
            }
        }
        emit_progress(&app, "compare", 100, "Done.");
        Ok(compare_dto(&st.compare.lock().unwrap(), errors))
    })
    .await
}

#[tauri::command]
pub fn compare_state(state: AppStateRef<'_>) -> CompareStateDto {
    compare_dto(&state.compare.lock().unwrap(), vec![])
}

#[tauri::command]
pub fn compare_remove_file(state: AppStateRef<'_>, id: String) -> CompareStateDto {
    let mut c = state.compare.lock().unwrap();
    c.remove_file(&id);
    compare_dto(&c, vec![])
}

#[tauri::command]
pub fn compare_clear(state: AppStateRef<'_>) -> CompareStateDto {
    let mut c = state.compare.lock().unwrap();
    c.clear();
    compare_dto(&c, vec![])
}

#[tauri::command]
pub fn compare_set_offset(state: AppStateRef<'_>, id: String, offset: f64) -> CompareStateDto {
    let mut c = state.compare.lock().unwrap();
    c.set_offset(&id, offset);
    compare_dto(&c, vec![])
}

#[tauri::command]
pub fn compare_align_trigger(state: AppStateRef<'_>, signal: String, threshold: f64, rising: bool) -> CompareStateDto {
    let mut c = state.compare.lock().unwrap();
    c.align_by_trigger(&signal, threshold, rising);
    compare_dto(&c, vec![])
}

#[tauri::command]
pub fn compare_align_clicks(state: AppStateRef<'_>, clicks: Vec<(String, f64)>) -> CompareStateDto {
    let mut c = state.compare.lock().unwrap();
    c.align_by_clicks(&clicks);
    compare_dto(&c, vec![])
}

#[tauri::command]
pub fn compare_nearest_file(state: AppStateRef<'_>, signal: String, t: f64, y: f64) -> Option<String> {
    state.compare.lock().unwrap().nearest_file(&signal, t, y)
}

#[tauri::command]
pub fn compare_set_mapping(state: AppStateRef<'_>, canonical: String, id: String, column: Option<String>) -> CompareStateDto {
    let mut c = state.compare.lock().unwrap();
    c.set_signal_mapping(&canonical, &id, column.as_deref());
    compare_dto(&c, vec![])
}

#[derive(Serialize)]
pub struct CompareTrace {
    file_id: String,
    name: String,
    color: String,
    x: Vec<f64>,
    y: Vec<f64>,
}

#[derive(Serialize)]
pub struct CompareSignalSeries {
    signal: String,
    traces: Vec<CompareTrace>,
}

#[tauri::command]
pub fn compare_series(state: AppStateRef<'_>, signals: Vec<String>, range: Option<[f64; 2]>, max_points: usize) -> Vec<CompareSignalSeries> {
    let c = state.compare.lock().unwrap();
    signals
        .iter()
        .map(|sig| CompareSignalSeries {
            signal: sig.clone(),
            traces: c
                .file_order
                .iter()
                .filter_map(|fid| {
                    let f = &c.files[fid];
                    let col = c.resolve_column(fid, sig)?;
                    let data = f.signals.get(&col)?;
                    let t = c.aligned_time(fid)?;
                    let (i0, i1) = window_indices(&t, range.map(|r| (r[0], r[1])));
                    let (x, y) = minmax(&t, data, i0, i1, max_points.max(100));
                    Some(CompareTrace { file_id: fid.clone(), name: f.short_name.clone(), color: f.color.clone(), x, y })
                })
                .collect(),
        })
        .collect()
}

#[tauri::command]
pub fn compare_differences(state: AppStateRef<'_>, signals: Vec<String>, max_points: usize) -> Vec<CompareSignalSeries> {
    let c = state.compare.lock().unwrap();
    let diff_colors = ["#ff2400", "#274259", "#6b7b84", "#5c5c5c", "#ff7a59"];
    let Some(ref_id) = c.file_order.first().cloned() else { return vec![] };
    signals
        .iter()
        .map(|sig| CompareSignalSeries {
            signal: sig.clone(),
            traces: c
                .file_order
                .iter()
                .skip(1)
                .enumerate()
                .filter_map(|(i, fid)| {
                    let (t, d) = c.compute_difference(sig, &ref_id, fid)?;
                    let (x, y) = minmax(&t, &d, 0, t.len(), max_points.max(100));
                    Some(CompareTrace { file_id: fid.clone(), name: c.files[fid].short_name.clone(), color: diff_colors[i % diff_colors.len()].into(), x, y })
                })
                .collect(),
        })
        .collect()
}

#[tauri::command]
pub fn compare_stats(state: AppStateRef<'_>, signals: Vec<String>) -> Vec<CompareStatistics> {
    let c = state.compare.lock().unwrap();
    let Some(ref_id) = c.file_order.first().cloned() else { return vec![] };
    let mut rows = Vec::new();
    for sig in &signals {
        for fid in c.file_order.iter().skip(1) {
            if let Some(s) = c.compute_statistics(sig, &ref_id, fid) {
                rows.push(s);
            }
        }
    }
    rows
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct ReportResult {
    path: String,
    note: Option<String>,
}

fn build_report(st: &AppState, sections: &[String], app: &AppHandle) -> CmdResult<ReportContent> {
    let inc = |s: &str| sections.iter().any(|x| x == s);
    let mut c = ReportContent::default();
    emit_progress(app, "report", 10, "Preparing report content...");
    {
        let guard = st.data.read().unwrap();
        if let Some(d) = guard.as_ref() {
            c.source_file = Some(d.path.clone());
            let info = d.info();
            c.summary = Some(DataSummary {
                file_name: d.path.clone(),
                file_type: info.file_type.clone(),
                n_samples: info.n_samples,
                n_signals: info.n_signals,
                sample_rate: info.sample_rate,
                duration: info.duration,
            });
            {
                let panels: Vec<Panel> = d
                    .columns()
                    .iter()
                    .take(3)
                    .enumerate()
                    .filter_map(|(k, col)| {
                        let y = d.get_signal(col)?;
                        Some(Panel { series: vec![Series { width: 0.9, ..Series::line(d.label(col), REPORT_PALETTE[k % REPORT_PALETTE.len()], d.time.to_vec(), y.to_vec()) }], ylabel: d.short_name(col), ..Default::default() })
                    })
                    .collect();
                if !panels.is_empty() {
                    c.overview_plot = Some(svgplot::stacked_lines(&panels, "Time [s]", None, 1000.0, 70.0));
                }
            }
            if inc("Metadata") {
                c.metadata = Some(d.metadata.clone());
            }
            if inc("Statistics") {
                c.stats = Some(compute_descriptive_stats(&d.all_signals(), Some(&st.cache)).as_ref().clone());
            }
            if inc("Signal Plots") {
                let cols = d.columns();
                for (gi, batch) in cols.chunks(4).enumerate() {
                    let start = gi * 4;
                    let panels: Vec<Panel> = batch
                        .iter()
                        .enumerate()
                        .filter_map(|(k, col)| {
                            let y = d.get_signal(col)?;
                            Some(Panel {
                                series: vec![Series { width: 0.8, ..Series::line(d.label(col), REPORT_PALETTE[(start + k) % REPORT_PALETTE.len()], d.time.to_vec(), y.to_vec()) }],
                                ylabel: d.label(col),
                                ..Default::default()
                            })
                        })
                        .collect();
                    if !panels.is_empty() {
                        let title = format!("Signals {}–{}", start + 1, start + batch.len());
                        let svg = svgplot::stacked_lines(&panels, "Time [s]", None, 1000.0, 120.0);
                        let caption = batch.iter().map(|col| d.label(col)).collect::<Vec<_>>().join(", ");
                        c.signal_plots.push(Plot { title, svg, caption });
                    }
                }
            }
            if inc("Filters Applied") {
                for s in &d.signals {
                    if let Some(chain) = d.filter_chain(&s.column) {
                        if chain.has_enabled() {
                            c.filters.push(FilterInfo {
                                signal: s.label.clone(),
                                description: chain.enabled_steps().map(|st| st.describe()).collect::<Vec<_>>().join(" → "),
                            });
                        }
                    }
                }
            }
            if inc("Correlations") {
                if let Some(corr) = st.correlation.lock().unwrap().as_ref() {
                    let labels: Vec<String> = corr.columns.iter().map(|col| d.short_name(col).chars().take(20).collect()).collect();
                    c.correlation_plot = Some(svgplot::heatmap(&corr.pearson_matrix, &labels, None));
                    c.correlation_pairs = corr.top_pairs.clone();
                    let names: Vec<(String, String)> = d.signals.iter().map(|s| (s.column.clone(), s.label.clone())).collect();
                    c.correlation_labels = Some(Box::new(move |col: &str| names.iter().find(|(k, _)| k == col).map(|(_, v)| v.clone()).unwrap_or_else(|| col.to_string())));
                }
            }
            if inc("Simulations") {
                for (model, r) in st.simulations.lock().unwrap().iter() {
                    for (out, meas, sim) in &r.outputs {
                        let label = d.short_name(out);
                        let panel = Panel {
                            series: vec![
                                Series::line("Measured", "#111419", r.time.clone(), meas.clone()),
                                Series::line("Simulated", "#c41230", r.time.clone(), sim.clone()).dashed(),
                            ],
                            ylabel: label.clone(),
                            legend: true,
                            ..Default::default()
                        };
                        let title = format!("{model}: {label}");
                        let m = crate::core::sysid::compute_metrics(meas, sim, out);
                        let caption = format!("{title} — VAF {:.1} %, RMSE {:.4}", m.vaf, m.rmse);
                        c.simulation_plots.push(Plot { svg: svgplot::stacked_lines(&[panel], "Time [s]", None, 1000.0, 200.0), title, caption });
                    }
                }
            }
            if inc("Validation") {
                if let Some((_, val)) = st.validation.lock().unwrap().as_ref() {
                    for a in &val.analyses {
                        let label = d.short_name(&a.output_name);
                        let m = &a.metrics;
                        let xs: Vec<f64> = (0..a.residuals.len()).map(|i| i as f64).collect();
                        let panel = Panel {
                            series: vec![Series { width: 0.7, ..Series::line("Residual", "#111419", xs, a.residuals.clone()) }],
                            ylabel: "Residual".into(),
                            hlines: vec![(0.0, "#a5a5a5".into(), true)],
                            title: Some(format!("Residuals: {label}")),
                            ..Default::default()
                        };
                        let res_svg = svgplot::stacked_lines(&[panel], "Sample", None, 1000.0, 160.0);
                        let mu = mean(&a.residuals);
                        let sigma = std(&a.residuals);
                        let nx: Vec<f64> = (0..200).map(|i| mu - 4.0 * sigma + 8.0 * sigma * i as f64 / 199.0).collect();
                        let ny: Vec<f64> = nx.iter().map(|x| if sigma > 0.0 { norm_pdf(*x, mu, sigma) } else { 0.0 }).collect();
                        let curve_label = format!("Normal (p={:.4})", a.shapiro_p);
                        let hist_svg = svgplot::histogram(&a.residuals, 80, Some((&nx, &ny, &curve_label)), "Residual", None, 1000.0, 260.0);
                        c.validation_plots.push(Plot {
                            caption: format!(
                                "Residuals (top) and their distribution with a fitted normal curve (bottom). Shapiro-Wilk p = {:.4}; NRMSE {:.2} %, MAE {:.4}.",
                                a.shapiro_p, m.nrmse, m.mae
                            ),
                            title: format!("{label} (VAF={:.2}%, R²={:.4})", m.vaf, m.r_squared),
                            svg: combine_vertical(&[res_svg, hist_svg]),
                        });
                    }
                }
            }
        }
    }
    if inc("Models") {
        for m in st.models.lock().unwrap().models() {
            c.models.push(ModelInfo {
                name: m.name.clone(),
                method: m.method.clone(),
                order: m.order,
                input_names: m.input_names.clone(),
                output_names: m.output_names.clone(),
                metrics: m.metrics.clone(),
            });
        }
    }
    if inc("Comparison") {
        let cm = st.compare.lock().unwrap();
        if cm.file_order.len() >= 2 {
            let mapped = cm.mapped_signals();
            for sig in &mapped {
                let series: Vec<Series> = cm
                    .file_order
                    .iter()
                    .enumerate()
                    .filter_map(|(fi, fid)| {
                        let f = &cm.files[fid];
                        let col = cm.resolve_column(fid, sig)?;
                        let data = f.signals.get(&col)?;
                        Some(Series::line(f.short_name.clone(), REPORT_PALETTE[fi % REPORT_PALETTE.len()], cm.aligned_time(fid)?, data.to_vec()))
                    })
                    .collect();
                let panel = Panel { series, ylabel: sig.clone(), legend: true, ..Default::default() };
                let files = cm.file_order.iter().map(|f| cm.files[f].short_name.clone()).collect::<Vec<_>>().join(" vs ");
                c.comparison_plots.push(Plot { title: sig.clone(), svg: svgplot::stacked_lines(&[panel], "Time [s]", None, 1000.0, 200.0), caption: format!("{sig}: {files} (aligned)") });
            }
            let ref_id = cm.file_order[0].clone();
            for sig in &mapped {
                for fid in cm.file_order.iter().skip(1) {
                    if let Some(s) = cm.compute_statistics(sig, &ref_id, fid) {
                        c.comparison_stats.push(ComparisonStat {
                            signal: s.signal,
                            file_name: s.file_name,
                            rmse: s.rmse,
                            max_deviation: s.max_deviation,
                            r_squared: s.r_squared,
                            mean_error: s.mean_error,
                        });
                    }
                }
            }
        }
    }
    Ok(c)
}

/// Stacks two standalone SVG documents into one.
fn combine_vertical(svgs: &[String]) -> String {
    let mut y = 0.0;
    let mut body = String::new();
    let mut width: f64 = 0.0;
    for s in svgs {
        let h = attr(s, "height").unwrap_or(200.0);
        let w = attr(s, "width").unwrap_or(1000.0);
        width = width.max(w);
        body.push_str(&format!(r#"<svg x="0" y="{y}"{}"#, &s[4..]));
        y += h;
    }
    format!(r#"<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{y}" viewBox="0 0 {width} {y}">{body}</svg>"#)
}

fn attr(svg: &str, name: &str) -> Option<f64> {
    let key = format!(" {name}=\"");
    let start = svg.find(&key)? + key.len();
    let end = svg[start..].find('"')? + start;
    svg[start..end].parse().ok()
}

#[tauri::command]
pub async fn report_generate(app: AppHandle, state: AppStateRef<'_>, sections: Vec<String>, format: String, path: String) -> CmdResult<ReportResult> {
    let st = state.inner().clone();
    blocking(move || {
        let content = build_report(&st, &sections, &app)?;
        let progress = |v: i32, m: String| emit_progress(&app, "report", v, m);
        let (p, note) = report::generate_report(Path::new(&path), &format, &content, &progress)?;
        Ok(ReportResult { path: p.to_string_lossy().into_owned(), note })
    })
    .await
}

#[allow(dead_code)]
fn _assert_cache_send(c: &CacheManager) -> usize {
    c.size()
}
