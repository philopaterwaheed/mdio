use serde::Serialize;
use std::cmp::Ordering as CmpOrdering;
use std::sync::{Arc, Mutex};

#[derive(Default)]
pub struct CurrentDoc {
    pub path: Option<String>,
    pub source: String,
}

pub struct CurruntFile {
    pub doc: Mutex<CurrentDoc>,
}

impl CurruntFile {
    pub fn new(path: Option<String>) -> Self {
        Self {
            doc: Mutex::new(CurrentDoc {
                path,
                source: String::new(),
            }),
        }
    }
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

#[derive(Debug, Clone, Serialize)]
pub struct SearchResult {
    pub name: String,
    pub path: String,
    pub score: i64,
}

impl Eq for SearchResult {}

impl PartialEq for SearchResult {
    fn eq(&self, other: &Self) -> bool {
        self.score == other.score
    }
}

impl Ord for SearchResult {
    fn cmp(&self, other: &Self) -> CmpOrdering {
        other.score.cmp(&self.score)
    }
}

impl PartialOrd for SearchResult {
    fn partial_cmp(&self, other: &Self) -> Option<CmpOrdering> {
        Some(self.cmp(other))
    }
}

#[derive(Debug, Serialize)]
pub struct RenderedFile {
    pub html: String,
    pub source: String,
    pub path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiskInfo {
    pub path: String,
    pub name: String,
    pub directory: String,
    pub bytes: u64,
    pub modified_ms: Option<i64>,
    pub created_ms: Option<i64>,
    pub readonly: bool,
}

pub struct WatcherState {
    pub current_path: Arc<Mutex<Option<String>>>,
}

#[derive(Default)]
pub struct Patch {
    pub path: Option<String>,
}
