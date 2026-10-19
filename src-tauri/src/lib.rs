pub mod commands;
pub mod core;
#[cfg(debug_assertions)]
pub mod devbridge;
pub mod state;

use std::sync::Arc;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Arc::new(state::AppState::default()))
        .setup(|_app| {
            #[cfg(debug_assertions)]
            devbridge::start(_app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::preview_file,
            commands::workspace_import,
            commands::workspace_view,
            commands::workspace_remove,
            commands::workspace_rename,
            commands::workspace_set_time,
            commands::workspace_clear,
            commands::workspace_edit,
            commands::workspace_vectors,
            commands::workspace_import_batch,
            commands::workspace_remove_source,
            commands::workspace_set_offset,
            commands::workspace_set_align,
            commands::workspace_add_derived,
            commands::workspace_set_formula,
            commands::workspace_variable,
            commands::recipe_save,
            commands::recipe_load,
            commands::recipe_apply,
            commands::recipe_set_auto,
            commands::project_save,
            commands::project_open,
            commands::export_dataset,
            commands::dataset_info,
            commands::descriptive_stats,
            commands::get_series,
            commands::analysis_vectors,
            commands::curve_fit,
            commands::values_at,
            commands::filter_suggest,
            commands::filter_preview,
            commands::filter_apply,
            commands::filter_clear,
            commands::filter_get_chain,
            commands::filter_save_chain,
            commands::filter_load_chain,
            commands::filter_describe,
            commands::spectrum,
            commands::correlation_compute,
            commands::correlation_pair,
            commands::correlation_lags,
            commands::sysid_auto_decimation,
            commands::sysid_estimate_time,
            commands::sysid_identify,
            commands::sysid_cancel,
            commands::sysid_save_result,
            commands::models_list,
            commands::model_detail,
            commands::model_rename,
            commands::model_duplicate,
            commands::model_delete,
            commands::models_compare,
            commands::model_update_matrices,
            commands::models_save,
            commands::models_load,
            commands::simulation_run,
            commands::simulation_clear,
            commands::simulation_view_cmd,
            commands::validation_run,
            commands::compare_add_files,
            commands::compare_state,
            commands::compare_remove_file,
            commands::compare_clear,
            commands::compare_set_offset,
            commands::compare_align_trigger,
            commands::compare_align_clicks,
            commands::compare_nearest_file,
            commands::compare_set_mapping,
            commands::compare_series,
            commands::compare_differences,
            commands::compare_stats,
            commands::report_generate,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Data Analyzer");
}
