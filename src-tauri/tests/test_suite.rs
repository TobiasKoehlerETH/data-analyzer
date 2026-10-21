//! Runs the generated test suite (`node tools/make-test-dataset.mjs`) through the engine and checks
//! the results against the ground truth the generator wrote to `samples/test-suite/manifest.json`.
//!
//! The stress test (`--ignored`) reads `samples/stress/` (`node tools/make-test-dataset.mjs --stress`)
//! and prints how long each step takes:
//!
//!     cargo test --release --test test_suite -- --ignored --nocapture

use std::path::PathBuf;
use std::time::Instant;

use data_analyzer_lib::core::correlation::{corrcoef_pairwise, spearman_pairwise};
use data_analyzer_lib::core::csv_parser::{parse_file_with, ImportOptions};
use data_analyzer_lib::core::filters::{FilterStep, FilterType};
use data_analyzer_lib::core::fitting::{fit, FitRequest, Parameter};
use data_analyzer_lib::core::report::{generate_report, ReportContent};
use data_analyzer_lib::core::spectrum::{compute_psd, detect_peaks};
use data_analyzer_lib::core::stats::compute_descriptive_stats;
use data_analyzer_lib::core::workspace::{Align, Edit, Workspace};
use serde_json::{json, Map, Value};

fn dir(name: &str) -> Option<PathBuf> {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../samples").join(name);
    p.join("manifest.json").exists().then_some(p)
}

fn suite() -> Option<(PathBuf, Value)> {
    let d = dir("test-suite")?;
    let m = serde_json::from_str(&std::fs::read_to_string(d.join("manifest.json")).unwrap()).unwrap();
    Some((d, m))
}

fn path(d: &PathBuf, f: &str) -> String {
    d.join(f).to_string_lossy().into_owned()
}

fn load(ws: &mut Workspace, d: &PathBuf, file: &str, opts: &ImportOptions, cols: &[&str]) -> Vec<String> {
    let mut cols: Vec<String> = cols.iter().map(|c| c.to_string()).collect();
    if cols.is_empty() {
        // Everything numeric, like ticking "all" in the import dialog.
        let parsed = parse_file_with(std::path::Path::new(&path(d, file)), None, opts).unwrap();
        cols = parsed.time_column.iter().cloned().chain(parsed.columns.iter().map(|(n, _)| n.clone())).collect();
    }
    ws.import(&path(d, file), None, opts, &cols, None).unwrap_or_else(|e| panic!("{file}: {e}")).0
}

fn filter(kind: FilterType, params: Value) -> Edit {
    let params: Map<String, Value> = params.as_object().unwrap().clone();
    Edit::Filter(FilterStep { filter_type: kind, params, enabled: true })
}

fn col<'a>(p: &'a data_analyzer_lib::core::csv_parser::ParseResult, name: &str) -> &'a Vec<f64> {
    &p.columns.iter().find(|(n, _)| n == name).unwrap_or_else(|| panic!("no column {name}")).1
}

fn f64s(v: &Value) -> Vec<f64> {
    v.as_array().unwrap().iter().map(|x| x.as_f64().unwrap()).collect()
}

#[test]
fn every_file_opens_with_the_right_shape() {
    let Some((d, m)) = suite() else { return };
    let cases: [(&str, usize, usize); 9] = [
        ("force_100hz.csv", 30000, 2),
        ("sensor_10hz.csv", 3000, 2),
        ("run_a.csv", 1200, 2),
        ("clock_log.csv", 3600, 3),
        ("european_hours.csv", 121, 2),
        ("system_id.csv", 12000, 4),
        ("fit_targets.csv", 1000, 4),
        ("correlations.csv", 2000, 8),
        ("many_columns.csv", 5000, 40),
    ];
    for (file, rows, signals) in cases {
        let mut ws = Workspace::default();
        let names = load(&mut ws, &d, file, &ImportOptions::default(), &[]);
        let p = ws.to_parse().unwrap_or_else(|| panic!("{file}: nothing to parse"));
        assert_eq!(p.columns[0].1.len(), rows, "{file} rows");
        // Every numeric column that is not the time axis.
        assert_eq!(names.len(), signals + 1, "{file}: {names:?} (signals plus the time column)");
    }
    assert_eq!(m["files"]["many_columns.csv"]["signals"], 40);
}

