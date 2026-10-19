//! Development-only HTTP bridge so the UI can be exercised in a regular browser
//! (e.g. `npm run dev` + http://localhost:1420) against the real Rust backend.
//!
//! Debug builds only, bound to 127.0.0.1. `POST /invoke/<command>` takes the same JSON
//! arguments as Tauri's `invoke` (camelCase keys); `GET /events` drains emitted events.

use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Listener, Manager};

use crate::commands as c;
use crate::core::csv_parser::ImportOptions;
use crate::core::filters::{FilterChain, FilterStep};
use crate::state::AppState;

pub const PORT: u16 = 1430;

/// Deserialises the camelCase argument object into local bindings.
macro_rules! args {
    ($v:expr; $($n:ident : $t:ty),* $(,)?) => {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        #[allow(non_snake_case, dead_code)]
        struct A { $($n: $t),* }
        let A { $($n),* } = serde_json::from_value::<A>($v).map_err(|e| format!("bad arguments: {e}"))?;
    };
}

fn ok<T: serde::Serialize>(v: T) -> Result<Value, String> {
    serde_json::to_value(v).map_err(|e| e.to_string())
}

async fn dispatch(app: &AppHandle, cmd: &str, a: Value) -> Result<Value, String> {
    let st = || app.state::<Arc<AppState>>();
    let a2 = a.clone();
    match cmd {
        "preview_file" => { args!(a; path: String, sheet: Option<String>, options: Option<ImportOptions>); ok(c::preview_file(path, sheet, options).await?) }
        "workspace_import" => { args!(a; path: String, sheet: Option<String>, options: Option<ImportOptions>, columns: Vec<String>); ok(c::workspace_import(app.clone(), st(), path, sheet, options, columns).await?) }
        "workspace_view" => ok(c::workspace_view(st())),
        "workspace_remove" => { args!(a; names: Vec<String>); ok(c::workspace_remove(app.clone(), st(), names).await?) }
        "workspace_rename" => { args!(a; old: String, new: String); ok(c::workspace_rename(app.clone(), st(), old, new).await?) }
        "workspace_set_time" => { args!(a; name: Option<String>); ok(c::workspace_set_time(app.clone(), st(), name).await?) }
        "workspace_edit" => { args!(a; name: String, action: String, edit: Option<crate::core::workspace::Edit>); ok(c::workspace_edit(app.clone(), st(), name, action, edit).await?) }
        "workspace_vectors" => { args!(a; names: Vec<String>); ok(c::workspace_vectors(st(), names).await?) }
        "workspace_clear" => ok(c::workspace_clear(app.clone(), st()).await?),
        "export_dataset" => { args!(a; path: String); ok(c::export_dataset(st(), path).await?) }
        "dataset_info" => ok(c::dataset_info(st())),
        "descriptive_stats" => ok(c::descriptive_stats(st()).await?),
        "analysis_vectors" => { args!(a; columns: Vec<String>); ok(c::analysis_vectors(st(), columns).await?) }
        "curve_fit" => { let request = serde_json::from_value(a2.get("request").cloned().unwrap_or(Value::Null)).map_err(|e| e.to_string())?; ok(c::curve_fit(request).await?) }
        "get_series" => { args!(a; columns: Vec<String>, range: Option<[f64; 2]>, maxPoints: usize); ok(c::get_series(st(), columns, range, maxPoints)?) }
        "values_at" => { args!(a; columns: Vec<String>, t: f64); ok(c::values_at(st(), columns, t)?) }
        "filter_suggest" => { args!(a; column: String); ok(c::filter_suggest(st(), column).await?) }
        "filter_preview" => { args!(a; column: String, chain: FilterChain, draft: Option<FilterStep>); ok(c::filter_preview(st(), column, chain, draft).await?) }
        "filter_apply" => { args!(a; column: String, chain: FilterChain); ok(c::filter_apply(st(), column, chain).await?) }
        "filter_clear" => { args!(a; column: String); ok(c::filter_clear(st(), column)?) }
        "filter_get_chain" => { args!(a; column: String); ok(c::filter_get_chain(st(), column)?) }
        "filter_save_chain" => { args!(a; path: String, chain: FilterChain); ok(c::filter_save_chain(path, chain)?) }
        "filter_load_chain" => { args!(a; path: String); ok(c::filter_load_chain(path)?) }
        "filter_describe" => { args!(a; steps: Vec<FilterStep>); ok(c::filter_describe(steps)) }
        "spectrum" => { args!(a; column: String, nperseg: usize); ok(c::spectrum(st(), column, nperseg).await?) }
        "correlation_compute" => ok(c::correlation_compute(st()).await?),
        "correlation_pair" => { args!(a; a: String, b: String); ok(c::correlation_pair(st(), a, b).await?) }
        "correlation_lags" => ok(c::correlation_lags(st()).await?),
        "sysid_auto_decimation" => { args!(a; columns: Vec<String>); ok(c::sysid_auto_decimation(st(), columns).await?) }
        "sysid_estimate_time" => { args!(a; nSamples: usize, nInputs: usize, nOutputs: usize, orderMin: usize, orderMax: usize); ok(c::sysid_estimate_time(nSamples, nInputs, nOutputs, orderMin, orderMax)) }
        "sysid_identify" => { let req = serde_json::from_value(a2.get("req").cloned().unwrap_or(Value::Null)).map_err(|e| e.to_string())?; ok(c::sysid_identify(app.clone(), st(), req).await?) }
        "sysid_cancel" => ok(c::sysid_cancel(st())),
        "sysid_save_result" => { args!(a; index: usize); ok(c::sysid_save_result(st(), index)?) }
        "models_list" => ok(c::models_list(st())),
        "model_detail" => { args!(a; name: String); ok(c::model_detail(st(), name)?) }
        "model_rename" => { args!(a; old: String, new: String); ok(c::model_rename(st(), old, new)?) }
        "model_duplicate" => { args!(a; names: Vec<String>); ok(c::model_duplicate(st(), names)) }
        "model_delete" => { args!(a; names: Vec<String>); ok(c::model_delete(st(), names)) }
        "models_compare" => { args!(a; names: Vec<String>); ok(c::models_compare(st(), names)) }
        "model_update_matrices" => { args!(a; name: String, a: Vec<Vec<f64>>, b: Vec<Vec<f64>>, c: Vec<Vec<f64>>, d: Vec<Vec<f64>>); ok(c::model_update_matrices(st(), name, a, b, c, d)?) }
        "models_save" => { args!(a; path: String); ok(c::models_save(st(), path)?) }
        "models_load" => { args!(a; path: String); ok(c::models_load(st(), path)?) }
        "simulation_run" => { args!(a; model: String, start: usize, end: usize, autoX0: bool, append: bool); ok(c::simulation_run(st(), model, start, end, autoX0, append).await?) }
        "simulation_clear" => ok(c::simulation_clear(st())),
        "simulation_view_cmd" => ok(c::simulation_view_cmd(st())?),
        "validation_run" => { args!(a; model: String); ok(c::validation_run(st(), model).await?) }
        "compare_add_files" => { args!(a; paths: Vec<String>); ok(c::compare_add_files(app.clone(), st(), paths).await?) }
        "compare_state" => ok(c::compare_state(st())),
        "compare_remove_file" => { args!(a; id: String); ok(c::compare_remove_file(st(), id)) }
        "compare_clear" => ok(c::compare_clear(st())),
        "compare_set_offset" => { args!(a; id: String, offset: f64); ok(c::compare_set_offset(st(), id, offset)) }
        "compare_align_trigger" => { args!(a; signal: String, threshold: f64, rising: bool); ok(c::compare_align_trigger(st(), signal, threshold, rising)) }
        "compare_align_clicks" => { args!(a; clicks: Vec<(String, f64)>); ok(c::compare_align_clicks(st(), clicks)) }
        "compare_nearest_file" => { args!(a; signal: String, t: f64, y: f64); ok(c::compare_nearest_file(st(), signal, t, y)) }
        "compare_set_mapping" => { args!(a; canonical: String, id: String, column: Option<String>); ok(c::compare_set_mapping(st(), canonical, id, column)) }
        "compare_series" => { args!(a; signals: Vec<String>, range: Option<[f64; 2]>, maxPoints: usize); ok(c::compare_series(st(), signals, range, maxPoints)) }
        "compare_differences" => { args!(a; signals: Vec<String>, maxPoints: usize); ok(c::compare_differences(st(), signals, maxPoints)) }
        "compare_stats" => { args!(a; signals: Vec<String>); ok(c::compare_stats(st(), signals)) }
        "report_generate" => { args!(a; sections: Vec<String>, format: String, path: String); ok(c::report_generate(app.clone(), st(), sections, format, path).await?) }
        other => Err(format!("Unknown command '{other}' (dev bridge)")),
    }
}

