use std::sync::{Arc, Mutex};
use tauri::State;

#[derive(Default)]
pub struct CurruntFile {
    pub path: Option<String>,
}

#[derive(Clone)]
pub struct FileState {
    pub files: Arc<Mutex<Vec<String>>>,
}

impl FileState {
    pub fn new() -> Self {
        Self {
            files: Arc::new(Mutex::new(Vec::new())),
        }
    }
}
