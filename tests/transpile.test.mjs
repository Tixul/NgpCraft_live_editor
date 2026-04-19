// Fixture-based regression tests for the C → JS transpiler.
//
// Each fixture: { name, c, [expectJs], [notExpectJs], [expectErrorRule], [shouldCompile] }
//
//   c               — input C source
//   expectJs        — array of substrings that MUST appear in the transpiled JS
//   notExpectJs     — array of substrings that MUST NOT appear
//   expectErrorRule — string: lint rule that must fire (e.g. 'HW-3b')
//   shouldCompile   — boolean (default true): whether compile() should succeed
//
// Run with:  node --test tests/

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadInterp } from "./_loader.mjs";

const fixtures = [
  // --- Smoke ---------------------------------------------------------------
  {
    name: "empty main compiles",
    c: "void main(void) {}",
    expectJs: ["function main()"],
  },
  {
    name: "empty main has no yield (no vsync)",
    c: "void main(void) {}",
    notExpectJs: ["yield"],
  },

  // --- Register bareword rewrites -----------------------------------------
  // Direct register writes (HW_XXX or alias) are rewritten to W8/W16/W32
  // calls via the memory bus. Runtime functions (ngpc_gfx_*) are kept as
  // plain JS calls and resolved through buildEnv at run-time.
  {
    name: "HW_DMA0V (8-bit register) write becomes W8",
    c: "void main(void) { HW_DMA0V = 0; }",
    expectJs: ["W8(124,"],  // 0x007C = 124
  },
  {
    name: "register read becomes R8",
    c: "void main(void) { u8 v = HW_DMA0V; }",
    expectJs: ["R8(124)"],
  },

  // --- Vsync rewrite -------------------------------------------------------
  {
    name: "ngpc_vsync becomes yield",
    c: "void main(void) { ngpc_vsync(); }",
    expectJs: ["yield"],
  },
  {
    name: "main becomes generator when vsync present",
    c: "void main(void) { ngpc_vsync(); }",
    expectJs: ["function* main()"],
  },

  // --- Comments stripped ---------------------------------------------------
  {
    name: "block comments stripped",
    c: "void main(void) { /* never appears */ }",
    notExpectJs: ["never appears"],
  },
  {
    name: "line comments stripped",
    c: "void main(void) { // also gone\n}",
    notExpectJs: ["also gone"],
  },

  // --- enum rewrites -------------------------------------------------------
  {
    name: "enum becomes const lines",
    c: "enum { A, B, C }; void main(void) { u8 x = B; }",
    expectJs: ["const A", "const B", "const C"],
  },

  // --- Pointer arithmetic --------------------------------------------------
  {
    name: "pointer cast rewritten",
    c: "void main(void) { u8 *p = (u8*)0x4000; }",
    expectJs: ["PTR("],
  },

  // --- Lint: HW-3b (for-decl) ----------------------------------------------
  {
    name: "HW-3b detects for(int i=...)",
    c: "void main(void) { for (int i = 0; i < 3; i++) {} }",
    shouldCompile: false,
    expectErrorRule: "HW-3b",
  },
  {
    name: "for(i=...) without decl passes",
    c: "void main(void) { int i; for (i = 0; i < 3; i++) {} }",
    shouldCompile: true,
  },

  // --- Lint: HW-3c (s8 OR chain) -------------------------------------------
  {
    name: "HW-3c detects s8 OR chain",
    c: "void main(void) { s8 a,b,c,d; if (a != b || c != d) {} }",
    shouldCompile: false,
    expectErrorRule: "HW-3c",
  },
  {
    name: "single inequality passes HW-3c",
    c: "void main(void) { s8 a,b; if (a != b) {} }",
    shouldCompile: true,
  },

  // --- Lint: HW-4 (large stack array) --------------------------------------
  {
    name: "HW-4 detects large stack array",
    c: "void main(void) { u8 buf[2400]; buf[0] = 1; }",
    shouldCompile: false,
    expectErrorRule: "HW-4",
  },
  {
    name: "static large array passes HW-4",
    c: "void main(void) { static u8 buf[2400]; buf[0] = 1; }",
    shouldCompile: true,
  },
  {
    name: "file-scope large array passes HW-4",
    c: "static u8 buf[2400]; void main(void) { buf[0] = 1; }",
    shouldCompile: true,
  },
  {
    name: "small stack array passes HW-4",
    c: "void main(void) { u8 buf[64]; }",
    shouldCompile: true,
  },

  // --- StarGunner mini pattern (regression for HW-3d false positive) -------
  {
    name: "StarGunner pattern: decls at top of for-body (no false positive)",
    c: `static void load_palettes(const u16 *pals, u8 base, u8 count) {
            u8 i;
            for (i = 0; i < count; i++) {
                u16 c0 = pals[i * 4 + 0];
                u16 c1 = pals[i * 4 + 1];
                u16 c2 = pals[i * 4 + 2];
                u16 c3 = pals[i * 4 + 3];
                ngpc_gfx_set_palette(GFX_SPR, (u8)(base + i), c0, c1, c2, c3);
            }
        }
        void main(void) { load_palettes(0, 0, 0); }`,
    shouldCompile: true,
  },

  // --- runFrames behaviour -------------------------------------------------
  {
    name: "runFrames with vsync drives generator",
    runFramesAssert: ({ Interp }) => {
      const r = Interp.runFrames(
        "void main(void) { ngpc_gfx_set_bg_color(RGB(7,7,7)); for(;;){ ngpc_vsync(); } }",
        { frames: 5, captureFramebuffer: false }
      );
      assert.equal(r.ok, true);
      assert.equal(r.framesAdvanced, 5);
      assert.equal(r.mainCompleted, false);
      assert.equal(r.state.bgColor, 0x777);
    },
  },
  {
    name: "runFrames captures framebuffer when requested",
    runFramesAssert: ({ Interp }) => {
      const r = Interp.runFrames(
        "void main(void) { ngpc_gfx_set_bg_color(RGB(0,0,15)); }",
        { frames: 1, captureFramebuffer: true }
      );
      assert.equal(r.ok, true);
      assert.ok(r.framebuffer, "framebuffer must be present");
      assert.equal(r.framebuffer.width, 160);
      assert.equal(r.framebuffer.height, 152);
      assert.equal(r.framebuffer.rgba.length, 160 * 152 * 4);
    },
  },

  // --- PSG event log (Tier 3 #10) -----------------------------------------
  {
    name: "PSG event log captures Sfx_Play writes",
    runFramesAssert: ({ Interp }) => {
      // Sfx_Play(1) emits a tone+attn sequence on channel 0.
      const r = Interp.runFrames(
        "void main(void) { Sounds_Init(); Sfx_Play(1); }",
        { frames: 1, capturePsgEvents: true, captureFramebuffer: false }
      );
      assert.equal(r.ok, true, `runFrames failed: ${r.message ?? r.kind}`);
      assert.ok(Array.isArray(r.psgEvents), "psgEvents must be an array");
      // Should contain at least one tone or attn event after Sfx_Play.
      const hasToneOrAttn = r.psgEvents.some(
        (e) => e.type === "tone" || e.type === "attn"
      );
      assert.ok(hasToneOrAttn,
        `expected tone/attn event, got: ${JSON.stringify(r.psgEvents).slice(0, 200)}`);
    },
  },
];

