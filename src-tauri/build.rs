fn main() {
    // the commands the pages may call (src/main.rs); capabilities/ says which window may call which
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
        "get_app_settings",
        "set_app_setting",
        "take_opened_packages",
        "save_password",
        "close_password_window",
    ])))
    .expect("tauri build script failed")
}
