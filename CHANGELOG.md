# Changelog — NgpCraft Live Editor

## 2026-07-08

### Fixed

- **byte mul/div r+r reclassified as executable (not silicon-broken)** — the
  BYTE register-to-register mul/div family (prefix `C8..CF`, sub-op
  `0x40..0x5F`; canonical `CB 51 = div A, C`) is NOT silicon-broken. Hardware
  test `hw_test_bytediv` on a real NGPC runs `div A, C` correctly
  (WA=0x1F64 / C=0x64 → WA=0x2450). This parallels the WORD mul/div clearing
  (`D8..DF`, 2026-07-06). NUANCE: the `CB` "C-source byte-ALU" family is
  SUB-OP-SPECIFIC — `add A, C` (`CB 81`) IS a confirmed HW crash and stays
  broken, but byte mul/div (`CB 0x40..0x5F`) are SAFE. No lint in this editor
  ever flagged the byte `CB` family, `div A, C`/`CB 51`, or byte mul/div (the
  HW-5 lint only covers the `0xD0`-prefix word ALU-immediate mis-encode, and
  no `add A, C`/`CB 81` flag exists here), so no code change was needed — this
  entry corrects the record. Mirrors NgpCraft_emulator `quirks_db.json`.

## 2026-07-06

### Fixed

- **mul/div r+r reclassified as executable (not silicon-broken)** — the
  `D8..DF` word register-to-register mul/div family (sub-op `0x40..0x5F`:
  mul `0x40-47`, muls `0x48-4F`, div `0x50-57`, divs `0x58-5F`; canonical
  `D9 50 = div WA, BC`) was previously listed as still-broken in the
  2026-07-05 note below. Disproven on real hardware: test ROM
  `hw_test_muldiv` on a real NGPC runs `div WA, BC` correctly
  (XWA=0x000003E8 / BC=0x000A → XWA=0x00000064, quotient 100 remainder 0).
  NOT silicon-broken. Parallels the 2026-07-05 `add r+r` clearing. No lint
  in this editor ever flagged mul/div r+r (the HW-5 lint only covers the
  `0xD0`-prefix ALU-immediate mis-encode), so no code change was needed —
  this entry corrects the record. In the `D8..DF` WORD prefix family, only
  **shift-by-A (`0xF8..0xFF`)** and the **`0xB8..0xBF` gap** remain
  silicon-broken. The `0xD0`-prefix ALU-immediate mis-encode warning is
  kept. Mirrors NgpCraft_emulator `quirks_db.json` `2026-07-06`.

## 2026-07-05

### Fixed

- **HW-5 lint false positive removed** — the `ld <XR>, XWA` r+r register-copy
  pattern no longer flags as silicon-broken. Hardware test (flashed
  `hw_test_addrr`, 2026-07-05) plus the retail mr_robot boot confirm the
  `D8..DF` word copies (`D8 88..8F`) and the `E8..EF` long copies execute
  cleanly — neither hangs. Only the `D8..DF` mul/div r+r (`0x40..0x5F`) and
  shift-by-A (`0xF8..0xFF`) remain broken, and the `0xD0`-prefix ALU-immediate
  mis-encode warning is kept. The earlier "sub-op 0x80..0xFF hangs the CPU"
  blanket rule (USER_MANUAL §12.1) is disproven. Mirrors NgpCraft_emulator
  `quirks_db.json` `2026-07-05.v10`.

## 2026-05-20

### Added

- **HW-5 lint — silicon-broken inline-asm opcodes**: detects two TLCS-900
  patterns inside `__asm__("…")` / `_asm { … }` blocks that crash on real
  NGPC silicon:
  - `ld <XR>, XWA` (D8 88..8F, working-bank long-register r+r) — recommends
    the byte-split via stack (`push WA; pop <R>; add A, L; adc W, H`).
  - `<alu> WA, imm` (D0 C8..CF) — recommends the cc900 byte-split
    (`ld HL, imm; <alu> A, L; <carry> W, H`).
  Mirrors NgpCraft_emulator `quirks_db.json` `2026-05-20.v4` and
  NgpCraft_Disasm `MANUAL.md`. 4 fixture tests added to
  `tests/transpile.test.mjs`.

## 2026-04-20

A pass focused on making the editor a real, scriptable building block — not
just a browser playground. Every JS module now exposes itself to non-browser
hosts (Node `vm`, Workers, electron), the lint catches more cc900 footguns,
and the renderer / interpreter expose first-class headless entry points so
external tools (MCP server, CI, regression tests) can use them without hacks.

### Added

- **`globalThis` exports on every module.** All 18 `js/*.js` files now end with
  `if (typeof globalThis !== 'undefined') globalThis.NGPC_X = NGPC_X;`. Top-level
  `const` was script-scoped and never reached embedding hosts; this trivial line
  per file removes a long-standing integration friction.
