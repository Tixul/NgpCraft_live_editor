// Virtual project filesystem for the live editor.
//
// Files are loaded from ./template/* at startup. The tree is exposed as a
// simple nested object. The user's entry point is src/main.c and is the only
// file treated as editable (and the only file fed to the interpreter). All
// others are read-only reference copies of the real NgpCraft_base_template
// headers — they mirror what the user would see in a real project checkout.

const NGPC_Project = (() => {
  // Files are embedded by sync_template.py into js/project_data.js as
  // `NGPC_PROJECT_DATA`. Keeping the data inline lets the editor boot
  // synchronously in one tick (simpler than a fetch dance).
  //
  // In addition to the template headers (read-only), the user can create
  // their own .c files under src/. User-created files are persisted in
  // localStorage under `STORAGE_KEY` so edits survive page reloads.
  const files = new Map();
  const STORAGE_KEY = 'ngpc-live-editor.project.v1';

  function load() {
    for (const { path, content, ...meta } of NGPC_PROJECT_DATA) {
      files.set(path, { content, ...meta, dirty: false, userCreated: false });
    }
    // Overlay persisted user state on top of the baked template.
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        for (const [path, entry] of Object.entries(saved)) {
          const base = files.get(path);
          if (base && base.editable) {
            files.set(path, { ...base, content: entry.content });
          } else if (entry.userCreated) {
            files.set(path, {
              content: entry.content,
              editable: true,
              entry: false,
              dirty: false,
              userCreated: true,
            });
          }
        }
      }
    } catch (_) { /* corrupt storage, ignore */ }
  }

  function persist() {
    try {
      const out = {};
      for (const [path, f] of files) {
        if (f.editable) {
          out[path] = { content: f.content, userCreated: !!f.userCreated };
        }
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(out));
    } catch (_) { /* quota or unavailable */ }
  }

  function addFile(path, content = '') {
    if (files.has(path)) throw new Error(`File already exists: ${path}`);
    // Accept .c for source and .h for generated / hand-written headers.
    // Asset tools (tools/ngpc_sprite_export.py, tools/ngpc_tilemap.py)
    // emit a matching .h alongside the .c — having both land in src/
    // lets other translation units `#include "player_mspr.h"` unchanged.
    if (!/^src\/[A-Za-z_][\w-]*\.[ch]$/.test(path)) {
      throw new Error(`Invalid path: must match src/NAME.c or src/NAME.h (e.g. src/game.c, src/player_mspr.h)`);
    }
    files.set(path, {
      content,
      editable: true,
      entry: false,
      dirty: false,
      userCreated: true,
    });
    persist();
  }

  function removeFile(path) {
    const f = files.get(path);
    if (!f || !f.userCreated) return false;
    files.delete(path);
    persist();
    return true;
  }

  // Return all editable .c files in a stable order. Entry file (main.c)
  // comes last so that helper function declarations from other files are
  // hoisted into the same JS scope before main() is called.
  function editableCSources() {
    const paths = listPaths()
      .filter(p => {
        const f = files.get(p);
        return f.editable && p.endsWith('.c');
      })
      .sort((a, b) => {
        const af = files.get(a), bf = files.get(b);
        if (af.entry !== bf.entry) return af.entry ? 1 : -1; // entry last
        return a.localeCompare(b);
      });
    return paths.map(p => ({ path: p, content: files.get(p).content }));
  }

  function getFile(path)   { return files.get(path); }
  function listPaths()     { return Array.from(files.keys()); }
  function entryFile()     { return listPaths().find(p => files.get(p).entry); }

  // Look up an included file by the last path segment (as a real compiler
  // would, given an include-path list). The interpreter's #include resolver
  // uses this so `#include "ngpc_gfx.h"` finds template/src/core/ngpc_gfx.h
  // without the user having to spell out the relative path. Returns the
  // file content or null if no match.
  function resolveInclude(name) {
    const clean = name.replace(/^\.\.?\/+/, '').replace(/\\/g, '/');
    const tail = clean.split('/').pop();
    // 1. Exact path match (fast path, unambiguous).
    for (const p of listPaths()) {
      if (p === clean) return files.get(p).content;
    }
    // 2. Last-segment match. For ambiguous tails we prefer headers over .c.
    const candidates = listPaths().filter(p => p.split('/').pop() === tail);
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => {
      const ah = a.endsWith('.h') ? 0 : 1;
      const bh = b.endsWith('.h') ? 0 : 1;
      return ah - bh;
    });
    return files.get(candidates[0]).content;
  }
  function setContent(path, content) {
    const f = files.get(path);
    if (!f) return;
    if (!f.editable) return;
    f.content = content;
    f.dirty = true;
    persist();
  }

  // Build a nested tree structure for rendering.
  // Returns: { name, path, isFile, children?, meta? }
  function buildTree() {
    const root = { name: 'project', path: '', isFile: false, children: [] };
    for (const path of listPaths()) {
      const meta = files.get(path);
      const parts = path.split('/');
      let cursor = root;
      for (let i = 0; i < parts.length; i++) {
        const name = parts[i];
        const isLeaf = i === parts.length - 1;
        let node = cursor.children.find(c => c.name === name);
        if (!node) {
          node = isLeaf
            ? { name, path, isFile: true, meta }
            : { name, path: parts.slice(0, i + 1).join('/'), isFile: false, children: [] };
          cursor.children.push(node);
        }
        cursor = node;
      }
    }
    // Sort: folders first, then files, alphabetically within each.
    const sortRec = (node) => {
      if (!node.children) return;
      node.children.sort((a, b) => {
        if (a.isFile !== b.isFile) return a.isFile ? 1 : -1;
        return a.name.localeCompare(b.name);
      });
      node.children.forEach(sortRec);
    };
    sortRec(root);
    return root;
  }

  // Serialise every editable source into a plain JSON bundle. Template
  // headers are read-only and live in NGPC_PROJECT_DATA, so they are
  // intentionally excluded — re-importing elsewhere still has them.
  //
  // Format (version 1):
  //   {
  //     "format":  "ngpcraft_live_editor_project",
  //     "version": 1,
  //     "exported_at": "ISO-8601 timestamp",
  //     "files": { "src/main.c": "...", "src/game.c": "..." }
  //   }
  //
  // Constraints enforced on import:
  //   - top-level `format` === "ngpcraft_live_editor_project"
  //     (legacy bundles with "ngpc_live_editor_project" are accepted too
  //      since the product was renamed mid-release)
  //   - `version` === 1
  //   - every key in `files` matches /^src\/[A-Za-z_][\w-]*\.c$/
  //   - every value is a string
  const BUNDLE_FORMAT        = 'ngpcraft_live_editor_project';
  const BUNDLE_FORMAT_LEGACY = 'ngpc_live_editor_project';

  function serialize() {
    const out = {};
    for (const { path, content } of editableCSources()) {
      out[path] = content;
    }
    return {
      format: BUNDLE_FORMAT,
      version: 1,
      exported_at: new Date().toISOString(),
      files: out,
    };
  }

  // Same rule as addFile — accept .c or .h under src/.
  const PATH_RE = /^src\/[A-Za-z_][\w-]*\.[ch]$/;

  function validateBundle(bundle) {
    if (!bundle || typeof bundle !== 'object') {
      throw new Error('Bundle is not an object.');
    }
    if (bundle.format !== BUNDLE_FORMAT && bundle.format !== BUNDLE_FORMAT_LEGACY) {
      throw new Error(
        `Unknown bundle format (expected "${BUNDLE_FORMAT}", got ${
          JSON.stringify(bundle.format)}).`);
    }
    if (bundle.version !== 1) {
      throw new Error(
        `Unsupported bundle version: ${bundle.version} (this build reads v1).`);
    }
    if (!bundle.files || typeof bundle.files !== 'object' || Array.isArray(bundle.files)) {
      throw new Error('Bundle is missing a "files" object.');
    }
    const entries = Object.entries(bundle.files);
    if (entries.length === 0) {
      throw new Error('Bundle has no files.');
    }
    for (const [path, content] of entries) {
      if (!PATH_RE.test(path)) {
        throw new Error(
          `Invalid path: ${JSON.stringify(path)} ` +
          `(must match src/<name>.c with letters, digits, dash or underscore).`);
      }
      if (typeof content !== 'string') {
        throw new Error(`File "${path}" content is not a string.`);
      }
    }
    return entries;
  }

  // Replace the entire editable set with `bundle`. Non-editable template
  // headers are left untouched. `src/main.c` stays the entry file so the
  // run button keeps working even if the bundle has its own main.c.
  function importBundle(bundle) {
    const entries = validateBundle(bundle);
    // Drop user-created files first; src/main.c isn't userCreated so it
    // survives this sweep and gets its content overwritten below if the
    // bundle provides one.
    for (const p of Array.from(files.keys())) {
      const f = files.get(p);
      if (f && f.userCreated) files.delete(p);
    }
    for (const [path, content] of entries) {
      const existing = files.get(path);
      if (existing && existing.editable) {
        files.set(path, { ...existing, content, dirty: true });
      } else {
        files.set(path, {
          content,
          editable:    true,
          entry:       path === 'src/main.c',
          dirty:       true,
          userCreated: path !== 'src/main.c',
        });
      }
    }
    persist();
    return entries.length;
  }

  return {
    load, getFile, listPaths, entryFile, setContent, buildTree,
    addFile, removeFile, editableCSources, resolveInclude,
    serialize, importBundle,
  };
})();
