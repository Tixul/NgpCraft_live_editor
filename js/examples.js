// Curated C89 / cc900-compatible examples for the live editor.
// Each entry is shown in the UI's "Load example" dropdown; selecting one
// either replaces src/main.c or imports a full project bundle.
//
// Examples are ordered from "first to write" to "advanced" so a student can
// work through them in sequence. Every example uses the real NgpCraft API
// and compiles transparently to the emulator — no emulator-only idioms.

const NGPC_EXAMPLES = [
  {
    id: 'minimal',
    label: '01 — Minimal (hello world)',
    body: `/*
 * Minimal program: initialise hardware, print a line of text.
 * This is the smallest useful main() — no loop, main returns after setup.
 */

#include "ngpc_sys.h"
#include "ngpc_gfx.h"
#include "ngpc_text.h"

void main(void)
{
    ngpc_init();
    ngpc_load_sysfont();

    ngpc_gfx_set_bg_color(RGB(0, 0, 6));
    ngpc_gfx_set_palette(GFX_SCR1, 0,
                         RGB(0, 0, 0), RGB(15, 15, 15),
                         RGB(0, 15, 0), RGB(0, 15, 15));
    ngpc_gfx_clear(GFX_SCR1);

    ngpc_text_print(GFX_SCR1, 0, 4, 9, "Hello, NGPC!");
}
`,
  },

  {
    id: 'sprite-move',
    label: '02 — Sprite + keyboard input',
    body: `/*
 * Interactive demo: a sprite follows the arrow keys.
 * 60 Hz loop with ngpc_vsync(). Input is read via ngpc_input_update() which
 * reads HW_JOYPAD (0x6F82) and exposes edge-detected held/pressed/released.
 *
 *   Arrows / WASD : move
 *   Z / Space     : A (count presses)
 *   X / Shift     : B (toggle LCD inversion via HW_LCD_CTL)
 */

#include "ngpc_sys.h"
#include "ngpc_gfx.h"
#include "ngpc_sprite.h"
#include "ngpc_text.h"
#include "ngpc_input.h"

void main(void)
{
    u8 x = 76, y = 72;
    u8 press_count = 0;

    ngpc_init();
    ngpc_load_sysfont();

    ngpc_gfx_set_bg_color(RGB(0, 0, 6));
    ngpc_gfx_set_palette(GFX_SCR1, 0,
                         RGB(0, 0, 0), RGB(15, 15, 15),
                         RGB(0, 15, 0), RGB(0, 15, 15));
    ngpc_gfx_clear(GFX_SCR1);

    ngpc_gfx_set_palette(GFX_SPR, 0,
                         RGB(0, 0, 0), RGB(15, 15, 0),
                         RGB(15, 8, 0), RGB(15, 0, 0));
    ngpc_sprite_hide_all();

    ngpc_text_print(GFX_SCR1, 0, 1, 1, "MOVE WITH ARROWS");
    ngpc_text_print(GFX_SCR1, 0, 1, 3, "A presses:");

    while (1) {
        ngpc_vsync();
        ngpc_input_update();

        if (ngpc_pad_pressed & PAD_A) press_count++;
        if (ngpc_pad_pressed & PAD_B) HW_LCD_CTL ^= 0x80;

        if (ngpc_pad_held & PAD_LEFT)  x--;
        if (ngpc_pad_held & PAD_RIGHT) x++;
        if (ngpc_pad_held & PAD_UP)    y--;
        if (ngpc_pad_held & PAD_DOWN)  y++;

        ngpc_sprite_set(0, x, y, 'O', 0, SPR_FRONT);
        ngpc_text_print_dec(GFX_SCR1, 0, 12, 3, press_count, 3);
    }
}
`,
  },

  {
    id: 'pointer-vram',
    label: '03 — Pointers tutorial (writing VRAM by hand)',
    body: `/*
 * Pointer tutorial: every byte of character RAM (tile 1) is written by
 * walking a u8 pointer. Demonstrates the C pointer primitives the
 * NgpCraft template uses to push asset data into VRAM:
 *
 *   u8 *p = (u8*)ADDR;   pointer creation from a hardware address
 *   *p = VAL;            write through the pointer
 *   p[i] = VAL;          array-style indexing (same memory)
 *   p++, p += N          advance the address by element size
 *
 * Watch the CPU budget meter to see how many memory ops this costs.
 */

#include "ngpc_sys.h"
#include "ngpc_gfx.h"
#include "ngpc_sprite.h"

void main(void)
{
    u8 *tile1;      /* byte pointer into tile RAM */
    u8  i;

    ngpc_init();

    ngpc_gfx_set_bg_color(RGB(0, 0, 4));
    ngpc_gfx_set_palette(GFX_SPR, 0,
                         RGB(0, 0, 0), RGB(15, 0, 0),
                         RGB(0, 15, 0), RGB(0, 0, 15));

    /* Tile 1 lives at 0xA000 + 1 * 16 = 0xA010. It is 16 bytes
     * (8 rows of 2 bytes each, K2GE tile format). Fill every byte
     * with 0x55 = binary 01 01 01 01 → every dot uses colour 1. */
    tile1 = (u8*)(0xA000 + 16);
    for (i = 0; i < 16; i++) {
        *tile1 = 0x55;
        tile1++;
    }

    /* Place the solid-red tile on sprite slot 0, front priority. */
    ngpc_sprite_hide_all();
    ngpc_sprite_set(0, 76, 72, 1, 0, SPR_FRONT);

    /* main() returns — screen is static. */
}
`,
  },

  {
    id: 'tilemap-scroll',
    label: '04 — Tilemap scroll + palette cycle',
    body: `/*
 * Fill SCR1 with a diagonal stripe pattern and cycle through palettes
 * while scrolling horizontally. Demonstrates:
 *   - tile RAM upload via raw pointer (one tile, two colours)
 *   - tilemap fill
 *   - horizontal scroll via HW_SCR1_OFS_X
 *   - palette animation via HW_PAL_SCR1[] (live PTR from template)
 */

#include "ngpc_sys.h"
#include "ngpc_gfx.h"

/* Diagonal-stripe tile: color 1 on one diagonal, color 2 on the next.
 * 8 rows of 2 bytes. K2GE byte 0 = dots 4..7, byte 1 = dots 0..3. */
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

    /* Palette 0: transparent + red + orange + yellow. */
    ngpc_gfx_set_palette(GFX_SCR1, 0,
                         RGB(0, 0, 0), RGB(15, 0, 0),
                         RGB(15, 8, 0), RGB(15, 15, 0));

    /* Upload our single custom tile at index 1. */
    ngpc_gfx_load_tiles_at(stripes, 8, 1);

    /* Fill the whole SCR1 tilemap with tile 1. */
    ngpc_gfx_fill(GFX_SCR1, 1, 0);

    while (1) {
        ngpc_vsync();

        scroll_x++;
        HW_SCR1_OFS_X = scroll_x;

        /* Every 30 frames rewrite palette 0 with a new colour 1. */
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
    id: 'bitmap',
    label: '05 — Bitmap mode (pixel drawing)',
    body: `/*
 * Software bitmap mode: every pixel is individually addressable at 2 bpp.
 * ngpc_bmp_init() wires a scroll plane to 380 unique tiles starting at a
 * tile offset; subsequent ngpc_bmp_* calls pulse pixels into tile RAM.
 *
 * Draws a starburst of lines + a filled rectangle.
 * Budget meter note: full-screen pixel work burns CPU fast — keep an eye on
 * the "CPU" bar while tweaking.
 */

#include "ngpc_sys.h"
#include "ngpc_gfx.h"

void main(void)
{
    u8 i;

    ngpc_init();

    ngpc_gfx_set_bg_color(RGB(0, 0, 0));
    ngpc_gfx_set_palette(GFX_SCR1, 0,
                         RGB(0, 0, 0), RGB(15, 15, 15),
                         RGB(0, 15, 15), RGB(15, 0, 15));

    /* Tile offset 1 (leaving tile 0 as blank). Uses palette 0. */
    ngpc_bmp_init(GFX_SCR1, 1, 0);

    /* Starburst from screen centre (80, 76) to the top / bottom edges.
     * Endpoints walk x = 0..154 in steps of 7, all inside the 160-wide
     * bitmap (the prior i < 24 hit x = 161 → warning from the bmp bounds
     * guard). */
    for (i = 0; i < 23; i++) {
        ngpc_bmp_line(80, 76, (u8)(i * 7), 4, 1);
        ngpc_bmp_line(80, 76, (u8)(i * 7), 151, 2);
    }

    /* A hollow rectangle and a filled one inside it. */
    ngpc_bmp_rect(20, 20, 120, 40, 3);
    ngpc_bmp_fill_rect(40, 28, 80, 24, 1);
}
`,
  },

  {
    id: 'sine',
    label: '06 — Sine wave sprite motion',
    body: `/*
 * Uses ngpc_sin() (256-entry table from ngpc_math.c) to move a sprite along
 * a sine curve. Time is tracked via g_vb_counter — the VBI-incremented frame
 * counter the template exposes as extern volatile u8.
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
    ngpc_sprite_hide_all();

    while (1) {
        ngpc_vsync();

        angle = g_vb_counter * 3;               /* ~4.4 s per full cycle */
        x = 80 + ((s16)ngpc_sin(angle) * 60) / 127;  /* amplitude 60 px */
        y = 72 + ((s16)ngpc_cos(angle) * 40) / 127;  /* amplitude 40 px */

        ngpc_sprite_set(0, (u8)x, (u8)y, '@', 0, SPR_FRONT);
    }
}
`,
  },

  {
    id: 'state-machine',
    label: '07 — Function-pointer state machine',
    body: `/*
 * A classic NGPC game structure: each state is a function, a state table
 * indexed by an enum drives the main loop. Compiles to a JS array of
 * function references — the transpile treats the table as any other array.
 *
 * Press A to advance to the next state.
 */

