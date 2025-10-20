use notify::{RecommendedWatcher, RecursiveMode, Result, Watcher};
use tauri::Emitter;
use std::sync::mpsc::channel;
use std::thread;

pub fn watch_files(app_handle: tauri::AppHandle, paths: Vec<&str>) -> Result<()> {
    let (tx, rx) = channel();

    let mut watcher = RecommendedWatcher::new(tx, notify::Config::default())?;

    for path in &paths {
        watcher.watch(path.as_ref(), RecursiveMode::NonRecursive)?;
        println!("Watching {:?}", path);
    }

    thread::spawn(move || {
        for res in rx {
            if let Ok(event) = res {
                println!("Change detected: {:?}", event);
                let _ = app_handle.emit("file-changed", event.paths);
            }
        }
    });

    Ok(())
}

