(async () => {
  if (window.__quickStickyLoaded) {
    return;
  }
  window.__quickStickyLoaded = true;

  const STORAGE_KEY = "quickStickyNotesByPage";
  const PAGE_KEY = `${location.origin}${location.pathname}${location.search}`;
  const NOTE_WIDTH = 280;
  const NOTE_MIN_HEIGHT = 150;
  const MAX_IMAGE_FILE_BYTES = 2 * 1024 * 1024;
  const MAX_IMAGE_TOTAL_BYTES_PER_NOTE = 8 * 1024 * 1024;
  const MAX_IMAGE_ITEMS_PER_NOTE = 12;
  const MAX_TOTAL_ITEMS_PER_NOTE = 40;
  const ALLOWED_IMAGE_MIME_TYPES = new Set([
    "image/png",
    "image/jpeg",
    "image/jpg",
    "image/gif",
    "image/webp",
    "image/bmp"
  ]);
  const ALLOWED_YOUTUBE_HOSTS = new Set([
    "youtube.com",
    "m.youtube.com",
    "youtu.be"
  ]);
  const ALLOWED_YOUTUBE_THUMB_HOSTS = new Set([
    "i.ytimg.com",
    "img.youtube.com",
    "i3.ytimg.com"
  ]);

  const host = document.createElement("div");
  Object.assign(host.style, {
    position: "fixed",
    inset: "0",
    zIndex: "2147483647",
    pointerEvents: "none"
  });
  document.documentElement.appendChild(host);

  const shadowRoot = host.attachShadow({ mode: "closed" });
  const styleEl = document.createElement("style");
  styleEl.textContent = await loadStyles();
  shadowRoot.appendChild(styleEl);

  const layer = document.createElement("div");
  layer.className = "qs-layer";
  shadowRoot.appendChild(layer);

  let storageCache = {};
  const notes = new Map();
  const noteEls = new Map();
  const activeStorageKeys = new Set([PAGE_KEY]);

  let lastPointer = {
    x: Math.round(window.innerWidth / 2 - NOTE_WIDTH / 2),
    y: Math.round(window.innerHeight / 2 - NOTE_MIN_HEIGHT / 2)
  };

  let saveTimer = null;
  let saveInFlight = false;
  let pendingSave = false;
  let dragging = null;
  let historyDragging = null;
  let runtimeInvalidated = false;

  const historyUi = createHistoryUi();

  window.addEventListener(
    "mousemove",
    (event) => {
      lastPointer = { x: event.clientX, y: event.clientY };

      if (dragging) {
        event.preventDefault();
        const note = notes.get(dragging.id);
        const noteEl = noteEls.get(dragging.id);
        if (note && noteEl) {
          note.x = Math.max(4, event.clientX - dragging.offsetX);
          note.y = Math.max(4, event.clientY - dragging.offsetY);
          applyNotePosition(noteEl, note.x, note.y);
          scheduleSave();
        }
      }

      if (historyDragging) {
        event.preventDefault();
        historyUi.movePanel(
          event.clientX - historyDragging.offsetX,
          event.clientY - historyDragging.offsetY
        );
      }
    },
    true
  );

  window.addEventListener(
    "mouseup",
    () => {
      if (dragging) {
        const noteEl = noteEls.get(dragging.id);
        if (noteEl) {
          noteEl.classList.remove("is-dragging");
        }
        dragging = null;
      }

      if (historyDragging) {
        historyDragging = null;
        historyUi.stopPanelDrag();
      }
    },
    true
  );

  document.addEventListener(
    "keydown",
    (event) => {
      if (!isCreateShortcut(event)) {
        return;
      }
      event.preventDefault();
      createNoteAtPointer();
    },
    true
  );

  try {
    chrome.runtime.onMessage.addListener((message) => {
      if (!message || message.type !== "QS_CREATE_NOTE") {
        return;
      }
      createNoteAtPointer();
    });
  } catch (error) {
    markRuntimeInvalid(error);
  }

  try {
    await hydrateFromStorage();
  } catch (error) {
    markRuntimeInvalid(error);
    console.warn("Quick Sticky: storage hydration skipped due to invalid extension context.");
  }
  refreshHistoryPanel();

  function isCreateShortcut(event) {
    if (event.repeat || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
      return false;
    }
    const key = String(event.key || "").toLowerCase();
    return event.code === "KeyN" || key === "n";
  }

  function createNoteAtPointer() {
    createNote({
      x: lastPointer.x,
      y: lastPointer.y,
      focus: true,
      persist: true
    });
  }

  async function loadStyles() {
    try {
      const response = await fetch(chrome.runtime.getURL("styles.css"));
      if (response.ok) {
        return await response.text();
      }
    } catch (error) {
      console.error("Quick Sticky: failed to load styles.", error);
    }

    return `
      :host { all: initial; }
      .qs-layer { position: fixed; inset: 0; pointer-events: none; }
      .qs-note { position: absolute; pointer-events: auto; background: rgba(255,255,255,0.5); border-radius: 12px; padding: 8px; }
      .qs-text { width: 260px; min-height: 120px; }
    `;
  }

  function createHistoryUi() {
    const root = document.createElement("div");
    root.className = "qs-history-root";
    shadowRoot.appendChild(root);

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "qs-history-toggle";
    toggle.title = "Open note history";
    toggle.setAttribute("aria-label", "Open note history");

    const icon = document.createElement("span");
    icon.className = "qs-menu-icon";
    for (let i = 0; i < 3; i += 1) {
      const line = document.createElement("span");
      line.className = "qs-menu-icon-line";
      icon.appendChild(line);
    }
    toggle.appendChild(icon);
    root.appendChild(toggle);

    const panel = document.createElement("aside");
    panel.className = "qs-history-panel";

    const panelHead = document.createElement("div");
    panelHead.className = "qs-history-head";

    const panelTitle = document.createElement("h3");
    panelTitle.className = "qs-history-title";
    panelTitle.textContent = "Note History";

    const panelClose = document.createElement("button");
    panelClose.type = "button";
    panelClose.className = "qs-history-close";
    panelClose.textContent = "x";
    panelClose.setAttribute("aria-label", "Close history");

    panelHead.append(panelTitle, panelClose);
    panelHead.addEventListener("mousedown", (event) => {
      if (event.button !== 0) {
        return;
      }
      if (event.target instanceof Element && event.target.closest(".qs-history-close")) {
        return;
      }

      event.preventDefault();
      const rect = panel.getBoundingClientRect();
      historyDragging = {
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top
      };
      state.customPosition = true;
      panel.classList.add("is-dragging");
      movePanel(rect.left, rect.top);
    });

    const controls = document.createElement("div");
    controls.className = "qs-history-controls";

    const granularityLabel = document.createElement("label");
    granularityLabel.className = "qs-field";
    granularityLabel.textContent = "Group";

    const granularitySelect = document.createElement("select");
    granularitySelect.className = "qs-select";
    appendSelectOption(granularitySelect, "date", "Date");
    appendSelectOption(granularitySelect, "month", "Month");
    appendSelectOption(granularitySelect, "year", "Year");
    granularityLabel.appendChild(granularitySelect);

    const periodLabel = document.createElement("label");
    periodLabel.className = "qs-field";
    periodLabel.textContent = "Period";

    const periodSelect = document.createElement("select");
    periodSelect.className = "qs-select";
    periodLabel.appendChild(periodSelect);

    const domainLabel = document.createElement("label");
    domainLabel.className = "qs-field";
    domainLabel.textContent = "Domain";

    const domainSelect = document.createElement("select");
    domainSelect.className = "qs-select";
    domainLabel.appendChild(domainSelect);

    controls.append(domainLabel, granularityLabel, periodLabel);

    const summary = document.createElement("div");
    summary.className = "qs-history-summary";
    summary.textContent = "0 notes";

    const list = document.createElement("div");
    list.className = "qs-history-list";

    panel.append(panelHead, controls, summary, list);
    shadowRoot.appendChild(panel);

    const state = {
      isOpen: false,
      domain: "all",
      granularity: "date",
      period: "all",
      customPosition: false
    };

    toggle.addEventListener("click", () => {
      setOpen(!state.isOpen);
    });

    panelClose.addEventListener("click", () => {
      setOpen(false);
    });

    domainSelect.addEventListener("change", () => {
      state.domain = domainSelect.value;
      state.period = "all";
      render();
    });

    granularitySelect.addEventListener("change", () => {
      state.granularity = granularitySelect.value;
      state.period = "all";
      render();
    });

    periodSelect.addEventListener("change", () => {
      state.period = periodSelect.value;
      render();
    });

    function render() {
      const entries = getHistoryEntries();
      const domains = buildDomainGroups(entries);
      fillDomainOptions(domainSelect, domains, state.domain);
      const hasDomain = domains.some((item) => item.key === domainSelect.value);
      state.domain = hasDomain ? domainSelect.value : "all";
      if (state.domain !== domainSelect.value) {
        domainSelect.value = state.domain;
      }

      const domainFiltered = state.domain === "all"
        ? entries
        : entries.filter((entry) => entry.domain === state.domain);

      const groups = buildPeriodGroups(domainFiltered, state.granularity);
      fillPeriodOptions(periodSelect, groups, state.period);

      const hasSelection = groups.some((group) => group.key === periodSelect.value);
      state.period = hasSelection ? periodSelect.value : "all";
      if (state.period !== periodSelect.value) {
        periodSelect.value = state.period;
      }

      const filtered = state.period === "all"
        ? domainFiltered
        : domainFiltered.filter((entry) => toPeriodKey(entry.updatedAt, state.granularity) === state.period);

      summary.textContent = `${filtered.length} notes`;
      drawHistoryList(list, filtered, state.domain === "all");
    }

    function setOpen(nextOpen) {
      state.isOpen = Boolean(nextOpen);
      panel.classList.toggle("is-open", state.isOpen);
      toggle.classList.toggle("is-active", state.isOpen);
      if (state.isOpen && !state.customPosition) {
        panel.style.left = "";
        panel.style.top = "";
        panel.style.transform = "";
      }
      if (state.isOpen) {
        render();
      }
    }

    function movePanel(rawX, rawY) {
      const rect = panel.getBoundingClientRect();
      const width = Math.max(rect.width, 260);
      const height = Math.max(rect.height, 220);
      const minX = 8;
      const minY = 8;
      const maxX = Math.max(minX, window.innerWidth - width - 8);
      const maxY = Math.max(minY, window.innerHeight - height - 8);
      const x = clamp(rawX, minX, maxX);
      const y = clamp(rawY, minY, maxY);
      panel.style.left = `${Math.round(x)}px`;
      panel.style.top = `${Math.round(y)}px`;
      panel.style.transform = "none";
    }

    function stopPanelDrag() {
      panel.classList.remove("is-dragging");
    }

    return {
      state,
      render,
      open: () => setOpen(true),
      close: () => setOpen(false),
      movePanel,
      stopPanelDrag
    };
  }

  function drawHistoryList(list, entries, groupByDomain = false) {
    list.textContent = "";

    if (entries.length === 0) {
      const empty = document.createElement("div");
      empty.className = "qs-history-empty";
      empty.textContent = "No notes for this period.";
      list.appendChild(empty);
      return;
    }

    const grouped = groupByDomain ? groupEntriesByDomain(entries) : [{ domain: "", entries }];
    for (const group of grouped) {
      if (groupByDomain) {
        const heading = document.createElement("div");
        heading.className = "qs-history-group-label";
        heading.textContent = group.domain;
        list.appendChild(heading);
      }

      for (const entry of group.entries) {
      const card = document.createElement("div");
      card.className = "qs-history-item";

      const title = document.createElement("div");
      title.className = "qs-history-item-title";
      title.textContent = historyTitle(entry);

      const meta = document.createElement("div");
      meta.className = "qs-history-item-meta";
      const statusText = entry.isClosed ? "Closed" : "Open";
      meta.textContent = `${formatDateTime(entry.updatedAt)}  |  ${formatPage(entry.pageKey)}  |  ${statusText}`;

      card.append(title, meta);

      card.classList.add("is-clickable");
      if (entry.pageKey === PAGE_KEY) {
        card.classList.add("is-current-page");
      }
      if (entry.isClosed) {
        card.classList.add("is-closed-note");
      }
      card.addEventListener("click", () => {
        openOrFocusNote(entry.id, entry.pageKey);
      });

      list.appendChild(card);
    }
    }
  }

  function focusNote(noteId) {
    const noteEl = noteEls.get(noteId);
    if (!noteEl) {
      return;
    }
    noteEl.classList.add("qs-note-highlight");
    setTimeout(() => noteEl.classList.remove("qs-note-highlight"), 700);
    const textEl = noteEl.querySelector(".qs-text");
    if (textEl) {
      textEl.focus();
    }
  }

  function openOrFocusNote(noteId, storagePageKey = PAGE_KEY) {
    const note = notes.get(noteId);
    if (note) {
      if (!note.isClosed && noteEls.has(noteId)) {
        void closeNote(noteId);
        return;
      }
      if (note.isClosed || !noteEls.has(noteId)) {
        reopenNote(noteId);
        return;
      }
      return;
    }

    const stored = findStoredNote(storagePageKey, noteId);
    if (!stored) {
      return;
    }

    createNote({
      id: stored.id,
      x: stored.x,
      y: stored.y,
      text: stored.text,
      items: stored.items,
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt,
      isClosed: false,
      storagePageKey: stored.storagePageKey,
      domain: stored.domain,
      focus: true,
      persist: true
    });
  }

  function reopenNote(noteId) {
    const note = notes.get(noteId);
    if (!note) {
      return;
    }
    note.isClosed = false;
    markEdited(note);
    createNote({
      id: note.id,
      x: note.x,
      y: note.y,
      text: note.text,
      items: note.items,
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
      isClosed: false,
      storagePageKey: note.storagePageKey,
      domain: note.domain,
      focus: true,
      persist: true
    });
  }

  function findStoredNote(pageKey, noteId) {
    const rawList = Array.isArray(storageCache[pageKey]) ? storageCache[pageKey] : [];
    const raw = rawList.find((item) => item && item.id === noteId);
    if (!raw) {
      return null;
    }
    return normalizeStoredNote(raw, pageKey);
  }

  function historyTitle(entry) {
    const trimmed = String(entry.text || "").trim();
    if (trimmed) {
      return trimmed.replace(/\s+/g, " ").slice(0, 56);
    }
    const imageCount = Number(entry.imageCount || 0);
    const linkCount = Number(entry.youtubeCount || 0);
    if (imageCount > 0 || linkCount > 0) {
      return `Media note (${imageCount} image, ${linkCount} link)`;
    }
    return "Untitled note";
  }

  function formatPage(pageKey) {
    try {
      const url = new URL(pageKey);
      const path = `${url.hostname}${url.pathname}`;
      return path.length > 40 ? `${path.slice(0, 40)}...` : path;
    } catch {
      return pageKey;
    }
  }

  function buildDomainGroups(entries) {
    const map = new Map();
    for (const entry of entries) {
      const key = normalizeDomain(entry.domain, entry.pageKey);
      if (!map.has(key)) {
        map.set(key, {
          key,
          label: key,
          latest: entry.updatedAt
        });
      } else {
        const current = map.get(key);
        if (entry.updatedAt > current.latest) {
          current.latest = entry.updatedAt;
        }
      }
    }
    return Array.from(map.values()).sort((a, b) => b.latest - a.latest);
  }

  function fillDomainOptions(selectEl, domains, selected) {
    selectEl.textContent = "";
    const allOption = document.createElement("option");
    allOption.value = "all";
    allOption.textContent = "All Domains";
    selectEl.appendChild(allOption);

    for (const item of domains) {
      const option = document.createElement("option");
      option.value = item.key;
      option.textContent = item.label;
      selectEl.appendChild(option);
    }

    selectEl.value = selected || "all";
    if (selectEl.value !== selected && selectEl.value !== "all") {
      selectEl.value = "all";
    }
  }

  function groupEntriesByDomain(entries) {
    const map = new Map();
    for (const entry of entries) {
      const key = normalizeDomain(entry.domain, entry.pageKey);
      if (!map.has(key)) {
        map.set(key, []);
      }
      map.get(key).push(entry);
    }
    return Array.from(map.entries())
      .map(([domain, list]) => ({ domain, entries: list }))
      .sort((a, b) => {
        const aLatest = a.entries.length > 0 ? a.entries[0].updatedAt : 0;
        const bLatest = b.entries.length > 0 ? b.entries[0].updatedAt : 0;
        return bLatest - aLatest;
      });
  }

  function buildPeriodGroups(entries, granularity) {
    const map = new Map();
    for (const entry of entries) {
      const key = toPeriodKey(entry.updatedAt, granularity);
      if (!map.has(key)) {
        map.set(key, {
          key,
          label: toPeriodLabel(entry.updatedAt, granularity),
          latest: entry.updatedAt
        });
      } else {
        const current = map.get(key);
        if (entry.updatedAt > current.latest) {
          current.latest = entry.updatedAt;
        }
      }
    }
    return Array.from(map.values()).sort((a, b) => b.latest - a.latest);
  }

  function fillPeriodOptions(selectEl, groups, selected) {
    selectEl.textContent = "";
    const allOption = document.createElement("option");
    allOption.value = "all";
    allOption.textContent = "All";
    selectEl.appendChild(allOption);

    for (const group of groups) {
      const option = document.createElement("option");
      option.value = group.key;
      option.textContent = group.label;
      selectEl.appendChild(option);
    }

    selectEl.value = selected || "all";
    if (selectEl.value !== selected && selectEl.value !== "all") {
      selectEl.value = "all";
    }
  }

  function toPeriodKey(timestamp, granularity) {
    const date = new Date(timestamp);
    const year = String(date.getFullYear());
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    if (granularity === "year") {
      return year;
    }
    if (granularity === "month") {
      return `${year}-${month}`;
    }
    return `${year}-${month}-${day}`;
  }

  function toPeriodLabel(timestamp, granularity) {
    const date = new Date(timestamp);
    const year = String(date.getFullYear());
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    if (granularity === "year") {
      return `${year}`;
    }
    if (granularity === "month") {
      return `${year}-${month}`;
    }
    return `${year}-${month}-${day}`;
  }

  function formatDateTime(timestamp) {
    const date = new Date(timestamp);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const hour = String(date.getHours()).padStart(2, "0");
    const minute = String(date.getMinutes()).padStart(2, "0");
    return `${year}-${month}-${day} ${hour}:${minute}`;
  }

  function refreshHistoryPanel() {
    if (!historyUi || !historyUi.render) {
      return;
    }
    historyUi.render();
  }

  function getHistoryEntries() {
    const entries = [];
    for (const [pageKey, rawList] of Object.entries(storageCache || {})) {
      if (!Array.isArray(rawList)) {
        continue;
      }
      for (const raw of rawList) {
        const normalized = normalizeStoredNote(raw, pageKey);
        entries.push({
          id: normalized.id,
          pageKey: normalized.storagePageKey,
          domain: normalized.domain,
          text: normalized.text,
          imageCount: normalized.items.filter((item) => item && item.type === "image").length,
          youtubeCount: normalized.items.filter((item) => item && item.type === "youtube").length,
          updatedAt: normalized.updatedAt,
          isClosed: Boolean(normalized.isClosed)
        });
      }
    }
    return entries.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  function createNote({
    id,
    x,
    y,
    text = "",
    items = [],
    createdAt,
    updatedAt,
    isClosed = false,
    storagePageKey = PAGE_KEY,
    domain,
    focus = false,
    persist = true
  } = {}) {
    const noteId = id || createId();
    const now = Date.now();
    const noteData = {
      id: noteId,
      x: typeof x === "number" ? x : lastPointer.x,
      y: typeof y === "number" ? y : lastPointer.y,
      text: typeof text === "string" ? text : "",
      items: sanitizeStoredItems(items),
      createdAt: finiteOr(createdAt, now),
      updatedAt: finiteOr(updatedAt, now),
      isClosed: Boolean(isClosed),
      storagePageKey: (typeof storagePageKey === "string" && storagePageKey) ? storagePageKey : PAGE_KEY,
      domain: normalizeDomain(domain, (typeof storagePageKey === "string" && storagePageKey) ? storagePageKey : PAGE_KEY)
    };
    activeStorageKeys.add(noteData.storagePageKey);

    notes.set(noteId, noteData);

    const previousEl = noteEls.get(noteId);
    if (previousEl) {
      previousEl.remove();
      noteEls.delete(noteId);
    }

    if (noteData.isClosed) {
      if (persist) {
        scheduleSave();
      }
      refreshHistoryPanel();
      return noteId;
    }

    const noteEl = document.createElement("section");
    noteEl.className = "qs-note";
    noteEl.dataset.noteId = noteId;
    applyNotePosition(noteEl, noteData.x, noteData.y);

    const head = document.createElement("div");
    head.className = "qs-note-head";

    const dragBar = document.createElement("div");
    dragBar.className = "qs-drag-bar";
    dragBar.title = "Drag note";
    dragBar.addEventListener("mousedown", (event) => {
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      dragging = {
        id: noteId,
        offsetX: event.clientX - noteData.x,
        offsetY: event.clientY - noteData.y
      };
      noteEl.classList.add("is-dragging");
    });

    const menuBtn = document.createElement("button");
    menuBtn.type = "button";
    menuBtn.className = "qs-btn qs-menu-btn";
    menuBtn.title = "Open note history";
    menuBtn.setAttribute("aria-label", "Open note history");
    const menuIcon = document.createElement("span");
    menuIcon.className = "qs-menu-icon qs-menu-icon--compact";
    for (let i = 0; i < 3; i += 1) {
      const line = document.createElement("span");
      line.className = "qs-menu-icon-line";
      menuIcon.appendChild(line);
    }
    menuBtn.appendChild(menuIcon);
    menuBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      historyUi.open();
    });

    const controls = document.createElement("div");
    controls.className = "qs-controls";

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "qs-btn qs-close-btn";
    closeBtn.textContent = "Close";
    closeBtn.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      await closeNote(noteId);
    });

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "qs-btn qs-delete-btn";
    deleteBtn.textContent = "Delete";
    deleteBtn.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      await deleteNote(noteId);
    });

    controls.append(closeBtn, deleteBtn);
    head.append(menuBtn, dragBar, controls);

    const body = document.createElement("div");
    body.className = "qs-note-body";

    const textarea = document.createElement("textarea");
    textarea.className = "qs-text";
    textarea.placeholder = "Type something...";
    textarea.value = noteData.text;
    textarea.spellcheck = true;
    const isolateFromPageShortcuts = (event) => {
      event.stopPropagation();
    };
    textarea.addEventListener("keydown", isolateFromPageShortcuts);
    textarea.addEventListener("keyup", isolateFromPageShortcuts);
    textarea.addEventListener("keypress", isolateFromPageShortcuts);
    textarea.addEventListener("paste", isolateFromPageShortcuts);
    textarea.addEventListener("copy", isolateFromPageShortcuts);
    textarea.addEventListener("cut", isolateFromPageShortcuts);
    textarea.addEventListener("input", () => {
      noteData.text = textarea.value;
      markEdited(noteData);
      scheduleSave();
    });

    const itemList = document.createElement("div");
    itemList.className = "qs-items";

    textarea.addEventListener("keydown", async (event) => {
      if (event.key !== "Enter" || event.isComposing) {
        return;
      }

      const line = getCurrentLine(textarea.value, textarea.selectionStart || 0);
      const youtube = parseYouTube(line.text.trim());
      if (!youtube) {
        return;
      }

      event.preventDefault();
      textarea.value = removeRange(textarea.value, line.start, line.end);
      textarea.selectionStart = textarea.selectionEnd = line.start;
      noteData.text = textarea.value;

      const item = await buildYouTubeItem(youtube.url, youtube.videoId);
      if (!item) {
        return;
      }
      noteData.items.push(item);
      appendItem(itemList, item);
      markEdited(noteData);
      scheduleSave();
    });

    for (const item of noteData.items) {
      appendItem(itemList, item);
    }

    noteEl.addEventListener("dragover", (event) => {
      if (!event.dataTransfer || !hasImageFile(event.dataTransfer.files)) {
        return;
      }
      event.preventDefault();
      noteEl.classList.add("is-drop-target");
    });

    noteEl.addEventListener("dragleave", () => {
      noteEl.classList.remove("is-drop-target");
    });

    noteEl.addEventListener("drop", async (event) => {
      noteEl.classList.remove("is-drop-target");
      if (!event.dataTransfer) {
        return;
      }

      const files = Array.from(event.dataTransfer.files || []).filter((file) => isAllowedImageFile(file));
      if (files.length === 0) {
        return;
      }

      event.preventDefault();
      let { imageCount, imageBytes } = getImageStats(noteData.items);
      let added = 0;
      for (const file of files) {
        if (noteData.items.length >= MAX_TOTAL_ITEMS_PER_NOTE) {
          break;
        }
        if (imageCount >= MAX_IMAGE_ITEMS_PER_NOTE) {
          break;
        }
        if (!Number.isFinite(file.size) || file.size <= 0 || file.size > MAX_IMAGE_FILE_BYTES) {
          continue;
        }
        if (imageBytes + file.size > MAX_IMAGE_TOTAL_BYTES_PER_NOTE) {
          continue;
        }

        const src = await fileToDataUrl(file);
        const safeSrc = normalizeImageDataUrl(src);
        if (!safeSrc) {
          continue;
        }

        const item = {
          type: "image",
          src: safeSrc,
          name: file.name || "image"
        };
        noteData.items.push(item);
        appendItem(itemList, item);
        imageCount += 1;
        imageBytes += file.size;
        added += 1;
      }
      if (added === 0) {
        return;
      }
      markEdited(noteData);
      scheduleSave();
    });

    body.append(textarea, itemList);
    noteEl.append(head, body);
    layer.appendChild(noteEl);
    noteEls.set(noteId, noteEl);

    if (focus) {
      requestAnimationFrame(() => {
        textarea.focus();
        textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
      });
    }

    if (persist) {
      scheduleSave();
    }
    return noteId;
  }

  function markEdited(note) {
    note.updatedAt = Date.now();
  }

  async function closeNote(noteId) {
    const note = notes.get(noteId);
    if (!note) {
      return;
    }
    note.isClosed = true;
    markEdited(note);

    const noteEl = noteEls.get(noteId);
    if (noteEl) {
      noteEl.remove();
    }
    noteEls.delete(noteId);
    if (dragging && dragging.id === noteId) {
      dragging = null;
    }
    await saveNow();
  }

  async function deleteNote(noteId) {
    const noteEl = noteEls.get(noteId);
    if (noteEl) {
      noteEl.remove();
    }
    noteEls.delete(noteId);
    notes.delete(noteId);
    if (dragging && dragging.id === noteId) {
      dragging = null;
    }
    await saveNow();
  }

  function appendItem(container, item) {
    if (!item || typeof item !== "object") {
      return;
    }

    if (item.type === "image") {
      const safeSrc = normalizeImageDataUrl(item.src);
      if (!safeSrc) {
        return;
      }
      const wrap = document.createElement("div");
      wrap.className = "qs-item qs-image-wrap";

      const img = document.createElement("img");
      img.className = "qs-image";
      img.src = safeSrc;
      img.alt = item.name || "Image";
      wrap.appendChild(img);
      container.appendChild(wrap);
      return;
    }

    if (item.type === "youtube") {
      const safeUrl = normalizeYouTubeUrl(item.url);
      if (!safeUrl) {
        return;
      }
      const videoId = extractYouTubeVideoId(new URL(safeUrl));
      const safeThumb = normalizeYouTubeThumbnail(item.thumbnail, videoId);
      if (!safeThumb) {
        return;
      }

      const card = document.createElement("button");
      card.type = "button";
      card.className = "qs-item qs-yt-card";
      card.addEventListener("click", () => {
        window.open(safeUrl, "_blank", "noopener,noreferrer");
      });

      const thumb = document.createElement("img");
      thumb.className = "qs-yt-thumb";
      thumb.src = safeThumb;
      thumb.alt = item.title || "YouTube thumbnail";

      const meta = document.createElement("div");
      meta.className = "qs-yt-meta";

      const title = document.createElement("div");
      title.className = "qs-yt-title";
      title.textContent = item.title || "YouTube Video";

      const url = document.createElement("div");
      url.className = "qs-yt-url";
      url.textContent = shortUrl(safeUrl);

      meta.append(title, url);
      card.append(thumb, meta);
      container.appendChild(card);
    }
  }

  async function buildYouTubeItem(url, videoId) {
    const safeUrl = normalizeYouTubeUrl(url);
    if (!safeUrl) {
      return null;
    }
    const safeVideoId = videoId && /^[a-zA-Z0-9_-]{11}$/.test(videoId)
      ? videoId
      : extractYouTubeVideoId(new URL(safeUrl));
    if (!safeVideoId) {
      return null;
    }

    const fallbackThumb = `https://i.ytimg.com/vi/${safeVideoId}/hqdefault.jpg`;
    let title = "YouTube Video";
    let thumbnail = fallbackThumb;

    try {
      const response = await fetch(
        `https://www.youtube.com/oembed?url=${encodeURIComponent(safeUrl)}&format=json`
      );
      if (response.ok) {
        const data = await response.json();
        if (typeof data.title === "string" && data.title.trim()) {
          title = data.title.trim();
        }
        if (typeof data.thumbnail_url === "string" && data.thumbnail_url.trim()) {
          thumbnail = data.thumbnail_url.trim();
        }
      }
    } catch (error) {
      console.warn("Quick Sticky: YouTube metadata fallback used.", error);
    }

    return {
      type: "youtube",
      url: safeUrl,
      videoId: safeVideoId,
      title,
      thumbnail: normalizeYouTubeThumbnail(thumbnail, safeVideoId) || fallbackThumb
    };
  }

  function parseYouTube(raw) {
    const safeUrl = normalizeYouTubeUrl(raw);
    if (!safeUrl) {
      return null;
    }
    const videoId = extractYouTubeVideoId(new URL(safeUrl));
    if (!videoId) {
      return null;
    }

    return {
      url: safeUrl,
      videoId
    };
  }

  function appendSelectOption(selectEl, value, label) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    selectEl.appendChild(option);
  }

  function isAllowedImageFile(file) {
    if (!file || typeof file.type !== "string") {
      return false;
    }
    return ALLOWED_IMAGE_MIME_TYPES.has(file.type.toLowerCase());
  }

  function normalizeImageDataUrl(raw) {
    if (typeof raw !== "string") {
      return "";
    }
    const trimmed = raw.trim();
    if (!/^data:image\/(png|jpe?g|gif|webp|bmp);base64,[a-z0-9+/=\s]+$/i.test(trimmed)) {
      return "";
    }
    return trimmed.replace(/\s+/g, "");
  }

  function estimateDataUrlBytes(dataUrl) {
    const normalized = normalizeImageDataUrl(dataUrl);
    if (!normalized) {
      return 0;
    }
    const base64 = normalized.split(",")[1] || "";
    const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
    return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
  }

  function getImageStats(items) {
    let imageCount = 0;
    let imageBytes = 0;
    for (const item of Array.isArray(items) ? items : []) {
      if (!item || item.type !== "image") {
        continue;
      }
      const safeSrc = normalizeImageDataUrl(item.src);
      if (!safeSrc) {
        continue;
      }
      imageCount += 1;
      imageBytes += estimateDataUrlBytes(safeSrc);
    }
    return { imageCount, imageBytes };
  }

  function normalizeYouTubeUrl(raw) {
    if (typeof raw !== "string" || !raw.trim()) {
      return "";
    }

    let url;
    try {
      url = new URL(raw.trim());
    } catch {
      return "";
    }

    if (url.protocol !== "https:") {
      return "";
    }

    const hostName = url.hostname.replace(/^www\./, "").toLowerCase();
    if (!ALLOWED_YOUTUBE_HOSTS.has(hostName)) {
      return "";
    }

    const videoId = extractYouTubeVideoId(url);
    if (!videoId) {
      return "";
    }
    return `https://www.youtube.com/watch?v=${videoId}`;
  }

  function extractYouTubeVideoId(url) {
    if (!(url instanceof URL)) {
      return "";
    }

    const hostName = url.hostname.replace(/^www\./, "").toLowerCase();
    let videoId = "";
    if (hostName === "youtu.be") {
      videoId = url.pathname.split("/").filter(Boolean)[0] || "";
    } else if (hostName === "youtube.com" || hostName === "m.youtube.com") {
      videoId = url.searchParams.get("v") || "";
      if (!videoId) {
        const parts = url.pathname.split("/").filter(Boolean);
        if (parts.length >= 2 && (parts[0] === "shorts" || parts[0] === "embed" || parts[0] === "live")) {
          videoId = parts[1];
        }
      }
    }

    return /^[a-zA-Z0-9_-]{11}$/.test(videoId) ? videoId : "";
  }

  function normalizeYouTubeThumbnail(raw, videoId) {
    const fallback = /^[a-zA-Z0-9_-]{11}$/.test(String(videoId || ""))
      ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
      : "";

    if (typeof raw !== "string" || !raw.trim()) {
      return fallback;
    }

    let url;
    try {
      url = new URL(raw.trim());
    } catch {
      return fallback;
    }

    if (url.protocol !== "https:") {
      return fallback;
    }

    const hostName = url.hostname.replace(/^www\./, "").toLowerCase();
    if (!ALLOWED_YOUTUBE_THUMB_HOSTS.has(hostName)) {
      return fallback;
    }
    return url.toString();
  }

  function sanitizeStoredItems(rawItems) {
    if (!Array.isArray(rawItems)) {
      return [];
    }

    const sanitized = [];
    let imageCount = 0;
    let imageBytes = 0;
    for (const raw of rawItems) {
      if (!raw || typeof raw !== "object") {
        continue;
      }
      if (sanitized.length >= MAX_TOTAL_ITEMS_PER_NOTE) {
        break;
      }

      if (raw.type === "image") {
        if (imageCount >= MAX_IMAGE_ITEMS_PER_NOTE) {
          continue;
        }
        const safeSrc = normalizeImageDataUrl(raw.src);
        if (!safeSrc) {
          continue;
        }
        const bytes = estimateDataUrlBytes(safeSrc);
        if (bytes <= 0 || bytes > MAX_IMAGE_FILE_BYTES) {
          continue;
        }
        if (imageBytes + bytes > MAX_IMAGE_TOTAL_BYTES_PER_NOTE) {
          continue;
        }
        sanitized.push({
          type: "image",
          src: safeSrc,
          name: typeof raw.name === "string" && raw.name.trim()
            ? raw.name.trim().slice(0, 120)
            : "image"
        });
        imageCount += 1;
        imageBytes += bytes;
        continue;
      }

      if (raw.type === "youtube") {
        const safeUrl = normalizeYouTubeUrl(raw.url);
        if (!safeUrl) {
          continue;
        }
        const videoId = extractYouTubeVideoId(new URL(safeUrl));
        if (!videoId) {
          continue;
        }
        const safeThumb = normalizeYouTubeThumbnail(raw.thumbnail, videoId);
        if (!safeThumb) {
          continue;
        }
        sanitized.push({
          type: "youtube",
          url: safeUrl,
          videoId,
          title: typeof raw.title === "string" && raw.title.trim()
            ? raw.title.trim().slice(0, 160)
            : "YouTube Video",
          thumbnail: safeThumb
        });
      }
    }
    return sanitized;
  }

  function areItemsEquivalent(sourceItems, sanitizedItems) {
    try {
      return JSON.stringify(Array.isArray(sourceItems) ? sourceItems : []) === JSON.stringify(sanitizedItems);
    } catch {
      return false;
    }
  }

  function getCurrentLine(value, caret) {
    const start = value.lastIndexOf("\n", Math.max(0, caret - 1)) + 1;
    let end = value.indexOf("\n", caret);
    if (end === -1) {
      end = value.length;
    }
    return {
      start,
      end,
      text: value.slice(start, end)
    };
  }

  function removeRange(value, start, end) {
    const before = value.slice(0, start);
    const after = value.slice(end);
    const merged = before.endsWith("\n") && after.startsWith("\n")
      ? `${before}${after.slice(1)}`
      : `${before}${after}`;
    return merged.replace(/\n{3,}/g, "\n\n");
  }

  function hasImageFile(fileList) {
    return Array.from(fileList || []).some((file) => isAllowedImageFile(file));
  }

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  function applyNotePosition(noteEl, x, y) {
    noteEl.style.left = `${Math.round(x)}px`;
    noteEl.style.top = `${Math.round(y)}px`;
  }

  function createId() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    return `note-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  function shortUrl(raw) {
    try {
      const url = new URL(raw);
      return `${url.hostname}${url.pathname}`;
    } catch {
      return raw;
    }
  }

  function normalizeDomain(rawDomain, fallbackPageKey = PAGE_KEY) {
    if (typeof rawDomain === "string" && rawDomain.trim()) {
      return rawDomain.trim().toLowerCase();
    }
    return extractDomainFromPageKey(fallbackPageKey);
  }

  function extractDomainFromPageKey(pageKey) {
    try {
      const url = new URL(pageKey);
      return url.hostname.replace(/^www\./i, "").toLowerCase();
    } catch {
      return "unknown-domain";
    }
  }

  function scheduleSave() {
    if (runtimeInvalidated) {
      return;
    }
    if (saveTimer) {
      clearTimeout(saveTimer);
    }
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void flushSave();
    }, 150);
  }

  async function saveNow() {
    if (runtimeInvalidated) {
      return;
    }
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    await flushSave();
  }

  async function flushSave() {
    if (saveInFlight) {
      pendingSave = true;
      return;
    }
    saveInFlight = true;
    try {
      do {
        pendingSave = false;
        storageCache = buildStorageSnapshot();
        await storageSet({ [STORAGE_KEY]: storageCache });
      } while (pendingSave);
      refreshHistoryPanel();
    } finally {
      saveInFlight = false;
    }
  }

  function serializeNote(note) {
    return {
      id: note.id,
      x: note.x,
      y: note.y,
      text: note.text,
      items: Array.isArray(note.items) ? note.items : [],
      createdAt: finiteOr(note.createdAt, Date.now()),
      updatedAt: finiteOr(note.updatedAt, Date.now()),
      isClosed: Boolean(note.isClosed),
      domain: normalizeDomain(note.domain, note.storagePageKey),
      storagePageKey: (typeof note.storagePageKey === "string" && note.storagePageKey)
        ? note.storagePageKey
        : PAGE_KEY
    };
  }

  function buildStorageSnapshot() {
    const nextCache = { ...storageCache };

    for (const key of activeStorageKeys) {
      nextCache[key] = [];
    }

    for (const note of notes.values()) {
      const key = (typeof note.storagePageKey === "string" && note.storagePageKey)
        ? note.storagePageKey
        : PAGE_KEY;
      activeStorageKeys.add(key);
      if (!Array.isArray(nextCache[key])) {
        nextCache[key] = [];
      }
      nextCache[key].push(serializeNote(note));
    }

    for (const key of activeStorageKeys) {
      if (!Array.isArray(nextCache[key])) {
        nextCache[key] = [];
      }
    }

    return nextCache;
  }

  async function hydrateFromStorage() {
    const data = await storageGet(STORAGE_KEY);
    storageCache = data && data[STORAGE_KEY] && typeof data[STORAGE_KEY] === "object"
      ? data[STORAGE_KEY]
      : {};

    const existing = Array.isArray(storageCache[PAGE_KEY]) ? storageCache[PAGE_KEY] : [];
    let needsMigration = false;

    for (const raw of existing) {
      const normalized = normalizeStoredNote(raw, PAGE_KEY);
      if (normalized.changed) {
        needsMigration = true;
      }

      createNote({
        id: normalized.id,
        x: finiteOr(normalized.x, lastPointer.x),
        y: finiteOr(normalized.y, lastPointer.y),
        text: normalized.text,
        items: normalized.items,
        createdAt: normalized.createdAt,
        updatedAt: normalized.updatedAt,
        isClosed: normalized.isClosed,
        domain: normalized.domain,
        storagePageKey: normalized.storagePageKey,
        focus: false,
        persist: false
      });
    }

    if (needsMigration) {
      await saveNow();
    }
  }

  function normalizeStoredNote(raw, fallbackPageKey = PAGE_KEY) {
    const now = Date.now();
    const source = raw && typeof raw === "object" ? raw : {};
    const id = typeof source.id === "string" && source.id ? source.id : createId();
    const text = typeof source.text === "string" ? source.text : "";
    const items = sanitizeStoredItems(source.items);
    const createdAt = finiteOr(source.createdAt, now);
    const updatedAt = finiteOr(source.updatedAt, createdAt);
    const isClosed = Boolean(source.isClosed);
    const storagePageKey = (typeof source.storagePageKey === "string" && source.storagePageKey)
      ? source.storagePageKey
      : fallbackPageKey;
    const domain = normalizeDomain(source.domain, storagePageKey);
    const x = finiteOr(source.x, lastPointer.x);
    const y = finiteOr(source.y, lastPointer.y);

    const changed = (
      source.id !== id ||
      source.text !== text ||
      !areItemsEquivalent(source.items, items) ||
      source.createdAt !== createdAt ||
      source.updatedAt !== updatedAt ||
      source.isClosed !== isClosed ||
      source.domain !== domain ||
      source.storagePageKey !== storagePageKey ||
      source.x !== x ||
      source.y !== y
    );

    return {
      id,
      x,
      y,
      text,
      items,
      createdAt,
      updatedAt,
      isClosed,
      domain,
      storagePageKey,
      changed
    };
  }

  function storageGet(key) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get([key], (result) => {
          if (chrome.runtime.lastError) {
            markRuntimeInvalid(chrome.runtime.lastError);
            resolve({});
            return;
          }
          resolve(result || {});
        });
      } catch (error) {
        markRuntimeInvalid(error);
        resolve({});
      }
    });
  }

  function storageSet(value) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.set(value, () => {
          if (chrome.runtime.lastError) {
            markRuntimeInvalid(chrome.runtime.lastError);
          }
          resolve();
        });
      } catch (error) {
        markRuntimeInvalid(error);
        resolve();
      }
    });
  }

  function finiteOr(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function markRuntimeInvalid(error) {
    if (runtimeInvalidated) {
      return;
    }
    const message = String((error && error.message) || error || "");
    if (message.toLowerCase().includes("extension context invalidated")) {
      runtimeInvalidated = true;
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      console.warn("Quick Sticky: extension context invalidated. Ignoring stale content script calls.");
    }
  }
})();
