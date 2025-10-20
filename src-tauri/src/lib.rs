// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod types;
mod files;

use types::{CurruntFile, FileState};
use pulldown_cmark::{html, Options, Parser};
use std::fs;
use tauri::Manager;

#[tauri::command]
fn render_markdown(markdown: String) -> String {
    let mut options = Options::empty();
    options.insert(Options::ENABLE_TABLES);
    options.insert(Options::ENABLE_FOOTNOTES);
    options.insert(Options::ENABLE_STRIKETHROUGH);
    options.insert(Options::ENABLE_TASKLISTS);
    options.insert(Options::ENABLE_HEADING_ATTRIBUTES);

    let parser = Parser::new_ext(&markdown, options);
    let mut html_output = String::new();
    html::push_html(&mut html_output, parser);
    html_output
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
    file_path: Option<String>,
) -> Result<String, String> {
    if file_path.is_none() {
        if state.path.is_none() {
            return Err("No file path provided".into());
        } else {
            let path = state.path.as_ref().unwrap().clone();
            let contents = fs::read_to_string(&path)
                .map_err(|e| format!("Failed to read file '{}': {}", path, e))?;
            let html = render_markdown(contents);
            return Ok(html);
        }
    } else {

        let path = file_path.as_ref().unwrap();
        let contents = fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read file '{}': {}", path, e))?;
        let html = render_markdown(contents);
        println!("got here");
        return Ok(html);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![render_markdown, parse_file, add_file, files::search::start_live_fuzzy_search ,files::search::cancel_fuzzy_search, list_files])
        .manage(FileState::new())
        .setup(|app| {
            let args: Vec<String> = std::env::args().collect();
            let state = app.state::<FileState>();
            let mut files = state.files.lock().unwrap();
            if args.len() > 1 {
                let file_path = &args[1];
                println!("Received file argument: {}", file_path);
                files.push(file_path.clone());
                app.manage(CurruntFile {
                    path: Some(file_path.clone()),
                });
            } else {
                app.manage(CurruntFile { path: None });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