const { Interp } = loadInterp();

for (const f of fixtures) {
  test(f.name, () => {
    if (f.runFramesAssert) {
      f.runFramesAssert({ Interp });
      return;
    }

    const expectError = f.expectErrorRule || f.shouldCompile === false;

    let js = null;
    let err = null;
    try {
      js = Interp.compile(f.c);
    } catch (e) {
      err = e;
    }

    if (expectError) {
      assert.ok(err, `expected compile() to throw, but it returned JS`);
      if (f.expectErrorRule) {
        assert.equal(err.name, "HwFidelityError",
          `expected HwFidelityError, got ${err.name}: ${err.message}`);
        const rules = (err.hwErrors || []).map((e) => e.rule);
        assert.ok(rules.includes(f.expectErrorRule),
          `expected rule ${f.expectErrorRule} in [${rules.join(", ")}]`);
      }
    } else {
      assert.equal(err, null,
        `unexpected compile error: ${err?.message ?? ""}`);
      if (f.expectJs) {
        for (const sub of f.expectJs) {
          assert.ok(js.toLowerCase().includes(sub.toLowerCase()),
            `expected JS to include "${sub}"\n--- transpiled ---\n${js.slice(0, 500)}…`);
        }
      }
      if (f.notExpectJs) {
        for (const sub of f.notExpectJs) {
          assert.ok(!js.includes(sub),
            `JS should NOT include "${sub}"\n--- transpiled ---\n${js.slice(0, 500)}…`);
        }
      }
    }
  });
}
