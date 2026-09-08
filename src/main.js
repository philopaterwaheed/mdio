import { themes, applyTheme, loadSavedTheme, getCurrentTheme } from './themes/themes.js';

const { listen } = window.__TAURI__.event;
const { invoke, convertFileSrc } = window.__TAURI__.core;

let outputEl;
let searchResultsEl = document.getElementById("searchResults");

const searchPopup = document.getElementById("searchPopup");
const searchInput = document.getElementById("searchInput");
const closeBtn = document.getElementById("closeBtn");

const themePopup = document.getElementById("themePopup");
const themeInput = document.getElementById("themeInput");
const themeResultsEl = document.getElementById("themeResults");

let leaderActive = false;
let leaderTimeout;
let results = [];
let selectedIndex = -1;

let themeResults = [];
let themeSelectedIndex = -1;

function openPopup() {
  searchPopup.style.display = "block";
  searchInput.focus();
}

window.closePopup = function () {
  searchPopup.style.display = "none";
  searchInput.value = "";
  searchResultsEl.innerHTML = "";
  results = [];
  selectedIndex = -1;
  leaderActive = false;
  searchInput.blur();
  invoke("cancel_fuzzy_search");
}

function openThemePopup() {
  themePopup.style.display = "block";
  themeInput.focus();
  renderThemes("");
}

function closeThemePopup() {
  themePopup.style.display = "none";
  themeInput.value = "";
  themeResultsEl.innerHTML = "";
  themeResults = [];
  themeSelectedIndex = -1;
  leaderActive = false;
  themeInput.blur();
}

function renderThemes(query) {
  const currentTheme = getCurrentTheme();
  const lowerQuery = query.toLowerCase();
  
  themeResults = Object.entries(themes)
    .filter(([id, theme]) => 
      theme.name.toLowerCase().includes(lowerQuery) ||
      id.toLowerCase().includes(lowerQuery)
    )
    .map(([id, theme]) => ({ id, ...theme }));
  
  themeResultsEl.innerHTML = themeResults
    .map((theme, index) => `
      <div class="result-item theme-item ${theme.id === currentTheme ? 'current-theme' : ''}" data-theme-id="${theme.id}">
        <div class="box" onclick="selectTheme('${theme.id}')">
          <span class="filename">${theme.name} ${theme.id === currentTheme ? '✓' : ''}</span>
          <small class="path">${theme.id}</small>
        </div>
      </div>
    `)
    .join("");
  
  if (themeSelectedIndex >= themeResults.length) {
    themeSelectedIndex = themeResults.length > 0 ? 0 : -1;
  }
  updateThemeSelection();
}

function updateThemeSelection() {
  const boxes = themeResultsEl.querySelectorAll(".result-item");
  boxes.forEach((box, index) => {
    if (index === themeSelectedIndex) {
      box.classList.add("selected");
      box.scrollIntoView({ block: "nearest", behavior: "smooth" });
    } else {
      box.classList.remove("selected");
    }
  });
}

window.selectTheme = function(themeId) {
  applyTheme(themeId);
  closeThemePopup();
  ignoreOutputClickUntil = Date.now() + 200;
};

const utf8 = new TextEncoder();
const utf8dec = new TextDecoder();

let currentSource = "";
let currentPath = null;
let sourceBytes = new Uint8Array();
let editorSession = null;
let cursorStart = null;
let lastBlockStart = null;
let hintState = null;
let ignoreOutputClickUntil = 0;

const HINT_CHARS = "asdfghjklqwertyuiopzxcvbnm";

function setSource(source) {
  currentSource = source;
  sourceBytes = utf8.encode(source);
}

function utf8Slice(start, end) {
  return utf8dec.decode(sourceBytes.subarray(start, end));
}

function isRemoteSrc(src) {
  return /^(https?:|data:|blob:|asset:|http:\/\/asset\.localhost|https:\/\/asset\.localhost)/i.test(
    src,
  );
}

