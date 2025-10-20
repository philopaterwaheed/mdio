
const { invoke } = window.__TAURI__.core;

let outputEl;

async function parseFile(filePath) {
  try {
    outputEl.innerHTML = '<p>Parsing file...</p>';
    const result = await invoke("parse_file", { filePath });
    outputEl.innerHTML = result;
  } catch (error) {
    outputEl.innerHTML = `<p style="color: red;">Error: ${error}</p>`;
  }
}

async function loadInitialFile() {
  try {
    alert("Loading initial file...");
    const initialFile = await invoke("get_initial_file");
    if (initialFile) {
      console.log("Loading file from args:", initialFile);
    alert(`Loading file: ${initialFile}`);
      await parseFile(initialFile);
    } else {
      outputEl.innerHTML = '<p style="color: red;">No file path provided. Please pass a file path as a command-line argument.</p>';
    }
  } catch (error) {
    console.error("Error getting initial file:", error);
    outputEl.innerHTML = `<p style="color: red;">Error loading file: ${error}</p>`;
  }
}

window.addEventListener("DOMContentLoaded", () => {
  outputEl = document.querySelector("#output");
  parseFile();
});