fn cors(resp: tiny_http::Response<std::io::Cursor<Vec<u8>>>) -> tiny_http::Response<std::io::Cursor<Vec<u8>>> {
    let h = |k: &str, v: &str| tiny_http::Header::from_bytes(k.as_bytes(), v.as_bytes()).unwrap();
    resp.with_header(h("Access-Control-Allow-Origin", "*"))
        .with_header(h("Access-Control-Allow-Headers", "content-type"))
        .with_header(h("Access-Control-Allow-Methods", "GET, POST, OPTIONS"))
        .with_header(h("Content-Type", "application/json"))
}

pub fn start(app: AppHandle) {
    let events: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
    {
        let ev = events.clone();
        app.listen_any("progress", move |e| {
            if let Ok(v) = serde_json::from_str::<Value>(e.payload()) {
                let mut q = ev.lock().unwrap();
                q.push(json!({ "event": "progress", "payload": v }));
                let len = q.len();
                if len > 500 {
                    q.drain(..len - 500);
                }
            }
        });
    }
    std::thread::spawn(move || {
        let server = match tiny_http::Server::http(("127.0.0.1", PORT)) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("dev bridge: cannot bind 127.0.0.1:{PORT}: {e}");
                return;
            }
        };
        eprintln!("dev bridge listening on http://127.0.0.1:{PORT}");
        for mut req in server.incoming_requests() {
            let app = app.clone();
            let events = events.clone();
            std::thread::spawn(move || {
                let url = req.url().to_string();
                let resp = if *req.method() == tiny_http::Method::Options {
                    tiny_http::Response::from_data(Vec::new())
                } else if url.starts_with("/events") {
                    let drained: Vec<Value> = std::mem::take(&mut *events.lock().unwrap());
                    tiny_http::Response::from_data(serde_json::to_vec(&drained).unwrap())
                } else if let Some(cmd) = url.strip_prefix("/invoke/") {
                    let mut body = String::new();
                    let _ = std::io::Read::read_to_string(req.as_reader(), &mut body);
                    let args: Value = serde_json::from_str(if body.trim().is_empty() { "{}" } else { &body }).unwrap_or(Value::Null);
                    let result = tauri::async_runtime::block_on(dispatch(&app, cmd, args));
                    match result {
                        Ok(v) => tiny_http::Response::from_data(serde_json::to_vec(&json!({ "result": v })).unwrap()),
                        Err(e) => tiny_http::Response::from_data(serde_json::to_vec(&json!({ "error": e })).unwrap()).with_status_code(400),
                    }
                } else {
                    tiny_http::Response::from_data(b"{\"ok\":true}".to_vec())
                };
                let _ = req.respond(cors(resp));
            });
        }
    });
}