function resolveFsPath(src, docPath) {
  if (!src) {
    return null;
  }
  let path = src.trim();
  if (path.startsWith("file://")) {
    path = decodeURIComponent(path.replace(/^file:\/\/(localhost)?/i, ""));
  }
  if (path.startsWith("/") && !path.startsWith("//")) {
    return path;
  }
  if (!docPath) {
    return null;
  }
  const dir = docPath.replace(/[/\\][^/\\]*$/, "") || ".";
  const parts = dir.split("/").filter(Boolean);
  for (const seg of path.replace(/\\/g, "/").split("/")) {
    if (!seg || seg === ".") {
      continue;
    }
    if (seg === "..") {
      parts.pop();
    } else {
      parts.push(seg);
    }
  }
  return `${dir.startsWith("/") ? "/" : ""}${parts.join("/")}`;
}

function decorateImages() {
  outputEl.querySelectorAll("img").forEach((img) => {
    if (img.closest(".md-image-preview")) {
      return;
    }
    const raw = img.getAttribute("src") || "";
    if (raw && !isRemoteSrc(raw)) {
      const fsPath = resolveFsPath(raw, currentPath);
      if (fsPath && typeof convertFileSrc === "function") {
        img.src = convertFileSrc(fsPath);
      }
    }
    const title = (img.getAttribute("alt") || "").trim() || "Image Preview";
    const frame = document.createElement("span");
    frame.className = "md-image-preview";
    const label = document.createElement("span");
    label.className = "md-image-title";
    label.textContent = title;
    img.replaceWith(frame);
    frame.append(label, img);
  });
}

function applyRendered(payload, preserveScroll = false) {
  stopHintMode();
  const scrollY = preserveScroll ? window.scrollY : 0;
  currentPath = payload.path;
  setSource(payload.source);
  outputEl.innerHTML = payload.html;
  decorateImages();
  outputEl.querySelectorAll("pre code").forEach((block) => {
    hljs.highlightElement(block);
  });
  if (preserveScroll) {
    window.scrollTo(0, scrollY);
  }
  ensureEditableSurface();
  const restoreAt = cursorStart ?? lastBlockStart;
  if (restoreAt != null) {
    setCursor(nearestBlock(restoreAt) || restoreAt);
  }
}

window.parseFile = async function (filePath, silent = false) {
  try {
    if (editorSession) {
      await commitEditor();
    }
    if (!silent) {
      outputEl.innerHTML = "<p>Parsing file...</p>";
    }
    const result = await invoke("parse_file", { filePath });
    if (!silent) {
      cursorStart = null;
      lastBlockStart = null;
    }
    applyRendered(result, silent);
  } catch (error) {
    outputEl.innerHTML = `<p style="color: red;">Error: ${error}</p>`;
  }
}

let reloadInFlight = false;
let reloadQueuedPath = null;

async function reloadFromDisk(path) {
  if (editorSession) {
    return;
  }
  if (reloadInFlight) {
    reloadQueuedPath = path;
    return;
  }
  reloadInFlight = true;
  try {
    await parseFile(path, true);
  } finally {
    reloadInFlight = false;
    if (reloadQueuedPath && !editorSession) {
      const queued = reloadQueuedPath;
      reloadQueuedPath = null;
      reloadFromDisk(queued);
    }
  }
}

function lineIndexAt(block, clientY) {
  const start = Number(block.dataset.start);
  const end = Number(block.dataset.end);
  const text = utf8Slice(start, end);
  const lines = text.split("\n");
  if (lines.length <= 1 || clientY == null) {
    return 0;
  }
  const rect = block.getBoundingClientRect();
  const ratio = rect.height <= 0 ? 0 : (clientY - rect.top) / rect.height;
  return Math.min(lines.length - 1, Math.max(0, Math.floor(ratio * lines.length)));
}