#[test]
fn european_file_reads_semicolons_decimal_commas_and_hours() {
    let Some((d, m)) = suite() else { return };
    let mut ws = Workspace::default();
    let names = load(&mut ws, &d, "european_hours.csv", &ImportOptions::default(), &[]);
    assert!(names.iter().any(|n| n.contains("Temperatur")), "{names:?}");
    let p = ws.to_parse().unwrap();
    let temp = col(&p, names.iter().find(|n| n.contains("Temperatur")).unwrap());
    let [lo, hi] = [f64s(&m["files"]["european_hours.csv"]["temp_from_to_C"])[0], f64s(&m["files"]["european_hours.csv"]["temp_from_to_C"])[1]];
    assert!((temp[0] - lo).abs() < 1e-6 && (temp[120] - hi).abs() < 0.2, "{} {}", temp[0], temp[120]);
    // The time column is read as seconds until told it holds hours.
    let id = ws.source_info()[0].id;
    assert!((ws.time_map(id, Some(121), None).unwrap().time - 2.0).abs() < 1e-3);
    ws.set_time_unit(id, 3600.0).unwrap();
    assert!((ws.time_map(id, Some(121), None).unwrap().time - 7200.0).abs() < 1.0);
}

#[test]
fn timestamps_give_a_clock_and_an_origin() {
    let Some((d, _)) = suite() else { return };
    let mut ws = Workspace::default();
    load(&mut ws, &d, "clock_log.csv", &ImportOptions::default(), &[]);
    let src = &ws.source_info()[0];
    assert!(src.origin.is_some(), "timestamps must give an absolute start");
    assert!((src.duration - 3599.0).abs() < 1.0, "duration {}", src.duration);
    let tm = ws.time_map(src.id, Some(1), None).unwrap();
    assert!(tm.clock.as_deref().is_some_and(|c| c.contains("08:00:00")), "{:?}", tm.clock);
}

#[test]
fn no_time_column_uses_a_fixed_step_and_the_spectrum_finds_the_tones() {
    let Some((d, m)) = suite() else { return };
    let mut ws = Workspace::default();
    load(&mut ws, &d, "vibration_no_time.txt", &ImportOptions::default(), &[]);
    let id = ws.source_info()[0].id;
    assert_eq!(ws.source_info()[0].rows, 20000);
    ws.set_row_step(id, Some(0.02)).unwrap();
    let ds = ws.to_dataset("vib").unwrap();
    assert!((ds.sample_rate - 50.0).abs() < 0.01, "fs {}", ds.sample_rate);
    let names: Vec<String> = ds.signals.iter().map(|s| s.name.clone()).collect();
    for (name, truth) in [("AccX", &m["files"]["vibration_no_time.txt"]["accx_peaks_hz"]), ("AccY", &m["files"]["vibration_no_time.txt"]["accy_peaks_hz"])] {
        let sig = ds.get_signal(names.iter().find(|n| n.contains(name)).unwrap()).unwrap();
        let psd = compute_psd(&sig, ds.sample_rate, Some(4096), None, "");
        let peaks = detect_peaks(&psd, 8.0, 0.0);
        for hz in truth.as_object().unwrap().keys() {
            let hz: f64 = hz.parse().unwrap();
            assert!(peaks.iter().any(|p| (p.frequency - hz).abs() < 0.1), "{name}: no peak at {hz} Hz in {:?}", peaks.iter().map(|p| p.frequency).collect::<Vec<_>>());
        }
    }
}

