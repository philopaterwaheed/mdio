use notify::event::ModifyKind;
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::{Path, PathBuf};
use std::sync::mpsc::channel;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::Emitter;

const EMIT_COOLDOWN: Duration = Duration::from_millis(40);

pub struct FileWatcher {
    watcher: RecommendedWatcher,
    current_path: Arc<Mutex<Option<PathBuf>>>,
    watched_dir: Option<PathBuf>,
    ignore_until: Arc<Mutex<Option<Instant>>>,
}

impl FileWatcher {
    pub fn new(app_handle: tauri::AppHandle) -> notify::Result<Self> {
        let (tx, rx) = channel();
        let current_path = Arc::new(Mutex::new(None::<PathBuf>));
        let current_path_clone = Arc::clone(&current_path);
        let ignore_until = Arc::new(Mutex::new(None::<Instant>));
        let ignore_until_clone = Arc::clone(&ignore_until);
        let watched_file = Arc::clone(&current_path);

        let watcher = RecommendedWatcher::new(
            move |res: notify::Result<Event>| {
                let Ok(event) = res else {
                    return;
                };
                let watched = watched_file.lock().ok().and_then(|path| path.clone());
                let Some(watched) = watched else {
                    return;
                };
                if !is_content_event(&event.kind) {
                    return;
                }
                if !event.paths.iter().any(|path| is_same_file(path, &watched)) {
                    return;
                }
                let _ = tx.send(watched);
            },
            notify::Config::default(),
        )?;

        thread::spawn(move || {
            let mut last_emit = Instant::now()
                .checked_sub(EMIT_COOLDOWN)
                .unwrap_or_else(Instant::now);
            for watched in rx {
                let suppressed = ignore_until_clone
                    .lock()
                    .ok()
                    .and_then(|until| *until)
                    .is_some_and(|until| Instant::now() < until);
                if suppressed {
                    continue;
                }
                if last_emit.elapsed() < EMIT_COOLDOWN {
                    continue;
                }
                last_emit = Instant::now();
                let _ = app_handle.emit("file-changed", watched.to_string_lossy().to_string());
            }
        });

        Ok(FileWatcher {
            watcher,
            current_path: current_path_clone,
            watched_dir: None,
            ignore_until,
        })
    }

    pub fn ignore_for(&self, duration: Duration) {
        if let Ok(mut until) = self.ignore_until.lock() {
            *until = Some(Instant::now() + duration);
        }
    }

    pub fn watch_file(&mut self, path: String) -> notify::Result<()> {
        let path_buf = PathBuf::from(&path);
        let dir = path_buf
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."));

        if self.watched_dir.as_ref() != Some(&dir) {
            if let Some(old_dir) = self.watched_dir.take() {
                let _ = self.watcher.unwatch(&old_dir);
            }
            self.watcher.watch(&dir, RecursiveMode::NonRecursive)?;
            self.watched_dir = Some(dir);
        }

        if let Ok(mut current) = self.current_path.lock() {
            *current = Some(path_buf);
        }

        Ok(())
    }

    pub fn stop_watching(&mut self) -> notify::Result<()> {
        if let Some(dir) = self.watched_dir.take() {
            self.watcher.unwatch(&dir)?;
        }
        if let Ok(mut current) = self.current_path.lock() {
            *current = None;
        }
        Ok(())
    }
}

fn is_content_event(kind: &EventKind) -> bool {
    matches!(
        kind,
        EventKind::Modify(ModifyKind::Data(_))
            | EventKind::Modify(ModifyKind::Name(_))
            | EventKind::Modify(ModifyKind::Any)
            | EventKind::Create(_)
            | EventKind::Any
    )
}

fn is_same_file(event_path: &Path, watched: &Path) -> bool {
    event_path == watched
        || (event_path.file_name() == watched.file_name()
            && event_path.parent() == watched.parent())
}
