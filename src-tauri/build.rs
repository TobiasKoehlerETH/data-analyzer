fn main() {
    // The app icon is stamped into the executable by this script, so it has to run again
    // whenever an icon file changes (otherwise Cargo keeps the previous icon).
    println!("cargo:rerun-if-changed=icons");
    println!("cargo:rerun-if-changed=tauri.conf.json");
    tauri_build::build()
}
