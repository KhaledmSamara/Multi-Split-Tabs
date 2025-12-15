const { app, BrowserWindow, BrowserView, ipcMain, globalShortcut, session } = require("electron");
const fs = require("fs");
const path = require("path");

const STATE_FILE = path.join(app.getPath("userData"), "app-state.json");

let windows = [];
let pages = [{ id: 1, name: "Session 1", sessionId: "persist:page_1" }];
let nextPageId = 2;
let deletedPageNumbers = [];
let globalZoomLevel = 100; // Global zoom for all windows
let lastCycleTabsAt = 0; // throttle for rapid Ctrl+Tab
let settings = {
  defaultTabs: 4,
  layoutPreset: "auto",
  hotkeys: {
    fullscreen: "F11",
    new_window: "CommandOrControl+N",
    add_tab: "CommandOrControl+T",
    delete_tab: "CommandOrControl+W",
    cycle_tabs: "CommandOrControl+Tab",
    cycle_sessions: "CommandOrControl+Shift+Tab",
    back: "Alt+Left",
    forward: "Alt+Right",
    search: "CommandOrControl+F",
    add_session: "CommandOrControl+Shift+N"
  }
};

function createOverlay(parent, file) {
  const w = new BrowserWindow({
    width: 1200, height: 900,
    frame: false, transparent: true,
    parent, show: false, skipTaskbar: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  w.setAlwaysOnTop(true, "floating");
  w.setIgnoreMouseEvents(true);
  w.loadFile(file);
  try { w.webContents.setMaxListeners(0); } catch (e) {}
  return w;
}
function pagesWithTabsFor(win) {
  return pages.map(p => ({ ...p, tabs: win.pageTabs[p.id] || 4 }));
}
function getActiveView(win) {
  const pid = win.currentPage;
  const idx = win.activeTabPerPage[pid];
  if (typeof idx !== "number") return undefined;
  return win.pageViews[pid]?.[idx];
}
function applyZoomToViews(views, zoom) {
  if (!views) return;
  views.forEach(v => {
    try {
      if (v.webContents && !v.webContents.isDestroyed()) {
        v.webContents.setZoomFactor(zoom / 100);
      }
    } catch (e) {}
  });
}
function applyZoomAllWindows() {
  windows.forEach(w => {
    Object.keys(w.pageViews).forEach(pid => {
      applyZoomToViews(w.pageViews[pid], globalZoomLevel);
    });
    sendToHeader(w, "update-zoom", globalZoomLevel);
  });
}
function enforceGlobalZoom(view) {
  if (!view || !view.webContents) return;
  const apply = () => {
    try { view.webContents.setZoomFactor(globalZoomLevel / 100); } catch (e) {}
  };
  apply();
  try {
    view.webContents.on("zoom-changed", apply);
    view.webContents.on("did-start-loading", apply);
    view.webContents.on("did-navigate", apply);
    view.webContents.on("did-navigate-in-page", apply);
    view.webContents.on("did-finish-load", apply);
  } catch (e) {}
}
function createTabView(sessionId, pageId, index) {
  const view = new BrowserView({
    webPreferences: { partition: sessionId, preload: path.join(__dirname, "preload.js") }
  });
  setupTabNavigationListeners(view, pageId, index);
  enforceGlobalZoom(view);
  return view;
}
function ensureViewsFor(win, pageId, count) {
  const page = pages.find(p => p.id === pageId);
  const sessionId = page?.sessionId;
  if (!win.pageViews[pageId]) win.pageViews[pageId] = [];
  const arr = win.pageViews[pageId];
  for (let i = arr.length; i < count; i++) {
    arr.push(createTabView(sessionId, pageId, i));
  }
  return arr;
}
function triggerLayout(win) {
  setTimeout(() => {
    if (!win.isDestroyed()) win.emit("resize");
  }, 50);
}
function getActiveMainWindow() {
  let fw;
  try { fw = BrowserWindow.getFocusedWindow(); } catch (e) {}
  if (fw && fw.headerView) return fw;
  try {
    if (fw && typeof fw.getParentWindow === "function") {
      const pw = fw.getParentWindow();
      if (pw && pw.headerView) return pw;
    }
  } catch (e) {}
  const candidate = windows.find(w => !w.isDestroyed());
  if (candidate) return candidate;
  const any = BrowserWindow.getAllWindows().find(w => w.headerView);
  return any || null;
}
function updateOverlaysBounds(win) {
  try {
    if (!win.isDestroyed()) {
      const [x, y] = win.getPosition();
      const [w, h] = win.getContentSize();
      [win.popupWindow, win.deleteModeWindow, win.settingsWindow].forEach(ow => {
        if (ow && !ow.isDestroyed()) ow.setBounds({ x, y, width: w, height: h });
      });
      if (win.searchBoxWindow && !win.searchBoxWindow.isDestroyed()) {
        const contentBounds = win.getContentBounds();
        if (win.searchBoxWindow.isVisible()) {
          const v = getActiveView(win);
          const b = v ? v.getBounds() : { x: 0, y: 0, width: w, height: h };
          win.searchBoxWindow.setBounds({
            x: contentBounds.x + b.x,
            y: contentBounds.y + b.y,
            width: b.width,
            height: b.height
          });
        } else {
          win.searchBoxWindow.setBounds({ x: contentBounds.x, y: contentBounds.y, width: contentBounds.width, height: contentBounds.height });
        }
      }
    }
  } catch (e) {}
}
function computeTabBounds(win) {
  const pid = win.currentPage;
  const count = win.pageTabs[pid] || 4;
  const [w, h] = win.getContentSize();
  const headerHeight = win.isFullScreen() ? 0 : 80;
  const contentY = headerHeight;
  const contentH = h - headerHeight;
  return boundsForPreset(w, contentY, contentH, count, settings.layoutPreset);
}
function cleanupSearch(win) {
  try {
    const targetPid = win.searchTargetPageId || win.currentPage;
    const targetIdx = typeof win.searchTargetTabIndex === "number" ? win.searchTargetTabIndex : win.activeTabPerPage[targetPid];
    const v = (typeof targetIdx === "number") ? (win.pageViews[targetPid]?.[targetIdx]) : undefined;
    if (v && v.webContents && !v.webContents.isDestroyed() && win.searchHighlightCSSKey) {
      v.webContents.removeInsertedCSS(win.searchHighlightCSSKey).catch(() => {});
      win.searchHighlightCSSKey = null;
    }
    win.searchTargetPageId = undefined;
    win.searchTargetTabIndex = undefined;
    if (!win.searchBoxWindow.isDestroyed() && win.searchBoxWindow.isVisible()) {
      win.searchBoxWindow.hide();
      win.searchBoxWindow.setIgnoreMouseEvents(true);
    }
  } catch (e) {}
}
function insertSnakeAnimation(view, win) {
  if (!view || !view.webContents || view.webContents.isDestroyed()) return;
  if (win.tabAnimationCSSKey) {
    view.webContents.removeInsertedCSS(win.tabAnimationCSSKey).catch(() => {});
    win.tabAnimationCSSKey = null;
  }
  view.webContents.executeJavaScript(`
    (function() {
      try {
        var old = document.getElementById('__snakeAnimOverlay');
        if (old) old.remove();
        var style = document.getElementById('__snakeAnimStyle');
        if (!style) {
          style = document.createElement('style');
          style.id = '__snakeAnimStyle';
          style.textContent = "@keyframes snakeBorderAnim{0%{left:var(--inset);bottom:var(--inset);width:100px;height:3px;}23%{left:calc(100% - 100px - var(--inset));bottom:var(--inset);width:100px;height:3px;}25%{left:calc(100% - 3px - var(--inset));bottom:var(--inset);width:3px;height:100px;}48%{left:calc(100% - 3px - var(--inset));bottom:calc(100% - 100px - var(--inset));width:3px;height:100px;}50%{left:calc(100% - 100px - var(--inset));bottom:calc(100% - 3px - var(--inset));width:100px;height:3px;}73%{left:var(--inset);bottom:calc(100% - 3px - var(--inset));width:100px;height:3px;}75%{left:var(--inset);bottom:calc(100% - 100px - var(--inset));width:3px;height:100px;}98%{left:var(--inset);bottom:var(--inset);width:3px;height:100px;}100%{left:var(--inset);bottom:var(--inset);width:100px;height:3px;opacity:0;}}";
          document.documentElement.appendChild(style);
        }
        var el = document.createElement('div');
        el.id = '__snakeAnimOverlay';
        el.style.position = 'fixed';
        el.style.left = 'var(--inset)';
        el.style.bottom = 'var(--inset)';
        el.style.width = '100px';
        el.style.height = '3px';
        el.style.pointerEvents = 'none';
        el.style.zIndex = '2147483647';
        el.style.animation = 'snakeBorderAnim 0.6s ease-in-out forwards';
        el.style.mixBlendMode = 'difference';
        el.style.background = 'linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.4) 25%, rgba(255,255,255,0.95) 50%, rgba(255,255,255,0.4) 75%, transparent 100%)';
        el.style.boxShadow = '0 0 12px rgba(255,255,255,0.9)';
        el.style.setProperty('--inset', '6px');
        document.documentElement.appendChild(el);
        setTimeout(function() {
          var e = document.getElementById('__snakeAnimOverlay');
          if (e) e.remove();
        }, 650);
      } catch (e) {
        try {
          var css = "@keyframes snakeBorderAnim{0%{left:var(--inset);bottom:var(--inset);width:100px;height:3px;}23%{left:calc(100% - 100px - var(--inset));bottom:var(--inset);width:100px;height:3px;}25%{left:calc(100% - 3px - var(--inset));bottom:var(--inset);width:3px;height:100px;}48%{left:calc(100% - 3px - var(--inset));bottom:calc(100% - 100px - var(--inset));width:3px;height:100px;}50%{left:calc(100% - 100px - var(--inset));bottom:calc(100% - 3px - var(--inset));width:100px;height:3px;}73%{left:var(--inset);bottom:calc(100% - 3px - var(--inset));width:100px;height:3px;}75%{left:var(--inset);bottom:calc(100% - 100px - var(--inset));width:3px;height:100px;}98%{left:var(--inset);bottom:var(--inset);width:3px;height:100px;}100%{left:var(--inset);bottom:var(--inset);width:100px;height:3px;opacity:0;}} html::after{--inset:6px;content:'';position:fixed;left:var(--inset);bottom:var(--inset);width:100px;height:3px;background:linear-gradient(90deg,transparent 0%,rgba(255,255,255,0.4) 25%,rgba(255,255,255,0.95) 50%,rgba(255,255,255,0.4) 75%,transparent 100%);box-shadow:0 0 12px rgba(255,255,255,0.9);pointer-events:none;z-index:2147483647;animation:snakeBorderAnim 0.6s ease-in-out forwards;mix-blend-mode:difference;}";
          if (view && view.webContents && !view.webContents.isDestroyed()) {
            view.webContents.insertCSS(css).then((key) => {
              win.tabAnimationCSSKey = key;
              setTimeout(() => {
                if (view && view.webContents && !view.webContents.isDestroyed()) {
                  view.webContents.removeInsertedCSS(key).catch(() => {});
                  if (win.tabAnimationCSSKey === key) win.tabAnimationCSSKey = null;
                }
              }, 650);
            }).catch(() => {});
          }
        } catch (_) {}
      }
    })();
  `).catch(() => {});
}
function activateTab(win, pageId, tabIndex) {
  if (!win || win.isDestroyed()) return;
  if (win.activeTabPerPage[pageId] === tabIndex) return;
  win.activeTabPerPage[pageId] = tabIndex;
  updateHeaderTabState(win);
  const v = win.pageViews[pageId]?.[tabIndex];
  if (v && v.webContents && !v.webContents.isDestroyed()) {
    try { win.focus(); } catch (e) {}
    try { v.webContents.focus(); } catch (e) {}
    insertSnakeAnimation(v, win);
  }
}
function addTabToCurrentPage(win, makeActive) {
  const pid = win.currentPage;
  const count = win.pageTabs[pid] || 4;
  if (count >= 12) {
    showPopup(win, "show-error", "Maximum 12 tabs allowed!");
    return;
  }
  win.pageTabs[pid] = count + 1;
  const idx = win.pageTabs[pid] - 1;
  if (makeActive) win.activeTabPerPage[pid] = idx;
  const startPage = `file://${__dirname}/start.html`;
  try {
    const newView = win.pageViews[pid][idx];
    try { newView.webContents.setZoomFactor(globalZoomLevel / 100); } catch (e) {}
    newView.webContents.loadURL(startPage);
    newView.webContents.once("did-finish-load", () => {
      try {
        if (!newView.webContents.isDestroyed()) {
          newView.webContents.setZoomFactor(globalZoomLevel / 100);
          injectClickDetection(newView, pid, idx);
        }
      } catch (e) {}
    });
  } catch (e) {}
  sendToHeader(win, "update-pages", pagesWithTabsFor(win));
  updateHeaderTabState(win);
  triggerLayout(win);
  debouncedSaveState();
}
function activateDeleteMode(win) {
  if (!win || win.isDestroyed()) return;
  if (!win.deleteModeWindow || win.deleteModeWindow.isDestroyed()) return;
  if (!win.pageTabs || !win.currentPage) return;
  const pid = win.currentPage;
  const count = win.pageTabs[pid] || 4;
  const tabBounds = computeTabBounds(win);
  try {
    if (win.deleteModeWindow && !win.deleteModeWindow.isDestroyed()) {
      const contentBounds = win.getContentBounds();
      win.deleteModeWindow.setBounds({
        x: contentBounds.x,
        y: contentBounds.y,
        width: contentBounds.width,
        height: contentBounds.height
      });
      win.deleteModeWindow.webContents.send("activate-delete-mode", tabBounds);
      win.deleteModeWindow.setIgnoreMouseEvents(false);
      win.deleteModeWindow.show();
      try { win.deleteModeWindow.focus(); } catch (e) {}
      win.isDeleteModeActive = true;
      try { win.moveTop(); } catch (e) {}
    }
  } catch (e) {
    console.error("Failed to activate delete mode:", e);
  }
}
function openSearchOverlay(win) {
  const pid = win.currentPage;
  const idx = win.activeTabPerPage[pid];
  if (typeof idx !== "number") return;
  const activeView = win.pageViews[pid]?.[idx];
  if (!activeView) return;
  win.searchTargetPageId = pid;
  win.searchTargetTabIndex = idx;
  const tabBounds = activeView.getBounds();
  const contentBounds = win.getContentBounds();
  try {
    if (!win.searchBoxWindow.isDestroyed()) {
      win.searchBoxWindow.setBounds({
        x: contentBounds.x + tabBounds.x,
        y: contentBounds.y + tabBounds.y,
        width: tabBounds.width,
        height: tabBounds.height
      });
      const level = win.isFullScreen() ? "screen-saver" : "floating";
      win.searchBoxWindow.setAlwaysOnTop(true, level);
      let currentUrl = "";
      try {
        if (activeView && activeView.webContents && !activeView.webContents.isDestroyed()) {
          currentUrl = activeView.webContents.getURL() || "";
        }
      } catch (e) {}
      win.searchBoxWindow.webContents.send("activate-search", tabBounds, currentUrl);
      win.searchBoxWindow.setIgnoreMouseEvents(false);
      win.searchBoxWindow.showInactive();
      try { win.searchBoxWindow.focus(); } catch (e) {}
      try { win.searchBoxWindow.webContents.focus(); } catch (e) {}
    }
  } catch (e) {
    console.error("Failed to open search:", e);
  }
}
function switchToPage(win, pageId) {
  if (!win || win.isDestroyed()) return;
  try {
    cleanupSearch(win);
    if (win.searchBoxWindow && !win.searchBoxWindow.isDestroyed()) {
      win.searchBoxWindow.setAlwaysOnTop(false);
      win.searchBoxWindow.hide();
      win.searchBoxWindow.setIgnoreMouseEvents(true);
    }
  } catch (e) {}
  const newPage = pages.find(p => p.id === pageId);
  if (!newPage || win.currentPage === pageId) return;
  const oldPageViews = win.pageViews[win.currentPage];
  if (oldPageViews) {
    oldPageViews.forEach(view => {
      try {
        win.removeBrowserView(view);
      } catch (e) {}
    });
  }
  const newPageViews = win.pageViews[pageId];
  if (newPageViews) {
    newPageViews.forEach(view => {
      try {
        win.addBrowserView(view);
      } catch (e) {}
    });
  }
  win.currentPage = pageId;
  try {
    win.removeBrowserView(win.headerView);
    win.addBrowserView(win.headerView);
  } catch (e) {}
  updateHeaderTabState(win);
  applyZoomToViews(newPageViews, globalZoomLevel);
  triggerLayout(win);
  sendToHeader(win, "update-current-page", pageId);
  debouncedSaveState();
  try {
    const tabCount = win.pageTabs[pageId] || 4;
    let activeIdx = win.activeTabPerPage[pageId];
    const valid = typeof activeIdx === "number" && activeIdx >= 0 && activeIdx < tabCount;
    if (!valid) {
      activeIdx = 0;
      win.activeTabPerPage[pageId] = activeIdx;
      updateHeaderTabState(win);
    }
    const activeView = win.pageViews[pageId]?.[activeIdx];
    if (activeView && activeView.webContents && !activeView.webContents.isDestroyed()) {
      try { win.focus(); } catch (e) {}
      try { activeView.webContents.focus(); } catch (e) {}
    }
  } catch (e) {}
}
function addPageGlobal() {
  let pageNumber;
  if (deletedPageNumbers.length > 0) {
    deletedPageNumbers.sort((a, b) => a - b);
    pageNumber = deletedPageNumbers.shift();
  } else {
    pageNumber = nextPageId++;
  }
  const newSessionId = `persist:page_${pageNumber}`;
  const newPage = { id: pageNumber, name: `Session ${pageNumber}`, sessionId: newSessionId };
  pages.push(newPage);
  windows.forEach(w => {
    const views = [];
    for (let i = 0; i < 12; i++) {
      const view = new BrowserView({
        webPreferences: { partition: newSessionId, preload: path.join(__dirname, "preload.js") }
      });
      views.push(view);
      setupTabNavigationListeners(view, pageNumber, i);
      // Attach global zoom enforcement to each new view
      const enforce = () => {
        try { view.webContents.setZoomFactor(globalZoomLevel / 100); } catch (e) {}
      };
      try {
        enforce();
        view.webContents.on('zoom-changed', enforce);
        view.webContents.on('did-start-loading', enforce);
        view.webContents.on('did-navigate', enforce);
        view.webContents.on('did-navigate-in-page', enforce);
        view.webContents.on('did-finish-load', enforce);
      } catch (e) {}
    }
    const startPage = `file://${__dirname}/start.html`;
    const defTabs = Math.max(1, Math.min(12, settings.defaultTabs || 4));
    w.pageTabs[pageNumber] = defTabs;
    for (let i = 0; i < defTabs; i++) {
      try { views[i].webContents.setZoomFactor(globalZoomLevel / 100); } catch (e) {}
      views[i].webContents.loadURL(startPage);
      views[i].webContents.once("did-finish-load", () => {
        try {
          if (!views[i].webContents.isDestroyed()) {
            views[i].webContents.setZoomFactor(globalZoomLevel / 100);
          }
        } catch (e) {}
      });
    }
    w.pageViews[pageNumber] = views;
    if (w.activeTabPerPage) {
      delete w.activeTabPerPage[pageNumber];
    }
    sendToHeader(w, "update-pages", pagesWithTabsFor(w));
  });
  debouncedSaveState();
}

// State persistence
function saveState() {
  if (windows.length === 0) return; // Don't save if no windows
  
  try {
    const state = {
      pages: pages,
      nextPageId: nextPageId,
      deletedPageNumbers: deletedPageNumbers,
      globalZoomLevel: globalZoomLevel,
      settings: settings,
      windows: windows.map(win => {
        if (win.isDestroyed()) return null;
        
        const tabUrls = {};
        Object.keys(win.pageViews).forEach(pageId => {
          const views = win.pageViews[pageId];
          const urls = [];
          const tabCount = win.pageTabs[pageId] || 4;
          
          for (let i = 0; i < tabCount; i++) {
            if (views[i] && views[i].webContents && !views[i].webContents.isDestroyed()) {
              urls.push(views[i].webContents.getURL());
            } else {
              urls.push(`file://${__dirname}/start.html`);
            }
          }
          tabUrls[pageId] = urls;
        });
        
        return {
          bounds: win.getBounds(),
          isMaximized: win.isMaximized(),
          isFullScreen: win.isFullScreen(),
          currentPage: win.currentPage,
          pageTabs: win.pageTabs,
          tabUrls: tabUrls
        };
      }).filter(w => w !== null)
    };
    
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error("Failed to save state:", err);
  }
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = fs.readFileSync(STATE_FILE, "utf8");
      return JSON.parse(data);
    }
  } catch (err) {
    console.error("Failed to load state:", err);
  }
  return null;
}