#[test]
fn cleaning_the_force_signal_finds_every_spike_and_fills_the_gap() {
    let Some((d, m)) = suite() else { return };
    let truth = &m["files"]["force_100hz.csv"];
    let mut ws = Workspace::default();
    load(&mut ws, &d, "force_100hz.csv", &ImportOptions::default(), &[]);
    let id = ws.source_info()[0].id;
    ws.set_time_unit(id, 60.0).unwrap();
    let dur = ws.source_info()[0].duration;
    assert!((dur - truth["duration_s"].as_f64().unwrap()).abs() < 0.1, "minutes read as {dur} s");

    let name = "Force (N)";
    let raw = ws.get(name).unwrap().original.clone();
    let gap = f64s(&truth["gap_rows_zero_based"]);
    assert!(raw[gap[0] as usize].is_nan() && raw[gap[1] as usize].is_nan(), "the dropout is missing in the file");
    let spikes: Vec<usize> = f64s(&truth["spike_rows_zero_based"]).iter().map(|r| *r as usize).collect();

    ws.edit(name, Edit::Despike(4.0)).unwrap();
    let after = ws.get(name).unwrap().data.clone();
    for r in &spikes {
        assert!(after[*r].is_nan(), "spike at row {r} was not found");
    }
    let flagged = after.iter().zip(raw.iter()).filter(|(a, r)| a.is_nan() && r.is_finite()).count();
    assert!(flagged <= spikes.len() + 40, "{flagged} rows removed for {} spikes", spikes.len());

    ws.edit(name, Edit::FillGaps).unwrap();
    let filled = ws.get(name).unwrap().data.clone();
    assert!(filled[2500].is_finite() && filled[15100].is_finite(), "gap and spike rows are bridged");
    assert!((filled[2500] - raw[2499]).abs() < 5.0, "the bridge follows the signal: {} vs {}", filled[2500], raw[2499]);

    // A 12 Hz notch removes the interference: the 12 Hz line drops in the spectrum.
    let fs = 100.0;
    let before = compute_psd(&filled, fs, Some(4096), None, "");
    ws.edit(name, filter(FilterType::Notch, json!({"freq": 12.0, "q": 20.0}))).unwrap();
    let notched = ws.get(name).unwrap().data.clone();
    let post = compute_psd(&notched, fs, Some(4096), None, "");
    let at = |p: &data_analyzer_lib::core::spectrum::PsdResult, hz: f64| p.freqs.iter().zip(&p.psd).min_by(|a, b| (a.0 - hz).abs().total_cmp(&(b.0 - hz).abs())).map(|x| *x.1).unwrap();
    assert!(at(&post, 12.0) < at(&before, 12.0) * 0.1, "12 Hz: {} -> {}", at(&before, 12.0), at(&post, 12.0));
    let blocks: Vec<String> = ws.pipeline(name).unwrap().stages.iter().map(|s| s.label.clone()).collect();
    assert!(blocks.len() == 3, "the diagram lists every block: {blocks:?}");
}

#[test]
fn force_and_sensor_have_the_same_length_after_downsampling_and_correlate() {
    let Some((d, _)) = suite() else { return };
    let mut ws = Workspace::default();
    load(&mut ws, &d, "force_100hz.csv", &ImportOptions::default(), &["Time (min)", "Force (N)"]);
    load(&mut ws, &d, "sensor_10hz.csv", &ImportOptions::default(), &["Time (s)", "Counts"]);
    let force_id = ws.source_info()[0].id;
    ws.set_time_unit(force_id, 60.0).unwrap();
    ws.edit("Force (N)", Edit::FillGaps).unwrap();
    let (nf, nc) = (ws.get("Force (N)").unwrap().data.len(), ws.get("Counts").unwrap().data.len());
    assert_eq!((nf, nc), (30000, 3000));
    ws.edit("Force (N)", Edit::Downsample(nf as f64 / nc as f64)).unwrap();
    let v = ws.get("Force (N)").unwrap();
    assert_eq!(v.data.len(), nc, "same length as Counts");
    assert_eq!(v.time.as_ref().unwrap().len(), nc, "with its own rows");
    assert!(v.time.as_ref().unwrap().windows(2).all(|w| w[1] > w[0]));

    // Both on the Counts grid; the sensor lags by 0.5 s, so r is high but not 1.
    ws.set_align(Align::Time, Some(0.1)).unwrap();
    let p = ws.to_parse().unwrap();
    let (f, c) = (col(&p, "Force (N)"), col(&p, "Counts"));
    assert_eq!(f.len(), c.len());
    let r = corrcoef_pairwise(&[f, c])[0][1];
    assert!(r > 0.97, "r = {r}");
}

#[test]
fn row_view_counts_each_signals_own_rows_after_a_downsample() {
    let Some((d, _)) = suite() else { return };
    let mut ws = Workspace::default();
    load(&mut ws, &d, "force_100hz.csv", &ImportOptions::default(), &["Time (min)", "Force (N)"]);
    load(&mut ws, &d, "sensor_10hz.csv", &ImportOptions::default(), &["Time (s)", "Counts"]);
    ws.set_time_unit(ws.source_info()[0].id, 60.0).unwrap();
    ws.edit("Force (N)", Edit::FillGaps).unwrap();
    ws.edit("Force (N)", Edit::Downsample(10.0)).unwrap();
    ws.set_align(Align::Row, None).unwrap();
    let p = ws.to_parse().unwrap();
    assert_eq!(p.n_rows, 3000, "no empty tail from the old 30 000 rows");
    let (f, c) = (col(&p, "Force (N)"), col(&p, "Counts"));
    assert!(f.iter().all(|v| v.is_finite()) && c.iter().all(|v| v.is_finite()));
    assert!(corrcoef_pairwise(&[f, c])[0][1] > 0.97);
    ws.undo("Force (N)").unwrap();
    assert_eq!(ws.to_parse().unwrap().n_rows, 30000, "undo brings the file's rows back");
}

