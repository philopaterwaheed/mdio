use notify::event::ModifyKind;
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::PathBuf;
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::Emitter;

pub struct FileWatcher {
    watcher: RecommendedWatcher,
    current_path: Arc<Mutex<Option<PathBuf>>>,
}

impl FileWatcher {
    pub fn new(app_handle: tauri::AppHandle) -> notify::Result<Self> {
        let (tx, rx) = channel();
        let current_path = Arc::new(Mutex::new(None));
        let current_path_clone = Arc::clone(&current_path);

        let watcher = RecommendedWatcher::new(
            move |res: notify::Result<Event>| {
                if let Err(e) = tx.send(res) {
                    eprintln!("Failed to send event: {}", e);
                }
            },
            notify::Config::default(),
        )?;

        thread::spawn(move || {
            for res in rx {
                match res {
                    Ok(event) => {
                        // Only emit for modify events (file content changed)
                        match event.kind {
                            EventKind::Modify(ModifyKind::Data(_))
                            | EventKind::Modify(ModifyKind::Any) => {
                                println!("File content changed: {:?}", event.paths);
                                if let Some(path) = event.paths.first() {
                                    let _ = app_handle
                                        .emit("file-changed", path.to_string_lossy().to_string());
                                }
                            }
                            _ => {}
                        }
                    }
                    Err(e) => eprintln!("Watch error: {:?}", e),
                }
            }
        });

        Ok(FileWatcher {
            watcher,
            current_path: current_path_clone,
        })
    }

    pub fn watch_file(&mut self, path: String) -> notify::Result<()> {
        if let Ok(current) = self.current_path.lock() {
            if let Some(old_path) = current.as_ref() {
                let _ = self.watcher.unwatch(old_path);
                println!("Stopped watching: {:?}", old_path);
            }
        }
        let path_buf = PathBuf::from(&path);
        self.watcher.watch(&path_buf, RecursiveMode::NonRecursive)?;
        println!("Now watching: {:?}", path_buf);
        if let Ok(mut current) = self.current_path.lock() {
            *current = Some(path_buf);
        }

        Ok(())
    }

    pub fn stop_watching(&mut self) -> notify::Result<()> {
        if let Ok(mut current) = self.current_path.lock() {
            if let Some(path) = current.take() {
                self.watcher.unwatch(&path)?;
                println!("Stopped watching: {:?}", path);
            }
        }
        Ok(())
    }
}