// Debounced save
let saveTimeout = null;
function debouncedSaveState() {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    if (windows.length > 0) saveState();
  }, 1000);
}

// Calculate optimal grid layout
function calculateLayout(tabCount) {
  if (tabCount === 1) return { cols: 1, rows: 1 };
  if (tabCount === 2) return { cols: 2, rows: 1 };
  if (tabCount === 3) return { cols: 2, rows: 2 }; // 2x2 with one empty
  if (tabCount === 4) return { cols: 2, rows: 2 };
  if (tabCount <= 6) return { cols: 3, rows: 2 };
  if (tabCount <= 9) return { cols: 3, rows: 3 };
  return { cols: 4, rows: 3 }; // 10-12 tabs
}
function boundsForPreset(w, contentY, contentH, tabCount, preset) {
  const out = [];
  const gridWithCols = (fixedCols) => {
    const cols = Math.max(1, Math.min(fixedCols, tabCount));
    const rows = Math.max(1, Math.ceil(tabCount / cols));
    const cellW = w / cols;
    const cellH = contentH / rows;
    for (let i = 0; i < tabCount; i++) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const isLastRow = row === rows - 1;
      const isLastTab = i === tabCount - 1;
      const tabsInLastRow = tabCount - (cols * (rows - 1));
      if (isLastTab && isLastRow && tabsInLastRow < cols) {
        const usedCols = tabsInLastRow;
        const remainingCols = cols - usedCols + 1;
        out.push({ x: col * cellW, y: contentY + row * cellH, width: cellW * remainingCols, height: cellH });
      } else {
        out.push({ x: col * cellW, y: contentY + row * cellH, width: cellW, height: cellH });
      }
    }
  };
  if (!preset || preset === "auto") {
    const { cols, rows } = calculateLayout(tabCount);
    const cellW = w / cols;
    const cellH = contentH / rows;
    for (let i = 0; i < tabCount; i++) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const isLastRow = row === rows - 1;
      const isLastTab = i === tabCount - 1;
      const tabsInLastRow = tabCount - (cols * (rows - 1));
      if (isLastTab && isLastRow && tabsInLastRow < cols) {
        const usedCols = tabsInLastRow;
        const remainingCols = cols - usedCols + 1;
        out.push({ x: col * cellW, y: contentY + row * cellH, width: cellW * remainingCols, height: cellH });
      } else {
        out.push({ x: col * cellW, y: contentY + row * cellH, width: cellW, height: cellH });
      }
    }
    return out;
  }
  if (preset === "columns_2") return gridWithCols(2), out;
  if (preset === "columns_3") return gridWithCols(3), out;
  if (preset === "columns_4") return gridWithCols(4), out;
  if (preset === "one_big_left") {
    const halfW = w / 2;
    out.push({ x: 0, y: contentY, width: halfW, height: contentH });
    const remaining = Math.max(0, tabCount - 1);
    if (remaining === 0) return out;
    const cols = Math.min(2, remaining);
    const rows = Math.ceil(remaining / cols);
    const cellW = halfW / cols;
    const cellH = contentH / rows;
    for (let i = 0; i < remaining; i++) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      out.push({ x: halfW + col * cellW, y: contentY + row * cellH, width: cellW, height: cellH });
    }
    return out;
  }
  if (preset === "one_big_right") {
    const halfW = w / 2;
    const remaining = Math.max(0, tabCount - 1);
    if (remaining > 0) {
      const cols = Math.min(2, remaining);
      const rows = Math.ceil(remaining / cols);
      const cellW = halfW / cols;
      const cellH = contentH / rows;
      for (let i = 0; i < remaining; i++) {
        const col = i % cols;
        const row = Math.floor(i / cols);
        out.push({ x: col * cellW, y: contentY + row * cellH, width: cellW, height: cellH });
      }
    }
    out.push({ x: halfW, y: contentY, width: halfW, height: contentH });
    return out;
  }
  if (preset === "odd_second_tall") {
    if (tabCount >= 3 && tabCount % 2 === 1) {
      const arr = new Array(tabCount);
      const halfW = w / 2;
      arr[1] = { x: halfW, y: contentY, width: halfW, height: contentH };
      const remainingIdxs = [];
      for (let i = 0; i < tabCount; i++) {
        if (i !== 1) remainingIdxs.push(i);
      }
      const rows = remainingIdxs.length;
      const cellH = contentH / rows;
      remainingIdxs.forEach((ti, p) => {
        arr[ti] = { x: 0, y: contentY + p * cellH, width: halfW, height: cellH };
      });
      return arr;
    }
  }
  if (preset === "odd_last_wide") {
    if (tabCount >= 3 && tabCount % 2 === 1) {
      const arr = new Array(tabCount);
      const bottomH = contentH / 3;
      const topH = contentH - bottomH;
      arr[tabCount - 1] = { x: 0, y: contentY + topH, width: w, height: bottomH };
      const remaining = tabCount - 1;
      const cols = Math.min(2, remaining);
      const rows = Math.ceil(remaining / cols);
      const cellW = w / cols;
      const cellH = topH / rows;
      for (let i = 0; i < remaining; i++) {
        const col = i % cols;
        const row = Math.floor(i / cols);
        arr[i] = { x: col * cellW, y: contentY + row * cellH, width: cellW, height: cellH };
      }
      return arr;
    }
  }
  if (preset === "first_wide_top") {
    if (tabCount >= 1) {
      const arr = new Array(tabCount);
      if (tabCount === 1) {
        arr[0] = { x: 0, y: contentY, width: w, height: contentH };
        return arr;
      }
      const topH = contentH / 3;
      arr[0] = { x: 0, y: contentY, width: w, height: topH };
      const remaining = tabCount - 1;
      const cols = Math.min(2, remaining);
      const rows = Math.ceil(remaining / cols);
      const cellW = w / cols;
      const cellH = (contentH - topH) / rows;
      for (let i = 0; i < remaining; i++) {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const ti = i + 1;
        arr[ti] = { x: col * cellW, y: contentY + topH + row * cellH, width: cellW, height: cellH };
      }
      return arr;
    }
  }
  const { cols, rows } = calculateLayout(tabCount);
  const cellW = w / cols;
  const cellH = contentH / rows;
  for (let i = 0; i < tabCount; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    out.push({ x: col * cellW, y: contentY + row * cellH, width: cellW, height: cellH });
  }
  return out;
}

