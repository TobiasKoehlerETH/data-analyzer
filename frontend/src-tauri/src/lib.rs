use tauri_plugin_shell::ShellExt;

/// Launch the Python analysis backend (FastAPI on 127.0.0.1:8000).
/// Dev: run the project's venv uvicorn. Release: run the bundled PyInstaller sidecar.
fn start_backend(app: &tauri::App) {
    let shell = app.shell();

    #[cfg(debug_assertions)]
    {
        let backend = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("backend");
        let python = backend.join(".venv").join("Scripts").join("python.exe");
        if let Err(e) = shell
            .command(python)
            .args(["-m", "uvicorn", "app:app", "--port", "8000"])
            .current_dir(&backend)
            .spawn()
        {
            eprintln!("failed to start dev backend: {e}");
        }
    }

    #[cfg(not(debug_assertions))]
    {
        match shell.sidecar("data-analyzer-backend") {
            Ok(cmd) => {
                if let Err(e) = cmd.spawn() {
                    eprintln!("failed to start backend sidecar: {e}");
                }
            }
            Err(e) => eprintln!("backend sidecar not found: {e}"),
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            start_backend(app);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
