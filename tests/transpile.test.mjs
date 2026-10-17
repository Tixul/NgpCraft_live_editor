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
// Run with:  node --test "tests/*.test.mjs"   (Node 21+; `tests/` alone fails on Node 25)

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

  // --- Lint: HW-5 (silicon-broken inline-asm opcodes) ----------------------
  {
    // HW-cleared 2026-07-05: `ld <XR>, XWA` r+r register copies are NOT
    // silicon-broken (word D8 88..8F = retail mr_robot; long E8 88..8F is the
    // confirmed-safe long family). The old HW-5 `ld` pattern was a false
    // positive and was removed — this must now compile clean.
    name: "HW-5 stays quiet on ld XHL, XWA (HW-confirmed working copy)",
    c: 'void main(void) { __asm__("ld XHL, XWA"); }',
    shouldCompile: true,
  },
  {
    name: "HW-5 catches add WA, imm inside __asm__",
    c: 'void main(void) { __asm__("add WA, 0x0001"); }',
    shouldCompile: false,
    expectErrorRule: "HW-5",
  },
  {
    name: "HW-5 stays quiet when inline-asm contains safe ops",
    c: 'void main(void) { __asm__("ld HL, 1; add A, L; adc W, H"); }',
    shouldCompile: true,
  },
  {
    name: "HW-5 stays quiet when no inline-asm is present",
    c: "void main(void) { /* ld XHL, XWA in a comment shouldn't trigger */ }",
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

  // --- HW-6: 8-bit arithmetic widened too late (each case measured with
  //     `cc900 -S -O3 -Nb2`, 2026-10-18) ------------------------------------
  {
    name: "HW-6 catches u8 + u8 stored in u16 (Over Rev scenery)",
    c: "u8 a; u8 b; u16 r; void main(void) { r = a + b; }",
    expectErrorRule: "HW-6",
  },
  {
    name: "HW-6 catches (u16)(u8 * 4u) (shift on 8 bits)",
    c: "u8 a; u16 r; void main(void) { r = (u16)(a * 4u); }",
    expectErrorRule: "HW-6",
  },
  {
    name: "HW-6 catches (s16)(f() * 16) with f returning u8 (Ninja Gaiden)",
    c: "static u8 floor_at(u16 x) { return (u8)x; }\n" +
       "s16 y; void main(void) { y = (s16)(floor_at(41u) * 16); }",
    expectErrorRule: "HW-6",
  },
  {
    name: "HW-6 catches s16 = u8 - u8 (zero-extended)",
    c: "u8 a; u8 b; s16 d; void main(void) { d = a - b; }",
    expectErrorRule: "HW-6",
  },
  {
    name: "HW-6 catches u16 += u8 + u8",
    c: "u8 a; u8 b; u16 w; void main(void) { w += a + b; }",
    expectErrorRule: "HW-6",
  },
  {
    name: "HW-6 catches mul then add: u16 = ty * 20 + tx",
    c: "u8 tx; u8 ty; u16 m; void main(void) { m = ty * 20 + tx; }",
    expectErrorRule: "HW-6",
  },
  {
    name: "HW-6 catches u8 array elements added into u16",
    c: "u8 arr[4]; u16 w; void main(void) { w = arr[1] + arr[2]; }",
    expectErrorRule: "HW-6",
  },
  {
    name: "HW-6 catches (u16)(u8 << 9)",
    c: "u8 a; u16 w; void main(void) { w = (u16)(a << 9); }",
    expectErrorRule: "HW-6",
  },
  {
    name: "HW-6 quiet on each-term casts, wide literal, lone MUL, cast-then-shift",
    c: "u8 a; u8 b; u16 r1; u16 r2; u16 r3; u16 r4; u16 r5;\n" +
       "void main(void) {\n" +
       "  r1 = (u16)a + (u16)b;\n" +
       "  r2 = (u16)(a + 300);\n" +
       "  r3 = a * b;\n" +
       "  r4 = (u16)(a * 100);\n" +
       "  r5 = (u16)(a & 0x0Fu) << 9;\n" +
       "}",
    shouldCompile: true,
  },
  {
    name: "HW-6 quiet when the target is 8-bit or operands are 16-bit",
    c: "u8 a; u8 b; u8 c; u16 w; u16 v; void main(void) {\n" +
       "  c = a + b;\n  c = (u8)(a + 1u);\n  w = v + 10u;\n  w = (u16)(v + a);\n}",
    shouldCompile: true,
  },

  // --- HW-7: helpers that do not link / compute wrong ------------------------
  {
    name: "HW-7a catches s32 * s32 (C9H_mulls)",
    c: "s32 x; s32 y; s32 r; void main(void) { r = x * y; }",
    expectErrorRule: "HW-7a",
  },
  {
    name: "HW-7a catches s32 * s16 and (s32)a * (s32)b",
    c: "s32 x; s16 v; s16 a; s16 b; s32 r; s32 q;\n" +
       "void main(void) { r = x * v; q = (s32)a * (s32)b; }",
    expectErrorRule: "HW-7a",
  },
  {
    name: "HW-7a quiet on s32 * constant and u16 * u16",
    c: "s32 x; s32 r; u16 a; u16 b; u16 w; void main(void) { r = x * 3; w = a * b; }",
    shouldCompile: true,
  },
  {
    name: "HW-7b catches pointer subtraction on a 6-byte struct (C9H_divls)",
    c: "typedef struct { u16 a; u16 b; u16 c; } T6;\n" +
       "T6 *tp; T6 *tq; s16 d; void main(void) { d = (s16)(tp - tq); }",
    expectErrorRule: "HW-7b",
  },
  {
    name: "HW-7b quiet on u16* subtraction and 4-byte struct",
    c: "typedef struct { u16 a; u16 b; } T4;\n" +
       "u16 *p; u16 *q; T4 *tp; T4 *tq; s16 d; s16 e;\n" +
       "void main(void) { d = (s16)(p - q); e = (s16)(tp - tq); }",
    shouldCompile: true,
  },
  {
    name: "HW-7c catches u32 % n (C9H_remlu)",
    c: "u32 ux; u16 rm; void main(void) { rm = (u16)(ux % 7ul); }",
    expectErrorRule: "HW-7c",
  },
  {
    name: "HW-7c quiet on 16-bit modulo",
    c: "u32 ux; u16 rm; void main(void) { rm = (u16)ux % (u16)7; }",
    shouldCompile: true,
  },

  // --- A1: sysfont ink = palette colour 3 (BIOS SYSFONTSET ra3 = 3) -------
  {
    name: "sysfont text is drawn with palette colour 3, like the BIOS",
    runFramesAssert: ({ Interp }) => {
      // Colour 1 = red, colour 3 = green: the glyph must come out green only.
      const r = Interp.runFrames(
        `void main(void) {
           ngpc_init();
           ngpc_load_sysfont();
           ngpc_gfx_set_bg_color(RGB(0, 0, 0));
           ngpc_gfx_set_palette(GFX_SCR1, 0, RGB(0,0,0), RGB(15,0,0),
                                RGB(0,0,15), RGB(0,15,0));
           ngpc_gfx_clear(GFX_SCR1);
           ngpc_text_print(GFX_SCR1, 0, 0, 0, "HHHH");
           for(;;){ ngpc_vsync(); }
         }`,
        { frames: 2, captureFramebuffer: true }
      );
      assert.equal(r.ok, true, `runFrames failed: ${r.message ?? r.kind}`);
      const { rgba, width } = r.framebuffer;
      let green = 0, red = 0;
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 32; x++) {
          const i = (y * width + x) * 4;
          if (rgba[i + 1] > 128 && rgba[i] < 64) green++;
          if (rgba[i] > 128 && rgba[i + 1] < 64) red++;
        }
      }
      assert.ok(green > 0, "text pixels must use palette colour 3 (green)");
      assert.equal(red, 0, "no text pixel may use palette colour 1 (red)");
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