#include "ngpc_sys.h"
#include "ngpc_gfx.h"
#include "ngpc_text.h"
#include "ngpc_input.h"

typedef enum { S_INTRO, S_PLAY, S_OVER, S_COUNT } GameState;
typedef void (*StateFn)(void);

static GameState current;

static void draw_screen(const char *title)
{
    ngpc_gfx_clear(GFX_SCR1);
    ngpc_text_print(GFX_SCR1, 0, 4, 4,  title);
    ngpc_text_print(GFX_SCR1, 0, 3, 10, "press A");
}

void state_intro(void) { draw_screen("INTRO"); }
void state_play(void)  { draw_screen("PLAYING"); }
void state_over(void)  { draw_screen("GAME OVER"); }

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

    current = S_INTRO;
    prev    = S_COUNT;     /* force first render */

    while (1) {
        ngpc_vsync();
        ngpc_input_update();

        if (current != prev) {
            states[current]();   /* draw the new state */
            prev = current;
        }

        if (ngpc_pad_pressed & PAD_A) {
            current = (current + 1) % S_COUNT;
        }
    }
}
`,
  },

  {
    id: 'png-assets',
    label: '08 — PNG assets (car sprite + grass BG)',
    body: `/*
 * Real-asset demo: the background and player sprite come from PNGs passed
 * through the NgpCraft converter tools (tools/ngpc_tilemap.py and
 * tools/ngpc_sprite_export.py). The arrays below are the verbatim output;
 * in a real project they live in their own .c/.h files.
 *
 *   Bg_grass.png (160x160 crop)     -> 4 tiles, 1 palette, 20x20 map
 *   car_01.png   (16x16, 1 frame)   -> 4 tiles, 1 palette, 1 metasprite
 *
 * Palettes are already RGB444 so we write them raw. Tile indices are the
 * *destination* VRAM slots chosen below: BG tiles at 0..3, sprite at 128..131.
 *
 *   Arrows / WASD : move the car
 */