function createWindow(restoreState = null) {
  const win = new BrowserWindow({
    width: restoreState?.bounds?.width || 1200,
    height: restoreState?.bounds?.height || 900,
    x: restoreState?.bounds?.x,
    y: restoreState?.bounds?.y,
    frame: false,
    backgroundColor: "#000000",
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });

  win.setMaxListeners(0);

  const popupWindow = createOverlay(win, "popup.html");
  const deleteModeWindow = createOverlay(win, "delete-mode.html");
  const searchBoxWindow = createOverlay(win, "search-box.html");
  const settingsWindow = createOverlay(win, "settings.html");

  // Header
  const header = new BrowserView({
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  win.addBrowserView(header);
  header.webContents.loadFile("header.html");
  try { header.webContents.setMaxListeners(0); } catch (e) {}

  // Create views for each page
  win.pageViews = {};
  win.pageTabs = {};
  
  pages.forEach(page => {
    const views = [];
    for (let i = 0; i < 12; i++) {
      const view = new BrowserView({
        webPreferences: { partition: page.sessionId, preload: path.join(__dirname, "preload.js") }
      });
      views.push(view);
      setupTabNavigationListeners(view, page.id, i);
    }
    win.pageTabs[page.id] = restoreState?.pageTabs?.[page.id] || 4;
    win.pageViews[page.id] = views;
    
    // Enforce global zoom on all views
    views.forEach(view => {
      const enforce = () => {
        try { view.webContents.setZoomFactor(globalZoomLevel / 100); } catch (e) {}
      };
      enforce();
      view.webContents.on('zoom-changed', enforce);
      view.webContents.on('did-start-loading', enforce);
      view.webContents.on('did-navigate', enforce);
      view.webContents.on('did-navigate-in-page', enforce);
      view.webContents.on('did-finish-load', enforce);
    });
    win.activeTabPerPage = win.activeTabPerPage || {};
  });
  win.activeTabPerPage = win.activeTabPerPage || {};

  // Set current page
  const restoredPage = restoreState?.currentPage || (pages.length > 0 ? pages[0].id : 1);
  win.currentPage = restoredPage;
  
  if (win.pageViews[win.currentPage]) {
    win.pageViews[win.currentPage].forEach(v => win.addBrowserView(v));
  } else if (pages.length > 0 && win.pageViews[pages[0].id]) {
    win.currentPage = pages[0].id;
    win.pageViews[pages[0].id].forEach(v => win.addBrowserView(v));
  }

  win.headerView = header;
  win.popupWindow = popupWindow;
  win.deleteModeWindow = deleteModeWindow;
  win.searchBoxWindow = searchBoxWindow;
  win.settingsWindow = settingsWindow;
  win.isDeleteModeActive = false;

  // Layout function with improved grid system
  const layoutViews = () => {
    try {
      if (win.isDestroyed()) return;

      const [w, h] = win.getContentSize();
      const headerHeight = win.isFullScreen() ? 0 : 80;
      
      // Update header
      header.setBounds({ 
        x: 0, 
        y: win.isFullScreen() ? -80 : 0, 
        width: w, 
        height: 80 
      });

      const currentPage = pages.find(p => p.id === win.currentPage);
      if (!currentPage || !win.pageViews[win.currentPage]) return;
      
      const tabCount = win.pageTabs[win.currentPage] || 4;
      const contentY = headerHeight;
      const contentH = h - headerHeight;
      const views = ensureViewsFor(win, win.currentPage, tabCount);

      // Hide all first
      views.forEach(v => v.setBounds({ x: 0, y: 0, width: 0, height: 0 }));

      const bounds = boundsForPreset(w, contentY, contentH, tabCount, settings.layoutPreset);
      for (let i = 0; i < tabCount; i++) {
        const b = bounds[i];
        try { win.addBrowserView(views[i]); } catch (e) {}
        views[i].setBounds(b);
      }
    } catch (err) {
      console.error('Layout error:', err);
    }
  };

  const updatePopup = () => updateOverlaysBounds(win);

  // Event handlers
  let resizeTimer = null;
  win.on("resize", () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      layoutViews();
      updatePopup();
    }, 16);
  });

  let moveTimer = null;
  win.on("move", () => {
    if (moveTimer) clearTimeout(moveTimer);
    moveTimer = setTimeout(updatePopup, 16);
  });

  win.on("leave-full-screen", () => {
    cleanupSearch(win);
    try {
      if (header.webContents && !header.webContents.isDestroyed()) {
        header.webContents.send("toggle-header", true);
      }
      layoutViews();
    } catch (err) {}
  });

  win.on("maximize", () => {
    try {
      if (header.webContents && !header.webContents.isDestroyed()) {
        header.webContents.send("update-maximize", true);
      }
      setTimeout(() => {
        if (!win.isDestroyed()) {
          layoutViews();
          updatePopup();
        }
      }, 150);
    } catch (err) {}
  });

  win.on("unmaximize", () => {
    try {
      if (header.webContents && !header.webContents.isDestroyed()) {
        header.webContents.send("update-maximize", false);
      }
      setTimeout(() => {
        if (!win.isDestroyed()) {
          layoutViews();
          updatePopup();
        }
      }, 150);
    } catch (err) {}
  });

  win.on("enter-full-screen", () => {
    try {
      if (header.webContents && !header.webContents.isDestroyed()) {
        header.webContents.send("toggle-header", false);
      }
      layoutViews();
    } catch (err) {}
  });

  win.on("blur", () => {
    try {
      const focusedWin = BrowserWindow.getFocusedWindow();
      if (focusedWin === win.searchBoxWindow) return;
      cleanupSearch(win);
      try {
        if (!win.searchBoxWindow.isDestroyed()) win.searchBoxWindow.setAlwaysOnTop(false);
      } catch (e) {}
    } catch (err) {}
  });

  layoutViews();
  updatePopup();

  header.webContents.on("did-finish-load", () => {
    try {
      header.webContents.send("update-state", {
        pages: pagesWithTabsFor(win),
        currentPage: win.currentPage,
        zoomLevel: globalZoomLevel,
        isMaximized: win.isMaximized()
      });
      updateHeaderTabState(win);
    } catch (err) {}
  });

  windows.push(win);

  win.on("closed", () => {
    windows = windows.filter(w => w !== win);
    
    // Destroy views
    Object.keys(win.pageViews).forEach(pageId => {
      win.pageViews[pageId].forEach(view => {
        try {
          if (view.webContents && !view.webContents.isDestroyed()) {
            view.webContents.destroy();
          }
        } catch (err) {}
      });
    });
    
    try {
      if (!popupWindow.isDestroyed()) popupWindow.close();
    } catch (err) {}
  });

  // Save state on close
  win.on("close", () => saveState());
  
  // Restore window state
  if (restoreState) {
    try { showPopup(win, "show-initial-loader"); } catch (e) {}
    setTimeout(() => {
      if (restoreState.isMaximized) win.maximize();
      if (restoreState.isFullScreen) win.setFullScreen(true);
      
      // Load URLs and apply zoom for this window only
      let pending = win.pageTabs[win.currentPage] || 4;
      Object.keys(win.pageViews).forEach(pageId => {
        const savedUrls = restoreState.tabUrls?.[pageId] || [];
        const tabCount = win.pageTabs[pageId] || 4;
        const startPage = `file://${__dirname}/start.html`;
        
        win.pageViews[pageId].forEach((view, index) => {
          try {
            if (view.webContents && !view.webContents.isDestroyed()) {
              if (index < tabCount) {
                const url = savedUrls[index] || startPage;
                try { view.webContents.setZoomFactor(globalZoomLevel / 100); } catch (e) {}
                view.webContents.loadURL(url);
                
                view.webContents.once('did-finish-load', () => {
                  try {
                    if (!view.webContents.isDestroyed()) {
                      view.webContents.setZoomFactor(globalZoomLevel / 100);
                    }
                    if (pageId == win.currentPage && pending > 0) {
                      pending = Math.max(0, pending - 1);
                      if (pending === 0) {
                        try { win.popupWindow.webContents.send("hide-initial-loader"); } catch (e) {}
                        try { win.popupWindow.hide(); } catch (e) {}
                      }
                    }
                  } catch (err) {}
                });
              }
            }
          } catch (err) {}
        });
      });
      setTimeout(() => {
        try { win.popupWindow.webContents.send("hide-initial-loader"); } catch (e) {}
        try { win.popupWindow.hide(); } catch (e) {}
      }, 2000);
    }, 200);
  } else {
    // Load default start pages
    try { showPopup(win, "show-initial-loader"); } catch (e) {}
    setTimeout(() => {
      const startPage = `file://${__dirname}/start.html`;
      let pending = win.pageTabs[win.currentPage] || 4;
      Object.keys(win.pageViews).forEach(pageId => {
        const tabCount = win.pageTabs[pageId] || 4;
        win.pageViews[pageId].forEach((view, index) => {
          try {
            if (index < tabCount && view.webContents && !view.webContents.isDestroyed()) {
              try { view.webContents.setZoomFactor(globalZoomLevel / 100); } catch (e) {}
              view.webContents.loadURL(startPage);
              if (pageId == win.currentPage && index < pending) {
                view.webContents.once("did-finish-load", () => {
                  try {
                    pending = Math.max(0, pending - 1);
                    if (pending === 0) {
                      try { win.popupWindow.webContents.send("hide-initial-loader"); } catch (e) {}
                      try { win.popupWindow.hide(); } catch (e) {}
                    }
                  } catch (e) {}
                });
              }
            }
          } catch (err) {}
        });
      });
      setTimeout(() => {
        try { win.popupWindow.webContents.send("hide-initial-loader"); } catch (e) {}
        try { win.popupWindow.hide(); } catch (e) {}
      }, 2000);
    }, 200);
  }

  return win;
}

