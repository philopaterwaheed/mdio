// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod files;
mod types;

use files::notify::FileWatcher;
use types::{CurruntFile, FileState, RenderedFile};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::Manager;

#[tauri::command]
fn render_markdown(markdown: String) -> String {
    files::markdown::render_html(&markdown)
}

#[tauri::command]
fn add_file(state: tauri::State<FileState>, path: String) {
    let mut files = state.files.lock().unwrap();
    if !files.contains(&path) {
        files.push(path.clone());
        println!("Added file: {}", path);
    }
}

#[tauri::command]
fn list_files(state: tauri::State<FileState>) -> Vec<String> {
    let files = state.files.lock().unwrap();
    files.clone()
}

#[tauri::command]
fn parse_file(
    state: tauri::State<CurruntFile>,
    watcher: tauri::State<Mutex<FileWatcher>>,
    file_path: Option<String>,
) -> Result<RenderedFile, String> {
    let mut doc = state.doc.lock().map_err(|e| e.to_string())?;
    let path = match file_path {
        Some(path) => path,
        None => doc
            .path
            .clone()
            .ok_or_else(|| "No file path provided".to_string())?,
    };

    if let Ok(mut watcher) = watcher.lock() {
        if let Err(e) = watcher.watch_file(path.clone()) {
            eprintln!("Failed to watch file '{}': {}", path, e);
        }
    }

    let source = fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read file '{}': {}", path, e))?;
    let html = files::markdown::render_mapped(&source);
    doc.path = Some(path.clone());
    doc.source = source.clone();

    Ok(RenderedFile {
        html,
        source,
        path,
    })
}

#[tauri::command]
fn splice_source(
    state: tauri::State<CurruntFile>,
    watcher: tauri::State<Mutex<FileWatcher>>,
    start: usize,
    end: usize,
    text: String,
) -> Result<RenderedFile, String> {
    let mut doc = state.doc.lock().map_err(|e| e.to_string())?;
    let path = doc
        .path
        .clone()
        .ok_or_else(|| "No file is open".to_string())?;

    if start > end || end > doc.source.len() {
        return Err("Invalid source range".into());
    }
    if !doc.source.is_char_boundary(start) || !doc.source.is_char_boundary(end) {
        return Err("Source range is not on a character boundary".into());
    }

    if &doc.source[start..end] != text {
        doc.source.replace_range(start..end, &text);
        if let Ok(watcher) = watcher.lock() {
            watcher.ignore_for(Duration::from_millis(400));
        }
        atomic_write(&path, &doc.source)?;
    }

    Ok(RenderedFile {
        html: files::markdown::render_mapped(&doc.source),
        source: doc.source.clone(),
        path,
    })
}

#[tauri::command]
fn create_markdown_file(
    state: tauri::State<CurruntFile>,
    name: String,
) -> Result<String, String> {
    let current = state
        .doc
        .lock()
        .ok()
        .and_then(|doc| doc.path.clone());
    let path = resolve_new_markdown_path(&name, current.as_deref())?;
    if path.exists() {
        return Err(format!("Already exists: {}", path.display()));
    }
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|e| {
                format!("Failed to create '{}': {}", parent.display(), e)
            })?;
        }
    }
    fs::write(&path, "").map_err(|e| format!("Failed to create '{}': {}", path.display(), e))?;
    files::search::index_file(&path);
    Ok(path.to_string_lossy().into_owned())
}

fn resolve_new_markdown_path(name: &str, current: Option<&str>) -> Result<PathBuf, String> {
    let name = name.trim().trim_end_matches(['/', '\\']);
    if name.is_empty() || name == "." || name == ".." {
        return Err("Name is empty".into());
    }
    if name.chars().any(|c| c == '\0') {
        return Err("Invalid name".into());
    }

    let mut path = if let Some(rest) = name.strip_prefix("~/") {
        dirs::home_dir()
            .ok_or_else(|| "No home directory".to_string())?
            .join(rest)
    } else if name == "~" {
        return Err("Name is empty".into());
    } else {
        let given = PathBuf::from(name);
        if given.is_absolute() {
            given
        } else {
            let base = current
                .and_then(|path| Path::new(path).parent().map(Path::to_path_buf))
                .or_else(dirs::home_dir)
                .unwrap_or_else(|| PathBuf::from("."));
            base.join(name)
        }
    };

    if path.file_name().is_none() {
        return Err("Name is empty".into());
    }
    if path.extension().is_none() {
        path.set_extension("md");
    }

    Ok(path)
}

#[tauri::command]
fn watch_file(watcher: tauri::State<Mutex<FileWatcher>>, path: String) -> Result<(), String> {
    watcher
        .lock()
        .map_err(|e| e.to_string())?
        .watch_file(path)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn stop_watching(watcher: tauri::State<Mutex<FileWatcher>>) -> Result<(), String> {
    watcher
        .lock()
        .map_err(|e| e.to_string())?
        .stop_watching()
        .map_err(|e| e.to_string())
}

fn atomic_write(path: &str, contents: &str) -> Result<(), String> {
    let tmp = Path::new(path).with_extension("mdio-tmp");
    fs::write(&tmp, contents).map_err(|e| format!("Failed to write '{}': {}", tmp.display(), e))?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("Failed to save '{}': {}", path, e)
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            render_markdown,
            parse_file,
            splice_source,
            create_markdown_file,
            add_file,
            files::search::start_live_fuzzy_search,
            files::search::cancel_fuzzy_search,
            list_files,
            watch_file,
            stop_watching
        ])
        .manage(FileState::new())
        .setup(|app| {
            let watcher = FileWatcher::new(app.handle().clone())?;
            app.manage(Mutex::new(watcher));
            files::search::warmup_index("md");

            let args: Vec<String> = std::env::args().collect();
            let state = app.state::<FileState>();
            let mut files = state.files.lock().unwrap();
            if args.len() > 1 {
                let file_path = &args[1];
                println!("Received file argument: {}", file_path);
                files.push(file_path.clone());
                app.manage(CurruntFile::new(Some(file_path.clone())));
            } else {
                app.manage(CurruntFile::new(None));
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