#include "ngpc_sys.h"
#include "ngpc_gfx.h"
#include "ngpc_sprite.h"
#include "ngpc_input.h"

/* ===== from ngpc_tilemap.py Bg_grass_cropped.png ===== */
const u16 grass_palette[4] = { 0x0000, 0x0183, 0x01C5, 0x0000 };

const u16 NGP_FAR grass_tiles[32] = {
    0x5565, 0x5555, 0x9555, 0x5555, 0x5595, 0x5555, 0x5555, 0x555A,
    0x6555, 0x5555, 0x5565, 0x5555, 0x5555, 0x5556, 0x5555, 0x5555,
    0x5555, 0x5555, 0x5556, 0x5555, 0x5555, 0x5595, 0x5555, 0x5555,
    0x5556, 0x5556, 0x5555, 0x5559, 0x5559, 0x5555, 0x5555, 0x5655
};

/* 20x20 tile indices, only rows 0..18 (19 tall) are visible at 160x152. */
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

/* ===== from ngpc_sprite_export.py car_01.png ===== */
const u16 car_palette[4] = { 0x0000, 0x0000, 0x000D, 0x0D00 };

const u16 NGP_FAR car_tiles[32] = {
    0x0015, 0x0076, 0x019A, 0x05AA, 0x05A5, 0x059F, 0x017D, 0x0156,
    0x5400, 0x9D00, 0xA640, 0xAA50, 0x5A50, 0xF650, 0x7D40, 0x9540,
    0x0199, 0x019A, 0x0165, 0x05AA, 0x0595, 0x056A, 0x01DA, 0x0055,
    0x6640, 0xA640, 0x5940, 0xAA50, 0x5650, 0xA950, 0xA740, 0x5500
};