function caretForLine(text, lineIndex) {
  const lines = text.split("\n");
  let offset = 0;
  for (let i = 0; i < lineIndex && i < lines.length; i++) {
    offset += lines[i].length + 1;
  }
  return offset;
}

function autosize(editor) {
  editor.style.height = "auto";
  editor.style.height = `${editor.scrollHeight}px`;
}

function createLineEditor(text, kind = "p") {
  const editor = document.createElement("textarea");
  editor.className = `md-line-editor md-editor-${kind}`;
  editor.value = text;
  editor.spellcheck = false;
  editor.rows = Math.max(1, text.split("\n").length || 1);
  return editor;
}

function ensureEditableSurface() {
  if (!outputEl) {
    return;
  }
  if (documentBlocks().length === 0) {
    const empty = document.createElement("div");
    empty.className = "md-block md-empty-file";
    empty.dataset.start = "0";
    empty.dataset.end = String(sourceBytes.length);
    empty.dataset.kind = "p";
    empty.textContent =
      sourceBytes.length === 0
        ? "Empty file — click or press i / o to write"
        : "Click or press i / o to add content";
    outputEl.appendChild(empty);
  }
  let slot = outputEl.querySelector(".md-add-slot");
  if (!slot) {
    slot = document.createElement("div");
    slot.className = "md-add-slot";
    slot.textContent = "+ add";
  }
  outputEl.appendChild(slot);
}

function pointAfter(block) {
  let at = Number(block.dataset.end);
  if (Number.isNaN(at)) {
    return sourceBytes.length;
  }
  while (at < sourceBytes.length && (sourceBytes[at] === 10 || sourceBytes[at] === 13)) {
    at += 1;
  }
  return at;
}

function insertedSource(text, at) {
  if (text === "") {
    return "";
  }
  if (sourceBytes.length === 0) {
    return text;
  }
  let out = text;
  if (at > 0 && sourceBytes[at - 1] !== 10) {
    out = "\n\n" + out;
  } else if (at > 1 && sourceBytes[at - 1] === 10 && sourceBytes[at - 2] !== 10) {
    out = "\n" + out;
  }
  if (at < sourceBytes.length && sourceBytes[at] !== 10) {
    out += "\n";
  }
  return out;
}

function currentBlock() {
  return (
    blockByStart(cursorStart) ||
    nearestBlock(cursorStart ?? lastBlockStart) ||
    documentBlocks().at(-1) ||
    null
  );
}

function startInsert(at, { after = null, before = null } = {}) {
  if (editorSession) {
    return;
  }
  const editor = createLineEditor("", "p");
  if (before) {
    before.before(editor);
  } else if (after) {
    after.after(editor);
  } else {
    const slot = outputEl.querySelector(".md-add-slot");
    if (slot) {
      slot.before(editor);
    } else {
      outputEl.appendChild(editor);
    }
  }

  const blocks = documentBlocks();
  let prevStart = null;
  let nextStart = null;
  if (after) {
    prevStart = Number(after.dataset.start);
    const idx = blocks.indexOf(after);
    nextStart = idx >= 0 && idx < blocks.length - 1 ? Number(blocks[idx + 1].dataset.start) : null;
  } else if (before) {
    nextStart = Number(before.dataset.start);
    const idx = blocks.indexOf(before);
    prevStart = idx > 0 ? Number(blocks[idx - 1].dataset.start) : null;
  }

  editorSession = {
    editor,
    block: null,
    start: at,
    end: at,
    inserting: true,
    prevStart,
    nextStart,
  };
  autosize(editor);
  editor.focus();
  cursorStart = at;
  lastBlockStart = at;
  editor.addEventListener("input", () => autosize(editor));
  editor.addEventListener("keydown", onEditorKeyDown);
}

function insertBelow() {
  const block = currentBlock();
  if (!block) {
    startInsert(sourceBytes.length);
    return;
  }
  if (block.classList.contains("md-empty-file")) {
    startEdit(block, null);
    return;
  }
  startInsert(pointAfter(block), { after: block });
}