#[test]
fn correlation_matrix_matches_the_known_relationships() {
    let Some((d, m)) = suite() else { return };
    let truth = &m["files"]["correlations.csv"];
    let mut ws = Workspace::default();
    load(&mut ws, &d, "correlations.csv", &ImportOptions::default(), &[]);
    let p = ws.to_parse().unwrap();
    let cols: Vec<&[f64]> = ["base", "linear", "lagged", "monotonic", "anti", "noise", "gappy"].iter().map(|n| col(&p, n).as_slice()).collect();
    let r = corrcoef_pairwise(&cols);
    for (i, key) in ["linear", "lagged", "monotonic", "anti", "noise", "gappy"].iter().enumerate() {
        let want = truth["pearson_with_base"][key].as_f64().unwrap();
        assert!((r[0][i + 1] - want).abs() < 0.01, "{key}: {} vs {want}", r[0][i + 1]);
    }
    let rho = spearman_pairwise(&cols.iter().map(|c| c.to_vec()).collect::<Vec<_>>());
    assert!((rho[0][3] - 1.0).abs() < 1e-4, "monotonic is perfect under Spearman: {}", rho[0][3]);
    assert!(r[0][3] < 0.99, "…but not under Pearson");
    // A constant column has no correlation.
    let flat = col(&p, "flat");
    assert!(corrcoef_pairwise(&[cols[0], flat.as_slice()])[0][1].is_nan() || corrcoef_pairwise(&[cols[0], flat.as_slice()])[0][1] == 0.0);
}

#[test]
fn curve_fits_recover_the_coefficients() {
    let Some((d, m)) = suite() else { return };
    let truth = &m["files"]["fit_targets.csv"];
    let mut ws = Workspace::default();
    load(&mut ws, &d, "fit_targets.csv", &ImportOptions::default(), &[]);
    let p = ws.to_parse().unwrap();
    let x = col(&p, "x");
    let param = |n: &str, s: f64| Parameter { name: n.into(), start: s, lower: None, upper: None, fixed: false };
    let run = |y: &str, expr: &str, params: Vec<Parameter>| {
        let points: Vec<[f64; 2]> = x.iter().zip(col(&p, y)).map(|(a, b)| [*a, *b]).collect();
        fit(FitRequest { points, expression: expr.into(), parameters: params, normalize: false, robust: false }).unwrap_or_else(|e| panic!("{y}: {e}"))
    };
    let lin = run("linear", "a*x+b", vec![param("a", 1.0), param("b", 0.0)]);
    assert!((lin.coefficients[0] - 2.5).abs() < 0.01 && (lin.coefficients[1] - 1.0).abs() < 0.02, "{:?}", lin.coefficients);
    let exp = run("exp_decay", "a*exp(-x/b)+c", vec![param("a", 3.0), param("b", 1.0), param("c", 0.0)]);
    let t = &truth["exp_decay"];
    for (i, k) in ["a", "b", "c"].iter().enumerate() {
        assert!((exp.coefficients[i] - t[k].as_f64().unwrap()).abs() < 0.05, "exp {k}: {:?}", exp.coefficients);
    }
    let gau = run("gaussian", "a*exp(-((x-b)/c)^2)+d", vec![param("a", 2.0), param("b", 4.0), param("c", 1.0), param("d", 0.0)]);
    let t = &truth["gaussian"];
    for (i, k) in ["a", "b", "c", "d"].iter().enumerate() {
        assert!((gau.coefficients[i] - t[k].as_f64().unwrap()).abs() < 0.05, "gaussian {k}: {:?}", gau.coefficients);
    }
    assert!(lin.r_squared.unwrap() > 0.999 && gau.r_squared.unwrap() > 0.99);
}