// App initialization
app.whenReady().then(() => {
  const savedState = loadState();
  
  if (savedState) {
    if (savedState.pages && savedState.pages.length > 0) {
      pages = savedState.pages;
      nextPageId = savedState.nextPageId || pages.length + 1;
      deletedPageNumbers = savedState.deletedPageNumbers || [];
    }
    
    // Restore global zoom level
    if (savedState.globalZoomLevel) {
      globalZoomLevel = savedState.globalZoomLevel;
    }
    if (savedState.settings) {
      settings = savedState.settings;
    }
    try {
      settings = settings || {};
      settings.hotkeys = settings.hotkeys || {};
      if (!settings.hotkeys.cycle_tabs || settings.hotkeys.cycle_tabs === "") {
        settings.hotkeys.cycle_tabs = "CommandOrControl+Tab";
      }
      if (!settings.hotkeys.cycle_sessions || settings.hotkeys.cycle_sessions === "" || settings.hotkeys.cycle_sessions === "CommandOrControl+Tab") {
        settings.hotkeys.cycle_sessions = "CommandOrControl+Shift+Tab";
      }
    } catch (e) {}
    
    if (savedState.windows && savedState.windows.length > 0) {
      savedState.windows.forEach(winState => createWindow(winState));
    } else {
      createWindow();
    }
  } else {
    createWindow();
  }
  
  // Auto-save every 10 seconds
  setInterval(() => {
    if (windows.length > 0) saveState();
  }, 10000);
  reRegisterHotkeys();
  app.on("browser-window-focus", () => {
    reRegisterHotkeys();
  });
  app.on("browser-window-blur", () => {
    try { globalShortcut.unregisterAll(); } catch (e) {}
    try {
      setTimeout(() => {
        try {
          const focused = BrowserWindow.getFocusedWindow();
          const isOurWindow = windows.some(w =>
            focused === w ||
            focused === w.searchBoxWindow ||
            focused === w.popupWindow ||
            focused === w.deleteModeWindow ||
            focused === w.settingsWindow
          );
          if (!isOurWindow) {
            BrowserWindow.getAllWindows().forEach(w => {
              try {
                cleanupSearch(w);
                if (w.searchBoxWindow && !w.searchBoxWindow.isDestroyed()) {
                  w.searchBoxWindow.setAlwaysOnTop(false);
                  w.searchBoxWindow.hide();
                  w.searchBoxWindow.setIgnoreMouseEvents(true);
                }
              } catch (e) {}
            });
          }
        } catch (e) {}
      }, 0);
    } catch (e) {}
  });
});

