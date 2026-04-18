// Autocomplete UI for the editor textarea.
//
// Attaches to the existing #code textarea (no full-blown code-editor
// framework — just a floating <div> popup positioned by measuring the
// caret against a hidden mirror of the textarea). Driven by the symbol
// catalogue in js/autocomplete_data.js.
//
// Behaviour:
//   - When enabled and the caret sits inside an identifier of >= 1 char,
//     match-prefix entries from the catalogue show in a dropdown.
//   - Arrow keys move the selection; Enter/Tab inserts the full symbol;
//     Esc dismisses. Typing while the popup is open filters live.
//   - The selected entry's full signature + docstring render in the side
//     panel of the popup (kept compact so it never eats the whole screen).
//   - The enable state is persisted in localStorage.
//
// Public API exposed on window.NGPC_Autocomplete for main.js:
//   attach(codeEl)    — wire the listeners on the editor textarea
//   setEnabled(flag)  — turn the feature on/off (persisted)
//   isEnabled()       — current state
//
// Keyboard events pre-empt the editor's own Tab handler when the popup is
// open. Outside the popup lifetime, normal editing resumes.

const NGPC_Autocomplete = (() => {
  const STORAGE_KEY = 'ngpc-live-editor.autocomplete.v1';
  let enabled = true;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw !== null) enabled = raw === '1';
  } catch (_) { /* localStorage unavailable */ }

  let codeEl = null;
  let popupEl = null;
  let listEl  = null;
  let docEl   = null;
  let mirror  = null;   // hidden div that mirrors the textarea for caret math

  let matches = [];
  let selected = 0;
  let anchorStart = -1;   // textarea index where the identifier being typed starts
  let visible = false;

  const KIND_ORDER = {
    function: 0, macro: 1, register: 2, constant: 3, type: 4,
  };

  function isEnabled() { return enabled; }
  function setEnabled(flag) {
    enabled = !!flag;
    try { localStorage.setItem(STORAGE_KEY, enabled ? '1' : '0'); } catch (_) {}
    if (!enabled) hide();
  }

  function ensurePopup() {
    if (popupEl) return;
    popupEl = document.createElement('div');
    popupEl.className = 'autocomplete-popup';
    popupEl.setAttribute('role', 'listbox');
    popupEl.hidden = true;

    listEl = document.createElement('ul');
    listEl.className = 'autocomplete-list';
    popupEl.appendChild(listEl);

    docEl = document.createElement('div');
    docEl.className = 'autocomplete-doc';
    popupEl.appendChild(docEl);

    document.body.appendChild(popupEl);

    // Mouse interactions — select on hover, insert on click.
    listEl.addEventListener('mousedown', (e) => {
      // `mousedown` prevents the textarea from losing focus before we insert.
      e.preventDefault();
      const li = e.target.closest('li[data-idx]');
      if (!li) return;
      selected = Number(li.dataset.idx);
      insertSelected();
    });
    listEl.addEventListener('mouseover', (e) => {
      const li = e.target.closest('li[data-idx]');
      if (!li) return;
      selected = Number(li.dataset.idx);
      renderSelection();
    });
  }

  // Caret-position math. We mirror the textarea's styles on a hidden <div>,
  // put the text-before-caret into it, append a marker <span>, and read the
  // span's bounding rect. Only place that depends on browser pixel layout.
  function ensureMirror() {
    if (mirror) return;
    mirror = document.createElement('div');
    mirror.className = 'autocomplete-mirror';
    mirror.setAttribute('aria-hidden', 'true');
    document.body.appendChild(mirror);
  }

  function caretRect() {
    ensureMirror();
    const cs = window.getComputedStyle(codeEl);
    mirror.style.font             = cs.font;
    mirror.style.lineHeight       = cs.lineHeight;
    mirror.style.padding          = cs.padding;
    mirror.style.border           = cs.border;
    mirror.style.boxSizing        = cs.boxSizing;
    mirror.style.whiteSpace       = 'pre-wrap';
    mirror.style.wordWrap         = 'break-word';
    mirror.style.width            = codeEl.clientWidth + 'px';
    mirror.style.position         = 'fixed';        /* viewport-relative, same as popup */
    mirror.style.visibility       = 'hidden';
    mirror.style.pointerEvents    = 'none';
    /* Measure at the actual code-element origin so the marker rect lines up;
     * we restore the off-screen coords after reading. */
    const codeRect = codeEl.getBoundingClientRect();
    mirror.style.top              = codeRect.top + 'px';
    mirror.style.left             = codeRect.left + 'px';

    const before = codeEl.value.slice(0, codeEl.selectionStart);
    mirror.textContent = before;
    const marker = document.createElement('span');
    marker.textContent = '\u200b';
    mirror.appendChild(marker);

    const markerRect = marker.getBoundingClientRect();
    const mirrorRect = mirror.getBoundingClientRect();

    // Translate marker (mirror-space) to viewport (code-element space).
    const x = codeRect.left + (markerRect.left - mirrorRect.left) - codeEl.scrollLeft;
    const y = codeRect.top  + (markerRect.top  - mirrorRect.top)  - codeEl.scrollTop;
    const lineHeight = parseFloat(cs.lineHeight) || 18;

    // Return to offscreen storage so an odd visibility override can't leak
    // the previous snapshot onto the page.
    mirror.style.top  = '-9999px';
    mirror.style.left = '-9999px';
    mirror.textContent = '';
    return { x, y, lineHeight };
  }

  // Scan back from the caret for [A-Za-z_]\w* to find the identifier the
  // user is in the middle of typing.
  function identifierAtCaret() {
    const v = codeEl.value;
    const end = codeEl.selectionStart;
    let start = end;
    while (start > 0 && /\w/.test(v[start - 1])) start--;
    const word = v.slice(start, end);
    if (!word || !/^[A-Za-z_]/.test(word)) return null;
    return { word, start, end };
  }

  function rankMatches(prefix) {
    const lc = prefix.toLowerCase();
    const out = [];
    for (const s of NGPC_AUTOCOMPLETE) {
      const lcName = s.name.toLowerCase();
      let score;
      if (s.name === prefix)                     score = 0;
      else if (s.name.startsWith(prefix))        score = 1;
      else if (lcName.startsWith(lc))            score = 2;
      else if (lcName.includes(lc))              score = 3;
      else                                        continue;
      out.push([score, s]);
    }
    out.sort((a, b) => {
      if (a[0] !== b[0]) return a[0] - b[0];
      const ka = KIND_ORDER[a[1].kind] ?? 9;
      const kb = KIND_ORDER[b[1].kind] ?? 9;
      if (ka !== kb) return ka - kb;
      return a[1].name.localeCompare(b[1].name);
    });
    return out.slice(0, 40).map(([, s]) => s);
  }

  function renderMatches() {
    listEl.innerHTML = '';
    for (let i = 0; i < matches.length; i++) {
      const s = matches[i];
      const li = document.createElement('li');
      li.dataset.idx = i;
      li.className = 'autocomplete-item' + (i === selected ? ' active' : '');
      li.innerHTML =
        `<span class="ac-kind ac-kind-${s.kind}">${s.kind}</span>` +
        `<span class="ac-name">${s.name}</span>`;
      listEl.appendChild(li);
    }
    renderSelection();
  }

  function renderSelection() {
    if (selected < 0) selected = 0;
    if (selected >= matches.length) selected = matches.length - 1;
    for (const li of listEl.children) {
      li.classList.toggle('active', Number(li.dataset.idx) === selected);
    }
    const s = matches[selected];
    if (!s) { docEl.textContent = ''; return; }
    docEl.innerHTML =
      `<div class="ac-sig">${escapeHtml(s.signature)}</div>` +
      `<div class="ac-desc">${escapeHtml(s.doc)}</div>`;
    // Scroll active into view.
    const active = listEl.querySelector('.active');
    if (active) active.scrollIntoView({ block: 'nearest' });
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;',
      '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function position() {
    const r = caretRect();
    popupEl.style.left = (r.x + 2) + 'px';
    popupEl.style.top  = (r.y + r.lineHeight) + 'px';
  }

  function show() {
    popupEl.hidden = false;
    visible = true;
    position();
  }
  function hide() {
    if (!popupEl) return;
    popupEl.hidden = true;
    visible = false;
    anchorStart = -1;
  }

  function refresh() {
    if (!enabled) { hide(); return; }
    ensurePopup();
    const ident = identifierAtCaret();
    if (!ident) { hide(); return; }
    matches = rankMatches(ident.word);
    if (matches.length === 0) { hide(); return; }
    anchorStart = ident.start;
    selected = 0;
    renderMatches();
    show();
  }

  function insertSelected() {
    const s = matches[selected];
    if (!s || anchorStart < 0) { hide(); return; }
    const caret = codeEl.selectionStart;
    const before = codeEl.value.slice(0, anchorStart);
    const after  = codeEl.value.slice(caret);
    let insertion = s.name;
    // For functions, drop the cursor inside the parens.
    let caretOffset = insertion.length;
    if (s.kind === 'function' || s.kind === 'macro') {
      // If the user already has a `(` immediately after the caret, don't
      // double it — they're editing an existing call.
      if (after[0] !== '(') {
        insertion += '()';
        caretOffset = insertion.length - 1;
      }
    }
    codeEl.value = before + insertion + after;
    const newCaret = anchorStart + caretOffset;
    codeEl.selectionStart = codeEl.selectionEnd = newCaret;
    codeEl.dispatchEvent(new Event('input', { bubbles: true }));
    hide();
    codeEl.focus();
  }

  function onKeyDown(e) {
    if (!enabled) return;
    // Ctrl+Space forces the popup (useful when it was dismissed).
    if ((e.ctrlKey || e.metaKey) && e.code === 'Space') {
      e.preventDefault();
      refresh();
      return;
    }
    if (!visible) return;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        selected = Math.min(matches.length - 1, selected + 1);
        renderSelection();
        return;
      case 'ArrowUp':
        e.preventDefault();
        selected = Math.max(0, selected - 1);
        renderSelection();
        return;
      case 'Enter':
      case 'Tab':
        e.preventDefault();
        insertSelected();
        return;
      case 'Escape':
        e.preventDefault();
        hide();
        return;
    }
  }

  function onInput() {
    if (!enabled) return;
    // Schedule one tick so selectionStart reflects the post-input caret.
    requestAnimationFrame(refresh);
  }
  function onBlur() {
    // Give click handlers a chance to fire before dismissing.
    setTimeout(hide, 120);
  }
  function onScroll() {
    if (visible) position();
  }

  function attach(el) {
    codeEl = el;
    ensurePopup();
    codeEl.addEventListener('keydown', onKeyDown);
    codeEl.addEventListener('input',   onInput);
    codeEl.addEventListener('blur',    onBlur);
    codeEl.addEventListener('scroll',  onScroll);
    codeEl.addEventListener('click',   onInput);   // caret moved by mouse
    window.addEventListener('resize',  () => { if (visible) position(); });
  }

  return { attach, setEnabled, isEnabled };
})();