void main(void)
{
    u16 i;
    u8 x = 72, y = 68;
    u8 ty;

    ngpc_init();
    ngpc_gfx_set_bg_color(RGB(0, 2, 0));

    /* Palettes are already RGB444 u16 words from the converter — write raw. */
    HW_PAL_SCR1[0] = grass_palette[0];
    HW_PAL_SCR1[1] = grass_palette[1];
    HW_PAL_SCR1[2] = grass_palette[2];
    HW_PAL_SCR1[3] = grass_palette[3];

    HW_PAL_SPR[0]  = car_palette[0];
    HW_PAL_SPR[1]  = car_palette[1];
    HW_PAL_SPR[2]  = car_palette[2];
    HW_PAL_SPR[3]  = car_palette[3];

    /* Upload tile bitmaps. BG occupies 0..3, sprite 128..131. */
    ngpc_gfx_load_tiles_at(grass_tiles, 32, 0);
    ngpc_gfx_load_tiles_at(car_tiles,   32, 128);

    /* Paint the visible part of the map (20 wide x 19 tall). */
    for (ty = 0; ty < 19; ty++) {
        for (i = 0; i < 20; i++) {
            ngpc_gfx_put_tile(GFX_SCR1, i, ty, grass_map[ty * 20 + i], 0);
        }
    }

    ngpc_sprite_hide_all();

    while (1) {
        ngpc_vsync();
        ngpc_input_update();

        if ((ngpc_pad_held & PAD_LEFT)  && x > 0)   x--;
        if ((ngpc_pad_held & PAD_RIGHT) && x < 144) x++;
        if ((ngpc_pad_held & PAD_UP)    && y > 0)   y--;
        if ((ngpc_pad_held & PAD_DOWN)  && y < 136) y++;

        /* 2x2 metasprite: 4 hardware sprites laid out in a 16x16 block. */
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
    label: '09 — Directional metasprite (car rotation)',
    body: `/*
 * Directional sprite using the NgpCraft metasprite pipeline exactly as
 * emitted by tools/ngpc_sprite_export.py from car_01-Sheet.png (5 frames,
 * 16x16). The 5 frames are rotations — not an idle cycle — so we pick one
 * based on the D-pad direction instead of looping a timer:
 *
 *     frame 0 : car facing UP
 *     frame 1 : diagonal up-right        (HFLIP -> up-left)
 *     frame 2 : facing RIGHT             (HFLIP -> left)
 *     frame 3 : diagonal down-right      (HFLIP -> down-left)
 *     frame 4 : facing DOWN
 *
 * The arrays below are the verbatim converter output (--no-dedupe keeps the
 * tile layout flat so tile indices walk 128..147). ngpc_mspr_draw() unpacks
 * each NgpcMetasprite into 4 hardware sprites.
 *
 *   Arrows / WASD : steer the car
 */

#include "ngpc_sys.h"
#include "ngpc_gfx.h"
#include "ngpc_sprite.h"
#include "ngpc_input.h"

/* ===== from ngpc_tilemap.py Bg_grass_cropped.png ===== */
const u16 grass_palette[4] = { 0x0000, 0x0183, 0x01C5, 0x0000 };
const u16 NGP_FAR grass_tiles[32] = {
    0x5565, 0x5555, 0x9555, 0x5555, 0x5595, 0x5555, 0x5555, 0x555A,
    0x6555, 0x5555, 0x5565, 0x5555, 0x5555, 0x5556, 0x5555, 0x5555,
    0x5555, 0x5555, 0x5556, 0x5555, 0x5555, 0x5595, 0x5555, 0x5555,
    0x5556, 0x5556, 0x5555, 0x5559, 0x5559, 0x5555, 0x5555, 0x5655
};

/* ===== from ngpc_sprite_export.py car_01-Sheet.png --frame-count 5 ===== */
const u16 car_palettes[4] = { 0x0000, 0x0000, 0x000D, 0x0D00 };

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

/* Lookup table: pointer-to-frame per rotation index 0..4.
 * The diagonals / right-facing frames are also used (with SPR_HFLIP) for
 * the mirrored left-facing directions. */
const NgpcMetasprite *car_frames[5] = {
    &car_frame_0, &car_frame_1, &car_frame_2, &car_frame_3, &car_frame_4
};

void main(void)
{
    u8 x = 72, y = 68;
    u8 dir = 0;        /* current rotation frame index */
    u8 flip = 0;       /* SPR_HFLIP when facing left */
    u8 left, right, up, down;
    u8 tx, ty;

    ngpc_init();
    ngpc_gfx_set_bg_color(RGB(0, 2, 0));

    /* BG palette + sprite palette — raw RGB444 from converter. */
    HW_PAL_SCR1[0] = grass_palette[0];
    HW_PAL_SCR1[1] = grass_palette[1];
    HW_PAL_SCR1[2] = grass_palette[2];
    HW_PAL_SCR1[3] = grass_palette[3];

    HW_PAL_SPR[0] = car_palettes[0];
    HW_PAL_SPR[1] = car_palettes[1];
    HW_PAL_SPR[2] = car_palettes[2];
    HW_PAL_SPR[3] = car_palettes[3];

    /* Upload BG tiles (0..3) and sprite tiles (128..147). */
    ngpc_gfx_load_tiles_at(grass_tiles, 32, 0);
    ngpc_gfx_load_tiles_at(car_tiles, 160, 128);

    /* Paint the 20x19 visible tilemap — 2x2 checker of the 4 grass tiles. */
    for (ty = 0; ty < 19; ty++) {
        for (tx = 0; tx < 20; tx++) {
            ngpc_gfx_put_tile(GFX_SCR1, tx, ty, ((ty & 1) << 1) | (tx & 1), 0);
        }
    }

    ngpc_sprite_hide_all();

    while (1) {
        ngpc_vsync();
        ngpc_input_update();

        left  = ngpc_pad_held & PAD_LEFT;
        right = ngpc_pad_held & PAD_RIGHT;
        up    = ngpc_pad_held & PAD_UP;
        down  = ngpc_pad_held & PAD_DOWN;

        /* Move according to held keys. */
        if (left  && x > 0)   x--;
        if (right && x < 144) x++;
        if (up    && y > 0)   y--;
        if (down  && y < 136) y++;

        /* Pick rotation frame. LEFT directions mirror the right-side frames
         * by setting SPR_HFLIP. No input keeps the previous direction. */
        flip = 0;
        if (up && right)        { dir = 1; }
        else if (up && left)    { dir = 1; flip = SPR_HFLIP; }
        else if (down && right) { dir = 3; }
        else if (down && left)  { dir = 3; flip = SPR_HFLIP; }
        else if (up)            { dir = 0; }
        else if (down)          { dir = 4; }
        else if (right)         { dir = 2; }
        else if (left)          { dir = 2; flip = SPR_HFLIP; }

        ngpc_mspr_draw(0, x, y, car_frames[dir], SPR_FRONT | flip);
    }
}
`,
  },
  {
    id: 'stargunner-mini-shmup',
    label: '10 - StarGunner mini shmup (multi-file)',
    bundle: NGPC_EXAMPLE_BUNDLES.stargunnerMiniShmup,
  },

  {
    id: 'audio-test',
    label: '11 - Audio test (tone + noise + BGM)',
    body: `/*
 * Audio test: exercise the T6W28 PSG emulator (3 tones + 1 noise) through
 * the template audio API.
 *
 * Controls (click the canvas first for keyboard focus):
 *   A        : play a tone on channel 0 at the current note
 *   B        : play a noise burst (white noise, 30 frames)
 *   OPTION   : toggle the built-in BGM loop
 *   UP/DOWN  : cycle through 8 notes (C4 ... C5)
 *   LEFT/RIGHT : change tone duration (10 / 30 / 60 / 120 frames)
 *
 * What to listen for:
 *   - Pressing A at different notes should give distinct pitches.
 *   - Noise burst is a hiss, same duration each time.
 *   - BGM plays 4 bars on tone 1, rests on tones 2/3, drum on noise.
 */

#include "ngpc_sys.h"
#include "ngpc_gfx.h"
#include "ngpc_text.h"
#include "ngpc_input.h"

/* Dividers for 8 notes C4..C5 (equal temperament, 96 kHz / Hz). */
const u16 NGP_FAR s_notes[8] = {
    367, 327, 291, 275, 245, 218, 194, 184
};
const char *s_note_names[8] = {
    "C4", "D4", "E4", "F4", "G4", "A4", "B4", "C5"
};
const u16 s_durations[4] = { 10, 30, 60, 120 };

/* Tiny BGM — 4 tone-0 notes with REST between. Loop back to byte 0.
 * Format: byte in [1..51] = note index; 0xFF = REST; 0x00 = END. */
const u8 NGP_FAR s_bgm_ch0[] = {
    27, 0xFF, 29, 0xFF, 31, 0xFF, 32, 0xFF,
    34, 0xFF, 32, 0xFF, 31, 0xFF, 29, 0xFF,
    0x00
};
const u8 NGP_FAR s_bgm_ch1[] = { 0xFF, 0xFF, 0xFF, 0xFF, 0x00 };
const u8 NGP_FAR s_bgm_ch2[] = { 0xFF, 0xFF, 0xFF, 0xFF, 0x00 };
/* Noise channel: byte 1..8 = noise ctrl. 4 = white/H-rate, 1 = periodic/M. */
const u8 NGP_FAR s_bgm_chn[] = {
    4, 0xFF, 0xFF, 0xFF, 1, 0xFF, 0xFF, 0xFF, 0x00
};

void main(void)
{
    u8 note_idx = 5;   /* start at A4 */
    u8 dur_idx  = 1;   /* 30 frames */
    u8 bgm_on   = 0;

    ngpc_init();
    ngpc_load_sysfont();
    Sounds_Init();

    ngpc_gfx_set_bg_color(RGB(0, 0, 4));
    ngpc_gfx_set_palette(GFX_SCR1, 0,
                         RGB(0, 0, 0), RGB(15, 15, 15),
                         RGB(0, 15, 15), RGB(15, 15, 0));
    ngpc_gfx_clear(GFX_SCR1);

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
        Sounds_Update();   /* ticks SFX timers + BGM pointers */

        if (ngpc_pad_pressed & PAD_UP)    note_idx = (note_idx + 1) & 7;
        if (ngpc_pad_pressed & PAD_DOWN)  note_idx = (note_idx + 7) & 7;
        if (ngpc_pad_pressed & PAD_RIGHT) dur_idx  = (dur_idx  + 1) & 3;
        if (ngpc_pad_pressed & PAD_LEFT)  dur_idx  = (dur_idx  + 3) & 3;

        if (ngpc_pad_pressed & PAD_A) {
            /* ch=0, divider from table, attn=0 (loudest), duration in frames */
            Sfx_PlayToneCh(0, s_notes[note_idx], 0, s_durations[dur_idx]);
        }
        if (ngpc_pad_pressed & PAD_B) {
            /* rate=0 (fastest), type=1 (white), attn=2, 30 frames */
            Sfx_PlayNoiseEx(0, 1, 2, 30, 0, 0, 0, 0, 0);
        }
        if (ngpc_pad_pressed & PAD_OPTION) {
            if (bgm_on) {
                Bgm_Stop();
                bgm_on = 0;
            } else {
                /* StartLoop4Ex with all four channels + loop-back offsets = 0
                 * means the streams restart from the top on END. */
                Bgm_StartLoop4Ex(s_bgm_ch0, 0, s_bgm_ch1, 0,
                                 s_bgm_ch2, 0, s_bgm_chn, 0);
                bgm_on = 1;
            }
        }

        ngpc_text_print(GFX_SCR1, 0, 9, 10, s_note_names[note_idx]);
        ngpc_text_print_dec(GFX_SCR1, 0, 9, 11, s_durations[dur_idx], 3);
        ngpc_text_print(GFX_SCR1, 0, 9, 12, bgm_on ? "ON " : "off");
    }
}
`,
  },
];

// Expose to globalThis so non-browser hosts (Node vm, Workers, electron) can
// access this binding — top-level `const` is otherwise script-scoped.
if (typeof globalThis !== 'undefined') globalThis.NGPC_EXAMPLES = NGPC_EXAMPLES;