function insertAbove() {
  const block = currentBlock();
  if (!block) {
    startInsert(0);
    return;
  }
  if (block.classList.contains("md-empty-file")) {
    startEdit(block, null);
    return;
  }
  startInsert(Number(block.dataset.start), { before: block });
}

function startEdit(block, clientY) {
  if (!block || editorSession) {
    return;
  }

  const start = Number(block.dataset.start);
  const end = Number(block.dataset.end);
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return;
  }

  const text = utf8Slice(start, end);
  const lineIndex = lineIndexAt(block, clientY);
  const editor = createLineEditor(text, block.dataset.kind || "p");

  const style = getComputedStyle(block);
  editor.style.fontSize = style.fontSize;
  editor.style.fontWeight = style.fontWeight;
  editor.style.fontFamily = style.fontFamily;
  editor.style.lineHeight = style.lineHeight;
  editor.style.color = style.color;
  editor.style.textAlign = style.textAlign;

  const blocks = [...outputEl.querySelectorAll(".md-block")];
  const idx = blocks.indexOf(block);
  block.replaceWith(editor);
  editorSession = {
    editor,
    block,
    start,
    end,
    prevStart: idx > 0 ? Number(blocks[idx - 1].dataset.start) : null,
    nextStart: idx >= 0 && idx < blocks.length - 1 ? Number(blocks[idx + 1].dataset.start) : null,
  };
  autosize(editor);

  const caret = caretForLine(text, lineIndex);
  editor.focus();
  editor.setSelectionRange(caret, caret);
  cursorStart = start;
  lastBlockStart = start;

  editor.addEventListener("input", () => autosize(editor));
  editor.addEventListener("keydown", onEditorKeyDown);
}

function onEditorKeyDown(e) {
  if (!editorSession) {
    return;
  }

  const { editor } = editorSession;
  const isMulti = editor.value.includes("\n");

  if (e.key === "Escape") {
    e.preventDefault();
    cancelEditor();
    return;
  }

  if (e.key === "Enter" && !e.shiftKey && !isMulti) {
    e.preventDefault();
    commitEditor();
    return;
  }

  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    commitEditor();
    return;
  }

  if (e.key === "Tab") {
    e.preventDefault();
    if (!e.shiftKey && editorSession.nextStart == null) {
      commitThenInsertBelow();
      return;
    }
    commitEditor(e.shiftKey ? editorSession.prevStart : editorSession.nextStart);
    return;
  }

  if (e.key === "ArrowUp" && editor.selectionStart === 0 && editor.selectionEnd === 0) {
    e.preventDefault();
    commitEditor(editorSession.prevStart);
    return;
  }

  if (
    e.key === "ArrowDown" &&
    editor.selectionStart === editor.value.length &&
    editor.selectionEnd === editor.value.length
  ) {
    e.preventDefault();
    if (editorSession.nextStart == null) {
      commitThenInsertBelow();
    } else {
      commitEditor(editorSession.nextStart);
    }
    return;
  }
}

function blockByStart(start) {
  if (start == null || Number.isNaN(start)) {
    return null;
  }
  return outputEl.querySelector(`.md-block[data-start="${start}"]`);
}

function documentBlocks() {
  return [...outputEl.querySelectorAll(".md-block")].filter(
    (block) => !block.parentElement?.closest(".md-block"),
  );
}

function clearCursor() {
  outputEl.querySelectorAll(".md-cursor").forEach((el) => {
    el.classList.remove("md-cursor");
  });
}

function nearestBlock(start) {
  const list = documentBlocks();
  if (list.length === 0 || start == null || Number.isNaN(Number(start))) {
    return null;
  }
  const target = Number(start);
  let best = list[0];
  let bestDist = Infinity;
  for (const block of list) {
    const dist = Math.abs(Number(block.dataset.start) - target);
    if (dist < bestDist) {
      bestDist = dist;
      best = block;
    }
  }
  return best;
}

