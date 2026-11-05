use std::fs;
use std::path::Path;

fn load_dotenv(path: &Path) {
    let Ok(contents) = fs::read_to_string(path) else {
        return;
    };
    for line in contents.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some((key, value)) = line.split_once('=') {
            println!("cargo:rustc-env={}={}", key.trim(), value.trim());
        }
    }
}

fn main() {
    load_dotenv(Path::new(".env"));
    println!("cargo:rerun-if-changed=.env");

    tauri_build::build()
}