app.on("will-quit", () => globalShortcut.unregisterAll());

// Helper
function sendToHeader(win, channel, ...args) {
  try {
    if (!win.isDestroyed() && win.headerView && win.headerView.webContents && !win.headerView.webContents.isDestroyed()) {
      win.headerView.webContents.send(channel, ...args);
    }
  } catch (err) {}
}

function windowForSender(sender) {
  try {
    const s = BrowserWindow.fromWebContents(sender);
    if (!s) return null;
    try {
      const p = typeof s.getParentWindow === "function" ? s.getParentWindow() : null;
      return p || s;
    } catch (e) {
      return s;
    }
  } catch (e) {
    return null;
  }
}
// Helper to update header with tab state
function updateHeaderTabState(win) {
  if (!win || win.isDestroyed()) return;
  const currentPageId = win.currentPage;
  const tabCount = win.pageTabs[currentPageId] || 0;
  const activeIdx = win.activeTabPerPage[currentPageId];
  const hasActiveTab = typeof activeIdx === "number" && activeIdx >= 0 && activeIdx < tabCount;
  sendToHeader(win, "update-tab-state", hasActiveTab);
}

function showPopup(win, channel, data) {
  try {
    if (!win.isDestroyed() && win.popupWindow && !win.popupWindow.isDestroyed()) {
      win.popupWindow.show();
      win.popupWindow.webContents.send(channel, data);
      try { win.focus(); } catch (e) {}
      try { win.moveTop(); } catch (e) {}
    }
  } catch (err) {}
}

function cancelDeleteModeForWindow(win) {
  if (!win || win.isDestroyed() || !win.deleteModeWindow) return;
  try {
    if (!win.deleteModeWindow.isDestroyed()) {
      win.deleteModeWindow.webContents.send("deactivate-delete-mode");
      win.deleteModeWindow.hide();
      win.deleteModeWindow.setIgnoreMouseEvents(true);
      win.isDeleteModeActive = false;
      try { win.focus(); } catch (e) {}
      try { win.moveTop(); } catch (e) {}
    }
  } catch (e) {}
}

