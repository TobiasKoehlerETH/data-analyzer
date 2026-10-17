//! Full engine pipeline on the repository's sample_data.csv (skipped if the file is absent).

use std::path::PathBuf;
use std::sync::Arc;

use data_analyzer_lib::core::cache::CacheManager;
use data_analyzer_lib::core::correlation::compute_correlation_matrix;
use data_analyzer_lib::core::csv_parser::{parse_file, preview_file};
use data_analyzer_lib::core::dataset::Dataset;
use data_analyzer_lib::core::filters::{apply_chain, suggest_filters, FilterChain};
use data_analyzer_lib::core::report::{generate_report, ReportContent};
use data_analyzer_lib::core::simulation::simulate;
use data_analyzer_lib::core::spectrum::{compute_psd, detect_peaks};
use data_analyzer_lib::core::stats::compute_descriptive_stats;
use data_analyzer_lib::core::sysid::{estimate_decimation_factor, identify_model, SysIdParams};
use data_analyzer_lib::core::validation::validate;

fn sample() -> Option<PathBuf> {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../sample_data.csv");
    p.exists().then_some(p)
}

#[test]
fn sample_pipeline() {
    let Some(path) = sample() else { return };
    let t0 = std::time::Instant::now();
    let prev = preview_file(&path, None).unwrap();
    assert!(prev.is_raser_format);
    assert_eq!(prev.delimiter, ";");
    assert_eq!(prev.headers.len(), 7);
    assert_eq!(prev.rows.len(), 100);
    assert_eq!(prev.metadata["User"], "synthetic");

    let parsed = parse_file(&path, None).unwrap();
    let ds = Dataset::from_parse(&path.to_string_lossy(), parsed);
    assert_eq!(ds.signals.len(), 6);
    assert!(ds.n_samples() > 4900);
    assert!((ds.sample_rate - 1.0).abs() < 0.01, "fs {}", ds.sample_rate);
    let groups: Vec<&str> = ds.signals.iter().map(|s| s.group.as_str()).collect();
    assert!(groups.contains(&"Motor") && groups.contains(&"Temperature") && groups.contains(&"Leakage"));
    println!("load: {:?}", t0.elapsed());

    let cache = CacheManager::default();
    let signals = ds.all_signals();
    let stats = compute_descriptive_stats(&signals, Some(&cache));
    assert_eq!(stats.len(), 6);
    let corr = compute_correlation_matrix(&signals, Some(&cache));
    assert_eq!(corr.top_pairs.len(), 15);

    let torque = ds.get_raw("Motor_Torque [Nm]").unwrap();
    let sugg = suggest_filters(&torque, ds.sample_rate, Some(&cache), "Motor_Torque [Nm]");
    println!("suggestions: {:#?}", sugg.iter().map(|s| &s.reason).collect::<Vec<_>>());
    let mut chain = FilterChain::default();
    chain.steps.extend(sugg.iter().map(|s| s.to_step()));
    let filtered = apply_chain(&torque, &chain, ds.sample_rate).unwrap();
    assert_eq!(filtered.len(), torque.len());
    let psd = compute_psd(&torque, ds.sample_rate, Some(4096), None, "");
    let _peaks = detect_peaks(&psd, 8.0, 0.0);

    let pick = |c: &str| (c.to_string(), ds.get_signal(c).unwrap());
    let inputs: Vec<(String, Arc<Vec<f64>>)> = vec![pick("Motor_Speed [rpm]"), pick("Motor_Torque [Nm]")];
    let outputs: Vec<(String, Arc<Vec<f64>>)> = vec![pick("T_Left [degC]"), pick("T_Right [degC]"), pick("Pressure [bar]")];
    let dec = estimate_decimation_factor(&outputs, ds.sample_rate, Some(&cache));
    println!("auto decimation: {dec}");
    for method in ["N4SID", "MOESP", "CVA"] {
        let t1 = std::time::Instant::now();
        let params = SysIdParams { name: "Model".into(), method: method.into(), order_min: 1, order_max: 6, decimation_factor: dec, start_idx: 0, end_idx: 0 };
        let models = identify_model(&inputs, &outputs, ds.sample_rate, &params, &|_, _| {}, &|| false).unwrap();
        assert!(!models.is_empty());
        let best = &models[0];
        println!("{method}: {} models, best order {} mean VAF {:.1}% ({:?})", models.len(), best.order, best.mean_vaf(), t1.elapsed());
        let sim = simulate(best, &inputs, &outputs, &ds.time, None, 0, 0).unwrap();
        let ins: Vec<(String, Vec<f64>)> = inputs.iter().map(|(n, d)| (n.clone(), d.to_vec())).collect();
        let val = validate(&sim, Some(&ins), 100);
        assert_eq!(val.analyses.len(), 3);
        assert!(val.analyses.iter().all(|a| a.metrics.rmse.is_finite()));
    }

    let out = std::env::temp_dir().join("da_sample_report.html");
    let content = ReportContent { metadata: Some(ds.metadata.clone()), stats: Some(stats.as_ref().clone()), ..Default::default() };
    let (p, _) = generate_report(&out, "html", &content, &|_, _| {}).unwrap();
    let html = std::fs::read_to_string(p).unwrap();
    assert!(html.contains("Descriptive statistics") && html.contains("synthetic"));
    assert!(html.contains("cover-band") && html.contains("data:image/png;base64"));
    std::fs::copy(&out, std::env::temp_dir().join("da_sample_report_copy.html")).ok();
    println!("total: {:?}", t0.elapsed());
}
