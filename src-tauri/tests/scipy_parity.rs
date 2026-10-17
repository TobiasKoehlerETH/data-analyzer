//! Numerical parity of the DSP ports against scipy reference output
//! (regenerate with `python tools/gen_scipy_reference.py`).

use data_analyzer_lib::core::dsp::*;
use data_analyzer_lib::core::stats::shapiro;
use serde_json::Value;

fn reference() -> Value {
    let s = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/scipy_reference.json")).unwrap();
    serde_json::from_str(&s).unwrap()
}

fn vec(v: &Value) -> Vec<f64> {
    v.as_array().unwrap().iter().map(|x| x.as_f64().unwrap()).collect()
}

fn max_abs_diff(a: &[f64], b: &[f64]) -> f64 {
    assert_eq!(a.len(), b.len(), "length mismatch");
    a.iter().zip(b).map(|(x, y)| (x - y).abs()).fold(0.0, f64::max)
}

#[test]
fn butterworth_sosfiltfilt() {
    let r = reference();
    let x = vec(&r["x"]);
    for case in r["butter"].as_array().unwrap() {
        let order = case["order"].as_u64().unwrap() as usize;
        let wn = vec(&case["wn"]);
        let bt = match case["btype"].as_str().unwrap() {
            "low" => BandType::Low,
            "high" => BandType::High,
            "bandpass" => BandType::BandPass,
            _ => BandType::BandStop,
        };
        let y = sosfiltfilt(&butter_sos(order, &wn, bt), &x).unwrap();
        let d = max_abs_diff(&y, &vec(&case["y"]));
        assert!(d < 1e-8, "{case:?}: max diff {d}", case = case["btype"]);
    }
}

#[test]
fn notch_matches() {
    let r = reference();
    let x = vec(&r["x"]);
    let n = &r["notch"];
    let s = iirnotch(n["freq"].as_f64().unwrap(), n["q"].as_f64().unwrap(), r["fs"].as_f64().unwrap());
    let b = vec(&n["b"]);
    let a = vec(&n["a"]);
    for i in 0..3 {
        assert!((s[i] - b[i]).abs() < 1e-14 && (s[3 + i] - a[i]).abs() < 1e-14);
    }
    let y = sosfiltfilt(&[s], &x).unwrap();
    assert!(max_abs_diff(&y, &vec(&n["y"])) < 1e-9);
}

#[test]
fn savgol_medfilt_match() {
    let r = reference();
    let x = vec(&r["x"]);
    assert!(max_abs_diff(&savgol_filter(&x, 51, 3), &vec(&r["savgol"]["y"])) < 1e-9);
    assert!(max_abs_diff(&medfilt(&x, 11), &vec(&r["medfilt"]["y"])) < 1e-15);
}

#[test]
fn welch_matches() {
    let r = reference();
    let x = vec(&r["x"]);
    let fs = r["fs"].as_f64().unwrap();
    for key in ["welch", "welch_odd"] {
        let w = &r[key];
        let (f, p) = welch(&x, fs, w["nperseg"].as_u64().unwrap() as usize);
        assert!(max_abs_diff(&f, &vec(&w["f"])) < 1e-12);
        let pr = vec(&w["p"]);
        let rel = p.iter().zip(&pr).map(|(a, b)| (a - b).abs() / b.abs().max(1e-12)).fold(0.0, f64::max);
        assert!(rel < 1e-9, "{key}: rel diff {rel}");
    }
}

#[test]
fn decimate_matches() {
    let r = reference();
    let x = vec(&r["x"]);
    for key in ["decimate", "decimate_big"] {
        let q = r[key]["q"].as_u64().unwrap() as usize;
        let y = decimate(&x, q).unwrap();
        let d = max_abs_diff(&y, &vec(&r[key]["y"]));
        assert!(d < 1e-6, "{key}: max diff {d}");
    }
}

#[test]
fn find_peaks_matches() {
    let r = reference();
    let p = vec(&r["welch"]["p"]);
    let (idx, prom) = find_peaks_prominence(&p, r["peaks"]["threshold"].as_f64().unwrap());
    let ridx: Vec<usize> = vec(&r["peaks"]["idx"]).iter().map(|v| *v as usize).collect();
    assert_eq!(idx, ridx);
    assert!(max_abs_diff(&prom, &vec(&r["peaks"]["prom"])) < 1e-12);
}

#[test]
fn shapiro_matches() {
    let r = reference();
    let s = &r["shapiro"];
    let (w, p) = shapiro(&vec(&s["x"])).unwrap();
    assert!((w - s["w"].as_f64().unwrap()).abs() < 1e-6, "W {w}");
    assert!((p - s["p"].as_f64().unwrap()).abs() < 1e-4, "p {p}");
    let (w8, p8) = shapiro(&[1.0, 2.0, 4.0, 8.0, 9.0, 15.0, 2.0, 3.0]).unwrap();
    assert!((w8 - s["w8"].as_f64().unwrap()).abs() < 1e-6, "W8 {w8}");
    assert!((p8 - s["p8"].as_f64().unwrap()).abs() < 1e-4, "p8 {p8}");
}