function reRegisterHotkeys() {
  try { globalShortcut.unregisterAll(); } catch (e) {}
  try {
    if (settings.hotkeys.fullscreen) {
      globalShortcut.register(settings.hotkeys.fullscreen, () => {
        const win = BrowserWindow.getFocusedWindow();
        if (win) win.setFullScreen(!win.isFullScreen());
      });
    }
    if (settings.hotkeys.new_window) {
      globalShortcut.register(settings.hotkeys.new_window, () => createWindow());
    }
    if (settings.hotkeys.add_tab) {
      globalShortcut.register(settings.hotkeys.add_tab, () => {
        const win = getActiveMainWindow();
        if (!win) return;
        addTabToCurrentPage(win, false);
      });
    }
    if (settings.hotkeys.delete_tab) {
      globalShortcut.register(settings.hotkeys.delete_tab, () => {
        const win = getActiveMainWindow();
        if (!win) return;
        activateDeleteMode(win);
      });
    }
    if (settings.hotkeys.cycle_tabs) {
      globalShortcut.register(settings.hotkeys.cycle_tabs, () => {
        const now = Date.now();
        if (now - lastCycleTabsAt < 120) return;
        lastCycleTabsAt = now;
        const win = getActiveMainWindow();
        if (!win || !win.currentPage) return;
        const pid = win.currentPage;
        const tabCount = win.pageTabs[pid] || 4;
        if (tabCount <= 0) return;
        const current = win.activeTabPerPage[pid];
        const next = (typeof current === "number") ? ((current + 1) % tabCount) : 0;
        activateTab(win, pid, next);
      });
    }
    if (settings.hotkeys.cycle_sessions) {
      globalShortcut.register(settings.hotkeys.cycle_sessions, () => {
        const win = getActiveMainWindow();
        if (!win || !win.currentPage) return;
        const currentIndex = pages.findIndex(p => p.id === win.currentPage);
        if (currentIndex === -1) return;
        const nextIndex = (currentIndex + 1) % pages.length;
        const nextPage = pages[nextIndex];
        if (!nextPage) return;
        switchToPage(win, nextPage.id);
      });
    }
    globalShortcut.register("Escape", () => {
      const focused = BrowserWindow.getFocusedWindow();
      const mainWin = typeof focused?.getParentWindow === "function" ? focused.getParentWindow() : focused;
      if (mainWin && mainWin.isDeleteModeActive) {
        cancelDeleteModeForWindow(mainWin);
        return;
      }
      if (!mainWin || !mainWin.searchBoxWindow) return;
      cleanupSearch(mainWin);
      try { if (!mainWin.searchBoxWindow.isDestroyed()) mainWin.searchBoxWindow.setAlwaysOnTop(false); } catch (e) {}
      try { mainWin.focus(); } catch (e) {}
    });
    if (settings.hotkeys.back) {
      globalShortcut.register(settings.hotkeys.back, () => {
        const win = getActiveMainWindow();
        if (!win || !win.currentPage) return;
        const v = getActiveView(win);
        if (v && v.webContents && !v.webContents.isDestroyed()) {
          if (v.webContents.navigationHistory.canGoBack()) v.webContents.navigationHistory.goBack();
        }
      });
    }
    if (settings.hotkeys.forward) {
      globalShortcut.register(settings.hotkeys.forward, () => {
        const win = getActiveMainWindow();
        if (!win || !win.currentPage) return;
        const v = getActiveView(win);
        if (v && v.webContents && !v.webContents.isDestroyed()) {
          if (v.webContents.navigationHistory.canGoForward()) v.webContents.navigationHistory.goForward();
        }
      });
    }
    if (settings.hotkeys.search) {
      globalShortcut.register(settings.hotkeys.search, () => {
        const win = getActiveMainWindow();
        if (!win || !win.currentPage || !win.searchBoxWindow) return;
        try { win.focus(); } catch (e) {}
        openSearchOverlay(win);
      });
    }
    if (settings.hotkeys.add_session) {
      globalShortcut.register(settings.hotkeys.add_session, () => {
        addPageGlobal();
      });
    }
  } catch (e) {}
}

// IPC Handlers
ipcMain.on("close-window", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.close();
});

  ipcMain.on("navigate-to", (event, url) => {
    try {
      if (!url) return;
      const win = windows.find(w => {
        if (!w || w.isDestroyed()) return false;
        const pid = w.currentPage;
        const idx = w.activeTabPerPage[pid];
        if (typeof idx !== "number") return false;
        const v = w.pageViews[pid]?.[idx];
        return v && v.webContents && v.webContents === event.sender;
      }) || BrowserWindow.fromWebContents(event.sender);
      if (!win || win.isDestroyed() || !win.currentPage) return;
      const pid = win.currentPage;
      const idx = win.activeTabPerPage[pid];
      if (typeof idx !== "number") return;
      const activeView = win.pageViews[pid]?.[idx];
      if (!activeView || !activeView.webContents || activeView.webContents.isDestroyed()) return;
      try { activeView.webContents.setZoomFactor(globalZoomLevel / 100); } catch (e) {}
      activeView.webContents.loadURL(url);
    } catch (e) {}
  });

ipcMain.on("suspend-hotkeys", () => {
  try { globalShortcut.unregisterAll(); } catch (e) {}
});
ipcMain.on("resume-hotkeys", () => {
  reRegisterHotkeys();
});

ipcMain.on("minimize-window", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.minimize();
});

ipcMain.on("maximize-window", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) {
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  }
});

ipcMain.on("toggle-fullscreen", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.setFullScreen(!win.isFullScreen());
});

  ipcMain.on("zoom-in", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    
  globalZoomLevel = Math.min(globalZoomLevel + 10, 200);
  applyZoomAllWindows();
  debouncedSaveState();
  });

  ipcMain.on("zoom-out", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    
  globalZoomLevel = Math.max(globalZoomLevel - 10, 50);
  applyZoomAllWindows();
  debouncedSaveState();
  });

ipcMain.on("new-window", () => createWindow());

  ipcMain.on("add-page", () => {
  addPageGlobal();
  });

  ipcMain.on("switch-page", (event, pageId) => {
    const win = BrowserWindow.fromWebContents(event.sender);
  switchToPage(win, pageId);
  });

  ipcMain.on("add-tab", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
  addTabToCurrentPage(win, true);
    try { win.focus(); } catch (e) {}
    try { win.moveTop(); } catch (e) {}
  });

  ipcMain.on("delete-tab", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
  activateDeleteMode(win);
  });
ipcMain.on("rename-page", (_event, pageId, newName) => {
  try {
    const p = pages.find(pp => pp.id === pageId);
    if (!p) return;
    const trimmed = String(newName || "").trim();
    if (trimmed.length === 0) return;
    p.name = trimmed;
    windows.forEach(w => {
      sendToHeader(w, "update-pages", pagesWithTabsFor(w));
    });
    debouncedSaveState();
  } catch (e) {}
});
ipcMain.on("reorder-pages", (_event, sourceId, targetId) => {
  try {
    const sIdx = pages.findIndex(p => p.id === sourceId);
    const tIdx = pages.findIndex(p => p.id === targetId);
    if (sIdx < 0 || tIdx < 0 || sIdx === tIdx) return;
    const [moved] = pages.splice(sIdx, 1);
    pages.splice(tIdx, 0, moved);
    windows.forEach(w => {
      sendToHeader(w, "update-state", {
        pages: pagesWithTabsFor(w),
        currentPage: w.currentPage,
        zoomLevel: globalZoomLevel,
        isMaximized: w.isMaximized()
      });
      updateHeaderTabState(w);
    });
    debouncedSaveState();
  } catch (e) {}
});
ipcMain.on("reorder-pages-index", (_event, sourceId, targetIndex) => {
  try {
    const sIdx = pages.findIndex(p => p.id === sourceId);
    if (sIdx < 0) return;
    let tIdx = Math.max(0, Math.min(Number(targetIndex) || 0, pages.length));
    const [moved] = pages.splice(sIdx, 1);
    if (tIdx > sIdx) tIdx = Math.max(0, tIdx - 1);
    pages.splice(tIdx, 0, moved);
    windows.forEach(w => {
      sendToHeader(w, "update-state", {
        pages: pagesWithTabsFor(w),
        currentPage: w.currentPage,
        zoomLevel: globalZoomLevel,
        isMaximized: w.isMaximized()
      });
      updateHeaderTabState(w);
    });
    debouncedSaveState();
  } catch (e) {}
});
// Cancel delete mode
ipcMain.on("cancel-delete-mode", (event) => {
  const win = windowForSender(event.sender);
  if (!win || win.isDestroyed() || !win.deleteModeWindow) return;
  cancelDeleteModeForWindow(win);
});

// Delete specific tab
ipcMain.on("delete-specific-tab", (event, tabIndex) => {
  const win = windowForSender(event.sender);
  if (!win || win.isDestroyed() || !win.deleteModeWindow) return;
  
  const currentPageId = win.currentPage;
  const currentTabCount = win.pageTabs[currentPageId] || 4;
  
  // Validate tab index
  if (tabIndex < 0 || tabIndex >= currentTabCount) return;
  
  if (currentTabCount <= 1) {
    cancelDeleteModeForWindow(win);
    if ((pages || []).length === 1) {
      showPopup(win, "show-confirm-close", currentPageId);
    } else {
      showPopup(win, "show-confirm", currentPageId);
    }
    return;
  }
  
  cancelDeleteModeForWindow(win);
  
  // Remove the tab by shifting all tabs after it
  const views = win.pageViews[currentPageId];
  
  // Shift all tabs after the deleted one
  for (let i = tabIndex; i < currentTabCount - 1; i++) {
    if (views[i] && views[i + 1]) {
      const nextUrl = views[i + 1].webContents.getURL();
      views[i].webContents.loadURL(nextUrl);
    }
  }
  
  // Hide the last tab
  if (views[currentTabCount - 1]) {
    views[currentTabCount - 1].setBounds({ x: 0, y: 0, width: 0, height: 0 });
  }
  
  // Update tab count
  win.pageTabs[currentPageId] = currentTabCount - 1;
  
  const pagesWithTabs = pages.map(p => ({ ...p, tabs: win.pageTabs[p.id] || 4 }));
  sendToHeader(win, "update-pages", pagesWithTabs);
  
  setTimeout(() => {
    if (!win.isDestroyed()) win.emit("resize");
  }, 50);
  
  debouncedSaveState();
  updateHeaderTabState(win);
});