function setCursor(startOrBlock) {
  clearCursor();
  let el =
    startOrBlock instanceof Element
      ? startOrBlock
      : blockByStart(startOrBlock);
  if (!el && startOrBlock != null && !(startOrBlock instanceof Element)) {
    el = nearestBlock(startOrBlock);
  }
  if (!el) {
    cursorStart = null;
    return;
  }
  cursorStart = Number(el.dataset.start);
  lastBlockStart = cursorStart;
  el.classList.add("md-cursor");
  el.scrollIntoView({ block: "nearest" });
}

function moveCursor(delta) {
  const list = documentBlocks();
  if (list.length === 0) {
    return;
  }
  const selected = outputEl.querySelector(".md-block.md-cursor");
  let idx = selected ? list.indexOf(selected) : -1;
  if (idx < 0) {
    const from = cursorStart ?? lastBlockStart;
    if (from != null) {
      idx = list.findIndex((block) => Number(block.dataset.start) === from);
      if (idx < 0) {
        const near = nearestBlock(from);
        idx = near ? list.indexOf(near) : -1;
      }
    }
  }
  if (idx < 0) {
    idx = delta > 0 ? 0 : list.length - 1;
  } else {
    idx = Math.max(0, Math.min(list.length - 1, idx + delta));
  }
  setCursor(list[idx]);
}

function editCursor() {
  const el =
    blockByStart(cursorStart) ||
    nearestBlock(cursorStart ?? lastBlockStart) ||
    documentBlocks()[0];
  if (!el) {
    startInsert(sourceBytes.length);
    return;
  }
  setCursor(el);
  startEdit(el, null);
}

function visibleBlocks() {
  return documentBlocks().filter((block) => {
    const rect = block.getBoundingClientRect();
    return rect.bottom > 0 && rect.top < window.innerHeight && rect.height > 0;
  });
}

function makeHintLabels(count) {
  if (count <= HINT_CHARS.length) {
    return [...HINT_CHARS.slice(0, count)];
  }
  const labels = [];
  for (let i = 0; i < count; i++) {
    labels.push(
      HINT_CHARS[Math.floor(i / HINT_CHARS.length) % HINT_CHARS.length] +
        HINT_CHARS[i % HINT_CHARS.length],
    );
  }
  return labels;
}

function hintLayer() {
  let layer = document.getElementById("hintLayer");
  if (!layer) {
    layer = document.createElement("div");
    layer.id = "hintLayer";
    document.body.appendChild(layer);
  }
  return layer;
}

function stopHintMode() {
  hintState = null;
  const layer = document.getElementById("hintLayer");
  if (layer) {
    layer.innerHTML = "";
  }
}

function positionHints() {
  if (!hintState) {
    return;
  }
  for (const node of hintState.nodes) {
    const rect = node.block.getBoundingClientRect();
    node.el.style.top = `${Math.max(4, rect.top)}px`;
    node.el.style.left = `${Math.max(4, rect.left - 8)}px`;
  }
}

function startHintMode() {
  stopHintMode();
  const blocks = visibleBlocks();
  if (blocks.length === 0) {
    return;
  }
  const labels = makeHintLabels(blocks.length);
  const layer = hintLayer();
  const map = {};
  const nodes = [];
  blocks.forEach((block, i) => {
    const el = document.createElement("span");
    el.className = "md-hint";
    el.textContent = labels[i];
    layer.appendChild(el);
    map[labels[i]] = block;
    nodes.push({ el, block, label: labels[i] });
  });
  hintState = { map, nodes, buffer: "" };
  positionHints();
}

function onHintKey(ch) {
  if (!hintState) {
    return;
  }
  const next = hintState.buffer + ch;
  const matches = Object.keys(hintState.map).filter((label) => label.startsWith(next));
  if (matches.length === 0) {
    return;
  }
  hintState.buffer = next;
  for (const node of hintState.nodes) {
    const keep = node.label.startsWith(next);
    node.el.classList.toggle("md-hint-dim", !keep);
    if (keep && next.length < node.label.length) {
      node.el.textContent = node.label.slice(next.length);
    }
  }
  if (matches.length === 1 && matches[0] === next) {
    const block = hintState.map[next];
    stopHintMode();
    setCursor(block);
    startEdit(block, null);
  }
}

