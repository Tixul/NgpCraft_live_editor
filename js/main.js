// Entry point: boot the project, render the tree, wire editor + interpreter + VDP.

(() => {
  const codeEl     = document.getElementById('code');
  const codeHlEl   = document.getElementById('code-hl');
  const codeGutterEl = document.getElementById('code-gutter');
  const editorWrap = document.querySelector('.editor-wrap');
  const canvasEl   = document.getElementById('screen');
  const statusEl   = document.getElementById('status');
  const fpsStatusEl = document.getElementById('fps-status');
  const logEl      = document.getElementById('log');
  const runBtn     = document.getElementById('run-btn');
  const pauseBtn   = document.getElementById('pause-btn');
  const stepBtn    = document.getElementById('step-btn');
  const resetBtn   = document.getElementById('reset-btn');
  const helpBtn    = document.getElementById('help-btn');
  const helpPopover = document.getElementById('help-popover');
  const liveToggle = document.getElementById('live-toggle');
  const autocompleteToggle = document.getElementById('autocomplete-toggle');
  const zoomSel    = document.getElementById('screen-zoom');
  const logFilterInfo  = document.getElementById('log-filter-info');
  const logFilterErr   = document.getElementById('log-filter-err');
  const logFilterAudio = document.getElementById('log-filter-audio');
  const logClearBtn    = document.getElementById('log-clear-btn');
  const treeEl     = document.getElementById('tree');
  const tabsListEl = document.getElementById('tabs-list');

  const ctx = canvasEl.getContext('2d');
  ctx.imageSmoothingEnabled = false;

  // Pipe ngpc_log_* from runtime into the HTML log pane.
  NGPC_Runtime._setHostLog((msg) => log(msg, 'info'));
  // Palette byte-access warning goes to the log as an error.
  NGPC_Memory.setPaletteWarnSink((msg) => log(msg, 'err'));
  // Generic hardware-fidelity warnings (ROM / read-only writes, invalid
  // viewport, etc.) — same sink so the student sees them in-editor.
  NGPC_Memory.setHwWarnSink((msg) => log(msg, 'err'));

  // ---- Debug panel (CPU / watchdog / sprite character-over) -------------
  const cpuFillEl    = document.getElementById('cpu-fill');
  const cpuValueEl   = document.getElementById('cpu-value');
  const wdFillEl     = document.getElementById('wd-fill');
  const wdValueEl    = document.getElementById('wd-value');
  const charOverEl   = document.getElementById('char-over-value');
  // Real NGPC hardware resets within ~100 ms if HW_WATCHDOG isn't written
  // 0x4E — the NgpCraft template's VBI pets every frame (16.67 ms), so
  // three-frame slack is already generous and ten-frame (~167 ms) is a
  // firm upper bound where silicon would have reset. The previous 90-frame
  // (1.5 s) value let code drift well past what hardware tolerates
  // (HW_REGISTERS.md §2 — "ld (0x006f),0x4e au debut VBL").
  const WATCHDOG_WARN_FRAMES  = 3;
  const WATCHDOG_RESET_FRAMES = 10;
  let watchdogReset = false;

  function updateDebugPanel() {
    const s = NGPC_Memory.getStats();
    const pct = Math.min(100, (s.opsThisFrame / s.FRAME_BUDGET) * 100);
    cpuFillEl.style.width = `${Math.min(100, pct).toFixed(1)}%`;
    cpuFillEl.classList.toggle('warn', pct >= 70 && pct < 100);
    cpuFillEl.classList.toggle('over', pct >= 100);
    cpuValueEl.textContent = `${s.opsThisFrame} / ${s.FRAME_BUDGET}`;
    cpuValueEl.classList.toggle('over', pct >= 100);
    if (pct >= 100) log(
      `CPU budget exceeded: ${s.opsThisFrame} memory ops (hw limit ~${s.FRAME_BUDGET}). ` +
      `On real NGPC, main loop would miss VBlank here.`, 'err');

    const wdPct = Math.min(100, (s.watchdogLastPet / WATCHDOG_RESET_FRAMES) * 100);
    wdFillEl.style.width = `${wdPct.toFixed(1)}%`;
    wdFillEl.classList.toggle('warn', s.watchdogLastPet >= WATCHDOG_WARN_FRAMES);
    wdFillEl.classList.toggle('over', s.watchdogLastPet >= WATCHDOG_RESET_FRAMES);
    wdValueEl.textContent = `${s.watchdogLastPet} frames since pet`;
    wdValueEl.classList.toggle('over', s.watchdogLastPet >= WATCHDOG_RESET_FRAMES);
    if (s.watchdogLastPet >= WATCHDOG_RESET_FRAMES && !watchdogReset) {
      watchdogReset = true;
      log(
        `Watchdog expired (${s.watchdogLastPet} frames without HW_WATCHDOG = 0x4E). ` +
        `Real NGPC hardware would have reset here — call ngpc_vsync() in your ` +
        `main loop, it pets the watchdog via the VBI handler.`, 'err');
      setStatus('Watchdog reset (halted)', 'err');
      cancelLoop();
    }

    const charOver = NGPC_Memory.read8(0x8010) & 0x80;
    charOverEl.textContent = charOver ? 'CHAR_OVR set' : 'ok';
    charOverEl.classList.toggle('over', !!charOver);

    updatePaletteInspector();
  }

  function resetDebugPanel() {
    watchdogReset = false;
    cpuFillEl.style.width = '0%';
    cpuValueEl.textContent = '—';
    wdFillEl.style.width = '0%';
    wdValueEl.textContent = '—';
    charOverEl.textContent = '—';
    for (const el of [cpuFillEl, cpuValueEl, wdFillEl, wdValueEl, charOverEl]) {
      el.classList.remove('warn', 'over');
    }
  }

  // ---- Palette inspector --------------------------------------------------
  // Draw the 16 palettes × 4 colours of each plane as a live 2D grid. Each
  // palette takes a column of 4 swatches (8×8 px per swatch), so a plane = 16
  // columns × 4 rows = 128×32 px. The BG palette is a single strip of 8 entries.
  const palCtx = {
    scr1: document.getElementById('pal-scr1').getContext('2d'),
    scr2: document.getElementById('pal-scr2').getContext('2d'),
    spr:  document.getElementById('pal-spr').getContext('2d'),
    bg:   document.getElementById('pal-bg').getContext('2d'),
  };
  for (const ctx of Object.values(palCtx)) ctx.imageSmoothingEnabled = false;

  function rgb444ToCss(packed) {
    const r = (packed & 0x00F) * 17;
    const g = ((packed >>> 4) & 0x0F) * 17;
    const b = ((packed >>> 8) & 0x0F) * 17;
    return `rgb(${r},${g},${b})`;
  }

  function drawPaletteGrid(ctx, baseAddr, paletteCount) {
    const SWATCH = 8;
    for (let pal = 0; pal < paletteCount; pal++) {
      for (let col = 0; col < 4; col++) {
        const packed = NGPC_Memory.read16(baseAddr + (pal * 4 + col) * 2);
        ctx.fillStyle = rgb444ToCss(packed);
        ctx.fillRect(pal * SWATCH, col * SWATCH, SWATCH, SWATCH);
      }
    }
  }

  function drawBgPaletteStrip(ctx, baseAddr) {
    const SWATCH = 8;
    for (let i = 0; i < 8; i++) {
      const packed = NGPC_Memory.read16(baseAddr + i * 2);
      ctx.fillStyle = rgb444ToCss(packed);
      ctx.fillRect(i * SWATCH, 0, SWATCH, SWATCH);
    }
  }

  function updatePaletteInspector() {
    // Caller (advance) wraps the full updateDebugPanel + render in host
    // ops, so these reads don't count against the user CPU budget.
    drawPaletteGrid(palCtx.scr1, 0x8280, 16);
    drawPaletteGrid(palCtx.scr2, 0x8300, 16);
    drawPaletteGrid(palCtx.spr,  0x8200, 16);
    drawBgPaletteStrip(palCtx.bg, 0x83E0);
  }

  // ?frames=N caps the generator loop at N frames (for automated screenshots
  // and sanity checks). Default: unlimited.
  const params = new URLSearchParams(window.location.search);
  const frameCap = parseInt(params.get('frames'), 10) || Infinity;

  let debounceTimer = null;
  let activePath = null;
  let rafId = null;

  // ---- Keyboard -> HW_JOYPAD ---------------------------------------------
  //
  // Real NGPC joypad state lives at 0x6F82. We mirror the held bitmask here
  // based on keydown/keyup events. `ngpc_input_update` reads this address
  // each frame to compute edges. The user can customize the bindings via the
  // keymap panel (settings persist in localStorage).
  const PAD_BUTTONS = [
    { bit: 0x01, label: 'UP' },
    { bit: 0x02, label: 'DOWN' },
    { bit: 0x04, label: 'LEFT' },
    { bit: 0x08, label: 'RIGHT' },
    { bit: 0x10, label: 'A' },
    { bit: 0x20, label: 'B' },
    { bit: 0x40, label: 'OPTION' },
  ];
  const DEFAULT_BINDINGS = {
    0x01: ['ArrowUp', 'w'],
    0x02: ['ArrowDown', 's'],
    0x04: ['ArrowLeft', 'a'],
    0x08: ['ArrowRight', 'd'],
    0x10: ['z', ' '],
    0x20: ['x', 'Shift'],
    0x40: ['Enter'],
  };
  const STORAGE_KEY = 'ngpc-live-editor.keymap.v1';

  // bindings: { padBit: string[] } — multiple keys per pad button allowed.
  let bindings = loadBindings();
  // Reverse map rebuilt from bindings: key -> padBit. Updated when bindings change.
  let keyToPad = {};
  rebuildKeyToPad();

  function loadBindings() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (_) { /* corrupt storage, fall through */ }
    return JSON.parse(JSON.stringify(DEFAULT_BINDINGS));
  }
  function saveBindings() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(bindings)); }
    catch (_) { /* ignored */ }
  }
  function rebuildKeyToPad() {
    keyToPad = {};
    for (const [bit, keys] of Object.entries(bindings)) {
      for (const k of keys) keyToPad[k] = parseInt(bit, 10);
    }
  }

  let padState = 0;
  function updatePadFromKey(e, down) {
    const bit = keyToPad[e.key];
    if (bit === undefined) return;
    if (down) padState |= bit; else padState &= ~bit;
    NGPC_Memory.write8(0x6F82, padState);
    e.preventDefault();
  }
  window.addEventListener('keydown', (e) => {
    if (document.activeElement === codeEl) return;
    if (rebindCapture) { captureRebind(e); return; }
    updatePadFromKey(e, true);
  });
  window.addEventListener('keyup', (e) => {
    if (document.activeElement === codeEl) return;
    updatePadFromKey(e, false);
  });

  // ---- Keymap panel UI ---------------------------------------------------
  const keymapRowsEl = document.getElementById('keymap-rows');
  const keymapResetBtn = document.getElementById('keymap-reset');
  let rebindCapture = null; // { bit, btnEl } when listening for a new key

  function displayKey(k) {
    if (k === ' ') return 'Space';
    if (k === 'ArrowUp')    return '↑';
    if (k === 'ArrowDown')  return '↓';
    if (k === 'ArrowLeft')  return '←';
    if (k === 'ArrowRight') return '→';
    return k;
  }

  function renderKeymap() {
    keymapRowsEl.innerHTML = '';
    for (const { bit, label } of PAD_BUTTONS) {
      const tr = document.createElement('tr');
      const tdName = document.createElement('td'); tdName.className = 'pad-name'; tdName.textContent = label;
      const tdKeys = document.createElement('td'); tdKeys.className = 'keys-list';
      const keys = bindings[bit] || [];
      for (const k of keys) {
        const chip = document.createElement('span');
        chip.className = 'key-chip';
        chip.textContent = displayKey(k);
        chip.title = `Click to unbind "${k}"`;
        chip.addEventListener('click', () => {
          bindings[bit] = (bindings[bit] || []).filter(x => x !== k);
          saveBindings(); rebuildKeyToPad(); renderKeymap();
        });
        tdKeys.appendChild(chip);
      }
      const tdBtn = document.createElement('td');
      const btn = document.createElement('button');
      btn.className = 'rebind-btn';
      btn.type = 'button';
      btn.textContent = '+ Add key';
      btn.addEventListener('click', () => {
        if (rebindCapture) rebindCapture.btnEl.classList.remove('listening');
        if (rebindCapture && rebindCapture.bit === bit) { rebindCapture = null; return; }
        rebindCapture = { bit, btnEl: btn };
        btn.classList.add('listening');
        btn.textContent = 'Press a key…';
      });
      tdBtn.appendChild(btn);
      tr.append(tdName, tdKeys, tdBtn);
      keymapRowsEl.appendChild(tr);
    }
  }

  function captureRebind(e) {
    e.preventDefault();
    if (e.key === 'Escape') { // cancel
      rebindCapture.btnEl.classList.remove('listening');
      rebindCapture = null;
      renderKeymap();
      return;
    }
    const { bit } = rebindCapture;
    if (!bindings[bit]) bindings[bit] = [];
    if (!bindings[bit].includes(e.key)) bindings[bit].push(e.key);
    rebindCapture.btnEl.classList.remove('listening');
    rebindCapture = null;
    saveBindings();
    rebuildKeyToPad();
    renderKeymap();
  }

  keymapResetBtn.addEventListener('click', () => {
    bindings = JSON.parse(JSON.stringify(DEFAULT_BINDINGS));
    saveBindings();
    rebuildKeyToPad();
    renderKeymap();
  });

  renderKeymap();

  function setStatus(msg, kind = '') {
    statusEl.textContent = msg;
    statusEl.className = 'status ' + kind;
  }

  // Each log line is a <span class="log-line log-<kind>"> so CSS classes
  // toggled on #log (`hide-info`, `hide-err`, `hide-audio`) can filter
  // without rebuilding the DOM. `audio` is a computed kind — routed here
  // from runtime.js `[sfx] …` / `[bgm] …` prefixes so they can be muted
  // separately from ngpc_log_* output.
  function detectAudioKind(msg, kind) {
    if (kind === 'err') return kind;
    if (typeof msg === 'string' && /^\[(sfx|bgm|audio)\]/.test(msg)) return 'audio';
    return kind || 'info';
  }
  function log(msg, kind = '') {
    const realKind = detectAudioKind(msg, kind);
    const line = document.createElement('span');
    line.className = `log-line log-${realKind}`;
    line.textContent = msg + '\n';
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
  }
  function clearLog() { logEl.textContent = ''; }

  /* Wire the log filter chips — CSS handles the actual hide/show via
   * `#log.hide-<kind> .log-<kind> { display: none; }`. */
  function syncLogFilters() {
    logEl.classList.toggle('hide-info',  !logFilterInfo.checked);
    logEl.classList.toggle('hide-err',   !logFilterErr.checked);
    logEl.classList.toggle('hide-audio', !logFilterAudio.checked);
  }
  [logFilterInfo, logFilterErr, logFilterAudio].forEach(el =>
    el.addEventListener('change', syncLogFilters));
  logClearBtn.addEventListener('click', clearLog);
  syncLogFilters();

  /* Gutter line numbers. Builds a "1\n2\n…\nN" string, widens the gutter if
   * the line count crosses the 3-digit mark. Scroll position is kept in
   * sync with the textarea (pure JS because the gutter is a separate
   * <pre>). */
  function refreshGutter() {
    const lines = codeEl.value.split('\n').length;
    const out = new Array(lines);
    for (let i = 0; i < lines; i++) out[i] = String(i + 1);
    codeGutterEl.textContent = out.join('\n') + '\n';
    const width = lines >= 100 ? '4em' : '3.5em';
    codeGutterEl.style.width = width;
    codeHlEl.style.left = width;
    codeEl.style.left   = width;
    codeHlEl.style.width = `calc(100% - ${width})`;
    codeEl.style.width   = `calc(100% - ${width})`;
  }
  function syncGutterScroll() {
    codeGutterEl.scrollTop = codeEl.scrollTop;
  }

  /* Screen zoom — pure CSS resize of the <canvas>, persisted. The emulated
   * 160x152 framebuffer is unchanged; only the DOM pixel size scales. */
  const ZOOM_KEY = 'ngpc-live-editor.zoom.v1';
  function applyZoom(n) {
    const scale = Math.max(1, Math.min(8, n | 0));
    canvasEl.style.width  = (160 * scale) + 'px';
    canvasEl.style.height = (152 * scale) + 'px';
    try { localStorage.setItem(ZOOM_KEY, String(scale)); } catch (_) {}
  }
  try {
    const savedZoom = parseInt(localStorage.getItem(ZOOM_KEY) || '3', 10);
    if (savedZoom >= 1 && savedZoom <= 8) zoomSel.value = String(savedZoom);
  } catch (_) {}
  zoomSel.addEventListener('change', () => applyZoom(parseInt(zoomSel.value, 10)));
  applyZoom(parseInt(zoomSel.value, 10));

  /* Help popover toggle. Outside-click and Esc dismiss. */
  function toggleHelp(force) {
    const show = force === undefined ? helpPopover.hidden : !!force;
    helpPopover.hidden = !show;
  }
  helpBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleHelp();
  });
  document.addEventListener('click', (e) => {
    if (!helpPopover.hidden && !helpPopover.contains(e.target) && e.target !== helpBtn) {
      toggleHelp(false);
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !helpPopover.hidden) toggleHelp(false);
  });

  // ---- File tree rendering ----
  function renderTree() {
    const root = NGPC_Project.buildTree();
    treeEl.innerHTML = '';
    for (const child of root.children) {
      treeEl.appendChild(renderNode(child, 0));
    }
  }
  function renderNode(node, depth) {
    const wrap = document.createElement('div');
    wrap.className = 'tree-node';

    const row = document.createElement('div');
    row.className = 'tree-row';
    row.dataset.path = node.path;
    row.style.paddingLeft = `${0.3 + depth * 0.9}rem`;

    const caret = document.createElement('span');
    caret.className = 'tree-caret';
    const icon = document.createElement('span');
    icon.className = 'tree-icon ' + (node.isFile ? 'file' : 'folder');

    if (node.isFile) {
      caret.textContent = ' ';
      icon.textContent = '📄';
      row.addEventListener('click', (ev) => {
        if (ev.target.classList.contains('tree-delete')) return;
        openFile(node.path);
      });
    } else {
      caret.textContent = '▾';
      icon.textContent = '📁';
      row.addEventListener('click', () => {
        const children = wrap.querySelector('.tree-children');
        if (!children) return;
        const collapsed = children.classList.toggle('collapsed');
        caret.textContent = collapsed ? '▸' : '▾';
      });
    }

    const label = document.createElement('span');
    label.textContent = node.name;
    row.append(caret, icon, label);

    // User-created files get a small delete button on hover.
    if (node.isFile && node.meta && node.meta.userCreated) {
      const del = document.createElement('button');
      del.className = 'tree-delete';
      del.type = 'button';
      del.textContent = '×';
      del.title = `Delete ${node.path}`;
      del.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (!confirm(`Delete ${node.path}?`)) return;
        NGPC_Project.removeFile(node.path);
        // Remove the deleted path from the open tabs list too (closeTab
        // would re-assert an active tab, but we already handle that below).
        const idx = openTabs.indexOf(node.path);
        if (idx >= 0) openTabs.splice(idx, 1);
        lastRunContent.delete(node.path);
        if (activePath === node.path) {
          const entry = NGPC_Project.entryFile();
          const next = openTabs[0] || entry;
          if (next) openFile(next);
        } else {
          renderTabs();
          persistTabs();
        }
        renderTree();
        runEntry();
      });
      row.appendChild(del);
    }
    wrap.appendChild(row);

    if (!node.isFile && node.children.length) {
      const children = document.createElement('div');
      children.className = 'tree-children';
      for (const child of node.children) {
        children.appendChild(renderNode(child, depth + 1));
      }
      wrap.appendChild(children);
    }
    return wrap;
  }

  function markActiveRow(path) {
    treeEl.querySelectorAll('.tree-row').forEach(r => {
      r.classList.toggle('active', r.dataset.path === path);
    });
  }

  // ---- Editor ↔ file binding ----
  function refreshHighlight() {
    codeHlEl.innerHTML = NGPC_Highlight.tokenize(codeEl.value) + '\n';
    refreshGutter();
  }

  function syncScroll() {
    codeHlEl.scrollTop = codeEl.scrollTop;
    codeHlEl.scrollLeft = codeEl.scrollLeft;
    syncGutterScroll();
  }

  // ---- Multi-tab editor state ----
  //
  // `openTabs` is an ordered list of open file paths; `activePath` is the
  // one currently in the <textarea>. Both are persisted to localStorage
  // so a reload restores exactly the buffers the user had open. Dirty
  // tracking compares the current file content against the snapshot taken
  // at the last successful Run — so the yellow dot means "this buffer
  // hasn't been executed yet".
  const TABS_KEY = 'ngpc-live-editor.tabs.v1';
  const openTabs = [];
  const lastRunContent = new Map();   // path -> string at last successful run

  function persistTabs() {
    try {
      localStorage.setItem(TABS_KEY, JSON.stringify({
        open: openTabs,
        active: activePath,
      }));
    } catch (_) { /* storage unavailable */ }
  }
  function restoreTabs() {
    try {
      const raw = localStorage.getItem(TABS_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.open)) return null;
      return parsed;
    } catch (_) { return null; }
  }

  function tabIsDirty(path) {
    const f = NGPC_Project.getFile(path);
    if (!f || !f.editable) return false;
    if (!lastRunContent.has(path)) return false;
    return lastRunContent.get(path) !== f.content;
  }

  function renderTabs() {
    tabsListEl.innerHTML = '';
    for (const path of openTabs) {
      const f = NGPC_Project.getFile(path);
      if (!f) continue;                 // file was deleted while open
      const tab = document.createElement('div');
      tab.className = 'tab';
      tab.dataset.path = path;
      tab.setAttribute('role', 'tab');
      if (path === activePath) tab.classList.add('active');
      if (tabIsDirty(path))   tab.classList.add('dirty');

      const parts = path.split('/');
      const base = parts.pop();
      const dir = parts.length ? parts.join('/') + '/' : '';

      const dirty = document.createElement('span');
      dirty.className = 'tab-dirty';
      dirty.textContent = '●';
      dirty.title = 'Modified since the last successful Run';
      tab.appendChild(dirty);

      const name = document.createElement('span');
      name.className = 'tab-name';
      name.innerHTML =
        (dir ? `<span class="tab-name-dir">${dir}</span>` : '') +
        `<span class="tab-name-basename">${base}</span>`;
      tab.appendChild(name);

      if (!f.editable) {
        const badge = document.createElement('span');
        badge.className = 'tab-badge';
        badge.textContent = 'readonly';
        tab.appendChild(badge);
      }

      const close = document.createElement('button');
      close.className = 'tab-close';
      close.type = 'button';
      close.textContent = '×';
      close.title = 'Close tab';
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        closeTab(path);
      });
      tab.appendChild(close);

      tab.addEventListener('click', () => { if (path !== activePath) openFile(path); });
      // Middle-click also closes, matching most editors.
      tab.addEventListener('mousedown', (e) => {
        if (e.button === 1) { e.preventDefault(); closeTab(path); }
      });
      tabsListEl.appendChild(tab);
    }
    // Ensure the active tab stays visible.
    const active = tabsListEl.querySelector('.tab.active');
    if (active) active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function refreshTabsOnly() {
    // Re-run renderTabs without touching the editor content — used when
    // only dirty state changes.
    renderTabs();
  }

  function openFile(path) {
    const f = NGPC_Project.getFile(path);
    if (!f) return;
    activePath = path;
    if (!openTabs.includes(path)) openTabs.push(path);
    codeEl.value = f.content;
    codeEl.readOnly = !f.editable;
    editorWrap.classList.toggle('readonly', !f.editable);
    refreshHighlight();
    syncScroll();
    markActiveRow(path);
    renderTabs();
    persistTabs();
  }

  function closeTab(path) {
    const idx = openTabs.indexOf(path);
    if (idx < 0) return;
    openTabs.splice(idx, 1);
    if (path === activePath) {
      // Fall back to the neighbor on the left, or the first remaining tab,
      // or re-open the entry file so the editor is never empty.
      const next = openTabs[idx - 1] || openTabs[0] || NGPC_Project.entryFile();
      if (next) openFile(next);
      else {
        activePath = null;
        codeEl.value = '';
        renderTabs();
        persistTabs();
      }
    } else {
      renderTabs();
      persistTabs();
    }
  }

  function cycleTab(direction) {
    if (openTabs.length < 2) return;
    const cur = openTabs.indexOf(activePath);
    const next = (cur + direction + openTabs.length) % openTabs.length;
    openFile(openTabs[next]);
  }

  codeEl.addEventListener('input', () => {
    if (!activePath) return;
    refreshHighlight();
    NGPC_Project.setContent(activePath, codeEl.value);
    refreshTabsOnly();                 // dirty dot updates live
    if (!liveToggle.checked) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(runEntry, 250);
  });
  codeEl.addEventListener('scroll', syncScroll);

  codeEl.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      runEntry();
    }
    // Ctrl+Tab / Ctrl+Shift+Tab cycle between open editor tabs. Browsers
    // reserve these for their own tab switcher, but pressing Ctrl+Tab
    // while the textarea is focused does reach us — we preventDefault so
    // the browser's own handler can't also fire.
    if (e.ctrlKey && !e.altKey && !e.metaKey && e.key === 'Tab') {
      e.preventDefault();
      cycleTab(e.shiftKey ? -1 : 1);
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      const { selectionStart: s, selectionEnd: t, value } = codeEl;
      codeEl.value = value.slice(0, s) + '    ' + value.slice(t);
      codeEl.selectionStart = codeEl.selectionEnd = s + 4;
      codeEl.dispatchEvent(new Event('input'));
    }
  });

  runBtn.addEventListener('click', runEntry);

  // Pause / step-frame / reset buttons. Only meaningful while a generator
  // loop is active (paused === false means the rAF step() is running); all
  // three are no-ops otherwise. Step-frame runs one advance() call even
  // when paused — handy for debugging "what changed on frame N".
  pauseBtn.addEventListener('click', () => {
    if (!currentAdvance) return;
    paused = !paused;
    updatePauseButton();
    updateFpsStatus();
    setStatus(paused ? 'Paused' : 'Running (60 Hz)', 'ok');
  });
  stepBtn.addEventListener('click', () => {
    if (!currentAdvance) return;
    paused = true;
    updatePauseButton();
    try {
      currentAdvance();
    } catch (e) {
      if (e.message !== 'NGPC_SHUTDOWN') {
        log(e.message || String(e), 'err');
        setStatus('Runtime error', 'err');
      }
    }
  });
  resetBtn.addEventListener('click', () => {
    // Cancel any running loop and re-run from a clean memory slate.
    cancelLoop();
    runEntry();
  });

  // Autocomplete: attach to the editor and sync the toolbar toggle to the
  // persisted state. Catalogue comes from js/autocomplete_data.js, UI from
  // js/autocomplete.js. Ctrl+Space inside the editor forces the popup.
  if (typeof NGPC_Autocomplete !== 'undefined') {
    NGPC_Autocomplete.attach(codeEl);
    autocompleteToggle.checked = NGPC_Autocomplete.isEnabled();
    autocompleteToggle.addEventListener('change', () => {
      NGPC_Autocomplete.setEnabled(autocompleteToggle.checked);
    });
  }

  // ---- Example selector ----
  const exampleSel = document.getElementById('example-select');
  if (typeof NGPC_EXAMPLES !== 'undefined') {
    for (const ex of NGPC_EXAMPLES) {
      const opt = document.createElement('option');
      opt.value = ex.id;
      opt.textContent = ex.label;
      exampleSel.appendChild(opt);
    }
  }
  exampleSel.addEventListener('change', async () => {
    const id = exampleSel.value;
    if (!id) return;
    const ex = NGPC_EXAMPLES.find(e => e.id === id);
    if (!ex) return;
    try {
      if (ex.bundle || ex.bundlePath) {
        if (!confirm(
            `Load "${ex.label}" as a full project?\n\n` +
            `This overwrites src/main.c and replaces every user-created editable file.`)) {
          exampleSel.value = '';
          return;
        }
        let bundle = ex.bundle || null;
        if (!bundle) {
          const res = await fetch(ex.bundlePath, { cache: 'no-store' });
          if (!res.ok) {
            throw new Error(
              `Example fetch failed: ${res.status} ${res.statusText} (${ex.bundlePath})`);
          }
          bundle = await res.json();
        }
        const count = NGPC_Project.importBundle(bundle);
        openTabs.length = 0;
        lastRunContent.clear();
        renderTree();
        const importedEntry = NGPC_Project.entryFile();
        if (importedEntry) openFile(importedEntry);
        log(`Loaded example project "${ex.label}" (${count} file${count === 1 ? '' : 's'}).`, 'info');
        runEntry();
        exampleSel.value = '';
        return;
      }
      const entry = NGPC_Project.entryFile();
      if (!entry) return;
      const current = NGPC_Project.getFile(entry);
      if (current && current.content.trim() && current.content !== ex.body) {
        if (!confirm(`Load "${ex.label}" into ${entry}? This overwrites the current content.`)) {
          exampleSel.value = '';
          return;
        }
      }
      NGPC_Project.setContent(entry, ex.body);
      openFile(entry);
      runEntry();
    } catch (e) {
      log(e.message || String(e), 'err');
      alert(`Load example failed:\n${e.message || String(e)}`);
    }
    exampleSel.value = '';
  });

  // ---- Download current file ----
  const downloadBtn = document.getElementById('download-btn');
  downloadBtn.addEventListener('click', () => {
    if (!activePath) return;
    const f = NGPC_Project.getFile(activePath);
    if (!f) return;
    const blob = new Blob([f.content], { type: 'text/x-c' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = activePath.split('/').pop();
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });

  // ---- New file button ----
  const newFileBtn = document.getElementById('new-file-btn');
  newFileBtn.addEventListener('click', () => {
    const name = prompt('New .c filename (no extension):', 'game');
    if (!name) return;
    const cleanName = name.replace(/\.c$/i, '');
    const path = `src/${cleanName}.c`;
    try {
      NGPC_Project.addFile(path, starterTemplateFor(cleanName));
    } catch (e) {
      alert(e.message);
      return;
    }
    renderTree();
    openFile(path);
    runEntry();
  });

  // ---- Project export / import ----
  //
  // Two export formats, same source of truth:
  //   - JSON bundle  — roundtrips inside this editor. Includes format
  //                    identifier + version so future incompatibilities
  //                    are caught cleanly.
  //   - ZIP archive  — raw .c files at their tree paths, ready to drop
  //                    into a real NGPC build. Encoded with "stored" (no
  //                    deflate) so the writer stays tiny and inspectable.
  //
  // Import auto-detects the payload from the filename suffix + magic:
  //   - single .json file   → NGPC_Project.importBundle
  //   - single .zip archive → NGPC_Zip.decode, keep src/*.c entries only
  //   - one or more .c files → each becomes src/<basename>.c
  // Template headers are never exported or overwritten — they live in
  // NGPC_PROJECT_DATA and are re-baked by sync_template.py.

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }
  function timestamp() {
    return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  }

  const exportJsonBtn = document.getElementById('export-json-btn');
  exportJsonBtn.addEventListener('click', () => {
    try {
      const bundle = NGPC_Project.serialize();
      const count = Object.keys(bundle.files).length;
      const blob = new Blob([JSON.stringify(bundle, null, 2)], {
        type: 'application/json',
      });
      downloadBlob(blob, `ngpcraft-project-${timestamp()}.json`);
      log(`Exported project as JSON (${count} file${count === 1 ? '' : 's'}).`, 'info');
    } catch (e) {
      log(`Export failed: ${e.message}`, 'err');
    }
  });

  const exportZipBtn = document.getElementById('export-zip-btn');
  exportZipBtn.addEventListener('click', () => {
    try {
      const sources = NGPC_Project.editableCSources();
      if (sources.length === 0) throw new Error('Nothing to export.');
      const zipBytes = NGPC_Zip.encode(sources);
      const blob = new Blob([zipBytes], { type: 'application/zip' });
      downloadBlob(blob, `ngpcraft-project-${timestamp()}.zip`);
      log(`Exported project as ZIP (${sources.length} file${sources.length === 1 ? '' : 's'}).`, 'info');
    } catch (e) {
      log(`ZIP export failed: ${e.message}`, 'err');
    }
  });

  // Convert a filename like "../src/game.c" → "src/game.c". Anything that
  // doesn't look like a valid project .c path (after stripping leading
  // directories) is rejected by the add/import helpers.
  function normaliseSrcPath(raw) {
    // Strip any leading "./" / "../" segments.
    let p = raw.replace(/\\/g, '/').replace(/^\.\/+/, '');
    while (p.startsWith('../')) p = p.slice(3);
    // If the path already includes "src/NAME.c" keep that portion.
    const srcIdx = p.lastIndexOf('src/');
    if (srcIdx >= 0) p = p.slice(srcIdx);
    // Otherwise prefix with src/ if the base name is a bare C file.
    if (!p.startsWith('src/')) p = 'src/' + p.split('/').pop();
    return p;
  }

  async function handleImportFiles(fileList) {
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList);
    // Decide the branch: exactly one .json / .zip / .png, or any number of .c.
    const kind = (() => {
      if (files.length === 1) {
        const n = files[0].name.toLowerCase();
        if (n.endsWith('.json')) return 'json';
        if (n.endsWith('.zip'))  return 'zip';
        if (n.endsWith('.png'))  return 'png';
      }
      if (files.every(f => /\.c$/i.test(f.name))) return 'c';
      return 'mixed';
    })();

    try {
      if (kind === 'json') {
        const text = await files[0].text();
        const bundle = JSON.parse(text);
        const incoming = Object.keys(bundle.files || {}).length;
        if (!confirm(
            `Import ${incoming} file(s) from JSON bundle?\n\n` +
            `Replaces every user-created .c file and overwrites src/main.c.`)) return;
        const n = NGPC_Project.importBundle(bundle);
        finishImport(files[0].name, n);
      } else if (kind === 'zip') {
        const bytes = new Uint8Array(await files[0].arrayBuffer());
        const entries = await NGPC_Zip.decode(bytes);
        // Filter to .c files whose normalised path fits src/<name>.c.
        const usable = [];
        for (const e of entries) {
          if (!/\.c$/i.test(e.path)) continue;
          const norm = normaliseSrcPath(e.path);
          usable.push({ path: norm, content: e.content });
        }
        if (usable.length === 0) {
          throw new Error('ZIP archive had no .c files.');
        }
        if (!confirm(
            `Import ${usable.length} .c file(s) from ${files[0].name}?\n\n` +
            `Replaces every user-created .c file and overwrites src/main.c.`)) return;
        const bundle = {
          format: 'ngpcraft_live_editor_project',
          version: 1,
          exported_at: new Date().toISOString(),
          files: Object.fromEntries(usable.map(f => [f.path, f.content])),
        };
        const n = NGPC_Project.importBundle(bundle);
        finishImport(files[0].name, n);
      } else if (kind === 'png') {
        // Hand off to the asset-import modal. It lets the user pick
        // sprite vs tilemap + params, runs the converter, then sends
        // the generated .c/.h back here.
        NGPC_PngImport.open(files[0], {
          onResult: ({ cPath, hPath, cSource, hSource, kind: assetKind, summary }) => {
            try {
              writeGeneratedFile(cPath, cSource);
              writeGeneratedFile(hPath, hSource);
              renderTree();
              openFile(cPath);
              const s = summary || {};
              const meta = assetKind === 'sprite'
                ? `${s.frames} frame(s) · ${s.tiles} tiles · ${s.palettes} palette(s)`
                : `${s.tileW}x${s.tileH} tiles · ${s.tiles} unique · ${s.palettes} palette(s)`;
              log(`Imported ${files[0].name} as ${assetKind}: ${cPath} + ${hPath} (${meta}).`, 'info');
              runEntry();
            } catch (err) {
              log(`Asset write failed: ${err.message}`, 'err');
              alert(`Asset write failed:\n${err.message}`);
            }
          },
          onCancel: () => {},
        });
        return;   // PNG flow is async via the modal; no further processing.
      } else if (kind === 'c') {
        const usable = [];
        for (const f of files) {
          const content = await f.text();
          usable.push({ path: normaliseSrcPath(f.name), content });
        }
        if (!confirm(
            `Import ${usable.length} .c file(s) into src/?\n\n` +
            `Replaces every user-created .c file with the same basename.`)) return;
        // Merge-mode: keep existing user files whose paths aren't in the
        // incoming set; overwrite the rest. importBundle replaces, so for
        // raw .c imports we just call addFile/setContent individually.
        for (const f of usable) {
          const existing = NGPC_Project.getFile(f.path);
          if (existing && existing.editable) {
            NGPC_Project.setContent(f.path, f.content);
          } else if (!existing) {
            NGPC_Project.addFile(f.path, f.content);
          } else {
            throw new Error(`Path ${f.path} is read-only — cannot overwrite.`);
          }
        }
        finishImport(
          usable.length === 1 ? files[0].name : `${usable.length} .c files`,
          usable.length,
        );
      } else {
        throw new Error(
          'Mixed selection: choose one .json, one .zip, or any number of .c files.');
      }
    } catch (e) {
      log(`Import failed: ${e.message}`, 'err');
      alert(`Import failed:\n${e.message}`);
    }
  }

  // Write-or-overwrite a generated file. Used by the PNG importer so
  // re-running the conversion on the same image replaces the previous
  // output instead of erroring on "file already exists".
  function writeGeneratedFile(path, content) {
    const existing = NGPC_Project.getFile(path);
    if (existing && existing.editable) {
      NGPC_Project.setContent(path, content);
    } else if (!existing) {
      NGPC_Project.addFile(path, content);
    } else {
      throw new Error(`Path ${path} is read-only.`);
    }
  }

  function finishImport(source, count) {
    renderTree();
    const entry = NGPC_Project.entryFile();
    if (entry) openFile(entry);
    log(`Imported ${count} file${count === 1 ? '' : 's'} from ${source}.`, 'info');
    runEntry();
  }

  const importProjectBtn   = document.getElementById('import-project-btn');
  const importProjectInput = document.getElementById('import-project-input');
  importProjectBtn.addEventListener('click', () => {
    importProjectInput.value = '';   // so selecting the same file fires change
    importProjectInput.click();
  });
  importProjectInput.addEventListener('change', () => {
    handleImportFiles(importProjectInput.files);
  });

  // Drag-and-drop onto the tree pane: same handler, no dialog wiring needed.
  const treePane = document.querySelector('.tree-pane');
  treePane.addEventListener('dragover', (e) => { e.preventDefault(); treePane.classList.add('drag-over'); });
  treePane.addEventListener('dragleave', () => treePane.classList.remove('drag-over'));
  treePane.addEventListener('drop', (e) => {
    e.preventDefault();
    treePane.classList.remove('drag-over');
    if (e.dataTransfer && e.dataTransfer.files) {
      handleImportFiles(e.dataTransfer.files);
    }
  });

  function starterTemplateFor(baseName) {
    return `/*
 * ${baseName}.c - ${baseName} module
 *
 * Function declarations here are hoisted into the same scope as main(),
 * so main.c can call ${baseName}_update() etc. directly.
 */

#include "ngpc_sys.h"
#include "ngpc_gfx.h"

void ${baseName}_update(void)
{
    /* TODO */
}
`;
  }

  // ---- Run the entry file ----
  // Loop state kept at module scope so the Pause / Step / Reset / FPS
  // wiring can reach it without plumbing a controller object around.
  let currentGen = null;        // active generator while a frame loop is live
  let currentAdvance = null;    // closure that runs one frame
  let paused = false;
  let framesRun = 0;
  let fpsSamples = [];

  function cancelLoop() {
    if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
    currentGen = null;
    currentAdvance = null;
    paused = false;
    updatePauseButton();
  }

  function updatePauseButton() {
    pauseBtn.textContent = paused ? '▶' : '❚❚';
    pauseBtn.title = paused ? 'Resume the frame loop' : 'Pause the frame loop';
  }
  function updateFpsStatus() {
    if (!currentAdvance) { fpsStatusEl.textContent = '—'; return; }
    // Average the last 30 dt samples (roughly half a second at 60 Hz).
    const avgMs = fpsSamples.length
      ? fpsSamples.reduce((a, b) => a + b, 0) / fpsSamples.length
      : 0;
    const fps = avgMs > 0 ? (1000 / avgMs) : 0;
    fpsStatusEl.textContent =
      `frame ${framesRun} · ${fps.toFixed(0)} fps${paused ? ' · paused' : ''}`;
  }

  function driveGenerator(gen) {
    // Wrap a single frame: bump VB counter, step the generator, render.
    // The first frame runs synchronously so headless screenshot tools (which
    // wait for `load` then capture) see a populated canvas even if they never
    // service requestAnimationFrame.
    //
    // Real NGPC runs at exactly 60 Hz (K2GE §1 §3-2). The browser's
    // requestAnimationFrame fires at the monitor refresh rate, which can be
    // 60 / 120 / 144 Hz. We decouple with a fixed-timestep accumulator so
    // game logic ticks at 60 Hz regardless of monitor refresh — matches hw
    // timing, prevents e.g. 120 Hz displays from making the game run twice
    // as fast.
    const FRAME_MS = 1000 / 60;
    let accumulator = 0;
    let lastTime = performance.now();
    let lastFrameTime = lastTime;

    let lastErr = null;
    framesRun = 0;
    fpsSamples = [];
    currentGen = gen;
    const advance = () => {
      // Simulate VBI handler firing during VBlank — host-only, doesn't
      // count against the user's CPU budget (real hw ISRs use a separate
      // register bank and negligible cycles anyway). Enter VBlank by
      // setting HW_STATUS bit 6 so polling ngpc_in_vblank() reports the
      // truth for this window (K2GETechRef §4-10, BLNK latch cleared at
      // end of VBlank); the char-over latch is cleared here too per the
      // same section.
      NGPC_Memory.beginHostOps();
      NGPC_Memory.setBlankFlag(true);
      NGPC_Memory.simulateVBI();
      const vb = NGPC_Memory.read8(0xFB00);
      NGPC_Memory.write8(0xFB00, (vb + 1) & 0xFF);
      NGPC_Memory.clearCharOver();
      NGPC_Memory.endHostOps();
      // Honor shutdown request (USR_SHUTDOWN or 30-frame POWER hold) —
      // matches ngpc_timing.c:37-52 semantics.
      if (NGPC_Memory.consumeShutdown()) {
        log('BIOS shutdown requested (USR_SHUTDOWN or 30-frame POWER hold).', 'info');
        return true; // treat as halted
      }
      // VBlank ends as user code resumes (active display period) — clear the
      // BLNK latch so user code that polls HW_STATUS sees the correct value.
      NGPC_Memory.beginHostOps();
      NGPC_Memory.setBlankFlag(false);
      NGPC_Memory.endHostOps();
      // Now step the user's code — every memory op counts toward budget.
      NGPC_Memory.beginFrame();
      const { done } = gen.next();
      NGPC_Memory.resetYieldCounter();
      NGPC_Memory.endFrame();
      // VDP render is parallel hardware on real NGPC: doesn't consume CPU.
      // Debug + palette inspector reads are also wrapped — they're
      // instrumentation, not user code. VDP render may raise CHAR_OVR per
      // the K2GETechRef §4-10 line-buffer model.
      NGPC_Memory.beginHostOps();
      NGPC_VDP.render(ctx);
      updateDebugPanel();
      NGPC_Memory.endHostOps();
      framesRun++;
      // FPS sampling — capture the gap between the last two advance() calls
      // regardless of the accumulator (step may drain multiple frames per
      // rAF tick). Keep the window short so pausing + resuming settles fast.
      const nowFrame = performance.now();
      const dtFrame = nowFrame - lastFrameTime;
      lastFrameTime = nowFrame;
      if (dtFrame > 0 && dtFrame < 1000) {
        fpsSamples.push(dtFrame);
        if (fpsSamples.length > 30) fpsSamples.shift();
      }
      updateFpsStatus();
      return done;
    };
    currentAdvance = advance;
    const stop = (msg) => { rafId = null; setStatus(msg, 'ok'); updateFpsStatus(); };
    try {
      if (advance()) return stop('Halted');
    } catch (e) {
      if (e.message === 'NGPC_SHUTDOWN') return stop('Shutdown');
      log(e.message || String(e), 'err');
      setStatus('Runtime error', 'err');
      return;
    }
    if (framesRun >= frameCap) return stop('Frame cap');
    const step = () => {
      try {
        if (paused) {
          // Keep the rAF chain alive so we can resume instantly; skip frame
          // advancement while paused.
          lastTime = performance.now();
          rafId = requestAnimationFrame(step);
          return;
        }
        const now = performance.now();
        const dt = now - lastTime;
        lastTime = now;
        accumulator += dt;
        // Cap accumulator so a dropped tab / long GC pause doesn't trigger
        // a storm of catch-up frames. 5 frames = 83 ms is plenty.
        if (accumulator > FRAME_MS * 5) accumulator = FRAME_MS;

        while (accumulator >= FRAME_MS) {
          if (advance()) return stop('Halted');
          accumulator -= FRAME_MS;
          if (framesRun >= frameCap) return stop('Frame cap');
        }
        rafId = requestAnimationFrame(step);
      } catch (e) {
        if (e.message === 'NGPC_SHUTDOWN') return stop('Shutdown');
        if (!lastErr || lastErr !== e.message) {
          lastErr = e.message;
          log(e.message || String(e), 'err');
          setStatus('Runtime error', 'err');
        }
        rafId = null;
      }
    };
    rafId = requestAnimationFrame(step);
  }

  function runEntry() {
    cancelLoop();
    resetDebugPanel();
    const sources = NGPC_Project.editableCSources();
    if (sources.length === 0) { setStatus('No source files', 'err'); return; }
    const combined = sources.map(s =>
      `/* ==== ${s.path} ==== */\n${s.content}`
    ).join('\n\n');
    clearLog();
    NGPC_Memory.reset();
    NGPC_Memory.write8(0x6F82, padState);
    try {
      const result = NGPC_Interp.run(combined, {
        onLog: (m) => log(m, 'info'),
        includeResolver: (name) => NGPC_Project.resolveInclude(name),
      });
      // Snapshot every source we just fed to the interpreter — a file is
      // now "clean" (dirty dot off) until the user edits it again.
      for (const s of sources) lastRunContent.set(s.path, s.content);
      refreshTabsOnly();
      if (result && typeof result.next === 'function') {
        setStatus('Running (60 Hz)', 'ok');
        driveGenerator(result);
      } else {
        NGPC_VDP.render(ctx);
        setStatus('OK', 'ok');
      }
    } catch (e) {
      setStatus('Error', 'err');
      log(e.message || String(e), 'err');
      NGPC_VDP.render(ctx);
    }
  }

  // ---- Boot ----
  try {
    NGPC_Project.load();
  } catch (e) {
    setStatus('Project load failed', 'err');
    log(e.message, 'err');
    return;
  }
  renderTree();
  // Restore the set of tabs the user had open before the reload, then pick
  // the saved active tab. If nothing survives (e.g. all persisted paths
  // point at files that no longer exist), fall back to the entry file.
  const savedTabs = restoreTabs();
  let restoredActive = null;
  if (savedTabs) {
    for (const p of savedTabs.open) {
      if (NGPC_Project.getFile(p)) openTabs.push(p);
    }
    if (savedTabs.active && NGPC_Project.getFile(savedTabs.active) &&
        openTabs.includes(savedTabs.active)) {
      restoredActive = savedTabs.active;
    }
  }
  const entry = NGPC_Project.entryFile();
  if (!openTabs.length && entry) openTabs.push(entry);
  const firstOpen = restoredActive || openTabs[0] || entry;
  if (firstOpen) openFile(firstOpen);
  runEntry();
})();
