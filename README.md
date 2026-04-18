# NgpCraft Live Editor

**Browser-based live C editor for Neo Geo Pocket Color development — write code, see results instantly, no toolchain required.**

---

## What is it?

NgpCraft Live Editor lets you write C code targeting the NGPC hardware API and see the emulated 160×152 screen update in real time. No compiler, no flash cart, no install — just open `index.html` and start coding.

The API surface mirrors [NgpCraft_base_template](../NgpCraft_base_template/), so anything that runs in the editor is a straight copy-paste away from a real cartridge build.

---

## Features

- **Live execution** — code reruns 250 ms after your last keystroke (or on demand with Ctrl+Enter)
- **Multi-file projects** — split code across multiple `src/*.c` files, add/delete from the tree pane
- **Full graphics emulation** — SCR1/SCR2 tilemaps, 64 sprites with H/V chaining, 16 palettes × 4 colors, scroll, flip, viewport, LCD invert, palette FX (fade, flash, cycle)
- **In-browser PNG import** — drag a PNG, choose Sprite or Tilemap, get generated C/H files instantly (same algorithms as the Python toolchain)
- **~150-symbol autocomplete** — signatures + docstrings for the full NgpCraft API (Ctrl+Space)
- **Import / export** — load and save projects as JSON bundles or ZIP archives compatible with the real template layout
- **10 progressive examples** — from hello-world to a multi-file StarGunner mini shmup
- **Hardware guardrails** — CPU budget, watchdog, sprite-line overflow (C.OVR), write-to-read-only warnings
- **No dependencies** — pure HTML/CSS/JS, no build step, no npm, no server required (or `python3 -m http.server 8000`)

---

## Quick start

```bash
git clone <repo>
cd NgpCraft_live_editor
python3 -m http.server 8000
# open http://localhost:8000
```

Or just double-click `index.html` in your browser.

Hello world:

```c
#include "ngpc_sys.h"
#include "ngpc_gfx.h"
#include "ngpc_text.h"

void main(void) {
    ngpc_init();
    ngpc_load_sysfont();
    ngpc_gfx_set_bg_color(RGB(0, 0, 6));
    ngpc_gfx_set_palette(GFX_SCR1, 0,
                         RGB(0,0,0), RGB(15,15,15), RGB(0,15,0), RGB(0,15,15));
    ngpc_text_print(GFX_SCR1, 0, 4, 9, "Hello World");
}
```

---

## Current limitations

- **No sound** — audio functions (`Sfx_Play`, `Bgm_Start*`, etc.) are stubs that log to the console only. The T6W28 PSG and Z80 sound CPU are not emulated.
- **C subset, not a real compiler** — the transpiler handles a curated C89 subset via regex passes. Edge cases unsupported: `*p++` in a single expression, pointer arithmetic on struct types, bit-fields, recursive macros.
- **No CPU emulation** — code runs as transpiled JavaScript, not TLCS-900/H instructions. Timing is approximate.
- **No DMA, HBlank effects, or interrupts** — `ngpc_vsync()` is the only sync point; hardware timer registers and DMA channels are accepted but do nothing.
- **No flash save or RTC** — `ngpc_flash_*` and `ngpc_rtc_*` are not implemented.
- **Substitute font** — the real BIOS sysfont is proprietary; a PIL bitmap font baked into 2bpp is used instead. Glyph shapes differ slightly.
- **`int` is 2 bytes** — matching the cc900 compiler convention. This surprises devs coming from 32-bit PC C.

---

## Project structure

```
index.html          — three-pane shell
js/
  interpreter.js    — C → JS transpiler
  vdp.js            — framebuffer renderer (tilemaps, sprites, palettes)
  runtime.js        — JS ports of NgpCraft C functions
  asset_tools.js    — in-browser PNG → sprite / tilemap converter
  ...
template/src/       — real NgpCraft headers (read-only reference)
sync_template.py    — regenerate project_data.js after header changes
sync_font.py        — regenerate font_data.js
```

---

## Part of the NgpCraft SDK

NgpCraft Live Editor is the learning and prototyping front-end for the [NgpCraft](../NgpCraft_base_template/) homebrew SDK for the Neo Geo Pocket Color.
