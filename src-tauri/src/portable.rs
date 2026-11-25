// The portable OTO.exe carries Node and the server inside it (a zip the release build makes, see scripts/tauri-release-files.js)
// and unpacks them once per build into the data folder, next to what OTO saves.

use std::{
    hash::{Hash, Hasher},
    io::Cursor,
    path::{Path, PathBuf},
};

static PAYLOAD: &[u8] = include_bytes!(env!("OTO_PAYLOAD"));

// Returns (node, server folder), unpacking them first when this build has not been unpacked yet
pub fn unpack(data_dir: &Path, version: &str) -> std::io::Result<(PathBuf, PathBuf)> {
    // Named by the payload's hash too: two builds of the same version must not share a folder
    let mut hasher = std::hash::DefaultHasher::new();
    PAYLOAD.hash(&mut hasher);
    let runtime = data_dir.join("runtime");
    let dir = runtime.join(format!("{version}-{:016x}", hasher.finish()));
    let node = dir.join(format!("node{}", std::env::consts::EXE_SUFFIX));
    if !dir.join(".complete").exists() {
        let partial = dir.with_extension("partial");
        let _ = std::fs::remove_dir_all(&partial);
        zip::ZipArchive::new(Cursor::new(PAYLOAD)).and_then(|mut zip| zip.extract(&partial)).map_err(std::io::Error::other)?;
        std::fs::write(partial.join(".complete"), b"")?;
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::rename(&partial, &dir)?;
        // Older builds' folders are no longer used
        for old in std::fs::read_dir(&runtime)?.flatten() {
            if old.path() != dir {
                let _ = std::fs::remove_dir_all(old.path());
            }
        }
    }
    Ok((node, dir.join("server")))
}
