const { listen } = window.__TAURI__.event;
const { invoke } = window.__TAURI__.core;

let outputEl;
let searchResultsEl = document.getElementById("searchResults");

const searchPopup = document.getElementById("searchPopup");
const searchInput = document.getElementById("searchInput");
const closeBtn = document.getElementById("closeBtn");

let leaderActive = false;
let leaderTimeout;
let results = [];
let selectedIndex = -1;

function openPopup() {
  searchPopup.style.display = "block";
  searchInput.focus();
}

function closePopup() {
  searchPopup.style.display = "none";
  searchInput.value = "";
  searchResultsEl.innerHTML = "";
  results = [];
  selectedIndex = -1;
  leaderActive = false;
  invoke("cancel_fuzzy_search");
}

async function parseFile(filePath) {
  try {
    console.log("parsing");
    outputEl.innerHTML = "<p>Parsing file...</p>";
    const result = await invoke("parse_file", { filePath });
    outputEl.innerHTML = result;
    console.log(outputEl.innerHTML)
  } catch (error) {
    outputEl.innerHTML = `<p style="color: red;">Error: ${error}</p>`;
    console.log("error parsing");
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
      outputEl.innerHTML =
        '<p style="color: red;">No file path provided. Please pass a file path as a command-line argument.</p>';
    }
  } catch (error) {
    console.error("Error getting initial file:", error);
    outputEl.innerHTML = `<p style="color: red;">Error loading file: ${error}</p>`;
  }
}


function updateSelection() {
  const boxes = document.querySelectorAll(".result-item");
  boxes.forEach((box, index) => {
    if (index === selectedIndex) {
      box.classList.add("selected");
      box.scrollIntoView({ block: "nearest", behavior: "smooth" });
    } else {
      box.classList.remove("selected");
    }
  });
}

window.addEventListener("keydown", (e) => {
  if (searchPopup.style.display !== "block") return;

  const boxes = document.querySelectorAll(".result-item");
  if (boxes.length === 0) return;

  if (e.key === "ArrowDown") {
    e.preventDefault();
    selectedIndex = (selectedIndex + 1) % boxes.length;
    updateSelection();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    selectedIndex = (selectedIndex - 1 + boxes.length) % boxes.length;
    updateSelection();
  } else if (e.key === "Enter" && selectedIndex >= 0) {
    e.preventDefault();
    const selected = boxes[selectedIndex];
    const path = selected.dataset.path;
    closePopup();
    parseFile(path);
  }
});

function renderResults() {
  searchResultsEl.innerHTML = results
    .map(
      (r) => `
      <div class="result-item" data-path="${r.path}">
        <div class="box" onclick="parseFile('${r.path.replace(/'/g, "\\'")}'); closePopup();">
          <span class="filename">${r.name}</span>
          <small class="path">${r.path}</small>
        </div>
      </div>
    `,
    )
    .join("");

  if (selectedIndex >= results.length) {
    selectedIndex = results.length > 0 ? 0 : -1;
  }
  updateSelection();

  document.querySelectorAll(".box").forEach((box) => {
    const pathEl = box.querySelector(".path");
    const scrollAmount = pathEl.scrollWidth - box.clientWidth;

    if (scrollAmount > 0) {
      pathEl.style.setProperty("--scroll-distance", `${scrollAmount + 20}px`);
      box.addEventListener("mouseenter", () => {
        pathEl.classList.remove("slide");
        void pathEl.offsetWidth;
        pathEl.classList.add("slide");
      });
      box.addEventListener("mouseleave", () => {
        pathEl.classList.remove("slide");
        pathEl.style.transform = "translateX(0)";
      });
    }
  });
}

let debounceTimer;
let currentUnlistenResult = null;
let currentUnlistenDone = null;

async function onSearchInput(e) {
  const query = e.target.value.trim();
  
  clearTimeout(debounceTimer);
  
  debounceTimer = setTimeout(async () => {
    results = [];
    selectedIndex = -1;
    renderResults();

    if (currentUnlistenResult) {
      currentUnlistenResult();
      currentUnlistenResult = null;
    }
    if (currentUnlistenDone) {
      currentUnlistenDone();
      currentUnlistenDone = null;
    }

    await invoke("cancel_fuzzy_search");

    if (query === "") return;

    currentUnlistenResult = await listen("live_fuzzy_result", (event) => {
      console.log("Received search results:", event.payload);
      const payload = event.payload;
      
      results = payload;
      renderResults();
    });

    currentUnlistenDone = await listen("live_fuzzy_done", () => {
      console.log("Search complete! Final results:", results.length);
      
      if (currentUnlistenResult) {
        currentUnlistenResult();
        currentUnlistenResult = null;
      }
      if (currentUnlistenDone) {
        currentUnlistenDone();
        currentUnlistenDone = null;
      }
    });

    await invoke("start_live_fuzzy_search", {
      extension: "md",
      query,
    });
  }, 250);
}

window.addEventListener("DOMContentLoaded", () => {
  outputEl = document.querySelector("#output");
  parseFile();
  searchInput.addEventListener("input", onSearchInput);
  
  // Leader key logic
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") return closePopup();

    if (searchPopup.style.display === "block") return;

    if (!leaderActive && e.key === " ") {
      leaderActive = true;
      leaderTimeout = setTimeout(() => {
        leaderActive = false;
      }, 1000);
      e.preventDefault(); // prevent scrolling
      return;
    }

    if (leaderActive) {
      e.preventDefault(); // prevent this key from typing in input
      if (e.key.toLowerCase() === "f") {
        openPopup();
      }
      leaderActive = false;
      clearTimeout(leaderTimeout);
    }
  });
});