#[test]
fn compare_runs_start_at_the_known_times() {
    let Some((d, m)) = suite() else { return };
    let truth = &m["files"]["run_a.csv, run_b.csv, run_c.csv"]["step_at_s"];
    let mut ws = Workspace::default();
    for f in ["run_a.csv", "run_b.csv", "run_c.csv"] {
        load(&mut ws, &d, f, &ImportOptions::default(), &[]);
    }
    assert_eq!(ws.source_info().len(), 3);
    // The first time each run's pressure passes 1.5 bar (just after the step).
    let mut t = vec![];
    for (i, f) in ["run_a", "run_b", "run_c"].iter().enumerate() {
        let id = ws.source_info()[i].id;
        let v = ws.get(&ws.info().iter().filter(|x| x.source_id == Some(id) && x.name.contains("Pressure")).map(|x| x.name.clone()).next().unwrap()).unwrap();
        let time = ws.base_time(v);
        let first = v.original.iter().position(|y| *y > 1.5).unwrap();
        t.push(time[first]);
        assert!(time[first] > truth[f].as_f64().unwrap() && time[first] < truth[f].as_f64().unwrap() + 1.0, "{f} rises at {}", time[first]);
    }
    assert!(((t[1] - t[0]) - 2.5).abs() < 0.1 && ((t[2] - t[0]) - 5.0).abs() < 0.1, "{t:?}");
}

#[test]
fn identification_finds_the_two_state_system() {
    use data_analyzer_lib::core::sysid::{identify_model, SysIdParams};
    use std::sync::Arc;
    let Some((d, m)) = suite() else { return };
    let mut ws = Workspace::default();
    load(&mut ws, &d, "system_id.csv", &ImportOptions::default(), &[]);
    let ds = ws.to_dataset("sysid").unwrap();
    let pick = |c: &str| (c.to_string(), ds.get_signal(c).unwrap());
    let inputs: Vec<(String, Arc<Vec<f64>>)> = vec![pick("u1"), pick("u2")];
    let outputs: Vec<(String, Arc<Vec<f64>>)> = vec![pick("y1"), pick("y2")];
    let min_vaf = m["files"]["system_id.csv"]["expected_vaf_percent_at_least"].as_f64().unwrap();
    for method in ["N4SID", "MOESP", "CVA"] {
        let params = SysIdParams { name: "m".into(), method: method.into(), order_min: 1, order_max: 4, decimation_factor: 1, start_idx: 0, end_idx: 0 };
        let models = identify_model(&inputs, &outputs, ds.sample_rate, &params, &|_, _| {}, &|| false).unwrap();
        let best = models.iter().map(|m| m.mean_vaf()).fold(0.0, f64::max);
        assert!(best >= min_vaf, "{method}: best VAF {best:.1}%");
    }
}

#[test]
fn project_round_trip_keeps_the_whole_suite() {
    let Some((d, _)) = suite() else { return };
    let mut ws = Workspace::default();
    load(&mut ws, &d, "force_100hz.csv", &ImportOptions::default(), &["Time (min)", "Force (N)"]);
    load(&mut ws, &d, "sensor_10hz.csv", &ImportOptions::default(), &["Time (s)", "Counts"]);
    ws.set_time_unit(ws.source_info()[0].id, 60.0).unwrap();
    ws.edit("Force (N)", Edit::Despike(4.0)).unwrap();
    ws.edit("Force (N)", Edit::FillGaps).unwrap();
    ws.edit("Force (N)", Edit::Downsample(10.0)).unwrap();
    let (before, _) = (ws.get("Force (N)").unwrap().data.clone(), ());
    let (mut back, warnings) = Workspace::from_project(&ws.to_project(), None);
    assert!(warnings.is_empty(), "{warnings:?}");
    back.to_parse();
    let after = back.get("Force (N)").unwrap();
    assert_eq!(after.data.len(), before.len());
    assert_eq!(after.edits, ws.get("Force (N)").unwrap().edits);
    assert!(after.data.iter().zip(before.iter()).all(|(a, b)| (a - b).abs() < 1e-9 || (a.is_nan() && b.is_nan())));
}

#[test]
fn a_report_builds_from_the_suite() {
    let Some((d, _)) = suite() else { return };
    let mut ws = Workspace::default();
    load(&mut ws, &d, "many_columns.csv", &ImportOptions::default(), &[]);
    let ds = ws.to_dataset("many").unwrap();
    let signals = ds.all_signals();
    let stats = compute_descriptive_stats(&signals, None);
    assert_eq!(stats.len(), 40);
    let out = std::env::temp_dir().join("da_suite_report.html");
    let content = ReportContent { metadata: Some(ds.metadata.clone()), stats: Some(stats.as_ref().clone()), ..Default::default() };
    generate_report(&out, "html", &content, &|_, _| {}).unwrap();
    let html = std::fs::read_to_string(&out).unwrap();
    assert!(html.contains("<h2>Statistics</h2>") && html.contains("Motor_1"));
    std::fs::remove_file(out).ok();
}

