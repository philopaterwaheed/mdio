const { invoke } = window.__TAURI__.core;

let fileInputEl;
let parseButtonEl;
let outputEl;
let filePathDisplayEl;

async function parseFile() {
  try {
    const filePath = fileInputEl.value.trim();
    if (!filePath) {
      outputEl.innerHTML = '<p style="color: red;">Please enter a file path</p>';
      return;
    }

    outputEl.innerHTML = '<p>Parsing file...</p>';
    const result = await invoke("parse_file", { filePath });
    outputEl.innerHTML = result;
    filePathDisplayEl.textContent = `Parsed: ${filePath}`;
  } catch (error) {
    outputEl.innerHTML = `<p style="color: red;">Error: ${error}</p>`;
  }
}

async function loadInitialFile() {
  try {
    const initialFile = await invoke("get_initial_file");
    if (initialFile) {
      console.log("Initial file from args:", initialFile);
      fileInputEl.value = initialFile;
      await parseFile();
    }
  } catch (error) {
    console.error("Error getting initial file:", error);
  }
}

window.addEventListener("DOMContentLoaded", () => {
  fileInputEl = document.querySelector("#file-input");
  parseButtonEl = document.querySelector("#parse-button");
  outputEl = document.querySelector("#output");
  filePathDisplayEl = document.querySelector("#file-path-display");

  parseButtonEl.addEventListener("click", parseFile);
  
  fileInputEl.addEventListener("keypress", (e) => {
    if (e.key === "Enter") {
      parseFile();
    }
  });

  loadInitialFile();
});