- **`NGPC_VDP.renderToPixels()`** — pure-pixel renderer that returns a
  `Uint8ClampedArray` of `W * H * 4` RGBA bytes. No DOM, no canvas. The existing
  `render(ctx)` is now a 4-line adapter; both share a private `renderInto(fb)`
  implementation so output stays byte-identical.
- **`NGPC_AssetTools.decodePngFromBytes(bytes)`** — sibling of `decodePng(file)`
  that accepts an `ArrayBuffer` or `Uint8Array`. Useful from Workers (no `File`
  on hand), browser extensions, and any host that already has the bytes in
  memory. Browser-only (uses `Blob` + `Image` + `Canvas`); Node hosts should use
  pngjs directly.
- **`NGPC_Interp.runFrames(code, opts)`** — first-class headless entry point.
  Wraps memory reset + `run()` + generator iteration + state capture into one
  call. Returns `{ ok, kind, errors?, framesAdvanced, mainCompleted, logs,
  state, framebuffer, psgEvents }`. Replaces the boilerplate every external
  caller (MCP server, tests, CI) had to reimplement.
- **PSG event log** — `NGPC_PSG.getEvents()`, `setEventSink(fn)`,
  `setEventBudget(n)`. Every `setTone`/`setAttn`/`setNoise`/`reset` now appends
  a structured event (`{type, ch, divider, freq, attn, silent, ctrl, white}`)
  to a 4096-entry ring buffer. Lets headless tools answer questions like "at
  what frame did channel 0 go silent?" without a WebAudio context.
- **Lint rule HW-3c** — flags `s8 != s8 || s8 != s8` chains. The Toshiba cc900
  compiler crashes on this pattern; now caught in-editor before the user
  migrates the code to a real build.
- **Lint rule HW-4** — flags `TYPE name[N]` (non-static, non-extern, in-function)
  when `N` exceeds 256. The NGPC stack is small (~512 bytes typical); a 2400-byte
  local array silently corrupts return addresses on real silicon. Suggested fix
  is to add `static` (move to BSS) or hoist to file scope. Validated against the
  Fix #23 DMA stack-overflow case from `bugs_silicon.json`.
- **DMA register write warnings.** Writes to the TLCS-900 DMA address ranges
  (0x0030..0x004F, 0x007C..0x007F, 0x0080..0x009F) now emit a one-shot warning
  via `warnOnce`: the editor does not emulate DMA, but real hardware fires the
  transfer — silent acceptance was misleading. Each address warns at most once
  per run.
- **`tests/` directory** — fixture-based regression suite with 22 cases covering
  smoke transpile, register read/write rewrites, vsync→yield + main→generator,
  comment stripping, enum rewrite, pointer rewrites, every active lint rule
  (positive + negative cases), the StarGunner-mini false-positive guard, and
  `runFrames` + PSG event log. Run with `node --test tests/transpile.test.mjs`
  (Node 20+, zero external dependencies).

### Changed

- **`runFrames` + screenshot path consolidation.** Memory reset, generator
  iteration, framebuffer capture and PSG event drain all live inside
  `runFrames` now. External callers no longer reimplement these steps.
- **`renderToPixels` / `render(ctx)` decoupling.** Pixel painting moved into a
  shared private `renderInto(fb)`. The existing browser path is preserved
  (byte-for-byte identical output); the new headless path is a single function
  call without DOM dependencies.
- **`NGPC_PSG.init()` is now Node-safe.** Guarded with
  `typeof window === 'undefined'` so loading PSG into a Node `vm` no longer
  crashes on `window.AudioContext`. Voice state model still updates;
  WebAudio output is simply skipped when no browser context exists.

### Fixed

- **Lint rule HW-3d removed** (after a brief introduction). Initial detection
  flagged any initialised declaration at brace depth ≥ 2, which produced false
  positives on valid C89 — including the StarGunner mini example's
  `for (i=0;…) { u16 c0 = …; u16 c1 = …; … }` pattern. The actual cc900 issue
  is most likely "mixed declarations and statements" (decl after a non-decl
  statement in the same block — C99 extension), but no precise reproducer is
  captured in the bug DB yet. The rule is documented as removed-pending-repro
  in the `interpreter.js` source.

### Notes

- The MCP server (`@ngpcraft/mcp`) consumes these snapshots via
  `vendor/transpiler/js/`. The `globalThis` exports above remove the
  `const → var` rewrite hack that the MCP loader previously needed.
- `runFrames` is the recommended entry point for any non-UI execution
  (tests, CI, MCP, future tooling). `run()` remains for code that needs
  the raw generator.
- `validate_transpile.py` (Python re-implementation, repo root) is unchanged
  and remains complementary to the new fixture suite — Python checks
  *structural* shape, fixtures check *behaviour*.

---

Earlier history not tracked in this file.