// ---------------------------------------------------------------------------------------------
// Stress
// ---------------------------------------------------------------------------------------------

fn timed<T>(label: &str, f: impl FnOnce() -> T) -> T {
    let t = Instant::now();
    let r = f();
    println!("{label:<58} {:>9.1} ms", t.elapsed().as_secs_f64() * 1e3);
    r
}

#[test]
#[ignore = "needs samples/stress (node tools/make-test-dataset.mjs --stress); run with --release"]
fn stress() {
    let Some(d) = dir("stress") else { panic!("generate the stress set first") };
    let mut ws = Workspace::default();
    let big = timed("import stress_1khz.csv (16 signals)", || load(&mut ws, &d, "stress_1khz.csv", &ImportOptions::default(), &[]));
    let rows = ws.get(&big[0]).unwrap().data.len();
    println!("   {rows} rows x {} signals", big.len());
    timed("import stress_100hz_minutes.csv", || load(&mut ws, &d, "stress_100hz_minutes.csv", &ImportOptions::default(), &[]));
    let id = ws.source_info()[1].id;
    ws.set_time_unit(id, 60.0).unwrap();
    timed("40 run files (batch import)", || {
        let paths: Vec<String> = (1..=40).map(|k| path(&d, &format!("runs/run_{k:02}.csv"))).collect();
        let (ok, bad) = ws.import_batch(&paths, None);
        assert!(bad.is_empty(), "{bad:?}");
        assert_eq!(ok.len(), 40 * 5, "four signals and a time column per file");
    });
    timed("import stress_wide.csv (200 signals)", || assert_eq!(load(&mut ws, &d, "stress_wide.csv", &ImportOptions::default(), &[]).len(), 201, "200 signals and a time column"));

    let name = big[1].clone(); // big[0] is the time column
    timed("despike 1M rows", || ws.edit(&name, Edit::Despike(5.0)).unwrap());
    timed("fill gaps", || ws.edit(&name, Edit::FillGaps).unwrap());
    timed("low-pass 5 Hz", || ws.edit(&name, filter(FilterType::Lowpass, json!({"cutoff": 5.0, "order": 4}))).unwrap());
    timed("notch 7 Hz", || ws.edit(&name, filter(FilterType::Notch, json!({"freq": 7.0, "q": 30.0}))).unwrap());
    timed("downsample by 100", || ws.edit(&name, Edit::Downsample(100.0)).unwrap());
    assert_eq!(ws.get(&name).unwrap().data.len(), rows / 100);
    timed("pipeline diagram (every block)", || assert!(ws.pipeline(&name).unwrap().stages.len() >= 5));
    timed("undo x3", || (0..3).for_each(|_| ws.undo(&name).unwrap()));

    timed("align on the common grid (Time)", || ws.set_align(Align::Time, None).unwrap());
    let ds = timed("build dataset from workspace", || ws.to_dataset("stress").unwrap());
    println!("   grid {} rows x {} signals", ds.n_samples(), ds.signals.len());
    let signals = ds.all_signals();
    timed("descriptive stats, all signals", || compute_descriptive_stats(&signals, None));
    let cols: Vec<&[f64]> = signals.iter().take(30).map(|s| s.1.as_slice()).collect();
    timed("Pearson matrix, 30 signals (pairwise)", || corrcoef_pairwise(&cols));
    timed("Spearman matrix, 8 signals", || spearman_pairwise(&signals.iter().take(8).map(|s| s.1.to_vec()).collect::<Vec<_>>()));
    timed("PSD of the first signal", || compute_psd(&signals[0].1, ds.sample_rate, None, None, ""));
    timed("report with statistics", || {
        let stats = compute_descriptive_stats(&signals, None);
        let out = std::env::temp_dir().join("da_stress_report.html");
        let content = ReportContent { metadata: Some(ds.metadata.clone()), stats: Some(stats.as_ref().clone()), ..Default::default() };
        generate_report(&out, "html", &content, &|_, _| {}).unwrap();
        std::fs::remove_file(out).ok();
    });
    timed("save project", || ws.to_project());
}
