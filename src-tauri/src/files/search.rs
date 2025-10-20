use tauri::{AppHandle, Manager};
use walkdir::WalkDir;
use fuzzy_matcher::skim::SkimMatcherV2;
use fuzzy_matcher::FuzzyMatcher;
use std::{
    path::PathBuf,
    sync::{Arc, atomic::{AtomicBool, Ordering}},
    thread,
    collections::BinaryHeap,
};
use tauri::Emitter;
use once_cell::sync::Lazy;
use crate::types::SearchResult;

// Shared cancel flag (used by all searches)
static CANCEL_FLAG: Lazy<Arc<AtomicBool>> = Lazy::new(|| Arc::new(AtomicBool::new(false)));

#[tauri::command]
pub fn cancel_fuzzy_search() {
    CANCEL_FLAG.store(true, Ordering::SeqCst);
}

#[tauri::command]
pub async fn start_live_fuzzy_search(app: AppHandle, extension: String, query: String) {
    // cancel any running search first
    CANCEL_FLAG.store(true, Ordering::SeqCst);
    // wait briefly for old thread to notice
    std::thread::sleep(std::time::Duration::from_millis(50));
    // reset cancel flag
    CANCEL_FLAG.store(false, Ordering::SeqCst);
    
    let cancel_flag = CANCEL_FLAG.clone();
    
    thread::spawn(move || {
        let matcher = SkimMatcherV2::default();
        let root = dirs::home_dir().unwrap_or(PathBuf::from("/"));
        
        let mut top_results: BinaryHeap<SearchResult> = BinaryHeap::new();
        const MAX_RESULTS: usize = 100;
        
        for entry in WalkDir::new(root)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|e| e.file_type().is_file())
        {
            if cancel_flag.load(Ordering::SeqCst) {
                break;
            }
            
            let path = entry.path();
            if let Some(ext) = path.extension().and_then(|s| s.to_str()) {
                if ext == extension {
                    let filename = path.file_name().unwrap().to_string_lossy();
                    if let Some(score) = matcher.fuzzy_match(&filename, &query) {
                        let result = SearchResult {
                            name: filename.to_string(),
                            path: path.to_string_lossy().to_string(),
                            score,
                        };
                        
                        let should_emit = if top_results.len() < MAX_RESULTS {
                            top_results.push(result);
                            true
                        } else if let Some(min_result) = top_results.peek() {
                            if score > min_result.score {
                                top_results.pop();
                                top_results.push(result);
                                true
                            } else {
                                false
                            }
                        } else {
                            false
                        };
                        
                        if should_emit {
                            let mut sorted_results: Vec<_> = top_results.iter().cloned().collect();
                            sorted_results.sort_by(|a, b| b.score.cmp(&a.score));
                            
                            let _ = app.emit("live_fuzzy_result", sorted_results);
                        }
                    }
                }
            }
        }
        
        let final_results: Vec<_> = top_results.into_sorted_vec();
        
        let _ = app.emit("live_fuzzy_result", final_results);
        let _ = app.emit("live_fuzzy_done", {});
    });
}