// Open search box
  ipcMain.on("open-search", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
  
  if (win.isFullScreen()) win.focus();
  openSearchOverlay(win);
    try { win.moveTop(); } catch (e) {}
  });
  ipcMain.on("open-settings", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed() || !win.settingsWindow) return;
    try { win.focus(); } catch (e) {}
    try {
      if (!win.settingsWindow.isDestroyed()) {
        win.settingsWindow.show();
        win.settingsWindow.webContents.send("settings-data", settings);
        win.settingsWindow.setIgnoreMouseEvents(false);
      }
    } catch (e) {}
    try { win.moveTop(); } catch (e) {}
  });
  function normalizeHotkeysOnSave(oldHotkeys, newHotkeys) {
    try {
      const changed = new Set(Object.keys(newHotkeys || {}).filter(k => (oldHotkeys || {})[k] !== newHotkeys[k]));
      const map = {};
      Object.keys(newHotkeys || {}).forEach(k => {
        const acc = newHotkeys[k];
        if (!acc) return;
        if (!map[acc]) map[acc] = [k];
        else map[acc].push(k);
      });
      Object.keys(map).forEach(acc => {
        const actions = map[acc];
        if (actions.length > 1) {
          const winner = actions.find(a => changed.has(a)) || actions[0];
          actions.forEach(a => { if (a !== winner) newHotkeys[a] = ""; });
        }
      });
    } catch (e) {}
  }
  ipcMain.on("save-settings", (event, newSettings) => {
    const win = BrowserWindow.getAllWindows().find(w =>
      !w.isDestroyed() && w.settingsWindow && w.settingsWindow.webContents === event.sender
    );
    if (!win || win.isDestroyed()) return;
    try { normalizeHotkeysOnSave((settings && settings.hotkeys) || {}, (newSettings && newSettings.hotkeys) || {}); } catch (e) {}
    settings = newSettings || settings;
    try {
      if (!win.settingsWindow.isDestroyed()) {
        win.settingsWindow.hide();
        win.settingsWindow.setIgnoreMouseEvents(true);
      }
    } catch (e) {}
    debouncedSaveState();
    reRegisterHotkeys();
    windows.forEach(w => {
      try { if (!w.isDestroyed()) w.emit("resize"); } catch (e) {}
    });
  });
  ipcMain.on("close-settings", (event) => {
    const win = BrowserWindow.getAllWindows().find(w =>
      !w.isDestroyed() && w.settingsWindow && w.settingsWindow.webContents === event.sender
    );
    if (!win || win.isDestroyed()) return;
    try {
      if (!win.settingsWindow.isDestroyed()) {
        win.settingsWindow.hide();
        win.settingsWindow.setIgnoreMouseEvents(true);
      }
    } catch (e) {}
  });



// Handle tab click to set as active
ipcMain.on("tab-clicked", (event, pageId, tabIndex) => {
  windows.forEach(win => {
    if (win.currentPage === pageId) {
      activateTab(win, pageId, tabIndex);
    }
  });
});

// Function to inject click detection into a tab

// Setup navigation listeners to re-inject click detection on page changes
function setupTabNavigationListeners(view, pageId, tabIndex) {
  if (!view || !view.webContents) return;
  if (view.__navListenersSet) return;
  view.__navListenersSet = true;
  try { view.webContents.setMaxListeners(0); } catch (e) {}
  
  const reinject = () => {
    injectClickDetection(view, pageId, tabIndex);
  };
  
  // Inject immediately so selection works right away
  reinject();
  
  // Re-inject on all navigation events for instant responsiveness
  view.webContents.on('dom-ready', reinject);
  view.webContents.on('did-start-loading', reinject);
  view.webContents.on('did-navigate', reinject);
  view.webContents.on('did-navigate-in-page', reinject);
  view.webContents.on('did-finish-load', reinject);
  try {
    view.webContents.on('will-navigate', () => {
      try { view.webContents.setZoomFactor(globalZoomLevel / 100); } catch (e) {}
    });
  } catch (e) {}
  const onFail = (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    try {
      if (!isMainFrame) return;
      if (!validatedURL || validatedURL.startsWith('file://')) return;
      if (errorCode === -3) return;
      const errPage = `file://${__dirname}/error.html?code=${encodeURIComponent(errorCode)}&desc=${encodeURIComponent(errorDescription || '')}&url=${encodeURIComponent(validatedURL || '')}`;
      try { view.webContents.setZoomFactor(globalZoomLevel / 100); } catch (_) {}
      view.webContents.loadURL(errPage);
    } catch (_) {}
  };
  try {
    view.webContents.on('did-fail-load', onFail);
    view.webContents.on('did-fail-provisional-load', onFail);
  } catch (e) {}
}
function injectClickDetection(view, pageId, tabIndex) {
  if (!view || !view.webContents || view.webContents.isDestroyed()) return;
  
  view.webContents.executeJavaScript(`
    (function() {
      try {
        if (window.__clickHandler) {
          document.removeEventListener('click', window.__clickHandler, true);
          document.removeEventListener('mousedown', window.__clickHandler, true);
          document.removeEventListener('pointerdown', window.__clickHandler, true);
          window.removeEventListener('pointerdown', window.__clickHandler, true);
        }
        window.__clickHandler = function() {
          try { window.electronAPI && window.electronAPI.sendTabClicked && window.electronAPI.sendTabClicked(${pageId}, ${tabIndex}); } catch (e) {}
        };
        var opts = { capture: true, passive: true };
        document.addEventListener('pointerdown', window.__clickHandler, opts);
        window.addEventListener('pointerdown', window.__clickHandler, opts);
        document.addEventListener('mousedown', window.__clickHandler, opts);
        document.addEventListener('click', window.__clickHandler, opts);
        document.addEventListener('readystatechange', function() {
          try {
            document.removeEventListener('pointerdown', window.__clickHandler, true);
            document.addEventListener('pointerdown', window.__clickHandler, { capture: true, passive: true });
          } catch (e) {}
        }, { once: true });
      } catch (err) {}
    })();
  `).catch(() => {});
}

// Perform search
ipcMain.on("perform-search", (event, query) => {
  const win = BrowserWindow.getAllWindows().find(w => 
    !w.isDestroyed() && w.searchBoxWindow && 
    w.searchBoxWindow.webContents === event.sender
  );
  
  if (!win || win.isDestroyed()) return;
  
  const targetPageId = win.searchTargetPageId || win.currentPage;
  const targetTabIndex = (typeof win.searchTargetTabIndex === "number") ? win.searchTargetTabIndex : win.activeTabPerPage[targetPageId];
  if (typeof targetTabIndex !== "number") return;
  const activeView = win.pageViews[targetPageId][targetTabIndex];
  
  if (!activeView || !activeView.webContents || activeView.webContents.isDestroyed()) return;
  
  // Determine if query is URL or search term
  let url;
  if (query.startsWith("http://") || query.startsWith("https://")) {
    url = query;
  } else if (query.includes(".") && !query.includes(" ")) {
    url = "https://" + query;
  } else {
    // Use Google search
    url = "https://www.google.com/search?q=" + encodeURIComponent(query);
  }
  
  // Navigate to URL
  try { activeView.webContents.setZoomFactor(globalZoomLevel / 100); } catch (e) {}
  activeView.webContents.loadURL(url);
  
  // Remove highlight
  if (win.searchHighlightCSSKey) {
    activeView.webContents.removeInsertedCSS(win.searchHighlightCSSKey);
    win.searchHighlightCSSKey = null;
  }
});

