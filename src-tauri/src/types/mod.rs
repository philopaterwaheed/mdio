use serde::Serialize;
use std::cmp::Ordering as CmpOrdering;
use std::sync::{Arc, Mutex};

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
        // Reverse ordering to create a min-heap (smallest score at top)
        other.score.cmp(&self.score)
    }
}

impl PartialOrd for SearchResult {
    fn partial_cmp(&self, other: &Self) -> Option<CmpOrdering> {
        Some(self.cmp(other))
    }
}
