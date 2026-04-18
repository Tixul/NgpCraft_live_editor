/*
 * main.c - Live editor starter (interactive demo)
 *
 * Bring-up mirrors NgpCraft_base_template/src/main.c:
 *   ngpc_init() -> ngpc_load_sysfont() -> setup -> loop.
 * Loop ordering: ngpc_vsync() FIRST, then ngpc_input_update(), then state.
 *
 * Shows three sprite patterns side-by-side to make it obvious sprites render:
 *   Sprite 0       : moving 'O' cursor (arrow keys)
 *   Sprite 10      : static 'A' (8x8)
 *   Sprites 20..23 : static 'A/B/C/D' 16x16 via H+V chaining on slot 20
 *                    (slots 21-23 are absorbed by the chain — SPRITES_OAM.md §2.1)
 *
 * Controls (click the canvas first so it has keyboard focus):
 *   Arrows / WASD : move cursor
 *   Z / Space     : A  (counts presses)
 *   X / Shift     : B  (toggles LCD inversion via HW_LCD_CTL)
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

    /* Sprite palette 0 = yellow, palette 1 = red. */
    ngpc_gfx_set_palette(GFX_SPR, 0,
                         RGB(0, 0, 0), RGB(15, 15, 0),
                         RGB(15, 8, 0), RGB(15, 0, 0));
    ngpc_gfx_set_palette(GFX_SPR, 1,
                         RGB(0, 0, 0), RGB(15, 0, 0),
                         RGB(15, 8, 0), RGB(15, 15, 0));
    ngpc_sprite_hide_all();

    ngpc_text_print(GFX_SCR1, 0, 1, 1, "NGPCRAFT LIVE EDITOR");
    ngpc_text_print(GFX_SCR1, 0, 1, 3, "arrows: move 'O'");
    ngpc_text_print(GFX_SCR1, 0, 1, 4, "Z / X : A / B");
    ngpc_text_print(GFX_SCR1, 0, 1, 6, "A presses:");
    ngpc_text_print(GFX_SCR1, 0, 1, 8, "pos x:");
    ngpc_text_print(GFX_SCR1, 0, 1, 9, "pos y:");

    /* --- Static sprites, set once before the loop --- */

    /* Simple 8x8 sprite (yellow 'A') at top-right corner. */
    ngpc_sprite_set(10, 140, 12, 'A', 0, SPR_FRONT);

    /* 16x16 H+V-chained sprite at bottom-right: four consecutive tiles
     * A/B/C/D arranged as 2x2. Hardware auto-places slot 20 at (x, y),
     * slot 21 at (x+8, y) with tile B (A+1), slot 22 at (x, y+8) with
     * tile C (A+2), slot 23 at (x+8, y+8) with tile D (A+3). */
    ngpc_sprite_set(20, 130, 125, 'A', 1, SPR_FRONT | SPR_HCHAIN | SPR_VCHAIN);

    while (1) {
        ngpc_vsync();
        ngpc_input_update();

        if (USR_SHUTDOWN) ngpc_shutdown();

        if (ngpc_pad_pressed & PAD_A) press_count++;
        if (ngpc_pad_pressed & PAD_B) HW_LCD_CTL ^= 0x80;

        if (ngpc_pad_held & PAD_LEFT)  x--;
        if (ngpc_pad_held & PAD_RIGHT) x++;
        if (ngpc_pad_held & PAD_UP)    y--;
        if (ngpc_pad_held & PAD_DOWN)  y++;

        /* Moving cursor on slot 0. */
        ngpc_sprite_set(0, x, y, 'O', 0, SPR_FRONT);

        ngpc_text_print_dec(GFX_SCR1, 0, 10, 6, press_count, 3);
        ngpc_text_print_dec(GFX_SCR1, 0,  8, 8, x, 3);
        ngpc_text_print_dec(GFX_SCR1, 0,  8, 9, y, 3);
    }
}
