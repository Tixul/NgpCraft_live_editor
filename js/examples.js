// Curated C89 / cc900-compatible examples for the live editor.
// Each entry appears in the UI's "Load example" dropdown; selecting one either
// replaces src/main.c or imports a full multi-file project bundle.
//
// Ordering is pedagogical: the first few show the minimum bring-up every
// program needs; later ones introduce new APIs one at a time. Every example
// uses the real NgpCraft API and runs on real hardware — no emulator-only
// idioms, no debug-only wrappers.
//
// Common bring-up pattern (appears in almost every example):
//
//   ngpc_init();                 // resets VDP/DMA/IRQs, zeroes VRAM
//   ngpc_load_sysfont();         // BIOS 8x8 font into tiles 32..127  (text only)
//   ngpc_gfx_set_bg_color(...);  // colour around the active window (BG0 reg)
//   ngpc_gfx_set_palette(plane, id, c0, c1, c2, c3);   // 2bpp palette (color 0 = transparent on planes)
//   ngpc_gfx_clear(GFX_SCR1);    // fill scroll plane 1 with blank tile 0
//   ngpc_gfx_clear(GFX_SCR2);    // plane 2 (front layer) — clear too or you get garbage
//   ngpc_gfx_scroll(GFX_SCR1, 0, 0);
//   ngpc_gfx_scroll(GFX_SCR2, 0, 0);
//   ngpc_sprite_hide_all();      // y=0 + invis on all 64 hardware sprites
//
// Main loop pattern:
//
//   while (1) {
//       ngpc_vsync();                         // wait VBlank — unlocks 60 Hz
//       ngpc_input_update();                  // read HW_JOYPAD, update ngpc_pad_*
//       if (USR_SHUTDOWN) ngpc_shutdown();    // honour BIOS power-off request
//       /* game logic */
//       /* drawing */
//   }

