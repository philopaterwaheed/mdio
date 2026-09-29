use crate::types::SearchResult;
use fuzzy_matcher::skim::SkimMatcherV2;
use fuzzy_matcher::FuzzyMatcher;
use std::{
    collections::BinaryHeap,
    ffi::OsStr,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter};
use walkdir::WalkDir;

const MAX_RESULTS: usize = 100;
const EMIT_INTERVAL: Duration = Duration::from_millis(40);

static SEARCH_GEN: AtomicU64 = AtomicU64::new(0);
static INDEX: Mutex<Option<FileIndex>> = Mutex::new(None);
static INDEX_BUILD: Mutex<()> = Mutex::new(());

struct FileIndex {
    extension: String,
    files: Arc<Vec<(String, String)>>,
}

#[tauri::command]
pub fn cancel_fuzzy_search() {
    SEARCH_GEN.fetch_add(1, Ordering::Relaxed);
}

pub fn warmup_index(extension: &str) {
    let extension = extension.to_string();
    thread::spawn(move || {
        let _build = INDEX_BUILD.lock().unwrap_or_else(|e| e.into_inner());
        if cached_index(&extension).is_some() {
            return;
        }
        let files = collect_files(&extension, &|| false);
        store_index(extension, files);
    });
}

#[tauri::command]
pub async fn start_live_fuzzy_search(app: AppHandle, extension: String, query: String) {
    let my_gen = SEARCH_GEN.fetch_add(1, Ordering::Relaxed) + 1;
    let is_cancelled = move || SEARCH_GEN.load(Ordering::Relaxed) != my_gen;

    thread::spawn(move || {
        let matcher = SkimMatcherV2::default();

        if let Some(files) = cached_index(&extension) {
            search_index(&app, &matcher, &query, &files, &is_cancelled);
            return;
        }

        let _build = INDEX_BUILD.lock().unwrap_or_else(|e| e.into_inner());
        if is_cancelled() {
            return;
        }
        if let Some(files) = cached_index(&extension) {
            drop(_build);
            search_index(&app, &matcher, &query, &files, &is_cancelled);
            return;
        }

        let mut indexed = Vec::new();
        let mut top_results = BinaryHeap::new();
        let mut last_emit = Instant::now()
            .checked_sub(EMIT_INTERVAL)
            .unwrap_or_else(Instant::now);

        collect_files_with(&extension, &is_cancelled, |name, path| {
            indexed.push((name.clone(), path.clone()));
            if let Some(score) = matcher.fuzzy_match(&name, &query) {
                if insert_result(
                    &mut top_results,
                    SearchResult {
                        name,
                        path,
                        score,
                    },
                ) && last_emit.elapsed() >= EMIT_INTERVAL
                {
                    emit_snapshot(&app, &top_results);
                    last_emit = Instant::now();
                }
            }
        });

        if is_cancelled() {
            return;
        }

        store_index(extension, indexed);
        emit_snapshot(&app, &top_results);
        let _ = app.emit("live_fuzzy_done", {});
    });
}

fn search_index(
    app: &AppHandle,
    matcher: &SkimMatcherV2,
    query: &str,
    files: &[(String, String)],
    is_cancelled: &dyn Fn() -> bool,
) {
    let mut top_results = BinaryHeap::new();

    for (name, path) in files {
        if is_cancelled() {
            return;
        }
        if let Some(score) = matcher.fuzzy_match(name, query) {
            insert_result(
                &mut top_results,
                SearchResult {
                    name: name.clone(),
                    path: path.clone(),
                    score,
                },
            );
        }
    }

    if is_cancelled() {
        return;
    }

    emit_snapshot(app, &top_results);
    let _ = app.emit("live_fuzzy_done", {});
}

fn insert_result(heap: &mut BinaryHeap<SearchResult>, result: SearchResult) -> bool {
    if heap.len() < MAX_RESULTS {
        heap.push(result);
        return true;
    }
    if heap.peek().is_some_and(|min| result.score > min.score) {
        heap.pop();
        heap.push(result);
        return true;
    }
    false
}

fn emit_snapshot(app: &AppHandle, heap: &BinaryHeap<SearchResult>) {
    let mut sorted: Vec<_> = heap.iter().cloned().collect();
    sorted.sort_by(|a, b| b.score.cmp(&a.score));
    let _ = app.emit("live_fuzzy_result", sorted);
}

fn cached_index(extension: &str) -> Option<Arc<Vec<(String, String)>>> {
    let index = INDEX.lock().unwrap_or_else(|e| e.into_inner());
    index.as_ref().and_then(|index| {
        (index.extension == extension).then(|| Arc::clone(&index.files))
    })
}

fn store_index(extension: String, files: Vec<(String, String)>) {
    let mut index = INDEX.lock().unwrap_or_else(|e| e.into_inner());
    *index = Some(FileIndex {
        extension,
        files: Arc::new(files),
    });
}

pub fn index_file(path: &std::path::Path) {
    let Some(ext) = path.extension().and_then(OsStr::to_str) else {
        return;
    };
    let Some(name) = path.file_name() else {
        return;
    };
    let name = name.to_string_lossy().into_owned();
    let path_s = path.to_string_lossy().into_owned();
    let mut index = INDEX.lock().unwrap_or_else(|e| e.into_inner());
    let Some(index) = index.as_mut() else {
        return;
    };
    if index.extension != ext {
        return;
    }
    let files = Arc::make_mut(&mut index.files);
    if !files.iter().any(|(_, existing)| existing == &path_s) {
        files.push((name, path_s));
    }
}

fn collect_files(extension: &str, is_cancelled: &dyn Fn() -> bool) -> Vec<(String, String)> {
    let mut files = Vec::new();
    collect_files_with(extension, is_cancelled, |name, path| {
        files.push((name, path));
    });
    files
}

fn collect_files_with(
    extension: &str,
    is_cancelled: &dyn Fn() -> bool,
    mut on_file: impl FnMut(String, String),
) {
    let root = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"));
    let ext = OsStr::new(extension);

    for entry in WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| {
            !entry.file_type().is_dir() || !should_skip_dir(entry.file_name())
        })
        .filter_map(Result::ok)
    {
        if is_cancelled() {
            return;
        }
        if !entry.file_type().is_file() {
            continue;
        }

        let path = entry.path();
        if path.extension() != Some(ext) {
            continue;
        }

        on_file(
            entry.file_name().to_string_lossy().into_owned(),
            path.to_string_lossy().into_owned(),
        );
    }
}

fn should_skip_dir(name: &OsStr) -> bool {
    let name = name.to_string_lossy();
    if name.starts_with('.') {
        return true;
    }
    matches!(
        name.as_ref(),
        "node_modules" | "target" | "__pycache__" | "venv" | "snap"
    )
}