// Navigate back in active tab
ipcMain.on("navigate-back", (event) => {
  const win = BrowserWindow.getAllWindows().find(w => 
    !w.isDestroyed() && w.searchBoxWindow && 
    w.searchBoxWindow.webContents === event.sender
  );
  
  if (!win || win.isDestroyed()) return;
  
  const currentPageId = win.currentPage;
  const activeTabIndex = win.activeTabPerPage[currentPageId];
  if (typeof activeTabIndex !== "number") return;
  const activeView = win.pageViews[currentPageId]?.[activeTabIndex];
  
  if (activeView && activeView.webContents && !activeView.webContents.isDestroyed()) {
    if (activeView.webContents.navigationHistory.canGoBack()) {
      activeView.webContents.navigationHistory.goBack();
    }
  }
});

// Navigate forward in active tab
ipcMain.on("navigate-forward", (event) => {
  const win = BrowserWindow.getAllWindows().find(w => 
    !w.isDestroyed() && w.searchBoxWindow && 
    w.searchBoxWindow.webContents === event.sender
  );
  
  if (!win || win.isDestroyed()) return;
  
  const currentPageId = win.currentPage;
  const activeTabIndex = win.activeTabPerPage[currentPageId];
  if (typeof activeTabIndex !== "number") return;
  const activeView = win.pageViews[currentPageId]?.[activeTabIndex];
  
  if (activeView && activeView.webContents && !activeView.webContents.isDestroyed()) {
    if (activeView.webContents.navigationHistory.canGoForward()) {
      activeView.webContents.navigationHistory.goForward();
    }
  }
});

// Close search box
ipcMain.on("close-search", (event, clickData) => {
  const win = BrowserWindow.getAllWindows().find(w => 
    !w.isDestroyed() && w.searchBoxWindow && 
    w.searchBoxWindow.webContents === event.sender
  );
  
  if (!win || win.isDestroyed()) return;
  
  try {
    if (!win.searchBoxWindow.isDestroyed()) {
      win.searchBoxWindow.setAlwaysOnTop(false);
      win.searchBoxWindow.hide();
      win.searchBoxWindow.setIgnoreMouseEvents(true);
    }
    
    // Remove highlight from active tab
    const targetPageId = win.searchTargetPageId || win.currentPage;
    const targetTabIndex = (typeof win.searchTargetTabIndex === "number") ? win.searchTargetTabIndex : win.activeTabPerPage[targetPageId];
    const activeView = (typeof targetTabIndex === "number") ? win.pageViews[targetPageId]?.[targetTabIndex] : undefined;
    
    if (activeView && activeView.webContents && !activeView.webContents.isDestroyed() && win.searchHighlightCSSKey) {
      activeView.webContents.removeInsertedCSS(win.searchHighlightCSSKey).catch(() => {});
      win.searchHighlightCSSKey = null;
    }
    win.searchTargetPageId = undefined;
    win.searchTargetTabIndex = undefined;
    
    if (clickData && clickData.clickX !== undefined && clickData.clickY !== undefined) {
      const views = win.pageViews[targetPageId];
      let clickedIndex = null;
      views.forEach((v, i) => {
        const b = v.getBounds();
        const x = clickData.clickX;
        const y = clickData.clickY;
        if (x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height) {
          if (clickedIndex === null) clickedIndex = i;
        }
      });
      if (clickedIndex !== null && clickedIndex !== targetTabIndex) {
        activateTab(win, targetPageId, clickedIndex);
      }
    }
    try { win.focus(); } catch (e) {}
    try { win.moveTop(); } catch (e) {}
  } catch (err) {
    console.error("Error closing search:", err);
  }
});


ipcMain.on("show-confirm-popup", (event, pageId) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  
  if (pages.length === 1) {
    showPopup(win, "show-confirm-close", pageId);
    return;
  }
  
  showPopup(win, "show-confirm", pageId);
});

ipcMain.on("delete-page-from-popup", (event, pageId) => {
  if (pages.length === 1) return;
  
  // Clear session storage
  const pageToDelete = pages.find(p => p.id === pageId);
  if (pageToDelete) {
    const targetSession = session.fromPartition(pageToDelete.sessionId);
    targetSession.clearStorageData(); 
    targetSession.clearCache();
  }
  const pageNum = pageToDelete?.id;
  if (pageNum) deletedPageNumbers.push(pageNum);
  
  // Remove and destroy views from all windows
  windows.forEach(win => {
    const viewsToDestroy = win.pageViews[pageId];
    if (viewsToDestroy) {
      viewsToDestroy.forEach(view => {
        try {
          win.removeBrowserView(view);
          if (view.webContents && !view.webContents.isDestroyed()) {
            view.webContents.destroy();
          }
        } catch (err) {}
      });
      delete win.pageViews[pageId];
      delete win.pageTabs[pageId];
      if (win.activeTabPerPage) {
        delete win.activeTabPerPage[pageId];
      }
    }
  });
  
  pages = pages.filter(p => p.id !== pageId);
  
  // Update all windows
  windows.forEach(win => {
    if (win.currentPage === pageId) {
      win.currentPage = pages[0].id;
      
      // Remove all current views
      Object.keys(win.pageViews).forEach(pid => {
        if (win.pageViews[pid]) {
          win.pageViews[pid].forEach(view => {
            try {
              win.removeBrowserView(view);
            } catch (err) {}
          });
        }
      });
      
      // Add first page's views
      const firstPageViews = win.pageViews[pages[0].id];
      if (firstPageViews) {
        firstPageViews.forEach(view => {
          try {
            win.addBrowserView(view);
          } catch (err) {}
        });
      }
      
      // Re-add header
      try {
        win.removeBrowserView(win.headerView);
        win.addBrowserView(win.headerView);
      } catch (err) {}
      
      setTimeout(() => {
        if (!win.isDestroyed()) win.emit("resize");
      }, 100);
    }
    
    const pagesWithTabs = pages.map(p => ({ ...p, tabs: win.pageTabs[p.id] || 4 }));
    
    sendToHeader(win, "update-state", {
      pages: pagesWithTabs,
      currentPage: win.currentPage,
      zoomLevel: globalZoomLevel,
      isMaximized: win.isMaximized()
    });
    updateHeaderTabState(win);
    
    try {
      if (!win.popupWindow.isDestroyed()) win.popupWindow.hide();
    } catch (err) {}
  });
  
  debouncedSaveState();
});

ipcMain.on("confirm-close-app", (_event, pageId) => {
  try {
    const pageToDelete = pages.find(p => p.id === pageId);
    if (pageToDelete) {
      const targetSession = session.fromPartition(pageToDelete.sessionId);
      try { targetSession.clearStorageData(); } catch (_) {}
      try { targetSession.clearCache(); } catch (_) {}
      const pageNum = pageToDelete.id;
      if (pageNum) deletedPageNumbers.push(pageNum);
    }
    pages = pages.filter(p => p.id !== pageId);
  } catch (_) {}
  try { saveState(); } catch (_) {}
  try { app.quit(); } catch (_) {}
});

ipcMain.on("set-popup-mouse-events", (event, enable) => {
  const popupWin = BrowserWindow.fromWebContents(event.sender);
  if (!popupWin || popupWin.isDestroyed()) return;

  if (enable) {
    popupWin.setIgnoreMouseEvents(false);
  } else {
    popupWin.setIgnoreMouseEvents(true);
    popupWin.hide();
    try {
      const parent = typeof popupWin.getParentWindow === "function" ? popupWin.getParentWindow() : null;
      if (parent && !parent.isDestroyed()) {
        try { parent.focus(); } catch (e) {}
        try { parent.moveTop(); } catch (e) {}
      }
    } catch (e) {}
  }
});
// Navigate back from header button
ipcMain.on("navigate-back-header", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed() || !win.currentPage) return;
  
  const currentPageId = win.currentPage;
  const activeTabIndex = win.activeTabPerPage[currentPageId];
  if (typeof activeTabIndex !== "number") return;
  const activeView = win.pageViews[currentPageId]?.[activeTabIndex];
  
  if (activeView && activeView.webContents && !activeView.webContents.isDestroyed()) {
    if (activeView.webContents.navigationHistory.canGoBack()) {
      activeView.webContents.navigationHistory.goBack();
    }
  }
});

// Navigate forward from header button
ipcMain.on("navigate-forward-header", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed() || !win.currentPage) return;
  
  const currentPageId = win.currentPage;
  const activeTabIndex = win.activeTabPerPage[currentPageId];
  if (typeof activeTabIndex !== "number") return;
  const activeView = win.pageViews[currentPageId]?.[activeTabIndex];
  
  if (activeView && activeView.webContents && !activeView.webContents.isDestroyed()) {
    if (activeView.webContents.navigationHistory.canGoForward()) {
      activeView.webContents.navigationHistory.goForward();
    }
  }
});