function cancelEditor() {
  if (!editorSession) {
    return;
  }
  const { editor, block } = editorSession;
  if (block) {
    editor.replaceWith(block);
    editorSession = null;
    setCursor(block);
  } else {
    editor.remove();
    editorSession = null;
    ensureEditableSurface();
    const restore = nearestBlock(lastBlockStart);
    if (restore) {
      setCursor(restore);
    }
  }
}

async function commitThenInsertBelow() {
  await commitEditor();
  insertBelow();
}

async function commitEditor(nextStart = null) {
  if (!editorSession) {
    return;
  }

  const { editor, block, start, end, inserting } = editorSession;
  const raw = editor.value;
  const original = utf8Slice(start, end);
  const text = inserting ? insertedSource(raw, start) : raw;

  if (!inserting && text === original) {
    editor.replaceWith(block);
    editorSession = null;
    if (nextStart != null) {
      startEdit(blockByStart(nextStart), null);
    } else {
      setCursor(block);
    }
    return;
  }

  if (inserting && raw === "") {
    editor.remove();
    editorSession = null;
    ensureEditableSurface();
    if (nextStart != null) {
      startEdit(blockByStart(nextStart), null);
    } else {
      const restore = nearestBlock(lastBlockStart);
      if (restore) {
        setCursor(restore);
      }
    }
    return;
  }

  editorSession = null;
  try {
    const payload = await invoke("splice_source", { start, end, text });
    const delta = utf8.encode(text).length - (end - start);
    cursorStart = start;
    lastBlockStart = start;
    applyRendered(payload, true);
    if (nextStart != null) {
      const target = nextStart >= end ? nextStart + delta : nextStart;
      startEdit(blockByStart(target), null);
    }
  } catch (error) {
    if (block) {
      editor.replaceWith(block);
    } else {
      editor.remove();
    }
    outputEl.insertAdjacentHTML(
      "afterbegin",
      `<p style="color: red;">Error saving: ${error}</p>`,
    );
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

  if (e.key === "Escape") {
    e.preventDefault();
    e.stopImmediatePropagation();
    closePopup();
    return;
  }

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
    e.stopImmediatePropagation();
    const selected = boxes[selectedIndex];
    const path = selected.dataset.path;
    closePopup();
    parseFile(path);
  }
});