const NGPC_EXAMPLES = [
  {
    id: 'minimal',
    label: '01 — Hello, NGPC!',
    body: `/*
 * SMALLEST USEFUL PROGRAM.
 *
 * Puts "Hello, NGPC!" on screen. Everything you need to know:
 *
 *   - ngpc_init()          resets the video chip, clears VRAM, wires the
 *                          VBlank interrupt, enables interrupts. Always first.
 *   - ngpc_load_sysfont()  uploads the BIOS 8x8 ASCII font into tile slots
 *                          32..127. Required before any ngpc_text_* call
 *                          (a letter character 'A' is tile 'A' = 65).
 *   - ngpc_gfx_set_bg_color(RGB(r,g,b))
 *                          sets the colour of the border / of any area not
 *                          covered by a plane or sprite. RGB() packs 3 nibbles
 *                          (0..15 each) into one 12-bit word (RGB444).
 *   - ngpc_gfx_set_palette(plane, pal_id, c0, c1, c2, c3)
 *                          writes a 4-colour 2bpp palette. Colour 0 is used
 *                          for "transparent" on scroll planes and sprites.
 *                          plane = GFX_SCR1 | GFX_SCR2 | GFX_SPR.
 *                          pal_id is 0..15; tiles pick their palette via the
 *                          map word or the sprite OAM byte.
 *   - ngpc_gfx_clear(plane) writes blank tile 0 over the whole 32x32 tilemap.
 *   - ngpc_text_print(plane, pal, col, row, "text")
 *                          draws a string at tile coordinates (col, row).
 *                          The screen is 20 tiles wide and 19 tall (160x152 px).
 *
 * The last while(1) + ngpc_vsync() just parks the CPU. Without it main()
 * returns and the runtime stops animating, so nothing is visible.
 */

#include "ngpc_sys.h"
#include "ngpc_gfx.h"
#include "ngpc_text.h"

void main(void)
{
    /* --- Bring-up (always in this order) --- */
    ngpc_init();
    ngpc_load_sysfont();

    ngpc_gfx_set_bg_color(RGB(0, 0, 6));

    /* Palette 0 on scroll plane 1: colour 0 transparent, 1 white, 2 green, 3 cyan.
     * The font tiles use palette colour 1 for the glyph strokes, so white
     * text = colour 1 = RGB(15, 15, 15). */
    ngpc_gfx_set_palette(GFX_SCR1, 0,
                         RGB(0, 0, 0), RGB(15, 15, 15),
                         RGB(0, 15, 0), RGB(0, 15, 15));
    ngpc_gfx_clear(GFX_SCR1);

    /* (col=4, row=9) → near-centre of a 20x19 text grid. */
    ngpc_text_print(GFX_SCR1, 0, 4, 9, "Hello, NGPC!");

    /* Keep the program alive — the runtime needs a vsync loop to keep
     * animating. Without it the static image might still render, but you
     * lose the 60 Hz heartbeat every real game needs. */
    while (1) {
        ngpc_vsync();
    }
}
`,
  },

  {
    id: 'sprite-move',
    label: '02 — Main loop, input, sprite',
    body: `/*
 * THE STANDARD NGPC MAIN LOOP.
 *
 * Every interactive program has the same skeleton:
 *
 *   init → while (1) { vsync; read input; update; draw; }
 *
 * This example teaches the three new APIs you need for that loop:
 *
 *   - ngpc_vsync()         blocks until the next VBlank interrupt → frame-
 *                          locked to 60 Hz. Put it FIRST inside the loop so
 *                          the previous frame is shown for exactly one frame.
 *   - ngpc_input_update()  latches HW_JOYPAD (0x6F82) into three u8 globals:
 *                            ngpc_pad_held      — buttons currently down
 *                            ngpc_pad_pressed   — just went down this frame
 *                            ngpc_pad_released  — just went up this frame
 *                          Mask with PAD_LEFT | PAD_RIGHT | PAD_UP | PAD_DOWN
 *                          | PAD_A | PAD_B | PAD_OPTION.
 *   - ngpc_sprite_set(id, x, y, tile, pal, flags)
 *                          pokes hardware sprite slot "id" (0..63). (x, y)
 *                          are pixel positions; tile is a VRAM tile index
 *                          (0..511); pal is sprite palette 0..15; flags
 *                          carries SPR_FRONT / SPR_BACK + optional HFLIP/VFLIP.
 *
 * Because ngpc_load_sysfont() uploaded the font at tile 32..127, we can use
 * ASCII codepoints directly as tile numbers: tile 'O' draws an O glyph.
 *
 * Controls (click the canvas first so it has keyboard focus):
 *   Arrows / WASD : move the cursor 'O'
 *   Z / Space     : A   — counts presses
 *   X / Shift     : B   — toggle LCD inversion (HW_LCD_CTL bit 7)
 */

#include "ngpc_sys.h"
#include "ngpc_gfx.h"
#include "ngpc_sprite.h"
#include "ngpc_text.h"
#include "ngpc_input.h"

void main(void)
{
    u8 x = 76, y = 72;        /* sprite pos — screen is 160x152 */
    u8 press_count = 0;

    ngpc_init();
    ngpc_load_sysfont();

    ngpc_gfx_set_bg_color(RGB(0, 0, 6));

    /* Text palette on plane 1, sprite palette on GFX_SPR. */
    ngpc_gfx_set_palette(GFX_SCR1, 0,
                         RGB(0, 0, 0), RGB(15, 15, 15),
                         RGB(0, 15, 0), RGB(0, 15, 15));
    ngpc_gfx_set_palette(GFX_SPR, 0,
                         RGB(0, 0, 0), RGB(15, 15, 0),
                         RGB(15, 8, 0), RGB(15, 0, 0));

    ngpc_gfx_clear(GFX_SCR1);
    ngpc_gfx_clear(GFX_SCR2);
    ngpc_sprite_hide_all();

    /* Static HUD text — drawn once, the tilemap keeps it on screen. */
    ngpc_text_print(GFX_SCR1, 0, 1, 1, "ARROWS: MOVE");
    ngpc_text_print(GFX_SCR1, 0, 1, 2, "Z: A   X: B");
    ngpc_text_print(GFX_SCR1, 0, 1, 4, "A PRESSES:");

    while (1) {
        /* 1 — synchronise to VBlank (frame-lock). */
        ngpc_vsync();

        /* 2 — sample input. ngpc_pad_* are valid until the next call. */
        ngpc_input_update();

        /* 3 — honour power-button shutdown request from BIOS. */
        if (USR_SHUTDOWN) ngpc_shutdown();

        /* 4 — game logic. "pressed" = edge-detected one-shot. */
        if (ngpc_pad_pressed & PAD_A) press_count++;
        if (ngpc_pad_pressed & PAD_B) HW_LCD_CTL ^= 0x80;  /* invert LCD */

        /* "held" repeats every frame → continuous motion while held. */
        if (ngpc_pad_held & PAD_LEFT)  x--;
        if (ngpc_pad_held & PAD_RIGHT) x++;
        if (ngpc_pad_held & PAD_UP)    y--;
        if (ngpc_pad_held & PAD_DOWN)  y++;

        /* 5 — draw. Sprite slot 0 = the cursor. Tile 'O' = ASCII 79. */
        ngpc_sprite_set(0, x, y, 'O', 0, SPR_FRONT);
        ngpc_text_print_dec(GFX_SCR1, 0, 12, 4, press_count, 3);
    }
}
`,
  },

  {
    id: 'pointer-vram',
    label: '03 — Pointers & raw VRAM (tile format)',
    body: `/*
 * HOW TILES ARE STORED IN VRAM.
 *
 * The NGPC tilemap chip (K2GE) stores each 8x8 tile as 16 bytes (8 rows of
 * 2 bytes). Each row is 4 bits per pixel on disk? No — 2 bits per pixel,
 * packed 2 pixels per byte. Byte 0 of a row = the LEFT 4 pixels, byte 1 =
 * the RIGHT 4 pixels, but each byte is read high-nibble-first:
 *
 *   byte layout of one row (8 pixels wide):
 *
 *     byte 0 : [p0 p1 p2 p3]    byte 1 : [p4 p5 p6 p7]
 *               hi         lo
 *
 *   Each p is 2 bits → colour index 0..3 into the tile's palette.
 *
 * Tile RAM starts at 0xA000. Tile index N lives at 0xA000 + N*16.
 *
 * We fill tile 1 with the byte 0x55 = binary 01 01 01 01 — every 2-bit pair
 * is colour 1, so the whole tile is solid "colour 1" (red here).
 *
 * The four pointer primitives every asset loader uses:
 *
 *     u8 *p = (u8*)ADDR;   cast an absolute address into a byte pointer
 *     *p = VAL;            write through the pointer (indirection)
 *     p[i] = VAL;          array-style indexing (same as *(p + i))
 *     p++ / p += N;        advance by N * sizeof(*p) bytes
 *
 * Watch the CPU budget meter on the right — walking 16 bytes is trivial, but
 * a full-screen pixel write (160x152 ÷ 4 bytes per pixel-pair) burns fast.
 */

#include "ngpc_sys.h"
#include "ngpc_gfx.h"
#include "ngpc_sprite.h"

void main(void)
{
    u8 *tile1;   /* byte pointer into tile RAM  */
    u8  i;

    ngpc_init();

    /* Clean slate — no sysfont, no text, just raw tiles + sprites. */
    ngpc_gfx_set_bg_color(RGB(0, 0, 4));
    ngpc_gfx_set_palette(GFX_SPR, 0,
                         RGB(0, 0, 0), RGB(15, 0, 0),
                         RGB(0, 15, 0), RGB(0, 0, 15));
    ngpc_gfx_clear(GFX_SCR1);
    ngpc_gfx_clear(GFX_SCR2);
    ngpc_sprite_hide_all();

    /* Tile 1 lives at 0xA000 + 1*16 = 0xA010. It is 16 bytes.
     * 0x55 = 01 01 01 01 in binary → every 2-bit pair = colour 1 (red). */
    tile1 = (u8*)(0xA000 + 16);
    for (i = 0; i < 16; i++) {
        *tile1 = 0x55;
        tile1++;                  /* advances by 1 byte (sizeof(u8) == 1) */
    }

    /* Show that tile as a sprite, slot 0, centred, front layer. */
    ngpc_sprite_set(0, 76, 72, 1, 0, SPR_FRONT);

    /* No logic to run — just park. */
    while (1) {
        ngpc_vsync();
    }
}
`,
  },

  {
    id: 'tilemap-scroll',
    label: '04 — Tilemap + scrolling',
    body: `/*
 * CUSTOM TILE → TILEMAP → HARDWARE SCROLL.
 *
 * Demonstrates three APIs you will use in every game with a background:
 *
 *   - ngpc_gfx_load_tiles_at(data, count, offset)
 *                       uploads "count" u16 words into tile RAM starting at
 *                       VRAM tile index "offset". 8 words == one tile.
 *                       "data" is declared with NGP_FAR because const arrays
 *                       live in the cartridge ROM at 0x200000+, which is out
 *                       of the default 16-bit (near) pointer range.
 *   - ngpc_gfx_fill(plane, tile, pal)
 *                       write the same (tile, pal) into every cell of the
 *                       32x32 tilemap of that plane. The 4-LSB of the map
 *                       word is the palette id; the rest is the tile index.
 *   - ngpc_gfx_scroll(plane, x, y)
 *                       moves the plane 0..255 pixels horizontally/vertically.
 *                       The tilemap is 256x256 pixels so it wraps cleanly.
 *
 * Every 30 frames we rewrite palette 0 — this is how classic 8/16-bit games
 * do cheap animation (colour cycling) without touching any tile data.
 */

#include "ngpc_sys.h"
#include "ngpc_gfx.h"

/* One custom tile, diagonal stripe. 8 rows * 2 bytes → 8 u16 words.
 * Each nibble is a colour index:  0=transparent, 1=fg, 2=fg2, 3=fg3.
 * For a simple stripe we use colour 1 in a different column on each row. */
const u16 NGP_FAR stripes[8] = {
    0x4000, 0x1000, 0x0400, 0x0100,
    0x0040, 0x0010, 0x0004, 0x0001
};

void main(void)
{
    u8 scroll_x = 0;
    u8 pal_idx  = 0;
    u8 frame    = 0;

    ngpc_init();

    ngpc_gfx_set_bg_color(RGB(0, 0, 0));
    /* Initial palette 0: transparent + red + orange + yellow. */
    ngpc_gfx_set_palette(GFX_SCR1, 0,
                         RGB(0, 0, 0), RGB(15, 0, 0),
                         RGB(15, 8, 0), RGB(15, 15, 0));

    ngpc_gfx_clear(GFX_SCR1);
    ngpc_gfx_clear(GFX_SCR2);
    ngpc_sprite_hide_all();

    /* Upload the custom stripe into VRAM tile slot 1 (slot 0 must stay blank). */
    ngpc_gfx_load_tiles_at(stripes, 8, 1);

    /* Fill the whole 32x32 plane-1 tilemap with (tile=1, pal=0). */
    ngpc_gfx_fill(GFX_SCR1, 1, 0);

    while (1) {
        ngpc_vsync();

        /* Horizontal scroll. Wraps at 256 because u8 overflows. */
        scroll_x++;
        ngpc_gfx_scroll(GFX_SCR1, scroll_x, 0);

        /* Every 30 frames (~0.5 s) cycle to the next palette variation.
         * ngpc_log_hex writes a labelled hex value to the live editor's
         * log panel — a free debug print. Stripped by the compiler on HW. */
        if ((frame % 30) == 0) {
            pal_idx = (pal_idx + 1) & 3;
            ngpc_log_hex("palette", pal_idx);
            if (pal_idx == 0) {
                ngpc_gfx_set_palette(GFX_SCR1, 0,
                    RGB(0,0,0), RGB(15, 0, 0), RGB(15,8,0), RGB(15,15,0));
            } else if (pal_idx == 1) {
                ngpc_gfx_set_palette(GFX_SCR1, 0,
                    RGB(0,0,0), RGB(15,15, 0), RGB(15,8,0), RGB(15,15,0));
            } else if (pal_idx == 2) {
                ngpc_gfx_set_palette(GFX_SCR1, 0,
                    RGB(0,0,0), RGB( 0,15, 0), RGB(15,8,0), RGB(15,15,0));
            } else {
                ngpc_gfx_set_palette(GFX_SCR1, 0,
                    RGB(0,0,0), RGB( 0, 0,15), RGB(15,8,0), RGB(15,15,0));
            }
        }
        frame++;
    }
}
`,
  },

  {
    id: 'sine',
    label: '05 — Sine-wave motion (math + timing)',
    body: `/*
 * SMOOTH MOTION WITH A LOOKUP TABLE.
 *
 * The NGPC has no FPU. For curved motion we use a precomputed 256-entry
 * sine table exposed by the template:
 *
 *   s8 ngpc_sin(u8 angle);   // -127..+127 for angle 0..255 (full turn)
 *   s8 ngpc_cos(u8 angle);   // same table, offset 64
 *
 * "angle" wraps automatically (u8 overflow) so you never need modulo.
 *
 * g_vb_counter is a template-provided  extern volatile u8  incremented by
 * the VBlank ISR — perfect to drive time-based motion without your own
 * counter. Overflow wraps cleanly as well.
 *
 * Integer math rule of thumb: multiply BEFORE dividing to keep precision.
 *   amplitude * sin / 127   → 0..amplitude range.
 */

#include "ngpc_sys.h"
#include "ngpc_gfx.h"
#include "ngpc_sprite.h"

void main(void)
{
    s16 x, y;
    u8  angle;

    ngpc_init();
    ngpc_load_sysfont();

    ngpc_gfx_set_bg_color(RGB(0, 0, 4));
    ngpc_gfx_set_palette(GFX_SPR, 0,
                         RGB(0, 0, 0), RGB(15, 15, 0),
                         RGB(15, 0, 0), RGB(0, 15, 0));
    ngpc_gfx_clear(GFX_SCR1);
    ngpc_gfx_clear(GFX_SCR2);
    ngpc_sprite_hide_all();

    while (1) {
        ngpc_vsync();

        /* 3 angle steps per frame → 256/3 ≈ 85 frames → ~1.4 s per full loop. */
        angle = g_vb_counter * 3;

        /* Parametric Lissajous curve: x uses sin(), y uses cos() → circle/oval.
         * Amplitude 60 horizontally, 40 vertically → fits the 160x152 screen. */
        x = 80 + ((s16)ngpc_sin(angle) * 60) / 127;
        y = 72 + ((s16)ngpc_cos(angle) * 40) / 127;

        ngpc_sprite_set(0, (u8)x, (u8)y, '@', 0, SPR_FRONT);
    }
}
`,
  },

  {
    id: 'bitmap',
    label: '06 — Bitmap drawing (pixel / line / rect)',
    body: `/*
 * SOFTWARE BITMAP MODE.
 *
 * Tile-based rendering is fast but coarse. When you need per-pixel art
 * (particle effects, plotters, debug overlays) the template offers a bitmap
 * wrapper that dedicates a stretch of tile RAM to act as a flat pixel buffer:
 *
 *   ngpc_bmp_init(plane, tile_offset, pal)
 *                    reserves 380 consecutive tiles starting at tile_offset
 *                    on "plane", paints the plane's tilemap to index into
 *                    them, and uses palette "pal" for every drawn pixel.
 *                    Screen is 160x152 = 20x19 tiles = 380 tiles. 2bpp.
 *   ngpc_bmp_pixel(x, y, color)       set one pixel (colour 0..3).
 *   ngpc_bmp_line(x1, y1, x2, y2, c)  Bresenham line.
 *   ngpc_bmp_rect(x, y, w, h, c)      hollow rectangle.
 *   ngpc_bmp_fill_rect(x, y, w, h, c) filled rectangle.
 *   ngpc_bmp_hline / vline / clear    straightforward.
 *
 * All functions take u8 coordinates — valid range is 0..159 for x and
 * 0..151 for y. Out-of-range calls hit a bounds guard and warn in the log.
 *
 * Budget meter tip: full-screen fills cost ~6000 memory ops — keep an eye
 * on the "CPU" bar while iterating.
 */

#include "ngpc_sys.h"
#include "ngpc_gfx.h"

void main(void)
{
    u8 i;

    ngpc_init();

    ngpc_gfx_set_bg_color(RGB(0, 0, 0));
    /* Bitmap palette: black / white / cyan / magenta. */
    ngpc_gfx_set_palette(GFX_SCR1, 0,
                         RGB(0, 0, 0), RGB(15, 15, 15),
                         RGB(0, 15, 15), RGB(15, 0, 15));
    ngpc_gfx_clear(GFX_SCR2);
    ngpc_sprite_hide_all();

    /* Reserve tiles 1..380 on SCR1 for the bitmap. Uses palette 0.
     * After this call, ngpc_bmp_* paints into those tiles. */
    ngpc_bmp_init(GFX_SCR1, 1, 0);

    /* Starburst from screen centre (80, 76) to every 7th pixel along the top
     * (y=4) and bottom (y=151) edges. 23 steps stay inside the 160-wide
     * bitmap (i*7 max = 154). Colour 1 above, colour 2 below. */
    for (i = 0; i < 23; i++) {
        ngpc_bmp_line(80, 76, (u8)(i * 7), 4,   1);
        ngpc_bmp_line(80, 76, (u8)(i * 7), 151, 2);
    }

    /* A hollow colour-3 rectangle framing a filled colour-1 block. */
    ngpc_bmp_rect(20, 20, 120, 40, 3);
    ngpc_bmp_fill_rect(40, 28, 80, 24, 1);

    /* Static image — vsync-park. */
    while (1) {
        ngpc_vsync();
    }
}
`,
  },

  {
    id: 'state-machine',
    label: '07 — State machine (function pointers)',
    body: `/*
 * HOW TO STRUCTURE A GAME LOOP WITH MULTIPLE SCREENS.
 *
 * Every NGPC game has at least TITLE → PLAY → GAME_OVER. A function-pointer
 * table is the classic way to dispatch:
 *
 *   typedef void (*StateFn)(void);
 *   const StateFn states[N_STATES] = { state_title, state_play, state_over };
 *   states[current]();                 // one indirect call per frame
 *
 * The compiler translates the table lookup into one load + one call, same
 * cost as a hand-written switch but with cleaner source.
 *
 * This demo draws a different title each state and lets A cycle through them.
 * We re-render only when the state actually changes (prev != current) — no
 * point repainting identical text every frame.
 *
 *   Z / Space : A → next state
 */

#include "ngpc_sys.h"
#include "ngpc_gfx.h"
#include "ngpc_text.h"
#include "ngpc_input.h"

typedef enum { S_INTRO, S_PLAY, S_OVER, S_COUNT } GameState;
typedef void (*StateFn)(void);

static GameState current;

/* Helper: clear the text plane and print the title centred-ish. */
static void draw_screen(const char *title)
{
    ngpc_gfx_clear(GFX_SCR1);
    ngpc_text_print(GFX_SCR1, 0, 4, 4,  title);
    ngpc_text_print(GFX_SCR1, 0, 3, 10, "press A");
}

void state_intro(void) { draw_screen("INTRO");      }
void state_play (void) { draw_screen("PLAYING");    }
void state_over (void) { draw_screen("GAME OVER");  }

/* Dispatch table — indexed by the enum. Order must match S_INTRO..S_OVER. */
const StateFn states[S_COUNT] = {
    state_intro, state_play, state_over
};

void main(void)
{
    GameState prev;

    ngpc_init();
    ngpc_load_sysfont();

    ngpc_gfx_set_bg_color(RGB(0, 0, 6));
    ngpc_gfx_set_palette(GFX_SCR1, 0,
                         RGB(0, 0, 0), RGB(15, 15, 15),
                         RGB(0, 15, 0), RGB(15, 0, 0));
    ngpc_gfx_clear(GFX_SCR1);
    ngpc_gfx_clear(GFX_SCR2);
    ngpc_sprite_hide_all();

    current = S_INTRO;
    prev    = S_COUNT;     /* sentinel — forces a redraw on the first frame */

    while (1) {
        ngpc_vsync();
        ngpc_input_update();
        if (USR_SHUTDOWN) ngpc_shutdown();

        /* Redraw only on state change — saves CPU. */
        if (current != prev) {
            states[current]();
            prev = current;
        }

        /* A advances to the next state; wrap at S_COUNT. */
        if (ngpc_pad_pressed & PAD_A) {
            current = (current + 1) % S_COUNT;
        }
    }
}
`,
  },

  {
    id: 'png-assets',
    label: '08 — PNG assets pipeline (BG + sprite)',
    body: `/*
 * REAL ASSETS VIA THE CONVERTER TOOLS.
 *
 * This is how a real game loads graphics. The arrays below are the verbatim
 * output of the NgpCraft Python exporters:
 *
 *   tools/ngpc_tilemap.py Bg_grass.png        → grass_tiles + grass_map + palette
 *   tools/ngpc_sprite_export.py car_01.png    → car_tiles + palette
 *
 * In a production project they live in their own .c/.h files (one pair per
 * asset) and are included via the header; they are inlined here so the
 * example fits in a single tab.
 *
 * Key ideas:
 *
 *   - Palettes from the converter are already RGB444 u16 words — write them
 *     straight into HW_PAL_SCR1 / HW_PAL_SPR arrays (one palette = 4 words).
 *   - Tile indices are the DESTINATION VRAM slots chosen by YOU (the BG
 *     gets slots 0..3, the sprite gets 128..131). The converter does not
 *     know where you will place them.
 *   - A 16x16 sprite is NOT one hardware sprite. It is four 8x8 tiles in a
 *     2x2 layout, drawn with four ngpc_sprite_set() calls at +0/+8 offsets.
 *     (Example 09 shows how NgpcMetasprite automates this.)
 *
 *   Arrows / WASD : drive the car around
 */

#include "ngpc_sys.h"
#include "ngpc_gfx.h"
#include "ngpc_sprite.h"
#include "ngpc_input.h"

/* ===== ngpc_tilemap.py output — Bg_grass_cropped.png =====
 * 4 unique tiles, 1 palette, 20x20 tile map (only 20x19 visible). */
const u16 grass_palette[4] = { 0x0000, 0x0183, 0x01C5, 0x0000 };

const u16 NGP_FAR grass_tiles[32] = {
    0x5565, 0x5555, 0x9555, 0x5555, 0x5595, 0x5555, 0x5555, 0x555A,
    0x6555, 0x5555, 0x5565, 0x5555, 0x5555, 0x5556, 0x5555, 0x5555,
    0x5555, 0x5555, 0x5556, 0x5555, 0x5555, 0x5595, 0x5555, 0x5555,
    0x5556, 0x5556, 0x5555, 0x5559, 0x5559, 0x5555, 0x5555, 0x5655
};

const u16 grass_map[400] = {
    0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,
    2,3,2,3,2,3,2,3,2,3,2,3,2,3,2,3,2,3,2,3,
    0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,
    2,3,2,3,2,3,2,3,2,3,2,3,2,3,2,3,2,3,2,3,
    0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,
    2,3,2,3,2,3,2,3,2,3,2,3,2,3,2,3,2,3,2,3,
    0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,
    2,3,2,3,2,3,2,3,2,3,2,3,2,3,2,3,2,3,2,3,
    0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,
    2,3,2,3,2,3,2,3,2,3,2,3,2,3,2,3,2,3,2,3,
    0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,
    2,3,2,3,2,3,2,3,2,3,2,3,2,3,2,3,2,3,2,3,
    0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,
    2,3,2,3,2,3,2,3,2,3,2,3,2,3,2,3,2,3,2,3,
    0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,
    2,3,2,3,2,3,2,3,2,3,2,3,2,3,2,3,2,3,2,3,
    0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,
    2,3,2,3,2,3,2,3,2,3,2,3,2,3,2,3,2,3,2,3,
    0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,
    2,3,2,3,2,3,2,3,2,3,2,3,2,3,2,3,2,3,2,3
};

/* ===== ngpc_sprite_export.py output — car_01.png =====
 * 4 tiles arranged 2x2 → one 16x16 metasprite. */
const u16 car_palette[4] = { 0x0000, 0x0000, 0x000D, 0x0D00 };

const u16 NGP_FAR car_tiles[32] = {
    0x0015, 0x0076, 0x019A, 0x05AA, 0x05A5, 0x059F, 0x017D, 0x0156,
    0x5400, 0x9D00, 0xA640, 0xAA50, 0x5A50, 0xF650, 0x7D40, 0x9540,
    0x0199, 0x019A, 0x0165, 0x05AA, 0x0595, 0x056A, 0x01DA, 0x0055,
    0x6640, 0xA640, 0x5940, 0xAA50, 0x5650, 0xA950, 0xA740, 0x5500
};

void main(void)
{
    u16 map_i;
    u8 x = 72, y = 68;
    u8 tx, ty;

    ngpc_init();

    ngpc_gfx_set_bg_color(RGB(0, 2, 0));
    ngpc_gfx_clear(GFX_SCR1);
    ngpc_gfx_clear(GFX_SCR2);
    ngpc_sprite_hide_all();

    /* Converter palettes are already RGB444 words — direct register write.
     * HW_PAL_SCR1 and HW_PAL_SPR are u16 arrays (16 palettes × 4 words). */
    HW_PAL_SCR1[0] = grass_palette[0];
    HW_PAL_SCR1[1] = grass_palette[1];
    HW_PAL_SCR1[2] = grass_palette[2];
    HW_PAL_SCR1[3] = grass_palette[3];

    HW_PAL_SPR[0] = car_palette[0];
    HW_PAL_SPR[1] = car_palette[1];
    HW_PAL_SPR[2] = car_palette[2];
    HW_PAL_SPR[3] = car_palette[3];

    /* Upload tile bitmaps. BG at 0..3, sprite at 128..131.
     * (Slots 32..127 are reserved by the sysfont if it was loaded.) */
    ngpc_gfx_load_tiles_at(grass_tiles, 32, 0);
    ngpc_gfx_load_tiles_at(car_tiles,   32, 128);

    /* Paint the 20x19 visible tilemap from the indices in grass_map[]. */
    for (ty = 0; ty < 19; ty++) {
        for (tx = 0; tx < 20; tx++) {
            map_i = ty * 20 + tx;
            ngpc_gfx_put_tile(GFX_SCR1, tx, ty, grass_map[map_i], 0);
        }
    }

    while (1) {
        ngpc_vsync();
        ngpc_input_update();
        if (USR_SHUTDOWN) ngpc_shutdown();

        /* Clamp to the active 160x152 window, minus the 16-pixel sprite size. */
        if ((ngpc_pad_held & PAD_LEFT)  && x > 0)   x--;
        if ((ngpc_pad_held & PAD_RIGHT) && x < 144) x++;
        if ((ngpc_pad_held & PAD_UP)    && y > 0)   y--;
        if ((ngpc_pad_held & PAD_DOWN)  && y < 136) y++;

        /* 16x16 metasprite by hand = 4 hardware sprites arranged 2x2. */
        ngpc_sprite_set(0, x,     y,     128, 0, SPR_FRONT);
        ngpc_sprite_set(1, x + 8, y,     129, 0, SPR_FRONT);
        ngpc_sprite_set(2, x,     y + 8, 130, 0, SPR_FRONT);
        ngpc_sprite_set(3, x + 8, y + 8, 131, 0, SPR_FRONT);
    }
}
`,
  },

  {
    id: 'anim-sprite',
    label: '09 — Metasprites + directional rotation',
    body: `/*
 * METASPRITE STRUCT + HFLIP FOR CHEAP DIRECTIONAL ART.
 *
 * Example 08 built a 16x16 sprite by calling ngpc_sprite_set() four times.
 * That gets old fast — in real games we use NgpcMetasprite, a read-only
 * struct produced by the sprite exporter:
 *
 *   typedef struct {
 *       u8 count;              // number of hardware sprites (here always 4)
 *       u8 w, h;               // bounding box in pixels
 *       struct { s8 ox, oy; u16 tile; u8 pal, flags; } parts[MAX];
 *   } NgpcMetasprite;
 *
 *   ngpc_mspr_draw(slot_start, x, y, &frame, flags);
 *
 * One call → N hardware sprites written, with per-part flip / priority mixed
 * in. We export the car as 5 rotation frames (UP → UP-RIGHT → RIGHT →
 * DOWN-RIGHT → DOWN); the LEFT-side directions are the right-side frames
 * rendered with SPR_HFLIP, so we save 3 frames' worth of VRAM.
 *
 *     frame 0 : UP       frame 1 : UP-RIGHT     (HFLIP → UP-LEFT)
 *     frame 2 : RIGHT    (HFLIP → LEFT)
 *     frame 3 : DOWN-RIGHT(HFLIP → DOWN-LEFT)
 *     frame 4 : DOWN
 *
 *   Arrows / WASD : steer the car
 */

#include "ngpc_sys.h"
#include "ngpc_gfx.h"
#include "ngpc_sprite.h"
#include "ngpc_input.h"

/* ===== Sprite export (car_01-Sheet.png, 5 frames, --no-dedupe) =====
 * Tiles 128..147 (5 frames × 4 tiles = 20 tiles = 160 words). */
const u16 car_palette[4] = { 0x0000, 0x0000, 0x000D, 0x0D00 };

const u16 NGP_FAR car_tiles[160] = {
    0x0015, 0x0076, 0x019A, 0x05AA, 0x05A5, 0x059F, 0x017D, 0x0156,
    0x5400, 0x9D00, 0xA640, 0xAA50, 0x5A50, 0xF650, 0x7D40, 0x9540,
    0x0199, 0x019A, 0x0165, 0x05AA, 0x0595, 0x056A, 0x01DA, 0x0055,
    0x6640, 0xA640, 0x5940, 0xAA50, 0x5650, 0xA950, 0xA740, 0x5500,
    0x0005, 0x0015, 0x0016, 0x0055, 0x015F, 0x0597, 0x5555, 0x5AA5,
    0x5400, 0xB500, 0xAA40, 0x6A50, 0xDAB4, 0xF6A4, 0xFDA4, 0x7D94,
    0x5A99, 0xD9A6, 0x5A6A, 0x1A9A, 0x06A6, 0x0195, 0x005D, 0x0014,
    0x9D54, 0x5550, 0x6500, 0x5400, 0x5000, 0x5000, 0x4000, 0x0000,
    0x0000, 0x0000, 0x0540, 0x1555, 0x769A, 0x59A5, 0x699A, 0x6999,
    0x0000, 0x0000, 0x0540, 0x5550, 0x5AA4, 0x769D, 0x7DA5, 0x9DA9,
    0x6999, 0x699A, 0x59A5, 0x769A, 0x1555, 0x0540, 0x0000, 0x0000,
    0x9DA9, 0x7DA5, 0x769D, 0x5AA4, 0x5550, 0x0540, 0x0000, 0x0000,
    0x0014, 0x005D, 0x0195, 0x06A6, 0x1A9A, 0x5A6A, 0xD9A6, 0x5A99,
    0x0000, 0x4000, 0x5000, 0x5000, 0x5400, 0x6500, 0x5550, 0x9D54,
    0x5AA5, 0x5555, 0x0597, 0x015F, 0x0055, 0x0016, 0x0015, 0x0005,
    0x7D94, 0xFDA4, 0xF6A4, 0xDAB4, 0x6A50, 0xAA40, 0xB500, 0x5400,
    0x0055, 0x01DA, 0x056A, 0x0595, 0x05AA, 0x0165, 0x019A, 0x0199,
    0x5500, 0xA740, 0xA950, 0x5650, 0xAA50, 0x5940, 0xA640, 0x6640,
    0x0156, 0x017D, 0x059F, 0x05A5, 0x05AA, 0x019A, 0x0076, 0x0015,
    0x9540, 0x7D40, 0xF650, 0x5A50, 0xAA50, 0xA640, 0x9D00, 0x5400
};

/* One metasprite per rotation frame. Parts are {ox, oy, tile, pal, flags}. */
const NgpcMetasprite car_frame_0 = {
    4u, 16u, 16u,
    { { 0, 0, 128, 0, 0 }, { 8, 0, 129, 0, 0 },
      { 0, 8, 130, 0, 0 }, { 8, 8, 131, 0, 0 } }
};
const NgpcMetasprite car_frame_1 = {
    4u, 16u, 16u,
    { { 0, 0, 132, 0, 0 }, { 8, 0, 133, 0, 0 },
      { 0, 8, 134, 0, 0 }, { 8, 8, 135, 0, 0 } }
};
const NgpcMetasprite car_frame_2 = {
    4u, 16u, 16u,
    { { 0, 0, 136, 0, 0 }, { 8, 0, 137, 0, 0 },
      { 0, 8, 138, 0, 0 }, { 8, 8, 139, 0, 0 } }
};
const NgpcMetasprite car_frame_3 = {
    4u, 16u, 16u,
    { { 0, 0, 140, 0, 0 }, { 8, 0, 141, 0, 0 },
      { 0, 8, 142, 0, 0 }, { 8, 8, 143, 0, 0 } }
};
const NgpcMetasprite car_frame_4 = {
    4u, 16u, 16u,
    { { 0, 0, 144, 0, 0 }, { 8, 0, 145, 0, 0 },
      { 0, 8, 146, 0, 0 }, { 8, 8, 147, 0, 0 } }
};

/* Index-by-rotation table: up / upright / right / downright / down. */
const NgpcMetasprite *car_frames[5] = {
    &car_frame_0, &car_frame_1, &car_frame_2, &car_frame_3, &car_frame_4
};

void main(void)
{
    u8 x = 72, y = 68;
    u8 dir  = 0;         /* current rotation frame index 0..4 */
    u8 flip = 0;         /* SPR_HFLIP when facing left */
    u8 left, right, up, down;

    ngpc_init();

    ngpc_gfx_set_bg_color(RGB(0, 2, 0));
    ngpc_gfx_clear(GFX_SCR1);
    ngpc_gfx_clear(GFX_SCR2);
    ngpc_sprite_hide_all();

    /* Sprite palette — raw RGB444 from exporter. */
    HW_PAL_SPR[0] = car_palette[0];
    HW_PAL_SPR[1] = car_palette[1];
    HW_PAL_SPR[2] = car_palette[2];
    HW_PAL_SPR[3] = car_palette[3];

    /* Upload all 20 car tiles to slots 128..147. */
    ngpc_gfx_load_tiles_at(car_tiles, 160, 128);

    while (1) {
        ngpc_vsync();
        ngpc_input_update();
        if (USR_SHUTDOWN) ngpc_shutdown();

        left  = ngpc_pad_held & PAD_LEFT;
        right = ngpc_pad_held & PAD_RIGHT;
        up    = ngpc_pad_held & PAD_UP;
        down  = ngpc_pad_held & PAD_DOWN;

        if (left  && x > 0)   x--;
        if (right && x < 144) x++;
        if (up    && y > 0)   y--;
        if (down  && y < 136) y++;

        /* Pick rotation frame. Left-diagonals reuse the right-side frames
         * with SPR_HFLIP. No input → keep previous direction. */
        flip = 0;
        if      (up   && right) { dir = 1; }
        else if (up   && left)  { dir = 1; flip = SPR_HFLIP; }
        else if (down && right) { dir = 3; }
        else if (down && left)  { dir = 3; flip = SPR_HFLIP; }
        else if (up)            { dir = 0; }
        else if (down)          { dir = 4; }
        else if (right)         { dir = 2; }
        else if (left)          { dir = 2; flip = SPR_HFLIP; }

        /* One call writes 4 hardware sprites (slots 0..3). */
        ngpc_mspr_draw(0, x, y, car_frames[dir], SPR_FRONT | flip);
    }
}
`,
  },

  {
    id: 'stargunner-mini-shmup',
    label: '10 — StarGunner mini shmup (multi-file)',
    bundle: NGPC_EXAMPLE_BUNDLES.stargunnerMiniShmup,
  },

  {
    id: 'audio-test',
    label: '11 — Audio: tones + noise + BGM',
    body: `/*
 * T6W28 PSG DRIVER.
 *
 * The NGPC sound chip is a T6W28 — 3 square-wave tone channels + 1 noise
 * channel, identical to a Game Gear PSG. The template's audio driver hides
 * the register poking behind a tiny API:
 *
 *   Sounds_Init()        must be called once, right after ngpc_init().
 *   Sounds_Update()      called once per frame inside the main loop — ticks
 *                        SFX timers and advances the BGM streams.
 *
 *   Sfx_PlayToneCh(ch, divider, attn, frames)
 *                        ch 0..2 picks the square channel.
 *                        divider = timer count (96 kHz ÷ freq).
 *                        attn 0..15: 0 = loudest, 15 = silent.
 *                        frames = duration in 60 Hz frames.
 *
 *   Sfx_PlayNoiseEx(rate, type, attn, frames, ...)
 *                        rate: 0 = fastest. type: 0 periodic, 1 white.
 *                        Trailing params are sweep/env controls (0 = off).
 *
 *   Bgm_StartLoop4Ex(tone0_stream, loop0_off, tone1, loop1,
 *                    tone2, loop2,  noise, loopN_off)
 *                        music format: per-byte opcodes. 1..51 = note index,
 *                        0xFF = REST (one frame), 0x00 = END → jump to
 *                        loop_off (0 = restart from top).
 *   Bgm_Stop()           stops the BGM.
 *
 * Controls (click the canvas first so it has keyboard focus):
 *   A            : play a tone on channel 0 at the selected pitch
 *   B            : fire a noise burst (white noise, 30 frames)
 *   OPTION       : toggle the built-in BGM loop
 *   UP / DOWN    : cycle 8 notes from C4 to C5
 *   LEFT / RIGHT : cycle tone duration: 10 / 30 / 60 / 120 frames
 */

#include "ngpc_sys.h"
#include "ngpc_gfx.h"
#include "ngpc_text.h"
#include "ngpc_input.h"

/* PSG timer dividers for C4..C5 (equal temperament). Formula:
 *   divider = 96000 / freq. e.g. A4 (440 Hz) → 218. */
const u16 NGP_FAR s_notes[8] = {
    367, 327, 291, 275, 245, 218, 194, 184
};
const char *s_note_names[8] = {
    "C4", "D4", "E4", "F4", "G4", "A4", "B4", "C5"
};
const u16 s_durations[4] = { 10, 30, 60, 120 };

/* BGM streams. Bytes 1..51 = note indices into the driver's note table;
 * 0xFF = REST; 0x00 = END. Loop offset 0 means "restart from byte 0". */
const u8 NGP_FAR s_bgm_ch0[] = {
    27, 0xFF, 29, 0xFF, 31, 0xFF, 32, 0xFF,
    34, 0xFF, 32, 0xFF, 31, 0xFF, 29, 0xFF,
    0x00
};
const u8 NGP_FAR s_bgm_ch1[] = { 0xFF, 0xFF, 0xFF, 0xFF, 0x00 };
const u8 NGP_FAR s_bgm_ch2[] = { 0xFF, 0xFF, 0xFF, 0xFF, 0x00 };
/* Noise: 4 = white rate-H, 1 = periodic rate-M. */
const u8 NGP_FAR s_bgm_chn[] = {
    4, 0xFF, 0xFF, 0xFF, 1, 0xFF, 0xFF, 0xFF, 0x00
};

void main(void)
{
    u8 note_idx = 5;   /* start at A4 */
    u8 dur_idx  = 1;   /* 30 frames   */
    u8 bgm_on   = 0;

    ngpc_init();
    ngpc_load_sysfont();
    Sounds_Init();                /* must come AFTER ngpc_init() */

    ngpc_gfx_set_bg_color(RGB(0, 0, 4));
    ngpc_gfx_set_palette(GFX_SCR1, 0,
                         RGB(0, 0, 0), RGB(15, 15, 15),
                         RGB(0, 15, 15), RGB(15, 15, 0));
    ngpc_gfx_clear(GFX_SCR1);
    ngpc_gfx_clear(GFX_SCR2);
    ngpc_sprite_hide_all();

    ngpc_text_print(GFX_SCR1, 0, 1,  1, "AUDIO TEST");
    ngpc_text_print(GFX_SCR1, 0, 1,  3, "A     : tone ch0");
    ngpc_text_print(GFX_SCR1, 0, 1,  4, "B     : noise burst");
    ngpc_text_print(GFX_SCR1, 0, 1,  5, "OPT   : BGM toggle");
    ngpc_text_print(GFX_SCR1, 0, 1,  6, "UP/DN : note");
    ngpc_text_print(GFX_SCR1, 0, 1,  7, "LF/RT : duration");

    ngpc_text_print(GFX_SCR1, 0, 1, 10, "NOTE  :");
    ngpc_text_print(GFX_SCR1, 0, 1, 11, "DURAT :");
    ngpc_text_print(GFX_SCR1, 0, 1, 12, "BGM   :");

    while (1) {
        ngpc_vsync();
        ngpc_input_update();
        Sounds_Update();             /* ticks SFX + BGM — do it every frame */
        if (USR_SHUTDOWN) ngpc_shutdown();

        /* Note / duration selectors (edge-detected → one step per press). */
        if (ngpc_pad_pressed & PAD_UP)    note_idx = (note_idx + 1) & 7;
        if (ngpc_pad_pressed & PAD_DOWN)  note_idx = (note_idx + 7) & 7;
        if (ngpc_pad_pressed & PAD_RIGHT) dur_idx  = (dur_idx  + 1) & 3;
        if (ngpc_pad_pressed & PAD_LEFT)  dur_idx  = (dur_idx  + 3) & 3;

        if (ngpc_pad_pressed & PAD_A) {
            /* ch=0, divider for the picked note, attn=0 (loudest), duration. */
            Sfx_PlayToneCh(0, s_notes[note_idx], 0, s_durations[dur_idx]);
        }
        if (ngpc_pad_pressed & PAD_B) {
            /* rate=0, type=1 (white), attn=2, 30 frames, no sweep/env. */
            Sfx_PlayNoiseEx(0, 1, 2, 30, 0, 0, 0, 0, 0);
        }
        if (ngpc_pad_pressed & PAD_OPTION) {
            if (bgm_on) {
                Bgm_Stop();
                bgm_on = 0;
            } else {
                /* 4 streams + 4 loop offsets (0 = restart from top). */
                Bgm_StartLoop4Ex(s_bgm_ch0, 0, s_bgm_ch1, 0,
                                 s_bgm_ch2, 0, s_bgm_chn, 0);
                bgm_on = 1;
            }
        }

        /* HUD refresh every frame (cheap — tiny strings). */
        ngpc_text_print    (GFX_SCR1, 0, 9, 10, s_note_names[note_idx]);
        ngpc_text_print_dec(GFX_SCR1, 0, 9, 11, s_durations[dur_idx], 3);
        ngpc_text_print    (GFX_SCR1, 0, 9, 12, bgm_on ? "ON " : "off");
    }
}
`,
  },
];

// Expose to globalThis so non-browser hosts (Node vm, Workers, electron) can
// access this binding — top-level `const` is otherwise script-scoped.
if (typeof globalThis !== 'undefined') globalThis.NGPC_EXAMPLES = NGPC_EXAMPLES;