window.addEventListener("keydown", (e) => {
  if (themePopup.style.display !== "block") return;

  if (e.key === "Escape") {
    e.preventDefault();
    e.stopImmediatePropagation();
    closeThemePopup();
    return;
  }

  const boxes = themeResultsEl.querySelectorAll(".result-item");
  if (boxes.length === 0) return;

  if (e.key === "ArrowDown") {
    e.preventDefault();
    themeSelectedIndex = (themeSelectedIndex + 1) % boxes.length;
    updateThemeSelection();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    themeSelectedIndex = (themeSelectedIndex - 1 + boxes.length) % boxes.length;
    updateThemeSelection();
  } else if (e.key === "Enter" && themeSelectedIndex >= 0) {
    e.preventDefault();
    e.stopImmediatePropagation();
    const selected = boxes[themeSelectedIndex];
    const themeId = selected.dataset.themeId;
    selectTheme(themeId);
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

async function onSearchInput(e) {
  const query = e.target.value.trim();
  
  clearTimeout(debounceTimer);
  
  debounceTimer = setTimeout(async () => {
    results = [];
    selectedIndex = -1;
    renderResults();

    if (query === "") {
      invoke("cancel_fuzzy_search");
      return;
    }

    await invoke("start_live_fuzzy_search", {
      extension: "md",
      query,
    });
  }, 250);
}

window.addEventListener("DOMContentLoaded", () => {
  outputEl = document.querySelector("#output");
  
  // Load saved theme
  loadSavedTheme();

  listen("file-changed", (event) => {
    if (editorSession) {
      return;
    }
    reloadFromDisk(event.payload);
  });

  outputEl.addEventListener("click", (e) => {
    if (Date.now() < ignoreOutputClickUntil) {
      return;
    }
    if (hintState) {
      stopHintMode();
    }
    if (e.target.closest("a") && (e.ctrlKey || e.metaKey)) {
      return;
    }
    if (e.target.closest(".md-line-editor")) {
      return;
    }
    if (e.target.closest(".md-add-slot")) {
      e.preventDefault();
      if (editorSession) {
        commitThenInsertBelow();
      } else {
        insertBelow();
      }
      return;
    }
    const block = e.target.closest(".md-block");
    if (!block || !outputEl.contains(block)) {
      return;
    }
    e.preventDefault();
    if (editorSession) {
      commitEditor(Number(block.dataset.start));
      return;
    }
    startEdit(block, e.clientY);
  });

  document.addEventListener("mousedown", (e) => {
    if (!editorSession) {
      return;
    }
    if (e.target.closest(".md-line-editor, .md-block, .popup")) {
      return;
    }
    commitEditor();
  });

  window.addEventListener("scroll", positionHints, true);
  window.addEventListener("resize", positionHints);

  listen("live_fuzzy_result", (event) => {
    results = event.payload;
    renderResults();
  });
  
  parseFile();
  searchInput.addEventListener("input", onSearchInput);
  themeInput.addEventListener("input", (e) => {
    renderThemes(e.target.value);
    themeSelectedIndex = 0;
    updateThemeSelection();
  });
  
  // Leader key logic
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (searchPopup.style.display === "block") {
        e.preventDefault();
        closePopup();
        return;
      }
      if (themePopup.style.display === "block") {
        e.preventDefault();
        closeThemePopup();
        return;
      }
      if (hintState) {
        e.preventDefault();
        stopHintMode();
        return;
      }
      if (editorSession) {
        return;
      }
      if (cursorStart != null) {
        e.preventDefault();
        clearCursor();
        cursorStart = null;
      }
      return;
    }

    if (searchPopup.style.display === "block" || themePopup.style.display === "block") {
      return;
    }

    if (e.target.closest("input, textarea") && !e.target.closest(".md-line-editor")) {
      return;
    }

    if (hintState) {
      if (e.key === "j" || e.key === "k" || e.key === "i" || e.key === "Enter" || e.key === "o" || e.key === "O") {
        stopHintMode();
      } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        onHintKey(e.key.toLowerCase());
        return;
      } else {
        return;
      }
    }

    if (editorSession || e.target.closest(".md-line-editor")) {
      return;
    }

    if (!leaderActive) {
      if (e.key === "f") {
        e.preventDefault();
        startHintMode();
        return;
      }
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        moveCursor(1);
        return;
      }
      if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        moveCursor(-1);
        return;
      }
      if (e.key === "Enter" || e.key === "i") {
        e.preventDefault();
        editCursor();
        return;
      }
      if (e.key === "o") {
        e.preventDefault();
        insertBelow();
        return;
      }
      if (e.key === "O") {
        e.preventDefault();
        insertAbove();
        return;
      }
      if (e.key === "g") {
        e.preventDefault();
        const list = documentBlocks();
        if (list.length > 0) {
          setCursor(list[0]);
        }
        return;
      }
      if (e.key === "G") {
        e.preventDefault();
        const list = documentBlocks();
        if (list.length > 0) {
          setCursor(list[list.length - 1]);
        }
        return;
      }
    }

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
      } else if (e.key.toLowerCase() === "t") {
        openThemePopup();
      }
      leaderActive = false;
      clearTimeout(leaderTimeout);
    }
  });
});
